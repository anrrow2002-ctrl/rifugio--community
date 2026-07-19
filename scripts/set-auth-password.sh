#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-$(dirname "$0")/../.env}"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

read -r -s -p "New Rifugio access password (16+ chars recommended): " p1
printf '\n'
read -r -s -p "Repeat password: " p2
printf '\n'

if [ "$p1" != "$p2" ]; then
  echo "Passwords do not match." >&2
  exit 1
fi
if [ "${#p1}" -lt 12 ]; then
  echo "Password is too short. Use at least 12 characters; 16+ is recommended." >&2
  exit 1
fi

hash="$(
  PASSWORD="$p1" node <<'NODE'
const crypto = require('crypto');
const password = process.env.PASSWORD || '';
const N = 32768, r = 8, p = 1, keylen = 64;
const salt = crypto.randomBytes(24);
const dk = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 });
console.log(`scrypt$${N}$${r}$${p}$${keylen}$${salt.toString('base64')}$${dk.toString('base64')}`);
NODE
)"

node - "$ENV_FILE" "$hash" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const envFile = process.argv[2];
const hash = process.argv[3];
const raw = fs.readFileSync(envFile, 'utf8');
let lines = raw.split(/\r?\n/);
const lastAuthSecret = lines
  .filter(line => /^AUTH_SECRET=/.test(line))
  .map(line => line.slice('AUTH_SECRET='.length))
  .filter(Boolean)
  .pop();
const authSecret = lastAuthSecret || crypto.randomBytes(32).toString('hex');

lines = lines.filter(line => !/^(AUTH_SECRET|AUTH_PASSWORD_HASH|AUTH_PIN_HASH|AUTH_LEGACY_SHA256_HASH|AUTH_TTL_HOURS|AUTH_LOGIN_MAX_FAILS|AUTH_LOGIN_WINDOW_SEC|AUTH_LOGIN_LOCK_SEC)=/.test(line));
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
lines.push(
  '',
  '# Rifugio auth hardening',
  `AUTH_SECRET=${authSecret}`,
  `AUTH_PASSWORD_HASH=${hash}`,
  'AUTH_TTL_HOURS=168',
  'AUTH_LOGIN_MAX_FAILS=5',
  'AUTH_LOGIN_WINDOW_SEC=900',
  'AUTH_LOGIN_LOCK_SEC=900',
);
fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
NODE

unset p1 p2
echo "AUTH_PASSWORD_HASH updated in $ENV_FILE"

# auto-generate AUTH_SECRET if missing
if ! grep -q '^AUTH_SECRET=.\+' "$ENV_FILE"; then
  secret="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  if grep -q '^AUTH_SECRET=' "$ENV_FILE"; then
    sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=${secret}|" "$ENV_FILE"
  else
    echo "AUTH_SECRET=${secret}" >> "$ENV_FILE"
  fi
  echo "AUTH_SECRET generated."
fi
