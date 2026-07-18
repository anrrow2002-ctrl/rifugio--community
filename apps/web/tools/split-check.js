#!/usr/bin/env node
// 拆分护栏：提取每个 js/apps/*.js 模块 return{} 的导出名，和基线对比。
// 用法：
//   node tools/split-check.js baseline   # 拆之前跑一次，存 tools/split-baseline.json
//   node tools/split-check.js verify     # 每拆完一步跑，缺一个名字就报错退出 1
// 原理：拆分只许搬家不许改名，所以所有 use* 模块 return 的名字取并集，
//       必须完整覆盖基线（多出来的新名字没关系）。
const fs = require('fs');
const path = require('path');

const APPS_DIR = path.join(__dirname, '..', 'js', 'apps');
const BASELINE = path.join(__dirname, 'split-baseline.json');

function extractReturnNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  // 找所有 "return {" 且缩进 <= 8 的模块级 return（函数内部深层 return 缩进更深，粗滤即可）
  // 更稳的办法：找 window.Rifugio.useXxx 函数体里最后一个 return { ... };
  const re = /return\s*\{([\s\S]*?)\};\s*\}\s*;?\s*(?:\/\/.*)?\s*$/m;
  // 逐个 use 函数分段
  const parts = src.split(/window\.Rifugio\.use/);
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    // 段内最后一个 return { ... }
    const idx = seg.lastIndexOf('return {');
    if (idx < 0) continue;
    const tail = seg.slice(idx + 'return {'.length);
    const end = tail.indexOf('};');
    if (end < 0) continue;
    const body = tail.slice(0, end);
    for (const tok of body.split(',')) {
      const name = tok.split(':')[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function collectAll() {
  const all = new Set();
  const perFile = {};
  for (const f of fs.readdirSync(APPS_DIR)) {
    if (!f.endsWith('.js')) continue;
    const names = extractReturnNames(path.join(APPS_DIR, f));
    perFile[f] = [...names].sort();
    names.forEach(n => all.add(n));
  }
  return { all, perFile };
}

const mode = process.argv[2];
if (mode === 'baseline') {
  const { all, perFile } = collectAll();
  fs.writeFileSync(BASELINE, JSON.stringify({ created: new Date().toISOString(), total: all.size, names: [...all].sort(), perFile }, null, 2));
  console.log(`baseline saved: ${all.size} exported names`);
} else if (mode === 'verify') {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const { all } = collectAll();
  const missing = base.names.filter(n => !all.has(n));
  if (missing.length) {
    console.error(`❌ 拆丢了 ${missing.length} 个导出：\n  ` + missing.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ 基线 ${base.names.length} 个导出全部还在（当前共 ${all.size}）`);
} else {
  console.log('usage: node tools/split-check.js baseline|verify');
  process.exit(2);
}
