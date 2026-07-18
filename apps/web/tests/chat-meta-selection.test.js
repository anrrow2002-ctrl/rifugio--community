const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const exportJs = fs.readFileSync(path.join(root, 'js/apps/18-talk-export.js'), 'utf8');
const streamJs = fs.readFileSync(path.join(root, 'js/apps/18-talk-stream.js'), 'utf8');
const cssPath = path.join(root, 'css/21-chat-meta-selection.css');
const css = fs.readFileSync(cssPath, 'utf8');
const mode = fs.statSync(cssPath).mode & 0o777;

assert.ok(mode & 0o004, 'nginx must be able to read the chat metadata stylesheet');
assert.match(
  style,
  /@import url\("\.\/21-chat-meta-selection\.css\?v=chat-meta-v1-20260715"\);/,
  'the production stylesheet must import chat metadata styling'
);
assert.match(
  html,
  /<div class="chat-meta">[\s\S]*?\{\{ m\.time \}\}/,
  'the Talk message template must render each stored timestamp'
);
assert.ok(
  (streamJs.match(/time:nowHM\(\)/g) || []).length >= 2,
  'new user and assistant messages must both receive timestamps'
);
assert.match(
  html,
  /class="talk-select-dot"[\s\S]*?talkSelectionActionLabel\(m\)/,
  'range controls must render their action labels'
);
assert.ok(exportJs.includes('\u8d77\u70b9') && exportJs.includes('\u5230\u8fd9'), 'selection logic must expose start and end labels');
assert.match(
  css,
  /\.talk-qq-shell:is\([^)]*theme-imessage[^)]*theme-wechat[^)]*theme-companion[^)]*\)[^{]*\.chat-meta\s*\{[\s\S]*?display:\s*block !important;/,
  'all visual chat themes must show timestamp metadata'
);
assert.match(
  css,
  /\.talk-select-dot\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?white-space:\s*nowrap;/,
  'range labels must have enough horizontal room'
);
assert.match(css, /\.talk-select-dot\.start[^\{]*\{[^}]*#0a84ff/i, 'start must use the blue state');
assert.match(css, /\.talk-select-dot\.end[^\{]*\{[^}]*#30b96b/i, 'end must use the green state');

console.log('chat metadata and selection regression checks passed');
