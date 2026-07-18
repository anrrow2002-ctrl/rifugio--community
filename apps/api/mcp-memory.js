#!/usr/bin/env node
// ============================================================
// mcp-memory.js — Rifugio stdio MCP server
// ============================================================
const Database = require('better-sqlite3');
const DB_PATH = process.env.RIFUGIO_DB || require('./modules/community-config').dataPath('rifugio-memory.db');

const { initBuckets, calcScore, insertBucket, parseBucket, statusToPatch } = require('./buckets');
const { initEmbedding, semanticSearch, keywordSearch } = require('./embedding');

initBuckets(DB_PATH);
initEmbedding(DB_PATH);

const TOOL_BREATH = {
  name: 'breath',
  description: '读取 Rifugio 记忆。无 query 时普通浮现 active 记忆；有 query 时语义检索；domain="feel" 时读取独立 feel 通道。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言检索词，可选' },
      q: { type: 'string', description: 'query 的别名' },
      domain: { type: 'string', description: '传 feel 可读取沉淀感受通道' },
      limit: { type: 'integer', description: '返回条数，默认 8，最多 20' },
      include_quiet: { type: 'boolean', description: '普通 breath 是否包含已沉底记忆' },
      include_digested: { type: 'boolean', description: '普通 breath 是否包含已消化记忆' },
    },
    required: [],
  },
};

const TOOL_SEARCH = {
  name: 'search_memory',
  description: '语义检索普通记忆，默认不返回 feel。embedding 失败时自动降级关键词搜索。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要回忆的内容' },
      limit: { type: 'integer', description: '返回条数，默认 6，最多 20' },
      include_quiet: { type: 'boolean' },
      include_digested: { type: 'boolean' },
    },
    required: ['query'],
  },
};

const TOOL_HOLD = {
  name: 'hold',
  description: '写入一条记忆；传 feel=true 时写入独立 feel 通道。只有确有长期相处理解/关系推进/重要领悟时，才写 feel 并传 source_bucket 或 source_ids。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      content: { type: 'string' },
      feel: { type: 'boolean' },
      source_bucket: { type: 'string', description: 'feel 来源 bucket id，可选' },
      source_ids: { type: 'array', items: { type: 'string' }, description: 'feel 来源 bucket id 列表，可选' },
      domain: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'integer' },
      valence: { type: 'number' },
      arousal: { type: 'number' },
      occurred_at: { type: 'string' },
    },
    required: ['content'],
  },
};

const TOOL_PLAN = {
  name: 'plan',
  description: '计划/欠账台账（piani表）。不传参=列出全部未完成计划；传content=登记新计划；传id+done=true 打勾闭环；传id+notes=补充备注。计划不衰减不浮现，用户立flag或Companion答应事情时登记，兑现时打勾。',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '新计划标题（登记用）' },
      notes: { type: 'string', description: '备注/细节' },
      id: { type: 'integer', description: '计划id（打勾或补注用）' },
      done: { type: 'boolean', description: 'true=标记完成' },
      status: { type: 'string', description: '自定义状态: pending/scheduled/frozen/waiting/done' },
      all: { type: 'boolean', description: 'true=连完成的也列出来' },
    },
    required: [],
  },
};

const TOOL_DREAM = {
  name: 'dream',
  description: '按 Ombre-Brain 风格读取最近 active 普通记忆，返回给当前 AI 做第一人称自省；工具本身不调 LLM、不自动写 feel、不自动沉底。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '返回最近多少条普通记忆，默认 10，最多 20' },
      dry_run: { type: 'boolean' },
    },
    required: [],
  },
};

const TOOL_DREAM_SEEN = {
  name: 'dream_seen',
  description: '标记 Dream 看过但不写 feel 的普通记忆；不沉底、不消化，仍保持 active，只是不再进入默认 dream 候选。不传 id/ids 时＝批量收尾：把本轮 dream 展示过、未写成 feel 的全部一次性打标（写过 feel 的自动跳过），省额度。也可传单个 id 或 ids 列表精确打标。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '可选。单条已看过的普通 bucket id' },
      ids: { type: 'array', items: { type: 'string' }, description: '可选。要打标的一批 bucket id' },
      reason: { type: 'string', description: '为什么不需要沉淀 feel，可选' },
    },
    required: [],
  },
};

