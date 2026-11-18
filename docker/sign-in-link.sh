#!/usr/bin/env bash
# Print a link that signs one browser in to GoatBot, once, within 15 minutes.
#   docker compose exec goatbot goatbot-sign-in you@example.com
# The address must be in ALLOWED_EMAILS (or already have an account).
set -euo pipefail
email="${1:?usage: goatbot-sign-in <email>}"
secret="$(grep -E '^SESSION_SECRET=' /root/goatbot/runtime.env | cut -d= -f2-)"
key="$(printf 'owner-login' | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)"
curl -fsS -X POST "http://127.0.0.1:8787/api/auth/owner" \
  -H "authorization: Bearer $key" -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"link\":true}" | sed -E 's/.*"url":"([^"]+)".*/\1/'
echo
