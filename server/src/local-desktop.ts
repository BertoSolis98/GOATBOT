import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { OrgoComputer, OrgoScreen } from './orgo.js';

/**
 * The bots' computer when GoatBot runs on your own machine (COMPUTER=local, see docker/). It answers
 * the same calls as Orgo's API, so the rest of the app does not change: the "computer" is the
 * machine (or container) this server runs on, and each screen is an X display started by
 * server/box/hq-display.sh (Xvfb, a window manager and a VNC server on localhost).
 *
 * Screen ids follow Orgo's: "default" is display :99, "screen-100" is :100, and so on.
 */

export const LOCAL_ID = 'local';
const SCRIPT = new URL('../box/hq-display.sh', import.meta.url).pathname;
const FIRST_EXTRA = 100;
const VNC_PASSWORD_FILE = '/root/goatbot/vnc/passwd.txt';

/** Where a screen's VNC server listens (see hq-display.sh). */
export const localVncPort = (screenId: string) => 5900 + displayNumber(screenId) - 99;

function displayNumber(screenId: string): number {
  if (!screenId || screenId === 'default') return 99;
  const n = Number(screenId.replace(/^screen-/, ''));
  if (!Number.isInteger(n) || n < FIRST_EXTRA) throw new Error(`not a screen of this computer: ${screenId}`);
  return n;
}

function run(file: string, args: string[], timeoutMs = 30_000, encoding: 'utf8' | 'buffer' = 'utf8', extraEnv: Record<string, string> = {}): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: encoding as any, env: { ...process.env, HOME: process.env.HOME ?? '/root', ...extraEnv } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file.split('/').pop()} ${args[0] ?? ''}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout as any);
    });
  });
}

const display = (cmd: string, n?: number) => run('bash', [SCRIPT, cmd, ...(n === undefined ? [] : [String(n)])]) as Promise<string>;

function size(): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(process.env.HQ_SCREEN_SIZE ?? '1280x800');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
}

function screenOf(n: number): OrgoScreen {
  return { id: n === 99 ? 'default' : `screen-${n}`, display: `:${n}`, ...size(), default: n === 99 };
}

async function upNumbers(): Promise<number[]> {
  const out = await display('list');
  return out.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
}

/** The subset of the Orgo client GoatBot uses, answered locally. */
export const localDesktop = {
  async getComputer(): Promise<OrgoComputer> {
    // The main screen comes up with the computer; bring it back if it went away.
    if (!(await upNumbers()).includes(99)) await display('start', 99);
    return { id: LOCAL_ID, status: 'running', name: 'This computer', resolution: `${size().width}x${size().height}`, asleep: null };
  },
  async start() { await display('start', 99); return {}; },
  async resume() { await display('start', 99); return {}; },
  async suspend() { return {}; },

  async vncPassword(): Promise<{ password: string; desktop_api_token: string }> {
    if (!fs.existsSync(VNC_PASSWORD_FILE)) await display('start', 99);
    return { password: fs.readFileSync(VNC_PASSWORD_FILE, 'utf8').trim(), desktop_api_token: '' };
  },

  async listScreens(): Promise<OrgoScreen[]> {
    return (await upNumbers()).map(screenOf);
  },
  async createScreen(): Promise<OrgoScreen> {
    const up = new Set(await upNumbers());
    let n = FIRST_EXTRA;
    while (up.has(n)) n++;
    await display('start', n);
    return screenOf(n);
  },
  async getScreen(_id: string, screen: string): Promise<OrgoScreen> {
    const n = displayNumber(screen);
    if (!(await upNumbers()).includes(n)) throw new Error(`screen ${screen} is not running`);
    return screenOf(n);
  },
  async deleteScreen(_id: string, screen: string): Promise<void> {
    const n = displayNumber(screen);
    if (n !== 99) await display('stop', n);
  },

  async screenshot(_id: string, screen?: string): Promise<{ image: string; mime_type: string; width: number; height: number }> {
    const n = displayNumber(screen ?? 'default');
    const jpg = (await run('import', ['-silent', '-window', 'root', '-quality', '75', 'jpeg:-'], 20_000, 'buffer', { DISPLAY: `:${n}` })) as Buffer;
    return { image: jpg.toString('base64'), mime_type: 'image/jpeg', ...size() };
  },

  async exportFile(): Promise<never> {
    // On this machine files are served straight from disk (box.local), so this is never needed.
    throw new Error('not available on a local computer');
  },
};
