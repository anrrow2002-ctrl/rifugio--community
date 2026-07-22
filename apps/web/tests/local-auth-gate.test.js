const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const lock = fs.readFileSync(path.join(root, 'js/04-lock-screen.js'), 'utf8');
const talk = fs.readFileSync(path.join(root, 'js/apps/18-talk.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('Termux localhost and 127.0.0.1 require a real server login', () => {
  const match = lock.match(/const isLocalPreview = ([^;]+);/);
  assert.ok(match, 'local preview expression missing');
  const evaluate = new Function('window', 'return (' + match[1] + ');');
  assert.equal(evaluate({ location:{ protocol:'http:', hostname:'127.0.0.1' } }), false);
  assert.equal(evaluate({ location:{ protocol:'http:', hostname:'localhost' } }), false);
  assert.equal(evaluate({ location:{ protocol:'https:', hostname:'example.com' } }), false);
  assert.equal(evaluate({ location:{ protocol:'file:', hostname:'' } }), true);
  assert.match(html, /04-lock-screen\.js\?v=termux-local-auth-20260722/, 'auth fix needs a fresh cachebuster');
});

test('model pull explains missing configuration before making an API request', () => {
  const baseGuard = talk.indexOf("talkSettings[statusKey] = '请先填写 Base URL'");
  const keyGuard = talk.indexOf("talkSettings[statusKey] = '请先填写 API Key'");
  const request = talk.indexOf("fetch('/api/integrations/models'");
  assert.ok(baseGuard > 0 && keyGuard > baseGuard && request > keyGuard);
  assert.match(talk, /throw new Error\(data\.error \|\| \('HTTP ' \+ res\.status\)\)/, 'backend error text must reach the UI');
});
