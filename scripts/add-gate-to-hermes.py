#!/usr/bin/env python3
"""Put GoatBot's approval gate on the main Hermes agent.

Extra bots get the gate automatically. The main agent is one GoatBot never reconfigures on its own,
so this script does it when you ask:
  - copies the hook script (server/box/goatbot-gate.py) into <hermes home>/agent-hooks/,
  - writes where it asks (goatbot-gate.json, read from the app's MCP entry for the main agent),
  - adds a `hooks: pre_tool_call:` entry to config.yaml (plain-text edit, dated backup kept),
  - adds the hook to shell-hooks-allowlist.json, because a gateway never prompts for consent.

Only calls made during a chat turn GoatBot started are gated; the agent's own channels (iMessage,
the CLI) keep Hermes' own approval rules.

Run on the computer, after add-hq-to-hermes.py:
    python3 add-gate-to-hermes.py [--home /root/.hermes] [--entry /opt/hq/data/hermes-mcp-hq.yaml]
                                  [--script /opt/hq/app/server/box/goatbot-gate.py] [--remove]
"""
import argparse, json, os, re, shutil, sys, time

MATCHER = '^(terminal|execute_code|browser_exec|browser_cdp|browser_vault|computer_use)$'  # same as server/src/gate-tools.ts

p = argparse.ArgumentParser()
p.add_argument('--home', default='/root/.hermes')
p.add_argument('--entry', default='/opt/hq/data/hermes-mcp-hq.yaml')
p.add_argument('--script', default='/opt/hq/app/server/box/goatbot-gate.py')
p.add_argument('--remove', action='store_true')
a = p.parse_args()
a.home = os.path.abspath(os.path.expanduser(a.home))

try:
    import yaml
except ImportError:
    sys.exit('PyYAML is needed; run this with the Python that Hermes uses.')

config = os.path.join(a.home, 'config.yaml')
hooks_dir = os.path.join(a.home, 'agent-hooks')
script = os.path.join(hooks_dir, 'goatbot-gate.py')
allow_file = os.path.join(a.home, 'shell-hooks-allowlist.json')

old = open(config, encoding='utf-8').read()
before = yaml.safe_load(old) or {}
lines = old.split('\n')

def ours(entry):
    return isinstance(entry, dict) and str(entry.get('command', '')).endswith('goatbot-gate.py')

block = [
    f'    - matcher: "{MATCHER}"',
    f'      command: "{script}"',
    '      timeout: 300',
    '      fail_closed: true',
]

hooks = before.get('hooks')
manual = False
if a.remove:
    if not (isinstance(hooks, dict) and any(ours(h) for h in hooks.get('pre_tool_call') or [])):
        print('nothing to change'); sys.exit(0)
    # Drop our list item: from its "- matcher" line through the lines indented under it.
    out, skip = [], False
    for l in lines:
        if skip and (re.match(r'^      \S', l) or not l.strip()):
            continue
        skip = False
        if l.startswith('    - matcher:') and MATCHER in l:
            skip = True
            continue
        out.append(l)
    # An empty pre_tool_call (and then an empty hooks) left behind goes too.
    def drop_empty(lines, header, indent):
        res = []
        for i, l in enumerate(lines):
            if l.rstrip() == header:
                rest = [x for x in lines[i + 1:] if x.strip()]
                if not rest or not rest[0].startswith(' ' * indent):
                    continue
            res.append(l)
        return res
    out = drop_empty(out, '  pre_tool_call:', 4)
    out = drop_empty(out, 'hooks:', 2)
    while len(out) > 1 and not out[-1].strip() and not out[-2].strip():
        out.pop()
    new = '\n'.join(out)
else:
    if hooks is not None and not isinstance(hooks, dict):
        sys.exit('hooks: is written in a form this script does not edit; add the entry by hand.')
    if isinstance(hooks, dict) and any(ours(h) for h in hooks.get('pre_tool_call') or []):
        print('the gate is already in config.yaml')
        new = old
    elif hooks is None:
        if lines and lines[-1].strip():
            lines.append('')
        lines += ['hooks:', '  pre_tool_call:'] + block + ['']
        new = '\n'.join(lines)
    else:
        # Merging into someone's own hooks by text is too easy to get wrong: set up the rest, print the entry.
        manual = True
        new = old

if new != old:
    after = yaml.safe_load(new) or {}
    rest = lambda d: {k: v for k, v in d.items() if k != 'hooks'}
    b_hooks = {k: v for k, v in (before.get('hooks') or {}).items() if k != 'pre_tool_call'}
    a_hooks = {k: v for k, v in (after.get('hooks') or {}).items() if k != 'pre_tool_call'}
    b_pre = [h for h in (before.get('hooks') or {}).get('pre_tool_call') or [] if not ours(h)]
    a_pre = [h for h in (after.get('hooks') or {}).get('pre_tool_call') or [] if not ours(h)]
    if rest(before) != rest(after) or b_hooks != a_hooks or b_pre != a_pre:
        sys.exit('refusing: the edit would change other settings')
    has = any(ours(h) for h in (after.get('hooks') or {}).get('pre_tool_call') or [])
    if has == a.remove:
        sys.exit('refusing: the gate entry did not read back correctly')
    backup = f"{config}.before-gate-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(config, backup)
    tmp = config + '.gate-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(new)
    shutil.copymode(config, tmp)
    st = os.stat(config); os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, config)
    print(('removed the gate from' if a.remove else 'added the gate to') + f' config.yaml; previous file kept as {backup}')

# The consent entry and the files the hook needs.
try:
    allow = json.load(open(allow_file, encoding='utf-8'))
except Exception:
    allow = {}
approvals = [x for x in allow.get('approvals') or [] if not (x.get('event') == 'pre_tool_call' and x.get('command') == script)]
if not a.remove:
    approvals.append({'event': 'pre_tool_call', 'command': script})
    entry = yaml.safe_load(open(a.entry, encoding='utf-8')) or {}
    hq = entry.get('hq') or entry
    url = re.sub(r'/mcp/primary$', '/gate/primary', str(hq.get('url', '')))
    token = str((hq.get('headers') or {}).get('Authorization', '')).replace('Bearer ', '').strip()
    if not url.endswith('/gate/primary') or not token:
        sys.exit(f'could not read the app URL and token from {a.entry}')
    os.makedirs(hooks_dir, exist_ok=True)
    shutil.copyfile(a.script, script)
    os.chmod(script, 0o755)
    cfg_path = os.path.join(hooks_dir, 'goatbot-gate.json')
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump({'url': url, 'token': token}, f)
    os.chmod(cfg_path, 0o600)
else:
    for f in (script, os.path.join(hooks_dir, 'goatbot-gate.json')):
        if os.path.exists(f):
            os.remove(f)
allow['approvals'] = approvals
with open(allow_file, 'w', encoding='utf-8') as f:
    json.dump(allow, f, indent=2)
os.chmod(allow_file, 0o600)
if manual:
    print('config.yaml already has a hooks: section, so it was left alone. The hook script and its consent entry are in place;')
    print('add this under hooks: -> pre_tool_call: yourself:\n\n' + '\n'.join(block) + '\n')
print('done. Hermes picks up the change within about 30 seconds, no restart needed.')
