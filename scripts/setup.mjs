import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const envExample = path.join(root, '.env.example');
const privateDir = path.join(root, 'private');
const dataDir = path.join(root, 'data');

fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(envFile)) fs.copyFileSync(envExample, envFile);
if (!fs.existsSync(path.join(privateDir, 'profile.json'))) {
  fs.copyFileSync(path.join(root, 'config/profile.example.json'), path.join(privateDir, 'profile.json'));
}
if (!fs.existsSync(path.join(privateDir, 'features.json'))) {
  fs.copyFileSync(path.join(root, 'config/features.example.json'), path.join(privateDir, 'features.json'));
}
if (!fs.existsSync(path.join(privateDir, 'persona.md'))) {
  fs.copyFileSync(path.join(root, 'config/persona.example.md'), path.join(privateDir, 'persona.md'));
}

const password = process.env.RIFUGIO_SETUP_PASSWORD || crypto.randomBytes(15).toString('base64url');
const salt = crypto.randomBytes(16);
const N = 16384, r = 8, p = 1, keylen = 64;
const hash = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 });
const values = {
  RIFUGIO_UID: typeof process.getuid === 'function' ? String(process.getuid()) : '1000',
  RIFUGIO_GID: typeof process.getgid === 'function' ? String(process.getgid()) : '1000',
  AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
  AUTH_PASSWORD_HASH: ['scrypt', N, r, p, keylen, salt.toString('base64'), hash.toString('base64')].join('$'),
  RIFUGIO_SECRET: crypto.randomBytes(32).toString('hex'),
  RIFUGIO_MCP_TOKEN: crypto.randomBytes(32).toString('hex'),
  CHAT_TOKEN: crypto.randomBytes(32).toString('hex'),
};

let text = fs.readFileSync(envFile, 'utf8');
for (const [key, value] of Object.entries(values)) {
  const line = key + "='" + value + "'";
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  text = pattern.test(text) ? text.replace(pattern, line) : text.replace(/\s*$/, '\n' + line + '\n');
}
fs.writeFileSync(envFile, text, { mode: 0o600 });
try { fs.chmodSync(envFile, 0o600); } catch {}

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  ✅ Setup complete!                                         ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
if (!process.env.RIFUGIO_SETUP_PASSWORD) {
  console.log('║  🔑 Your login password (shown ONCE, write it down!):      ║');
  console.log('║     ' + password.padEnd(55) + '║');
} else {
  console.log('║  🔑 Login password: set from RIFUGIO_SETUP_PASSWORD        ║');
  console.log('║     (the value you passed in the command)                  ║');
}
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  📝 This password is for the WEBSITE lock screen.           ║');
console.log('║     You will type it in the BROWSER, not in Termux.         ║');
console.log('║     If you lose it, run: bash scripts/set-auth-password.sh  ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║  MCP Token: see .env → RIFUGIO_MCP_TOKEN                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('Next steps:');
console.log('  1. (Optional) Edit private/profile.json with your names');
console.log('  2. Copy .env to API:  cp .env apps/api/.env');
console.log('  3. Install deps:      npm --prefix apps/api ci --omit=dev --omit=optional');
console.log('  4. Start the server — see docs/TERMUX-保姆级教程.md');