const TOOL_STATE = {
  name: 'trace',
  description: '更新记忆状态。status 可为 active/quiet/digested。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['active', 'quiet', 'digested'] },
    },
    required: ['id', 'status'],
  },
};

const TOOL_QUIET = {
  name: 'quiet',
  description: '将一条普通记忆标记为已沉底：不再主动普通浮现，但搜索仍可找到。',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
};

const TOOL_DIGEST = {
  name: 'digest',
  description: '将一条普通记忆标记为已消化：降低普通权重，不参与默认 dream/breath。',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function tryParse(str, fallback) {
  if (Array.isArray(str)) return str;
  try { return JSON.parse(str || ''); } catch(e) { return fallback; }
}

function normalizeIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(/[,\s]+/).map(v => v.trim()).filter(Boolean);
}

function formatBucket(r, i) {
  const body = (r.content || '').split('\n---RIFUGIO---')[0].trim();
  const tags = Array.isArray(r.tags) ? r.tags : tryParse(r.tags, []);
  const status = r.status || (r.bucket_type === 'feel' ? 'feel' : (r.digested ? 'digested' : (r.resolved ? 'quiet' : 'active')));
  const score = r.similarity !== undefined ? `相关度=${r.similarity}` : `权重=${r.score ?? r._score ?? ''}`;
  return `${i + 1}. 【${r.name}】${status ? `(${status})` : ''} ${score}${tags.length ? ' [' + tags.join(' ') + ']' : ''}\n${body}`;
}

function ordinaryWhere(opts = {}) {
  const conds = ["bucket_type NOT IN ('archive','feel')"];
  if (!opts.include_quiet) conds.push('COALESCE(resolved,0)=0');
  if (!opts.include_digested) conds.push('COALESCE(digested,0)=0');
  return conds.join(' AND ');
}

