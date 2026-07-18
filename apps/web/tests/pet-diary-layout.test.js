const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const roomJs = fs.readFileSync(path.join(root, 'js/apps/21-room.js'), 'utf8');
const cssPath = path.join(root, 'css/19-pet-diary-layout.css');
const css = fs.readFileSync(cssPath, 'utf8');
const style = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const mode = fs.statSync(cssPath).mode & 0o777;

assert.ok(mode & 0o004, 'nginx must be able to read the pet diary stylesheet');
assert.match(html, /aria-label="\u6253\u5f00\u795e\u79d8\u80b2\u513f\u8bb0\u5f55\u672c"/, 'the closed diary must remain in the room after exit');
assert.match(
  html,
  /<header class="crab-diary-head">[\s\S]*?aria-label="\u5408\u4e0a\u8bb0\u5f55\u672c"/,
  'the diary exit control must remain inside the real diary header'
);
assert.match(
  roomJs,
  /const closePetDiary = \(\) => \{[\s\S]*?petUi\.diaryOpen = false;/,
  'exit must remove the full-screen diary and reveal the room again'
);
assert.match(
  css,
  /\.phone-room-app:has\(\.crab-diary-overlay\) > \.phone-app-topbar\s*\{[\s\S]*?display:\s*none !important;/,
  'the Room app header must not remain above the full-screen diary'
);
assert.match(
  css,
  /\.crab-diary-overlay\s*\{[\s\S]*?position:\s*absolute !important;[\s\S]*?inset:\s*0 !important;[\s\S]*?padding:\s*0 !important;/,
  'the diary overlay must fill the entire Room app viewport'
);
assert.match(
  css,
  /\.crab-diary-shell \.crab-diary-head\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?safe-area-inset-top/,
  'the diary header must stay fixed below the Dynamic Island'
);
assert.match(
  css,
  /\.crab-diary-shell\.view-cover \.crab-diary-head > button:last-child\s*\{[\s\S]*?order:\s*-1;[\s\S]*?border-radius:\s*15px !important;/,
  'the cover close action must become the left-side back control'
);
assert.match(
  css,
  /\.crab-diary-shell\.view-cover \.crab-diary-head > button:last-child::after\s*\{[\s\S]*?content:\s*"‹";/,
  'the cover back control must use the same quiet chevron language as the pages'
);
assert.match(
  css,
  /\.crab-diary-shell\.view-pages \.crab-diary-head > button:last-child\s*\{[\s\S]*?display:\s*none !important;/,
  'the pages view must not show a redundant exit control beside its back button'
);
assert.match(
  css,
  /\.crab-diary-shell\.view-pages \.crab-diary-pages\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/,
  'only the diary pages area should scroll'
);
assert.doesNotMatch(css, /crab-diary-header|crab-diary-close/, 'CSS must not target nonexistent diary classes');
assert.match(
  style,
  /@import url\("\.\/19-pet-diary-layout\.css\?v=pet-diary-v2-20260715"\);/,
  'the production stylesheet must load the diary layout guard'
);

console.log('pet diary full-screen regression checks passed');
