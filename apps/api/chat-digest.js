#!/usr/bin/env node
// chat-digest.js — 每日自动把 rifugio 聊天室新增对话喂进 /api/buckets/import 提取记忆。
// 只取 user/assistant 的 content 文本；attachments/thinking/toolUses/资料粘贴一律不进提取。
// 水位线存 chat_digest_state（rifugio-chat.db），只消化上次之后的新消息。
// 用法: node chat-digest.js [--dry-run] [--convo <id>] [--force]
//   --force 忽略 6 小时冷却（对话最后一条消息距今 <6h 时默认跳过，避免消化聊到一半的）

const fs = require('fs');
const path = require('path');
const Database = require('./modules/sqlite');
const crypto = require('crypto');

const CHAT_DB = process.env.RIFUGIO_CHAT_DB || require('./modules/community-config').dataPath('rifugio-chat.db');
const API_BASE = process.env.RIFUGIO_API_BASE || 'http://127.0.0.1:3457';
const COOLDOWN_MS = 3 * 3600 * 1000; // 常驻对话(老公)天天有新消息，3h 够判定"这一晚聊完了"
const MIN_NEW_MSGS = 4;          // 绝对下限，少于这个不跑
const BATCH_THRESHOLD = 150;     // 攒批：够 150 条新消息才消化（对齐 claude.ai 600-800/窗的稀疏节奏）
const MAX_WAIT_DAYS = 7;         // 但最老的未消化消息放满 7 天就不再等，避免小对话永远轮空
const MAX_TURNS_PER_RUN = 400;   // 单对话单次上限，历史大对话分多天消化
const MAX_CONTENT_CHARS = 3000;  // 超长消息（粘贴的资料/代码）截断

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const onlyConvo = (() => { const i = process.argv.indexOf('--convo'); return i > -1 ? process.argv[i + 1] : null; })();

function readAuthSecret() {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const m = env.match(/^AUTH_SECRET=(.+)$/m);
  if (!m) throw new Error('AUTH_SECRET not found in api/.env');
  return m[1].trim();
}

function signCookie(secret) {
  const exp = Date.now() + 10 * 60 * 1000; // 10 分钟够用
  const sig = crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
  return `refuge_auth=${encodeURIComponent(`${exp}.${sig}`)}`;
}

function cleanContent(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  // 图片/文件的 base64 内联直接剥掉
  text = text.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]{100,}/g, '[附件已略]');
  if (text.length > MAX_CONTENT_CHARS) {
    text = text.slice(0, MAX_CONTENT_CHARS) + '\n[超长内容截断——多为粘贴的资料，不属于对话]';
  }
  return text;
}

function msgDate(m) {
  // 消息 id 是毫秒时间戳
  const t = Number(m.id);
  if (!Number.isFinite(t) || t < 1e12) return null;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function main() {
  const cookie = signCookie(readAuthSecret());
  const db = new Database(CHAT_DB);
  db.exec(`CREATE TABLE IF NOT EXISTS chat_digest_state (
    convo_id TEXT PRIMARY KEY,
    last_msg_id INTEGER NOT NULL DEFAULT 0,
    digested_at TEXT
  )`);

  const convos = db.prepare('SELECT id, name, messages, updated_at FROM chat_convos').all()
    .filter(c => !onlyConvo || c.id === onlyConvo);
  const getWm = db.prepare('SELECT last_msg_id FROM chat_digest_state WHERE convo_id=?');
  const setWm = db.prepare(`INSERT INTO chat_digest_state (convo_id, last_msg_id, digested_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(convo_id) DO UPDATE SET last_msg_id=excluded.last_msg_id, digested_at=excluded.digested_at`);

  let totalCreated = 0;
  for (const convo of convos) {
    let msgs;
    try { msgs = JSON.parse(convo.messages); } catch { continue; }
    if (!Array.isArray(msgs) || !msgs.length) continue;

    // 冷却窗只留住最近 3h 的尾巴，更早的照常消化——整段跳过曾让 4 点的班天天撞上夜聊、连续空转
    const cutoff = FORCE ? Infinity : Date.now() - COOLDOWN_MS;

    const wm = getWm.get(convo.id)?.last_msg_id || 0;
    const fresh = msgs.filter(m =>
      (m.role === 'user' || m.role === 'assistant') &&
      Number(m.id) > wm &&
      Number(m.id) <= cutoff &&
      cleanContent(m.content)
    ).slice(0, MAX_TURNS_PER_RUN);

    if (!fresh.length && msgs.some(m => Number(m.id) > wm && Number(m.id) > cutoff)) {
      console.log(`[skip] ${convo.name}: 新消息都在 3h 冷却窗内，下次再收`);
      continue;
    }
    if (fresh.length < MIN_NEW_MSGS) {
      if (fresh.length) console.log(`[skip] ${convo.name}: 新消息仅 ${fresh.length} 条，攒着下次`);
      continue;
    }
    const oldestFreshTs = Number(fresh[0]?.id) || 0;
    const agedOut = Date.now() - oldestFreshTs > MAX_WAIT_DAYS * 86400 * 1000;
    if (fresh.length < BATCH_THRESHOLD && !agedOut && !FORCE) {
      console.log(`[skip] ${convo.name}: 攒到 ${fresh.length}/${BATCH_THRESHOLD} 条，继续攒`);
      continue;
    }

    const turns = fresh.map(m => ({
      role: m.role,
      content: cleanContent(m.content),
      time: msgDate(m) || undefined,
    }));
    const maxId = Math.max(...fresh.map(m => Number(m.id)));
    const firstDay = (msgDate(fresh[0]) || '').split(' ')[0] || new Date().toLocaleDateString('en-US');

    console.log(`[digest] ${convo.name} (${convo.id}): ${turns.length} 条新消息 (${firstDay} 起)${DRY_RUN ? ' [dry-run]' : ''}`);

    const resp = await fetch(`${API_BASE}/api/buckets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        content: JSON.stringify(turns),
        filename: `rifugio-chat-${convo.id}.json`,
        format: 'json',
        personas: { user: '用户', ai: '伴侣' },
        dry_run: DRY_RUN,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
      console.error(`[fail] ${convo.name}: ${data.error || resp.status}`);
      continue; // 水位线不动，下次重试
    }
    const n = DRY_RUN ? (data.count ?? 0) : (data.created ?? 0);
    if (DRY_RUN) (data.buckets || []).forEach(b => console.log(`   · ${b.name} (imp ${b.importance})`));
    totalCreated += n;
    console.log(`[ok] ${convo.name}: ${DRY_RUN ? '候选' : '入库'} ${n} 条记忆${(data.errors || []).length ? '，错误: ' + data.errors.join('; ') : ''}`);
    if (!DRY_RUN) {
      if ((data.errors || []).length) {
        console.log(`[hold] ${convo.name}: 有 chunk 失败，游标不动，下次整批重试`);
      } else {
        setWm.run(convo.id, maxId);
      }
    }
  }
  db.close();
  console.log(`[done] 共${DRY_RUN ? '预览' : '入库'} ${totalCreated} 条记忆`);
}

main().catch(e => { console.error('[chat-digest] fatal:', e.message); process.exit(1); });