async function readFeel(args) {
  const limit = Math.min(Math.max(parseInt(args.limit) || 8, 1), 20);
  const query = String(args.query || args.q || '').trim();
  if (query) {
    try {
      const rows = await semanticSearch(query, limit, { domain: 'feel', include_feel: true });
      if (rows.length) return rows;
      throw new Error('no feel vector match');
    } catch(e) {
      return keywordSearch(query, limit, { domain: 'feel', include_feel: true });
    }
  }
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT * FROM buckets
      WHERE bucket_type='feel'
      ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
      LIMIT ?
    `).all(limit);
    return rows.map(parseBucket);
  } finally {
    db.close();
  }
}

function surfaceOrdinary(args) {
  const db = new Database(DB_PATH);
  try {
    const limit = Math.min(Math.max(parseInt(args.limit) || 8, 1), 20);
    const rows = db.prepare(`
      SELECT * FROM buckets
      WHERE ${ordinaryWhere(args)}
      ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
      LIMIT 80
    `).all().map(parseBucket).map(b => ({ ...b, _score: calcScore(b) }));
    rows.sort((a, b) => b._score - a._score);
    const top = rows.slice(0, limit);
    return top;
  } finally {
    db.close();
  }
}

function dreamCandidates(args = {}) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const limit = Math.min(Math.max(parseInt(args.limit) || 10, 1), 20);
    const rows = db.prepare(`
      SELECT * FROM buckets
      WHERE bucket_type NOT IN ('archive','feel','permanent','core')
        AND COALESCE(resolved,0)=0
        AND COALESCE(digested,0)=0
        AND COALESCE(pinned,0)=0
      ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
      LIMIT 80
    `).all().map(parseBucket).filter(b => {
      const meta = b.metadata || {};
      const dream = meta.dream || {};
      const type = String(meta.type || b.bucket_type || '').toLowerCase();
      if (['archive', 'feel', 'permanent', 'core'].includes(type)) return false;
      if (meta.pinned || meta.protected || b.pinned) return false;
      if (dream.source_of_feel === true ||
        dream.skip_dream === true ||
        dream.reviewed === true ||
        dream.no_feel === true ||
        ['digested', 'reviewed_no_feel'].includes(dream.status)) return false;
      return true;
    });
    return rows.slice(0, limit);
  } finally {
    db.close();
  }
}

function formatDreamBucket(b, i) {
  const meta = b.metadata || {};
  const body = (b.content || '').replace(/\s+/g, ' ').trim().slice(0, 420);
  const when = (b.occurred_at || b.created_at || meta.created || '').slice(0, 10);
  return `${i + 1}. id=${b.id}
标题：${b.name || '未命名'}
时间：${when || '未知'}  重要度：${b.importance ?? 5}  V/A：${b.valence ?? 0.5}/${b.arousal ?? 0.3}
内容：${body}`;
}

function markDreamShown(ids) {
  const list = (ids || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!list.length) return;
  const db = new Database(DB_PATH);
  try {
    const select = db.prepare("SELECT id, metadata FROM buckets WHERE id=? AND bucket_type NOT IN ('archive','feel')");
    const update = db.prepare('UPDATE buckets SET metadata=? WHERE id=?');
    const now = new Date().toISOString();
    for (const bid of list) {
      const row = select.get(bid);
      if (!row) continue;
      const meta = tryParse(row.metadata, {}) || {};
      const dream = meta.dream || {};
      if (dream.source_of_feel === true || dream.no_feel === true || ['digested', 'reviewed_no_feel'].includes(dream.status)) continue;
      dream.shown = true;
      dream.shown_at = now;
      meta.dream = dream;
      update.run(JSON.stringify(meta), bid);
    }
  } finally {
    db.close();
  }
}

function readDream(args = {}) {
  const rows = dreamCandidates(args);
  if (!rows.length) {
    return '（Dream 没有找到需要自省的 recent active 普通记忆。）';
  }
  markDreamShown(rows.map(r => r.id));
  return `[Rifugio Dream]
下面是最近的 active 普通记忆。请你在当前对话里第一人称自省：有没有真正值得带走的 feel。

规则：
- 这一步只是自省，不是清理数据库。
- 没有真实沉淀就不要写 feel。
- 不要把每条日记、每条普通记忆都提炼成 feel；多数日常生活分享应该没有 feel。
- feel 不是事件摘要，不是普通 bucket 总结，也不是替 AI 每条写感受。
- feel 必须是具体、克制、可复用的长期相处理解：能帮助失忆后的你找回“我是谁、我怎么理解这段关系”。
- 只有明确触动、反复模式、重要约定/边界、偏好变化、关系推进、很深的领悟，才可以写 feel。
- 普通日常分享、一次性情绪、技术调试、代码/配置/报错通常不生成 feel。
- 如果你犹豫，就不要生成 feel。
- 最近记忆默认保持 active，不要因为它最近就沉底。
- 如果确有沉淀，用 hold(feel=true, source_bucket="id", name=..., content=..., tags=[...], importance=...) 写入。
- 收尾：写完该写的 feel 后，调一次 dream_seen()（不传 id），就会把本轮展示过、没写成 feel 的全部一次性标记看过（写过 feel 的自动跳过），不用再一条一条打标、省额度。想精确控制某几条时仍可 dream_seen(id="...", reason="...")。

最近记忆：
${rows.map(formatDreamBucket).join('\n\n---\n\n')}`;
}

function markSourcesAsFelt(db, sourceIds, feelId) {
  const ids = normalizeIds(sourceIds);
  if (!ids.length || !feelId) return;
  const select = db.prepare("SELECT id, metadata FROM buckets WHERE id=? AND bucket_type NOT IN ('archive','feel')");
  const update = db.prepare('UPDATE buckets SET metadata=? WHERE id=?');
  for (const sourceId of ids) {
    const row = select.get(sourceId);
    if (!row) continue;
    const metadata = tryParse(row.metadata, {});
    const linked = normalizeIds(metadata.dream?.linked_feel_ids);
    if (!linked.includes(feelId)) linked.push(feelId);
    metadata.dream = {
      ...(metadata.dream || {}),
      source_of_feel: true,
      status: 'source_of_feel',
      reason: 'source of manually held feel',
      linked_feel_ids: linked,
      marked_at: new Date().toISOString(),
    };
    update.run(JSON.stringify(metadata), row.id);
  }
}

function touch(ids) {
  if (!ids.length) return;
  const db = new Database(DB_PATH);
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 6 * 3600000).toISOString();
    const stmt = db.prepare(`
      UPDATE buckets SET last_active=?, activation_count=activation_count+1
      WHERE id=? AND bucket_type NOT IN ('archive','feel') AND (last_active IS NULL OR last_active < ?)
    `);
    ids.forEach(id => stmt.run(now.toISOString(), id, cutoff));
  } finally {
    db.close();
  }
}

async function searchOrdinary(args) {
  const query = String(args.query || args.q || '').trim();
  const limit = Math.min(Math.max(parseInt(args.limit) || 6, 1), 20);
  try {
    const rows = await semanticSearch(query, limit, args);
    touch(rows.map(r => r.id || r.bucket_id));
    return { rows, fallback: false };
  } catch(e) {
    const rows = keywordSearch(query, limit, args);
    touch(rows.map(r => r.id || r.bucket_id));
    return { rows, fallback: 'keyword', reason: e.message };
  }
}

function updateStatus(id, status) {
  const patch = statusToPatch(status);
  if (!patch) throw new Error('unknown status: ' + status);
  const db = new Database(DB_PATH);
  try {
    db.prepare('UPDATE buckets SET resolved=?, digested=?, digested_at=? WHERE id=?')
      .run(patch.resolved, patch.digested, patch.digested_at, id);
    return parseBucket(db.prepare('SELECT * FROM buckets WHERE id=?').get(id));
  } finally {
    db.close();
  }
}

function applyDreamSeenRow(db, bid, reason, now) {
  const row = db.prepare("SELECT * FROM buckets WHERE id=? AND bucket_type NOT IN ('archive','feel')").get(bid);
  if (!row) return null;
  const bucket = parseBucket(row);
  const metadata = bucket.metadata || {};
  metadata.dream = {
    ...(metadata.dream || {}),
    reviewed: true,
    no_feel: true,
    skip_dream: true,
    shown: false,
    status: 'reviewed_no_feel',
    reason: reason || '没有形成值得长期沉淀的 feel',
    reviewed_at: now,
  };
  db.prepare('UPDATE buckets SET metadata=? WHERE id=?').run(JSON.stringify(metadata), bid);
  return bucket.name || bid;
}

// 不传 id/ids 时批量收尾本轮 dream 展示过、未写 feel 的全部
function markDreamSeen(id = '', ids = null, reason = '') {
  const now = new Date().toISOString();
  let targets = normalizeIds(ids);
  if (String(id || '').trim()) targets.unshift(String(id).trim());
  targets = [...new Set(targets.map(x => String(x || '').trim()).filter(Boolean))];
  const batch = targets.length === 0;
  const db = new Database(DB_PATH);
  try {
    if (batch) {
      const rows = db.prepare(`SELECT id, metadata FROM buckets WHERE bucket_type NOT IN ('archive','feel') ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC LIMIT 200`).all();
      for (const r of rows) {
        const dream = (tryParse(r.metadata, {}) || {}).dream || {};
        if (dream.shown !== true) continue;
        if (dream.source_of_feel === true || dream.no_feel === true || ['digested', 'reviewed_no_feel'].includes(dream.status)) continue;
        targets.push(r.id);
      }
      targets = [...new Set(targets)];
      if (!targets.length) return { text: '（没有待收尾的 dream 记忆：要么本轮都写成 feel 了，要么已经标记过。）', done: [] };
    }
    const done = [];
    for (const bid of targets) {
      const name = applyDreamSeenRow(db, bid, reason, now);
      if (name) done.push(name);
    }
    if (!done.length) return { text: 'dream_seen失败：找不到对应的普通记忆', done: [] };
    let text;
    if (done.length === 1 && !batch) {
      text = `Dream 已标记看过：${done[0]}（不写 feel，保持 active）`;
    } else {
      text = `${batch ? '本轮收尾，已批量标记看过' : '已标记看过'} ${done.length} 条（不写 feel，保持 active）：` + done.slice(0, 12).join('、') + (done.length > 12 ? '…' : '');
    }
    return { text, done };
  } finally {
    db.close();
  }
}

async function handle(req) {
  const { id, method, params } = req || {};
  const hasId = id !== undefined && id !== null;

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'rifugio-memory', version: '3.0.0' },
    }});
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [TOOL_BREATH, TOOL_SEARCH, TOOL_HOLD, TOOL_PLAN, TOOL_DREAM, TOOL_DREAM_SEEN, TOOL_STATE, TOOL_QUIET, TOOL_DIGEST] } });
  }
  if (method !== 'tools/call') {
    if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    return;
  }

  const name = params?.name;
  const args = params?.arguments || {};
  try {
    if (name === 'breath') {
      const domain = String(args.domain || '').trim().toLowerCase();
      let rows;
      let note = '';
      if (domain === 'feel') rows = await readFeel(args);
      else if (args.query || args.q) {
        const out = await searchOrdinary(args);
        rows = out.rows;
        note = out.fallback ? `\n\n（已降级为关键词搜索：${out.reason}）` : '';
      } else rows = surfaceOrdinary(args);
      const text = rows.length ? rows.map(formatBucket).join('\n\n') + note : '（没有找到记忆）';
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    }

    if (name === 'search_memory') {
      const out = await searchOrdinary(args);
      const text = out.rows.length ? out.rows.map(formatBucket).join('\n\n') : '（没有找到相关记忆）';
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text + (out.fallback ? `\n\n（关键词 fallback：${out.reason}）` : '') }] } });
    }

    if (name === 'hold') {
      const db = new Database(DB_PATH);
      try {
        const sourceIds = normalizeIds(args.source_ids || args.source_bucket);
        const payload = { ...args };
        if (payload.feel === true && sourceIds.length) payload.source_ids = sourceIds;
        const data = insertBucket(db, payload);
        if (payload.feel === true) markSourcesAsFelt(db, sourceIds, data.id);
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `已写入：${data.name} (${data.status})` }], data } });
      } finally {
        db.close();
      }
    }

    if (name === 'plan') {
      const db = new Database(DB_PATH);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS piani (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT DEFAULT 'pending', flag_date TEXT, done_date TEXT, notes TEXT)");
        if (args.content) {
          const info = db.prepare('INSERT INTO piani (title, status, flag_date, notes) VALUES (?, ?, date(\'now\'), ?)').run(args.content, args.status || 'pending', args.notes || '');
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `计划已登记 #${info.lastInsertRowid}：${args.content}` }] } });
        }
        if (args.id && args.done === true) {
          db.prepare("UPDATE piani SET status='done', done_date=date('now') WHERE id=?").run(args.id);
          const row = db.prepare('SELECT title FROM piani WHERE id=?').get(args.id);
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `已打勾 #${args.id}：${row ? row.title : '?'} ✓` }] } });
        }
        if (args.id && (args.notes || args.status)) {
          if (args.notes) db.prepare('UPDATE piani SET notes = COALESCE(notes,\'\') || \'；\' || ? WHERE id=?').run(args.notes, args.id);
          if (args.status) db.prepare('UPDATE piani SET status=? WHERE id=?').run(args.status, args.id);
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `已更新 #${args.id}` }] } });
        }
        const rows = args.all === true
          ? db.prepare('SELECT * FROM piani ORDER BY id').all()
          : db.prepare("SELECT * FROM piani WHERE status != 'done' ORDER BY id").all();
        const text = rows.length
          ? rows.map(r => `#${r.id} [${r.status}] ${r.title}${r.flag_date ? ' (立于' + r.flag_date + ')' : ''}${r.notes ? '\n   ' + r.notes : ''}`).join('\n')
          : '（台账干净，没有欠账）';
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } finally {
        db.close();
      }
    }

    if (name === 'dream') {
      const text = readDream(args);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], data: { ok: true } } });
    }

    if (name === 'dream_seen') {
      const r = markDreamSeen(args.id, args.ids, args.reason);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], data: { ok: true, count: r.done.length } } });
    }

    if (name === 'trace') {
      const data = updateStatus(args.id, args.status);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `状态已更新：${data.name} -> ${data.status}` }], data } });
    }

    if (name === 'quiet' || name === 'digest') {
      const data = updateStatus(args.id, name === 'quiet' ? 'quiet' : 'digested');
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `状态已更新：${data.name} -> ${data.status}` }], data } });
    }

    if (hasId) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
  } catch(e) {
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${name || 'tool'} 失败：${e.message}` }], isError: true } });
  }
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
process.stdin.on('error', () => {});
process.stderr.write('[mcp-memory] ready — tools: breath, search_memory, hold, plan, dream, dream_seen, trace, quiet, digest\n');
