import crypto from 'node:crypto';
import { Hono } from 'hono';
import { db } from './db.js';
import { env } from './env.js';
import { getBotRow } from './store.js';
import { mcpToken, primaryBotId } from './engine.js';
import { findCallRow, requestApproval } from './agent/loop.js';

/**
 * The approval gate for what an agent does with its own hands: shell commands, code, the browser
 * and desktop control. Hermes runs these tools itself, so the app never sees them as MCP calls.
 * Instead each agent's Hermes has a `pre_tool_call` shell hook (server/box/goatbot-gate.py) that
 * posts the call here before it runs:
 *
 *   POST /gate/<botId>     a managed bot's engine; same bearer token as its /mcp endpoint
 *   POST /gate/primary     the primary engine
 *
 * The answer is {decision: 'allow'} or {decision: 'deny', message}. Calls that are not part of a
 * turn the app started (the agent reached through its own channels) are left to Hermes' own rules.
 */

/** Hermes waits at most 300 s for a shell hook; the card gives up a little before the hook does. */
const GATE_WAIT_MS = 280_000;

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this in time (or sent a new message). Do not retry unless they ask.';

export interface GateAsk {
  /** Permission keys this call needs; "Always allow" saves the first one. */
  keys: string[];
  title: string;
  sub: string;
  detail: string;
  noAlways?: boolean;
}

/** Programs that run whatever they are given: allowing them for good would allow everything. */
const RUNS_ANYTHING = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'python', 'python3', 'node', 'deno', 'bun', 'npx', 'perl', 'ruby', 'php', 'sudo', 'su', 'doas', 'env', 'xargs', 'eval', 'exec', 'nohup', 'timeout', 'watch', 'ssh', 'docker', 'podman']);

/** Programs that delete, overwrite or stop things: asked about every time, never allowed for good. */
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'dd', 'mkfs', 'truncate', 'mv', 'chmod', 'chown', 'chgrp', 'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'poweroff', 'halt', 'systemctl', 'service', 'crontab', 'iptables', 'ufw', 'useradd', 'userdel', 'usermod', 'passwd', 'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'pip', 'pip3', 'npm', 'git']);

/** Shell syntax that chains, substitutes or redirects: the first word no longer says what runs. */
const COMPOUND = /[;&|`$<>(){}\n\\*?]/;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The one program a simple command runs, or null when the command is compound. */
export function commandProgram(command: string): string | null {
  const cmd = command.trim();
  if (!cmd || COMPOUND.test(cmd)) return null;
  const first = cmd.split(/\s+/)[0];
  if (first.includes('=') || first.startsWith('-')) return null;
  const prog = first.split('/').pop()!.toLowerCase();
  return /^[a-z0-9._+-]+$/.test(prog) ? prog : null;
}

/** Sites a piece of browser code names, without "www.". */
export function hostsIn(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi)) out.add(m[1].toLowerCase().replace(/^www\./, '').replace(/\.$/, ''));
  return [...out].filter(Boolean);
}

/** What asking about this call looks like, or null when it needs no approval. */
export function classify(tool: string, input: any): GateAsk | null {
  const a = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'terminal': {
      const command = String(a.command ?? '');
      const prog = commandProgram(command);
      const broad = !prog || RUNS_ANYTHING.has(prog);
      return {
        keys: [broad ? 'shell:any-command' : `shell:${prog}`],
        title: 'run a command',
        sub: broad ? 'Shell command' : `Shell command · ${prog}`,
        detail: clip(command, 1200),
        noAlways: broad || DESTRUCTIVE.has(prog!),
      };
    }
    case 'execute_code':
      return { keys: ['shell:run-code'], title: 'run code', sub: 'Code on its computer', detail: clip(String(a.code ?? ''), 1200), noAlways: true };
    case 'browser_exec': {
      const hosts = hostsIn(String(a.code ?? ''));
      // Code that names no site keeps working on the page it is already on.
      if (!hosts.length) return null;
      return {
        keys: hosts.map((h) => `browser:${h}`),
        title: hosts.length === 1 ? `open ${hosts[0]}` : `open ${hosts.length} sites`,
        sub: 'Browser',
        detail: hosts.join('\n'),
        noAlways: hosts.length > 1,
      };
    }
    case 'browser_cdp':
      return { keys: ['browser:devtools'], title: 'use browser developer tools', sub: 'Browser', detail: clip(`${a.method ?? ''}${a.params ? ` ${JSON.stringify(a.params)}` : ''}`, 600), noAlways: true };
    case 'browser_vault': {
      const action = String(a.action ?? '');
      if (action === 'list' || action === '') return null;
      return { keys: ['browser:saved-logins'], title: 'use a saved login or card', sub: 'Browser · saved logins', detail: `action: ${action}`, noAlways: true };
    }
    case 'computer_use': {
      const action = String(a.action ?? '');
      // Looking is free; anything that clicks, types or changes focus is control.
      if (['capture', 'wait', 'list_apps', 'list_windows', ''].includes(action)) return null;
      const what = a.text ? `\ntext: ${clip(String(a.text), 200)}` : a.keys ? `\nkeys: ${clip(String(a.keys), 80)}` : '';
      return { keys: ['computer:control'], title: 'control its screen', sub: 'Mouse and keyboard', detail: `action: ${action}${what}` };
    }
    default:
      return null;
  }
}

type Mode = 'always_allow' | 'needs_approval' | 'blocked';
const modeFor = (userId: string, key: string): Mode =>
  ((db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, key) as any)?.mode ?? 'needs_approval') as Mode;

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const gateApi = new Hono();

gateApi.post('/:bot', async (c) => {
  const slug = c.req.param('bot');
  const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return c.json({ decision: 'deny', message: 'Unauthorized' }, 401);
  const botId = slug === 'primary' ? primaryBotId() : slug;
  const bot = botId ? getBotRow(botId) : null;
  const allow = () => c.json({ decision: 'allow' });
  if (!botId || !bot) return allow(); // no bot in the app yet: nothing here to ask with

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ decision: 'deny', message: 'Unreadable request' }, 400); }
  if (!env.gateComputerActions) return allow();

  const tool = String(body?.tool_name ?? '');
  const ask = classify(tool, body?.tool_input);
  if (!ask) return allow();

  const call = await findCallRow(botId, String(body?.tool_call_id ?? ''), tool);
  if (!call.running) return allow(); // not a turn started here: Hermes' own approval rules apply

  const userId: string = bot.user_id;
  const modes = ask.keys.map((k) => modeFor(userId, k));
  if (modes.includes('blocked')) return c.json({ decision: 'deny', message: DECLINED });
  // Too broad to allow for good: asked every time, whatever was saved before.
  const pending = ask.noAlways ? ask.keys : ask.keys.filter((_, i) => modes[i] !== 'always_allow');
  if (!pending.length) return allow();

  const decision = await requestApproval(
    { userId, botId },
    { key: pending[0], title: ask.title, sub: ask.sub, detail: ask.detail, noAlways: ask.noAlways || pending.length > 1, waitMs: GATE_WAIT_MS },
    body?.tool_input ?? {},
    call.seq,
  );
  if (decision === 'allow') return allow();
  return c.json({ decision: 'deny', message: decision === 'deny' ? DECLINED : SKIPPED });
});

gateApi.all('/:bot', (c) => c.body(null, 405, { Allow: 'POST' }));
