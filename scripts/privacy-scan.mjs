#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(thisFile), '..');
const ignoredDirs = new Set(['.git', 'node_modules', 'data', 'private', 'dist', 'build', 'coverage', 'vendor', '__pycache__']);
const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.pyc']);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const privateTermsFile = path.join(root, 'private', 'privacy-terms.txt');
const privateTerms = (() => {
  try {
    return fs.readFileSync(privateTermsFile, 'utf8')
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(value => value && !value.startsWith('#'));
  } catch {
    return [];
  }
})();

const forbidden = [
  ...privateTerms.map(term => ({ label: 'configured private term', re: new RegExp(escapeRegExp(term), 'gi') })),
  { label: 'private server path', re: /\/root\/[A-Za-z0-9._/-]+/g },
  { label: 'likely API secret', re: /\b(?:sk|nvapi|xai)-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: 'credential in URL', re: /https?:\/\/[^\s/@:]+:[^\s/@]+@/g },
];

const findings = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (file === thisFile) continue;
    if (entry.isDirectory()) { walk(file); continue; }
    if (binaryExts.has(path.extname(entry.name).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const rule of forbidden) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(text))) {
        findings.push({
          file: path.relative(root, file),
          line: text.slice(0, match.index).split('\n').length,
          label: rule.label,
          sample: match[0],
        });
        if (!match[0].length) rule.re.lastIndex += 1;
      }
    }
  }
}
walk(root);
if (findings.length) {
  console.error('Privacy scan failed:');
  for (const item of findings) {
    console.error(`- ${item.file}:${item.line} [${item.label}] ${JSON.stringify(item.sample)}`);
  }
  process.exit(1);
}
console.log(`Privacy scan passed (${privateTerms.length} configured private terms).`);
