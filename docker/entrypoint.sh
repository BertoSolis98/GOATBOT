#!/usr/bin/env bash
# Container start: settle the secrets, point the first bot's Hermes at the app, start the main
# screen, then hand over to supervisord (Hermes and the GoatBot server, see supervisord.conf).
set -euo pipefail

G=/root/goatbot
H=/root/.hermes
mkdir -p "$G/data" "$G/engines" "$G/files" "$G/logs" "$H"
umask 077

# 1. The app's session secret: from the env file, else made once and kept in the volume.
if [ -z "${SESSION_SECRET:-}" ] || [ "$SESSION_SECRET" = "change-me-to-a-long-random-string" ]; then
  [ -s "$G/session-secret" ] || openssl rand -hex 32 > "$G/session-secret"
  SESSION_SECRET="$(cat "$G/session-secret")"
fi
printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET" > "$G/runtime.env"

# 2. The first bot is the Hermes agent in this container. Turn on its API server (local only).
touch "$H/.env"
setvar() {
  if grep -q "^$1=" "$H/.env"; then sed -i "s|^$1=.*|$1=$2|" "$H/.env"; else printf '%s=%s\n' "$1" "$2" >> "$H/.env"; fi
}
key="$(grep -E '^API_SERVER_KEY=' "$H/.env" | tail -1 | cut -d= -f2- || true)"
[ -n "$key" ] || key="$(openssl rand -hex 24)"
setvar API_SERVER_ENABLED true
setvar API_SERVER_KEY "$key"
setvar API_SERVER_HOST 127.0.0.1
setvar API_SERVER_PORT 8642
# Model keys from the env file go to the agent (extra bots copy them from here).
for k in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY NOUS_API_KEY; do
  v="${!k:-}"
  if [ -n "$v" ]; then setvar "$k" "$v"; fi
done

# 3. Give it the app's tools (MCP) and the approval gate. Both scripts change nothing if already done.
[ -f "$H/config.yaml" ] || printf '# Hermes settings\n' > "$H/config.yaml"
tok="$(printf 'mcp:primary' | openssl dgst -sha256 -hmac "$SESSION_SECRET" -r | cut -d' ' -f1)"
cat > "$G/hermes-mcp-hq.yaml" <<EOF
# The app's MCP server for the first bot (written by docker/entrypoint.sh on every start).
  hq:
    url: http://127.0.0.1:8787/mcp/primary
    headers:
      Authorization: Bearer $tok
    timeout: 1800
    connect_timeout: 30
EOF
python3 /opt/goatbot/scripts/add-hq-to-hermes.py --config "$H/config.yaml" --entry "$G/hermes-mcp-hq.yaml"
python3 /opt/goatbot/scripts/add-gate-to-hermes.py --home "$H" --entry "$G/hermes-mcp-hq.yaml" --script /opt/goatbot/server/box/goatbot-gate.py

# 4. The main screen (display :99). Extra bots' screens are started by the app when needed.
umask 022
bash /opt/goatbot/server/box/hq-display.sh start 99

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
