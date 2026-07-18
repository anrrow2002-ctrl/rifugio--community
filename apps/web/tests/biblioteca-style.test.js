const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const cssPath = path.join(root, 'css/20-biblioteca.css');
const css = fs.readFileSync(cssPath, 'utf8');
const mode = fs.statSync(cssPath).mode & 0o777;

assert.ok(mode & 0o004, 'nginx must be able to read the standalone biblioteca stylesheet');
assert.match(
  style,
  /@import url\("\.\/20-biblioteca\.css\?v=biblioteca-v1-20260715"\);/,
  'the production stylesheet must import biblioteca styling'
);

for (const className of [
  'biblio-app-shell',
  'biblio-shelf',
  'biblio-book-card',
  'biblio-reader-shell',
  'biblio-reader-scroll',
  'biblio-page',
]) {
  assert.match(html, new RegExp('class="[^"]*' + className), 'markup is missing .' + className);
  assert.match(css, new RegExp('\\.' + className + '(?:[\\s.{:#>]|$)'), 'CSS is missing .' + className);
}

assert.match(
  css,
  /\.biblio-app-shell\s*\{[\s\S]*?display:\s*flex;[\s\S]*?background:/,
  'the bookshelf shell needs its designed layout and paper background'
);
assert.match(
  css,
  /\.biblio-reader-scroll\s*\{[\s\S]*?overflow-y:\s*auto;/,
  'the reader body must remain independently scrollable'
);
assert.match(
  css,
  /\.phone-biblio-app > \.phone-app-topbar\s*\{[\s\S]*?display:\s*none !important;/,
  'biblioteca must hide the duplicate generic app header'
);
assert.match(
  css,
  /\.phone-biblio-app \.biblio-shelf\s*\{[\s\S]*?safe-area-inset-top/,
  'the remaining shelf header must protect the Dynamic Island safe area'
);
assert.match(
  css,
  /\.phone-biblio-app \.biblio-reader-head\s*\{[\s\S]*?safe-area-inset-top/,
  'the reader header must protect the Dynamic Island safe area too'
);

console.log('biblioteca style regression checks passed');
