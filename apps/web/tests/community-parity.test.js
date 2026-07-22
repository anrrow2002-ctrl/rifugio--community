const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const lock = fs.readFileSync(path.join(root, 'js/04-lock-screen.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/05-vue-app.js'), 'utf8');
const toy = fs.readFileSync(path.join(root, 'js/apps/10-toy.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

assert.match(lock, /window\.fetch = async function guardedFetch/, 'protected requests need one authentication-aware fetch gate');
assert.ok(lock.includes('if (protectedRequest) await authReady;'), 'protected API calls must wait for login');
assert.match(lock, /unauthorized\|browser login required/, 'expired browser sessions must return to the lock screen');
assert.ok(!lock.includes('terminal verification required'), 'terminal step-up failures must not trigger the browser lock');
assert.ok(lock.includes("nativeFetch('/api/auth/logout'"), 'manual relock must invalidate the server cookie');

assert.ok(app.includes('const DEFAULT_DOCK_ICONS = {};'), 'community App launchers must default to emoji or characters');
assert.doesNotMatch(app, /https:\/\/i\.postimg\.cc\/[^'"\s]+\/IMG-299[12456]\.jpg/, 'legacy photo App-icon URLs must not ship as concrete links');
assert.equal(manifest.icons.length, 2, 'PWA install icons are separate and must remain available');

assert.match(index, />失控模式</, 'toy wild mode must be visible in the community UI');
assert.match(toy, /TOY_WILD_CHOICES/, 'toy wild duration choices must be wired');
assert.match(toy, /600,900,1200,1800/, 'toy wild choices must cover 10–30 minutes');
assert.match(toy, /状态暂时不可用（运行不受影响）/, 'status polling failures must not stop a bridge-local run');
assert.match(toy, /const stopToyWild = async/, 'wild mode needs an explicit stop action');

const memoria = fs.readFileSync(path.join(root, 'js/apps/15-memoria.js'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'js/apps/19-chat.js'), 'utf8');
assert.ok(memoria.includes("fetch('/api/settings/llm/test'"), 'memory model lookup must use the authenticated backend proxy');
assert.ok(!memoria.includes("fetch(memSettings.base_url"), 'memory model lookup must never expose the key to browser-side upstream fetch');
assert.ok(chat.includes("fetch('/api/talk-api/v1/chat/completions'"), 'legacy chat must use the backend provider proxy');
assert.ok(!chat.includes("fetch(\`\$\{base\}/chat/completions\`"), 'legacy chat must not call provider URLs from the browser');
assert.ok(!app.includes("port.id === 'cc' ||"), 'changing the CC seat to an external provider must not bypass the backend proxy');
assert.equal((app.match(/const isCc = \/\^\\\/api\\\/chatroom-cc/g) || []).length, 2, 'only the same-origin CC shim may use the direct seat path');

console.log('community parity checks passed');
