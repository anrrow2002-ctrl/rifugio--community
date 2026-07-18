// ============================================================
// buckets.js — Rifugio 记忆桶系统
//
// 替换原有的扁平 memories 表，使用带情感坐标 + 遗忘曲线的 bucket 结构。
// 吸收 Ombre Brain 精髓，修掉它的局限：
//   - 名字完全自定义（personas 字段，不强制叫"用户"）
//   - 可以手动编辑任意字段
//   - 向量化可选，不绑死主 API
//   - occurred_at / last_active 双时间轴，遗忘曲线按事件发生时间算
//   - 支持从 Markdown 对话文件导入，自动提取时间戳
//
// 挂载方式（在 server.js 里加两行）：
//   const { initBuckets, mountBucketRoutes } = require('./buckets');
//   initBuckets(DB_PATH);
//   mountBucketRoutes(app, DB_PATH);
// ============================================================

const crypto = require('crypto');
const DEFAULT_BACKFILL_DREAM_CUTOFF = process.env.RIFUGIO_DREAM_BACKFILL_CUTOFF || '2026-06-18';
const SOFT_DELETE_RETENTION_DAYS = 30;
const INSERT_BUCKET_TYPES = new Set(['dynamic', 'feel', 'permanent', 'core', 'self', 'archive']);
const RESTORABLE_BUCKET_TYPES = new Set(INSERT_BUCKET_TYPES);

const DEFAULT_BUCKET_IMPORT_PROMPT = `你是 Rifugio 的纯聊天记忆提取器。你的任务是从我和 AI 伴侣的日常聊天中，提取未来继续相处时真正有用的长期记忆。

规则：

1. 这是纯聊天、陪伴、关系记忆库，不是技术知识库。
2. 不要保存代码、脚本、正则、报错、插件配置、MCP配置、前端实现细节。
3. 技术内容只作为上下文理解，默认不要保存为长期 bucket。
4. 不要文学化，不要升华，不要把普通聊天总结成宏大意义。
5. 不要推断我没有明说的深层心理、人格标签或动机。
6. 只记录未来 AI 伴侣和我继续聊天时会用到的信息。
7. 优先记录：关系状态、称呼习惯、相处偏好、明确约定、重要事件、雷点边界、安慰方式、反复出现的互动模式。
8. 临时情绪可以不记；只有反复出现、会影响以后回应方式的情绪模式才记。
9. 同一主题可以合并，但不要改变原意。
10. 每条记忆必须具体、克制、可复用。
11. 没有值得长期保存的内容就返回空数组。
12. 只输出 JSON 数组，不要解释。

重要度标尺（importance，严格按此打分）：
- 9-10：关系里程碑、重大承诺/约定、纪念日、边界与雷点
- 7-8：反复出现的相处模式、称呼习惯、偏好、安慰方式、情感确认
- 5-6：有复用价值的具体事件、一次性但值得记的时刻
- 3-4：轻量日常、背景信息
- 1-2：几乎不值得记（这种直接不要输出）
日常聊天记忆正常应以 6-8 分为主，不要普遍打低分。

输出 JSON：
[
{
"name": "10字以内标题",
"summary": "50字以内摘要",
"content": "具体、克制、可复用的聊天记忆",
"domain": ["关系|偏好|约定|边界|事件|情绪模式|日常"],
"tags": ["标签1", "标签2"],
"importance": 1-10,
"valence": 0-1,
"arousal": 0-1,
"occurred_at": "YYYY-MM-DD或空",
"reason": "为什么未来聊天会用到"
}
]`;

function embedding() {
  try { return require('./embedding'); } catch(e) { return {}; }
}

function dedup() {
  try { return require('./dedup'); } catch(e) { return {}; }
}

// ─── Schema ───────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',

  -- 情感坐标 (Russell circumplex)
  valence       REAL NOT NULL DEFAULT 0.5,
  arousal       REAL NOT NULL DEFAULT 0.3,

  -- 分类
  domain        TEXT NOT NULL DEFAULT '[]',
  tags          TEXT NOT NULL DEFAULT '[]',

  -- 权重
  importance    INTEGER NOT NULL DEFAULT 5,
  bucket_type   TEXT NOT NULL DEFAULT 'dynamic',
  metadata      TEXT NOT NULL DEFAULT '{}',

  -- 双时间轴（核心设计，修复 Ombre Brain 遗忘曲线问题）
  occurred_at   TEXT,
  last_active   TEXT,
  activation_count INTEGER NOT NULL DEFAULT 1,

  -- 状态
  resolved      INTEGER NOT NULL DEFAULT 0,
  digested      INTEGER NOT NULL DEFAULT 0,
  digested_at   TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,

  -- 涉及人名（解决 Ombre Brain 把名字改成"用户"的问题）
  personas      TEXT NOT NULL DEFAULT '{}',

  deleted_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
`;

// ─── Init ─────────────────────────────────────────────────

let _dbPath = null;

function initBuckets(dbPath) {
  _dbPath = dbPath;
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  migrateBucketSchema(db);
  ensureBucketIndexes(db);
  purgeExpiredSoftDeleted(db);
  db.close();
  console.error('[buckets] Schema initialized');
}

function openDb(readonly = false) {
  const Database = require('better-sqlite3');
  return new Database(_dbPath, readonly ? { readonly: true } : {});
}

function migrateBucketSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(buckets)").all().map(c => c.name));
  const addColumn = (name, sql) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE buckets ADD COLUMN ${sql}`);
  };
  addColumn('bucket_type', "bucket_type TEXT NOT NULL DEFAULT 'dynamic'");
  addColumn('metadata', "metadata TEXT NOT NULL DEFAULT '{}'");
  addColumn('digested', "digested INTEGER NOT NULL DEFAULT 0");
  addColumn('digested_at', "digested_at TEXT DEFAULT NULL");
  addColumn('resolved', "resolved INTEGER NOT NULL DEFAULT 0");
  addColumn('pinned', "pinned INTEGER NOT NULL DEFAULT 0");
  addColumn('deleted_at', "deleted_at TEXT DEFAULT NULL");
  db.prepare("UPDATE buckets SET bucket_type='dynamic' WHERE bucket_type IS NULL OR trim(bucket_type)=''").run();
  db.prepare("UPDATE buckets SET metadata='{}' WHERE metadata IS NULL OR trim(metadata)=''").run();
  repairDreamSourceOfFeelState(db);
}

function repairDreamSourceOfFeelState(db) {
  const rows = db.prepare(`
    SELECT id, metadata FROM buckets
    WHERE bucket_type NOT IN ('archive','feel','self')
      AND (COALESCE(resolved,0)=1 OR COALESCE(digested,0)=1)
  `).all();
  const restore = db.prepare('UPDATE buckets SET resolved=0, digested=0, digested_at=NULL WHERE id=?');
  for (const row of rows) {
    const metadata = tryParse(row.metadata, {});
    if (metadata?.dream?.source_of_feel === true) restore.run(row.id);
  }
}

function ensureBucketIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bk_type     ON buckets(bucket_type);
    CREATE INDEX IF NOT EXISTS idx_bk_occurred ON buckets(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_bk_resolved ON buckets(resolved);
    CREATE INDEX IF NOT EXISTS idx_bk_digested ON buckets(digested);
    CREATE INDEX IF NOT EXISTS idx_bk_pinned   ON buckets(pinned);
    CREATE INDEX IF NOT EXISTS idx_bk_deleted  ON buckets(deleted_at);
  `);
}

// ─── Decay Engine ─────────────────────────────────────────
//
// score = importance × activation_count^0.3 × e^(-λ × days) × (0.5 + arousal×0.5)
//
// days   : 距 occurred_at（没有则用 created_at）的天数
// λ=0.05 : 约14天降到一半
// 已沉底 : ×0.05（沉底但不消失）
// 钉选   : 直接返回 999
//
// ─── 衰减引擎 v2 ──────────────────────────────────────────
//
// 设计原则：重要度（importance）决定半衰期，不是乘法放大器
//
//   halfLife = 4 × importance（天）
//     imp=10 → 40天半衰  imp=5 → 20天半衰  imp=1 → 4天半衰
//
//   score = importance × e^(-ln2/halfLife × days) × emotionFactor × actBonus
//
//   emotionFactor = 0.5 + arousal×0.5   （0.5~1.0）
//   actBonus      = 1 + 0.05×min(10, activation_count)  （最多 1.5×，软上限）
//
//   时间基准：occurred_at（记忆发生时间），activation 会更新 last_active 但不影响衰减起点
//   钉选：999  已沉底：×0.05
//
function calcScore(b) {
  const bucketType = b.bucket_type || b.type || b.metadata?.type || 'dynamic';
  if (bucketType === 'feel') return 0;
  if (b.pinned) return 999;
  const imp = Math.max(1, Math.min(10, b.importance || 5));
  const ar  = Math.max(0, Math.min(1,  b.arousal    || 0.3));

  // 重要度决定半衰期
  const halfLife = 4 * imp; // days
  const lambda   = Math.LN2 / halfLife;

  // 衰减从 occurred_at 算起（记忆发生时间）
  const base = b.occurred_at || b.created_at;
  const days = base ? Math.max(0, (Date.now() - new Date(base).getTime()) / 86400000) : 0;
  const timeFactor = Math.exp(-lambda * days);

  // activation 加成：用 last_active 新鲜度，而非累积次数
  // 避免被反复touch的旧记忆无限霸榜（正反馈死循环修复）
  const lastActiveDays = b.last_active
    ? Math.max(0, (Date.now() - new Date(b.last_active).getTime()) / 86400000)
    : 30;
  // ── 打分（2026-06-20 重构，按用户的设计）─────────────────────────────────
  // 记忆曲线：事件离现在越近 → 记得越深 → 分越高；越久越模糊。importance 与 recency 力度
  // 相当、recency 略弱(wR<wI)。两者各归一到 0~1 再加权混合，放回 0~10 量纲。
  // 半衰期仍 = 4×importance（重要的衰减更慢、依然会浮现，有 importance 项作分数地板）；
  // 情绪强度(arousal)与近期触达(activation) 只做温和修正，不喧宾夺主；钉选=999。
  const R = timeFactor;          // recency 0~1（距事件 occurred_at 的衰减）
  const I = imp / 10;            // importance 0~1
  let score = (0.52 * R + 0.48 * I) * 10;                  // 0~10，recency 与 importance 力度相当（recency 略强一点）
  // time_weight 硬性新鲜度门槛（源自 Ombre-Brain 的 final_score = time_weight × base_score，
  // 原版 7 天后封 0.3，我们记忆量小、用温和的 0.7）：老记忆再重要也让位给最近几天的事
  const timeWeight = days <= 2 ? 1.0 : Math.max(0.7, 0.95 * Math.exp(-0.08 * (days - 2)));
  score *= timeWeight;
  score *= (0.9 + ar * 0.1);                               // 情绪微调 0.9~1.0
  score *= (1 + 0.1 * Math.exp(-0.15 * lastActiveDays));   // 近期被 touch 的小加成 1.0~1.1
  if (b.resolved) score *= 0.05;
  if (b.digested) score *= 0.02;
  return Math.round(score * 1000) / 1000;
}

// ─── Helpers ──────────────────────────────────────────────

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function parseBucket(row) {
  if (!row) return null;
  const metadata = tryParse(row.metadata, {});
  const bucketType = row.bucket_type || metadata.type || 'dynamic';
  const status = row.deleted_at
    ? 'deleted'
    : (bucketType === 'feel' ? 'feel' : (row.digested ? 'digested' : (row.resolved ? 'quiet' : 'active')));
  return {
    ...row,
    bucket_type: bucketType,
    type: metadata.type || bucketType,
    status,
    metadata,
    domain:   tryParse(row.domain,   []),
    tags:     tryParse(row.tags,     []),
    personas: tryParse(row.personas, {}),
    resolved: !!row.resolved,
    digested: !!row.digested,
    pinned:   !!row.pinned,
    score:    calcScore({ ...row, bucket_type: bucketType, metadata }),
  };
}

function tryParse(str, fallback) {
  if (Array.isArray(str)) return str;
  if (str && typeof str === 'object') return str;
  try { return JSON.parse(str || ''); } catch(e) { return fallback; }
}

function toJson(v) {
  if (Array.isArray(v) || (v && typeof v === 'object')) return JSON.stringify(v);
  return v;
}

function normalizeList(v, fallback = []) {
  if (Array.isArray(v)) return v.filter(Boolean).map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return fallback;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeList(parsed, fallback);
    } catch(e) {}
    return trimmed.split(',').map(x => x.trim()).filter(Boolean);
  }
  return fallback;
}

function normalizeMetadata(v, defaults = {}) {
  const base = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...v } : tryParse(v, {});
  for (const [k, val] of Object.entries(defaults)) {
    if (base[k] === undefined || base[k] === null || base[k] === '') base[k] = val;
  }
  return base;
}

function isFeelInput(input = {}) {
  const type = String(input.bucket_type || input.type || '').trim().toLowerCase();
  return input.feel === true || type === 'feel';
}

function ordinaryWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `${p}bucket_type NOT IN ('archive','feel','self') AND ${p}deleted_at IS NULL`;
}

function searchableOrdinaryWhere(prefix = '') {
  return ordinaryWhere(prefix);
}

function surfacingWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `${ordinaryWhere(prefix)} AND COALESCE(${p}digested,0)=0 AND COALESCE(${p}resolved,0)=0`;
}

function isDreamCandidate(b = {}) {
  const type = String(b.bucket_type || b.type || b.metadata?.type || '').trim().toLowerCase();
  const metaType = String(b.metadata?.type || '').trim().toLowerCase();
  const dreamMeta = b.metadata?.dream || {};
  if (['archive', 'feel', 'permanent', 'core'].includes(type)) return false;
  if (['archive', 'feel', 'permanent', 'core'].includes(metaType)) return false;
  if (b.pinned || b.metadata?.pinned || b.metadata?.protected) return false;
  if (dreamMeta.source_of_feel === true ||
    dreamMeta.skip_dream === true ||
    dreamMeta.reviewed === true ||
    dreamMeta.no_feel === true ||
    dreamMeta.status === 'reviewed_no_feel') return false;
  return true;
}

function normalizeCutoff(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? '' : new Date(ts).toISOString();
}

function selectDreamCandidates(db, limit, options = {}) {
  const cutoff = normalizeCutoff(options.cutoff || options.before || options.until);
  const cutoffWhere = cutoff ? 'AND datetime(COALESCE(occurred_at, created_at)) < datetime(?)' : '';
  const scanLimit = Math.max(limit * 40, 500);
  const params = cutoff ? [cutoff, scanLimit] : [scanLimit];
  const rows = db.prepare(`
    SELECT * FROM buckets
    WHERE ${surfacingWhere()}
      AND bucket_type NOT IN ('permanent','core')
      AND COALESCE(pinned,0)=0
      ${cutoffWhere}
    ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
    LIMIT ?
  `).all(...params).map(parseBucket);
  return rows.filter(isDreamCandidate).slice(0, limit);
}

function isDreamReviewedMetadata(metadata = {}) {
  const dream = metadata?.dream || {};
  return dream.source_of_feel === true ||
    dream.skip_dream === true ||
    dream.reviewed === true ||
    dream.status === 'reviewed_no_feel';
}

function countDreamReviewed(db) {
  return db.prepare(`SELECT metadata FROM buckets WHERE ${ordinaryWhere()}`).all()
    .filter(r => isDreamReviewedMetadata(tryParse(r.metadata, {}))).length;
}

function breathWhere(prefix = '', opts = {}) {
  const p = prefix ? `${prefix}.` : '';
  const conds = [ordinaryWhere(prefix)];
  if (!opts.include_digested) conds.push(`COALESCE(${p}digested,0)=0`);
  if (!opts.include_quiet) conds.push(`COALESCE(${p}resolved,0)=0`);
  return conds.join(' AND ');
}

function statusToPatch(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'active' || s === 'trace') return { resolved: 0, digested: 0, digested_at: null };
  if (s === 'quiet' || s === 'resolved') return { resolved: 1, digested: 0, digested_at: null };
  if (s === 'digested' || s === 'digest') return { resolved: 1, digested: 1, digested_at: new Date().toISOString() };
  return null;
}

function scheduleBucketEmbedding(id, reason = 'changed') {
  const mod = embedding();
  if (typeof mod.scheduleEmbed === 'function') {
    try { mod.scheduleEmbed(id, reason); } catch(e) {}
  }
}

function invalidateBucketEmbedding(id, reason = 'changed') {
  const mod = embedding();
  if (typeof mod.invalidateBucketVector === 'function') {
    try { mod.invalidateBucketVector(id, reason); return; } catch(e) {}
  }
  scheduleBucketEmbedding(id, reason);
}

function touchBuckets(db, ids, cooldownHours = 6) {
  if (!Array.isArray(ids) || !ids.length) return;
  const now = new Date();
  const cutoff = new Date(now.getTime() - cooldownHours * 3600000).toISOString();
  const stmt = db.prepare(`
    UPDATE buckets
    SET last_active=?, activation_count=activation_count+1
    WHERE id=?
      AND bucket_type NOT IN ('archive','feel','self')
      AND deleted_at IS NULL
      AND (last_active IS NULL OR last_active < ?)
  `);
  for (const id of ids) stmt.run(now.toISOString(), id, cutoff);
}

function touchBucketIds(ids, cooldownHours = 6) {
  const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!safeIds.length) return;
  const writeDb = openDb(false);
  try {
    touchBuckets(writeDb, safeIds, cooldownHours);
  } catch (e) {
    console.warn('[buckets] touch failed:', e.message);
  } finally {
    writeDb.close();
  }
}

function purgeExpiredSoftDeleted(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - SOFT_DELETE_RETENTION_DAYS * 86400000).toISOString();
  const ids = db.prepare(`
    SELECT id FROM buckets
    WHERE deleted_at IS NOT NULL AND datetime(deleted_at) <= datetime(?)
  `).all(cutoff).map(row => row.id);
  if (!ids.length) return 0;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const deleteVector = tables.has('bucket_vectors') ? db.prepare('DELETE FROM bucket_vectors WHERE bucket_id=?') : null;
  const deleteJob = tables.has('embedding_jobs') ? db.prepare('DELETE FROM embedding_jobs WHERE bucket_id=?') : null;
  const deleteBucket = db.prepare('DELETE FROM buckets WHERE id=? AND deleted_at IS NOT NULL');
  let purged = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (deleteVector) deleteVector.run(id);
      if (deleteJob) deleteJob.run(id);
      purged += deleteBucket.run(id).changes;
    }
  })();
  return purged;
}

function validatedBucketType(value, fallback = 'dynamic') {
  const type = String(value || fallback).trim().toLowerCase();
  if (!INSERT_BUCKET_TYPES.has(type)) throw new Error('unsupported bucket_type');
  return type;
}

function validatedOccurredAt(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (raw.length > 64 || Number.isNaN(Date.parse(raw))) throw new Error('invalid occurred_at');
  return raw;
}

function boundedList(value, maxItems = 64, maxLength = 100) {
  return normalizeList(value, []).slice(0, maxItems).map(item => item.slice(0, maxLength));
}

function maybeExistingBucket(db, input = {}) {
  if (isFeelInput(input)) {
    const fn = dedup().findSimilarFeel;
    if (typeof fn === 'function') return fn(db, input);
    return null;
  }
  const fn = dedup().findExactDuplicate;
  if (typeof fn === 'function') return fn(db, input);
  return null;
}

function findLightImportDuplicate(db, item = {}) {
  const fn = dedup().textSimilarity;
  if (typeof fn !== 'function') return null;
  const candidate = {
    name: item.name || '',
    content: item.content || '',
    domain: normalizeList(item.domain, []),
    tags: normalizeList(item.tags, []),
    occurred_at: item.occurred_at || '',
  };
  const rows = db.prepare(`
    SELECT id, name, content, domain, tags, occurred_at, created_at, importance, pinned
    FROM buckets
    WHERE bucket_type NOT IN ('archive','feel','self')
    ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
    LIMIT 500
  `).all().map(r => ({
    ...r,
    domain: tryParse(r.domain, []),
    tags: tryParse(r.tags, []),
    pinned: !!r.pinned,
  }));
  let best = null;
  for (const row of rows) {
    const similarity = fn(candidate, row);
    if (similarity >= 0.78 && (!best || similarity > best.similarity)) {
      best = { id: row.id, name: row.name, similarity: Math.round(similarity * 1000) / 1000 };
    }
  }
  return best;
}

function runPostImportDedupSoon(limit = 30) {
  setTimeout(async () => {
    try {
      const mod = embedding();
      if (typeof mod.processEmbeddingQueue === 'function') {
        await mod.processEmbeddingQueue(limit);
      }
      const fn = dedup().runDedup;
      if (typeof fn === 'function' && _dbPath) {
        const result = fn(_dbPath, {});
        if (result.archived) console.log(`[buckets] post-import dedup archived ${result.archived}`);
      }
    } catch (e) {
      console.warn('[buckets] post-import dedup skipped:', e.message);
    }
  }, 250);
}

function insertBucket(db, input = {}) {
  const now = new Date().toISOString();
  const feel = isFeelInput(input);
  const bucketType = feel ? 'feel' : validatedBucketType(input.bucket_type || input.type, 'dynamic');
  const name = String(input.name || (feel ? '主观沉淀' : '未命名')).trim() || (feel ? '主观沉淀' : '未命名');
  const content = String(input.content || '');
  if (name.length > 200) throw new Error('name too long');
  if (content.length > 200000) throw new Error('content too long');
  if (input.id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(String(input.id))) {
    throw new Error('invalid bucket id');
  }
  const valence = clampNumber(input.valence, 0, 1, 0.5);
  const arousal = clampNumber(input.arousal, 0, 1, 0.3);
  const importance = clampNumber(input.importance, 1, 10, feel ? 8 : 5);
  if (!input.skip_duplicate_check) {
    const existing = maybeExistingBucket(db, { ...input, bucket_type: bucketType, feel });
    if (existing) {
      if (!feel) touchBuckets(db, [existing.id], 1);
      return { ...parseBucket(existing), deduped: true };
    }
  }
  const domain = boundedList(input.domain, 64, 100).length ? boundedList(input.domain, 64, 100) : (feel ? ['feel'] : []);
  if (feel && !domain.includes('feel')) domain.unshift('feel');
  const metadata = normalizeMetadata(input.metadata, {
    type: bucketType,
    created: now,
  });
  metadata.type = bucketType;
  if (feel) metadata.channel = 'feel';
  if (input.source_ids !== undefined) metadata.source_ids = boundedList(input.source_ids, 64, 128);
  if (input.source !== undefined) metadata.source = String(input.source).slice(0, 200);
  const metadataJson = toJson(metadata);
  const tags = boundedList(input.tags, 64, 100);
  const personasJson = toJson(input.personas || {});
  if (metadataJson.length > 100000) throw new Error('metadata too large');
  if (personasJson.length > 100000) throw new Error('personas too large');
  const occurredAt = validatedOccurredAt(input.occurred_at, now);

  const id = input.id || newId();
  db.prepare(`
    INSERT INTO buckets (id,name,content,valence,arousal,domain,tags,importance,
      bucket_type,metadata,occurred_at,last_active,activation_count,resolved,digested,digested_at,pinned,personas,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)
  `).run(
    id,
    name,
    content,
    valence,
    arousal,
    toJson(domain),
    toJson(tags),
    importance,
    bucketType,
    metadataJson,
    occurredAt,
    now,
    input.resolved ? 1 : 0,
    input.digested ? 1 : 0,
    input.digested_at || null,
    input.pinned ? 1 : 0,
    personasJson,
    now
  );
  const created = parseBucket(db.prepare('SELECT * FROM buckets WHERE id=?').get(id));
  if (!input.defer_embedding && bucketType !== 'archive') scheduleBucketEmbedding(id, input.source || (feel ? 'feel-created' : 'created'));
  return created;
}

function getLLMConfig(db, override = {}) {
  let baseUrl = override.llm_base_url || 'https://api.openai.com/v1';
  let model   = override.llm_model   || 'gpt-4o-mini';
  let apiKey  = override.llm_api_key || '';

  if (!apiKey) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
    if (row) {
      const cfg = tryParse(row.value, {});
      baseUrl = cfg.base_url || baseUrl;
      model   = cfg.model   || model;
      if (cfg.api_key_enc) {
        try {
          const SECRET = process.env.RIFUGIO_SECRET || 'dev-only-rifugio-secret';
          const [ivHex, enc] = cfg.api_key_enc.split(':');
          const d = crypto.createDecipheriv('aes-256-cbc',
            crypto.createHash('sha256').update(SECRET).digest(),
            Buffer.from(ivHex, 'hex'));
          apiKey = d.update(enc, 'hex', 'utf8') + d.final('utf8');
        } catch(e) {}
      }
    }
  }
  return { baseUrl, model, apiKey };
}

function getBucketImportPrompt(db) {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='bucket_import_prompt'").get();
    const saved = row ? String(row.value || '').trim() : '';
    return saved || DEFAULT_BUCKET_IMPORT_PROMPT;
  } catch(e) {
    return DEFAULT_BUCKET_IMPORT_PROMPT;
  }
}

// 去掉孤立代理项（lone surrogate）：聊天导出里被截断的 emoji 会留下半个代理对，
// JSON.stringify 输出成孤立 \uXXXX，严格 JSON 解析器（DeepSeek 等）会报
// "lone leading surrogate" 400。这里只删落单的，成对的正常 emoji 保留。
function stripLoneSurrogates(s) {
  return String(s == null ? '' : s)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeImportItem(item = {}, fallbackDate = null) {
  return {
    name: String(item.name || '未命名').slice(0, 40),
    summary: String(item.summary || '').slice(0, 200),
    content: String(item.content || '').trim(),
    domain: normalizeList(item.domain, []),
    tags: normalizeList(item.tags, []),
    importance: clampNumber(item.importance, 1, 10, 5),
    valence: clampNumber(item.valence, 0, 1, 0.5),
    arousal: clampNumber(item.arousal, 0, 1, 0.3),
    occurred_at: item.occurred_at || fallbackDate || null,
    keywords: normalizeList(item.keywords, []),
    original_quotes: normalizeList(item.original_quotes, []),
    reason: String(item.reason || '').slice(0, 300),
    selected: item.selected !== false,
  };
}

function stripCodeFence(raw) {
  return String(raw || '').replace(/```json|```/g, '').trim();
}

function parseDreamAnalysis(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return parseDreamAnalysis(JSON.parse(stripCodeFence(raw))); } catch(e) { return null; }
  }
  if (Array.isArray(raw)) return { decisions: [], feels: raw };
  if (typeof raw !== 'object') return null;
  return {
    decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    feels: Array.isArray(raw.feels) ? raw.feels : (Array.isArray(raw.feel) ? raw.feel : []),
  };
}

function dreamDecisionStatus(d = {}) {
  const raw = String(d.status || d.state || d.action || '').trim().toLowerCase();
  if (['archive', 'archived'].includes(raw)) return 'archived';
  if (['quiet', 'resolved', 'settled', 'sink', '沉底'].includes(raw)) return 'quiet';
  if (['digested', 'digest', 'done', '消化'].includes(raw)) return 'digested';
  if (['active', 'keep', 'trace', '持续关注'].includes(raw)) return 'active';
  if (d.resolved === true || d.digested === true) return 'digested';
  return 'active';
}

async function runDreamLLM(db, candidates, override = {}) {
  const { baseUrl, model, apiKey } = getLLMConfig(db, override);
  if (!apiKey) {
    throw new Error('Dream 没有读到 LLM API key；请检查记忆 LLM 设置、RIFUGIO_SECRET、以及前端请求是否打到同一个后端/数据库。');
  }
  const payload = candidates.map(b => ({
    id: b.id,
    name: b.name,
    content: String(b.content || '').slice(0, 900),
    domain: b.domain,
    tags: b.tags,
    importance: b.importance,
    valence: b.valence,
    arousal: b.arousal,
    occurred_at: b.occurred_at,
  }));
  const prompt = `你是 Rifugio 的 Dream。你不是清理数据库的后台任务，而是在写入记忆后的第一人称自省。

请阅读这批普通记忆，思考这些记忆里有没有真正值得“带走”的 feel：
- 长期相处理解；
- 仍未解的问题；
- 明显变化；
- 关系经验、偏好、雷点、约定、重要事件、相处方式；
- 一件事确实推动了关系发展、改变了以后相处方式，或留下了很深的理解。

规则：
- 有沉淀才生成 feel，不要强迫生成。没有值得沉淀的内容就返回空 feels。
- 不要把每条日记、每条普通记忆都提炼成 feel；多数日常生活分享应该没有 feel。
- feel 不是事件摘要，不是普通 bucket 总结，也不是替 AI 每条写感受。
- feel 必须是具体、克制、可复用的长期相处理解：它要能帮助失忆后的我找回“我是谁、我怎么理解这段关系”。
- 只有明确触动、反复模式、重要约定/边界、偏好变化、关系推进、很深的领悟，才可以写 feel。
- 普通日常分享、一次性情绪、技术调试、代码/配置/报错通常不生成 feel，也不要自动沉底。
- 如果你犹豫，就不要生成 feel。
- decisions 只作为建议，不会默认执行。
- 最新记忆默认保持 active。不要因为它“最近”就建议沉底。
- 普通记忆成功成为 feel 的 source 后，会被标记为已沉淀来源以避免重复 Dream；默认仍保持 active。
- 明确约定、偏好、雷点、重要事件、相处方式必须保持 active。
- quiet 只能建议用于明显过期、重复、临时、低价值的信息。
- digested 只能建议用于已经成功生成 feel 的 source。
- archive 不应由 Dream 自动执行，除非用户手动确认；这里只能极谨慎地建议。
- 如果没有 feel，也没有 quiet/digested/archive 建议，就返回空数组；系统会把这批记忆标记为已 Dream 看过但不沉底。
- source_ids 必须引用输入中的 id。
- 只输出 JSON，不要解释。

JSON 结构：
{
  "decisions": [
    {"id": "bucket id", "status": "active|quiet|digested|archived", "reason": "简短理由"}
  ],
  "feels": [
    {"name": "短标题", "content": "主观沉淀正文", "source_ids": ["bucket id"], "domain": ["feel"], "tags": ["关系"], "importance": 8, "valence": 0.5, "arousal": 0.3}
  ]
}

普通记忆：
${JSON.stringify(payload, null, 2)}`;

  const requestDream = (useJsonMode = true) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 3000,
      ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: '只输出一个合法 JSON object，不要 Markdown，不要解释。' },
        { role: 'user', content: prompt }
      ]
    })
  });
  let resp = await requestDream(true);
  if (!resp.ok && [400, 422].includes(resp.status)) {
    const body = await resp.text();
    if (/response_format|json_object/i.test(body)) resp = await requestDream(false);
    else throw new Error(`LLM ${resp.status}: ${body.slice(0, 200)}`);
  }
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const finishReason = data.choices?.[0]?.finish_reason;
  if (finishReason === 'length') {
    throw new Error('Dream JSON 被 max_tokens 截断；请减少 dream limit 或提高 max_tokens。');
  }
  const analysis = parseDreamAnalysis(data.choices?.[0]?.message?.content || '');
  if (!analysis) throw new Error('Dream LLM 返回内容不是有效 JSON，可能是输出被截断或模型没有遵守 JSON 格式。');
  return analysis;
}

function hasExistingFeelForSources(db, sourceIds, content) {
  const ids = normalizeList(sourceIds).sort();
  const newContent = normalizeFeelContent(content);
  const rows = db.prepare("SELECT content, metadata FROM buckets WHERE bucket_type='feel'").all();
  return rows.some(r => {
    if (newContent && areFeelContentsSimilar(newContent, normalizeFeelContent(r.content))) return true;
    if (!ids.length) return false;
    const existing = normalizeList(tryParse(r.metadata, {}).source_ids).sort();
    if (!existing.length) return false;
    const overlap = ids.filter(id => existing.includes(id)).length;
    return overlap / Math.min(existing.length, ids.length) >= 0.5;
  });
}

function normalizeFeelContent(content) {
  return String(content || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function feelNgrams(s, n = 3) {
  if (!s) return new Set();
  if (s.length <= n) return new Set([s]);
  const out = new Set();
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

function areFeelContentsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (minLen >= 12 && (a.includes(b) || b.includes(a)) && minLen / maxLen >= 0.8) return true;
  const aa = feelNgrams(a);
  const bb = feelNgrams(b);
  if (!aa.size || !bb.size) return false;
  let hit = 0;
  for (const g of aa) if (bb.has(g)) hit++;
  return (2 * hit) / (aa.size + bb.size) >= 0.9;
}

function applyDreamAnalysis(db, candidates, analysis, options = {}) {
  const parsed = parseDreamAnalysis(analysis) || { decisions: [], feels: [] };
  const applyDecisions = options.apply_decisions === true;
  const candidateById = new Map(candidates.map(b => [b.id, b]));
  const candidateIds = new Set(candidateById.keys());
  const now = new Date().toISOString();
  const digested = [];
  const quiet = [];
  const archived = [];
  const kept = [];
  const reviewed = [];
  const reviewedById = new Map();
  const feels = [];
  const processedIds = new Set();
  const createdFeelSourceIds = new Set();
  const requestedMaxFeels = Number(options.max_feels);
  const maxFeels = Number.isFinite(requestedMaxFeels) && requestedMaxFeels >= 0
    ? Math.floor(requestedMaxFeels)
    : Math.max(1, Math.min(3, Math.ceil(candidates.length / 4)));

  const updateStmt = db.prepare(`
    UPDATE buckets
    SET resolved=?, digested=?, digested_at=?, bucket_type=?, metadata=?
    WHERE id=?
  `);
  const updateMetadataStmt = db.prepare('UPDATE buckets SET metadata=? WHERE id=?');
  const deleteVectorStmt = applyDecisions ? db.prepare('DELETE FROM bucket_vectors WHERE bucket_id=?') : null;

  for (const id of candidateIds) {
    const bucket = candidateById.get(id);
    if (!bucket) continue;
    const metadata = normalizeMetadata(bucket.metadata, {});
    metadata.dream = {
      ...(metadata.dream || {}),
      reviewed: true,
      no_feel: metadata.dream?.source_of_feel === true ? metadata.dream?.no_feel : true,
      skip_dream: true,
      status: metadata.dream?.source_of_feel === true ? metadata.dream?.status || 'source_of_feel' : 'reviewed_no_feel',
      reason: metadata.dream?.reason || 'Dream 已看过，没有形成值得长期沉淀的 feel',
      reviewed_at: now,
      last_dreamed_at: now,
    };
    updateMetadataStmt.run(toJson(metadata), id);
    reviewedById.set(id, { id, status: metadata.dream.status, reason: metadata.dream.reason });
  }

  for (const d of parsed.decisions) {
    const id = d.id || d.bucket_id;
    if (!candidateIds.has(id)) continue;
    processedIds.add(id);
    const bucket = candidateById.get(id);
    const status = dreamDecisionStatus(d);
    if (status === 'active') {
      kept.push(id);
      continue;
    }
    const suggestion = { id, status, reason: d.reason || '' };
    if (applyDecisions) {
      const metadata = normalizeMetadata(bucket.metadata, {});
      metadata.dream = {
        ...(metadata.dream || {}),
        status,
        reason: d.reason || '',
        digested_at: now,
        reviewed: true,
        skip_dream: true,
        reviewed_at: now,
      };
      const bucketType = status === 'archived' ? 'archive' : bucket.bucket_type;
      const isDigested = status === 'digested' || status === 'archived';
      updateStmt.run(1, isDigested ? 1 : 0, isDigested ? now : null, bucketType, toJson(metadata), id);
      if (status === 'archived') deleteVectorStmt.run(id);
    }
    if (status === 'quiet') quiet.push(suggestion);
    else if (status === 'archived') {
      archived.push(suggestion);
    }
    else digested.push(suggestion);
  }

  for (const f of parsed.feels) {
    if (feels.length >= maxFeels) break;
    const sourceIds = normalizeList(f.source_ids || f.source_bucket || f.sources || f.bucket_ids).filter(id => candidateIds.has(id));
    if (!sourceIds.length) continue;
    const content = String(f.content || f.summary || '').trim();
    if (!content || content.length < 8) continue;
    if (hasExistingFeelForSources(db, sourceIds, content)) continue;
    const createdFeel = insertBucket(db, {
      name: f.name || '主观沉淀',
      content,
      feel: true,
      bucket_type: 'feel',
      domain: normalizeList(f.domain, ['feel']),
      tags: normalizeList(f.tags, []),
      importance: f.importance || 8,
      valence: f.valence ?? 0.5,
      arousal: f.arousal ?? 0.3,
      source_ids: sourceIds,
      source: 'dream',
      metadata: normalizeMetadata(f.metadata, {
        type: 'feel',
        channel: 'feel',
        source: 'dream',
        source_ids: sourceIds,
        created: now,
      }),
    });
    if (!createdFeel.deduped) feels.push(createdFeel);

    if (createdFeel.deduped) continue;

    for (const sourceId of sourceIds) {
      const bucket = candidateById.get(sourceId);
      if (!bucket) continue;
      const metadata = normalizeMetadata(bucket.metadata, {});
      const linkedFeelIds = normalizeList(metadata.dream?.linked_feel_ids, []);
      if (!linkedFeelIds.includes(createdFeel.id)) linkedFeelIds.push(createdFeel.id);
      const current = db.prepare('SELECT metadata FROM buckets WHERE id=?').get(sourceId);
      const currentMetadata = normalizeMetadata(current?.metadata, metadata);
      currentMetadata.dream = {
        ...(currentMetadata.dream || {}),
        reason: 'source of generated feel',
        last_dreamed_at: now,
        reviewed: true,
        skip_dream: true,
        no_feel: false,
        source_of_feel: true,
        linked_feel_ids: linkedFeelIds,
      };
      if (applyDecisions) currentMetadata.dream.status = 'digested';
      else currentMetadata.dream.status = 'source_of_feel';
      if (applyDecisions) updateStmt.run(1, 1, now, bucket.bucket_type, toJson(currentMetadata), sourceId);
      else updateMetadataStmt.run(toJson(currentMetadata), sourceId);
      createdFeelSourceIds.add(sourceId);
      reviewedById.set(sourceId, { id: sourceId, status: currentMetadata.dream.status, reason: currentMetadata.dream.reason });
      processedIds.add(sourceId);
      for (const arr of [quiet, digested, archived]) {
        const idx = arr.findIndex(x => x.id === sourceId);
        if (idx >= 0) arr.splice(idx, 1);
      }
      const keptIdx = kept.indexOf(sourceId);
      if (keptIdx >= 0) kept.splice(keptIdx, 1);
      if (applyDecisions) digested.push({ id: sourceId, status: 'digested', reason: 'source of generated feel' });
    }
  }

  for (const id of candidateIds) {
    if (!processedIds.has(id)) kept.push(id);
  }

  const suggestionById = new Map([...quiet, ...digested, ...archived].map(x => [x.id, x]));
  for (const id of candidateIds) {
    if (createdFeelSourceIds.has(id)) continue;
    const bucket = candidateById.get(id);
    if (!bucket) continue;
    const metadata = normalizeMetadata(bucket.metadata, {});
    if (metadata.dream?.source_of_feel === true) continue;
    const suggestion = suggestionById.get(id);
    const reason = suggestion?.reason ||
      (suggestion ? `Dream 已看过，并给出 ${suggestion.status} 建议` : 'Dream 已看过，没有形成值得长期沉淀的 feel');
    metadata.dream = {
      ...(metadata.dream || {}),
      reviewed: true,
      no_feel: true,
      skip_dream: true,
      status: 'reviewed_no_feel',
      suggested_status: suggestion?.status || metadata.dream?.suggested_status || null,
      reason,
      reviewed_at: now,
    };
    updateMetadataStmt.run(toJson(metadata), id);
    reviewedById.set(id, { id, status: 'reviewed_no_feel', reason: metadata.dream.reason });
  }
  reviewed.push(...reviewedById.values());

  return {
    quiet,
    digested,
    archived,
    kept: applyDecisions ? kept : [...candidateIds],
    reviewed,
    dreamed_count: candidateIds.size,
    feels,
  };
}

async function runDreamCycle(options = {}) {
  const db = openDb();
  try {
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
    const applyDecisions = options.apply_decisions === true;
    const cutoff = normalizeCutoff(options.cutoff || options.before || options.until);
    const candidates = selectDreamCandidates(db, limit, { cutoff });
    const dreamReviewedBefore = countDreamReviewed(db);

    if (options.dry_run) {
      return { ok: true, dry_run: true, candidates };
    }

    if (!candidates.length) {
      return {
        ok: true,
        mode: cutoff ? 'backfill' : 'dream',
        cutoff: cutoff || null,
        apply_decisions: applyDecisions,
        candidates: [],
        quiet: [],
        digested: [],
        archived: [],
        suggested_quiet: [],
        suggested_digested: [],
        suggested_archived: [],
        kept: [],
        active: [],
        reviewed: [],
        reviewed_count: 0,
        dreamed_count: 0,
        dream_reviewed_before: dreamReviewedBefore,
        dream_reviewed_total: dreamReviewedBefore,
        dream_reviewed_added: 0,
        feels_created: 0,
        feels: [],
      };
    }

    const analysis = options.analysis
      ? parseDreamAnalysis(options.analysis)
      : await runDreamLLM(db, candidates, {
          llm_base_url: options.llm_base_url,
          llm_api_key: options.llm_api_key,
          llm_model: options.llm_model,
        });

    if (!analysis) {
      return {
        ok: false,
        error: 'Dream analysis 为空或不是有效 JSON。',
        candidates,
      };
    }

    const tx = db.transaction(() => applyDreamAnalysis(db, candidates, analysis, { apply_decisions: applyDecisions, max_feels: options.max_feels }));
    const result = tx();
    result.feels.forEach(f => scheduleBucketEmbedding(f.id, 'dream-feel'));
    const dreamReviewedTotal = countDreamReviewed(db);
    const dreamReviewedAdded = Math.max(0, dreamReviewedTotal - dreamReviewedBefore);
    return {
      ok: true,
      mode: cutoff ? 'backfill' : 'dream',
      cutoff: cutoff || null,
      apply_decisions: applyDecisions,
      candidates: candidates.map(b => ({ id: b.id, name: b.name })),
      quiet: applyDecisions ? result.quiet : [],
      digested: applyDecisions ? result.digested : [],
      archived: applyDecisions ? result.archived : [],
      suggested_quiet: result.quiet,
      suggested_digested: result.digested,
      suggested_archived: result.archived,
      kept: result.kept,
      active: result.kept,
      reviewed: result.reviewed,
      reviewed_count: result.dreamed_count,
      dreamed_count: result.dreamed_count,
      dream_reviewed_before: dreamReviewedBefore,
      dream_reviewed_total: dreamReviewedTotal,
      dream_reviewed_added: dreamReviewedAdded,
      feels_created: result.feels.length,
      feels: result.feels,
    };
  } finally {
    db.close();
  }
}

// ─── Routes ───────────────────────────────────────────────

function mountBucketRoutes(app, dbPath) {
  _dbPath = dbPath;

  app.get('/api/settings/bucket-import-prompt', (req, res) => {
    const db = openDb(true);
    try {
      res.json({ ok: true, prompt: getBucketImportPrompt(db), default_prompt: DEFAULT_BUCKET_IMPORT_PROMPT });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.put('/api/settings/bucket-import-prompt', (req, res) => {
    const db = openDb();
    try {
      const prompt = String((req.body || {}).prompt || '').trim();
      if (!prompt) return res.json({ ok: false, error: 'prompt required' });
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('bucket_import_prompt', ?, datetime('now'))").run(prompt);
      res.json({ ok: true, prompt });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.post('/api/settings/bucket-import-prompt/reset', (req, res) => {
    const db = openDb();
    try {
      db.prepare("DELETE FROM app_settings WHERE key='bucket_import_prompt'").run();
      res.json({ ok: true, prompt: DEFAULT_BUCKET_IMPORT_PROMPT });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/buckets — list all buckets (sorted by decay score)
  app.get('/api/buckets', (req, res) => {
    const db = openDb(true);
    try {
      const { type, resolved, domain, state, status, include_feel, include_deleted } = req.query;
      const wantedState = String(state || status || '').trim().toLowerCase();
      let sql = "SELECT * FROM buckets";
      const conds = [], params = [];
      if (type)     { conds.push("bucket_type=?"); params.push(type); }
      else if (wantedState === 'feel') conds.push("bucket_type='feel'");
      else if (include_feel !== 'true') conds.push("bucket_type NOT IN ('archive','feel','self')");
      else conds.push("bucket_type NOT IN ('archive','self')");
      if (include_deleted !== 'true') conds.push('deleted_at IS NULL');
      if (resolved !== undefined) { conds.push("resolved=?"); params.push(Number(resolved)); }
      if (wantedState === 'active') { conds.push("COALESCE(resolved,0)=0"); conds.push("COALESCE(digested,0)=0"); conds.push("bucket_type NOT IN ('archive','feel','self')"); }
      if (wantedState === 'quiet') { conds.push("COALESCE(resolved,0)=1"); conds.push("COALESCE(digested,0)=0"); conds.push("bucket_type NOT IN ('archive','feel','self')"); }
      if (wantedState === 'digested') { conds.push("COALESCE(digested,0)=1"); conds.push("bucket_type NOT IN ('archive','feel','self')"); }
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      sql += ' ORDER BY created_at DESC';

      let rows = db.prepare(sql).all(...params).map(parseBucket);
      if (domain) rows = rows.filter(b => b.domain.some(d => d.includes(domain)));
      rows.sort((a, b) => b.score - a.score);   // 钉选(999)置顶；其余按记忆曲线分(近期+重要)降序
      res.json({ ok: true, data: rows });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/self — 伴侣的自我认知版本链（version 升序：老→新），只读
  app.get('/api/self', (req, res) => {
    const db = openDb(true);
    try {
      const rows = db.prepare("SELECT * FROM buckets WHERE bucket_type='self' AND deleted_at IS NULL").all().map(parseBucket);
      const data = rows.map(b => ({
        id: b.id,
        version: Number(b.metadata && b.metadata.version) || 0,
        content: (b.content || '').trim(),
        summary: (b.metadata && b.metadata.summary) || '',
        prev_id: (b.metadata && b.metadata.prev_id) || null,
        created_at: b.created_at,
      })).sort((a, b) => a.version - b.version);
      res.json({ ok: true, data });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/buckets/stats — summary for Ombre Dashboard
  app.get('/api/buckets/stats', (req, res) => {
    const db = openDb(true);
    try {
      const active = ordinaryWhere();
      const total      = db.prepare(`SELECT COUNT(*) as n FROM buckets WHERE ${active}`).get().n;
      const activeCount = db.prepare(`SELECT COUNT(*) as n FROM buckets WHERE COALESCE(resolved,0)=0 AND COALESCE(digested,0)=0 AND ${active}`).get().n;
      const quiet       = db.prepare(`SELECT COUNT(*) as n FROM buckets WHERE COALESCE(resolved,0)=1 AND COALESCE(digested,0)=0 AND ${active}`).get().n;
      const digested    = db.prepare(`SELECT COUNT(*) as n FROM buckets WHERE COALESCE(digested,0)=1 AND ${active}`).get().n;
      const unresolved = activeCount;
      const resolved   = quiet + digested;
      const feel       = db.prepare("SELECT COUNT(*) as n FROM buckets WHERE bucket_type='feel'").get().n;
      const pinned     = db.prepare(`SELECT COUNT(*) as n FROM buckets WHERE pinned=1 AND ${active}`).get().n;
      const dreamRows = db.prepare(`SELECT metadata FROM buckets WHERE ${active}`).all();
      const sourceOfFeel = dreamRows
        .filter(r => tryParse(r.metadata, {})?.dream?.source_of_feel === true).length;
      const dreamReviewed = dreamRows.filter(r => isDreamReviewedMetadata(tryParse(r.metadata, {}))).length;

      // Domain distribution
      const domainMap = {};
      db.prepare(`SELECT domain FROM buckets WHERE ${active}`).all().forEach(r => {
        tryParse(r.domain, []).forEach(d => { domainMap[d] = (domainMap[d]||0)+1; });
      });
      const domains = Object.entries(domainMap).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}));

      // Emotion quadrants
      const q = {'愉悦/激动':0,'愉悦/平静':0,'消沉/平静':0,'消沉/激动':0};
      db.prepare(`SELECT valence, arousal FROM buckets WHERE ${active}`).all().forEach(r => {
        const hv = r.valence >= 0.5, ha = r.arousal >= 0.5;
        if (hv && ha) q['愉悦/激动']++;
        else if (hv)  q['愉悦/平静']++;
        else if (!ha) q['消沉/平静']++;
        else          q['消沉/激动']++;
      });
      const emotions = Object.entries(q).map(([label, count]) => ({ label, count }));

      // Importance distribution — 返回1-10每级 + 三段式兼容
      const impByLevel = {};
      for (let i = 1; i <= 10; i++) impByLevel[i] = 0;
      const imp = { I: 0, II: 0, III: 0 };
      db.prepare(`SELECT importance FROM buckets WHERE ${active}`).all().forEach(r => {
        const v = Math.max(1, Math.min(10, r.importance || 5));
        impByLevel[v] = (impByLevel[v] || 0) + 1;
        if (v >= 8) imp.III++;
        else if (v >= 4) imp.II++;
        else imp.I++;
      });

      // Monthly (last 6 months, using occurred_at)
      const monthly = db.prepare(`
        SELECT substr(coalesce(occurred_at, created_at), 1, 7) as month, COUNT(*) as count
        FROM buckets WHERE ${active}
        GROUP BY month ORDER BY month DESC LIMIT 6
      `).all().reverse();

      res.json({ ok: true, data: { total, active: activeCount, quiet, unresolved, resolved, digested, feel, source_of_feel: sourceOfFeel, sourceOfFeel, dream_reviewed: dreamReviewed, dreamReviewed, pinned, domains, emotions, importance: Object.assign({}, impByLevel, { I: imp.I, II: imp.II, III: imp.III }), monthly } });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/buckets/breath — surface top unresolved (for Casa breath window)
  // 前12条按score排，后3条从旧记忆随机闪回
  app.get('/api/buckets/breath', async (req, res) => {
    const db = openDb(true);
    try {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || req.query.top) || 15));
      const domain = String(req.query.domain || '').trim().toLowerCase();
      const query = String(req.query.q || req.query.query || '').trim().toLowerCase();
      const includeDigested = req.query.include_digested === 'true';
      const includeQuiet = req.query.include_quiet === 'true';

      // Feel is a separate channel. Keep this before empty-query surfacing.
      if (domain === 'feel') {
        let rows;
        if (query) {
          try {
            const mod = embedding();
            if (typeof mod.semanticSearch !== 'function') throw new Error('semanticSearch unavailable');
            rows = await mod.semanticSearch(query, limit, { domain: 'feel', include_feel: true });
            if (rows.length) return res.json({ ok: true, domain: 'feel', data: rows.map(parseBucket), fallback: false });
            throw new Error('no feel vector match');
          } catch(e) {
            const mod = embedding();
            if (typeof mod.keywordSearch === 'function') {
              rows = mod.keywordSearch(query, limit, { domain: 'feel', include_feel: true });
            } else {
              const like = `%${query}%`;
              rows = db.prepare(`
                SELECT * FROM buckets
                WHERE bucket_type='feel'
                  AND (lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)
                ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
                LIMIT ?
              `).all(like, like, like, like, limit);
            }
            return res.json({ ok: true, domain: 'feel', data: rows.map(parseBucket), fallback: 'keyword', reason: e.message });
          }
        } else {
          rows = db.prepare(`
            SELECT * FROM buckets
            WHERE bucket_type='feel'
            ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
            LIMIT ?
          `).all(limit);
        }
        return res.json({ ok: true, domain: 'feel', data: rows.map(parseBucket) });
      }

      if (query) {
        let rows = [];
        let fallback = false;
        let reason = '';
        try {
          const mod = embedding();
          if (typeof mod.semanticSearch !== 'function') throw new Error('semanticSearch unavailable');
          rows = await mod.semanticSearch(query, limit * 2, {
            domain,
            include_digested: includeDigested,
            include_quiet: includeQuiet,
          });
        } catch(e) {
          fallback = 'keyword';
          reason = e.message;
          const mod = embedding();
          if (typeof mod.keywordSearch === 'function') {
            rows = mod.keywordSearch(query, limit * 2, {
              domain,
              include_digested: includeDigested,
              include_quiet: includeQuiet,
            });
          } else {
            const like = `%${query}%`;
            rows = db.prepare(`
              SELECT * FROM buckets
              WHERE ${breathWhere('', { include_digested: includeDigested, include_quiet: includeQuiet })}
                AND (lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)
              ORDER BY created_at DESC
              LIMIT ?
            `).all(like, like, like, like, limit * 2);
          }
        }
        rows = rows.map(parseBucket)
          .filter(b => !domain || b.domain.some(d => String(d).toLowerCase().includes(domain)))
          .map(b => {
            const scorePart = Math.min(1, Math.max(0, (b.score || 0) / 12));
            const simPart = Number(b.similarity || 0);
            const pinPart = b.pinned ? 0.2 : 0;
            return { ...b, rank: Math.round((simPart * 0.72 + scorePart * 0.2 + pinPart) * 1000) / 1000, fallback };
          })
          .sort((a,b) => (b.rank || 0) - (a.rank || 0))
          .slice(0, limit);
        touchBucketIds(rows.map(r => r.id || r.bucket_id));
        return res.json({ ok: true, data: rows, fallback, reason });
      }

      const mainCount = Math.min(12, limit);
      const flashbackCount = Math.max(0, limit - mainCount);
      const allRows = db.prepare(`
        SELECT * FROM buckets WHERE ${breathWhere('', { include_digested: includeDigested, include_quiet: includeQuiet })}
      `).all().map(parseBucket)
        .filter(b => !domain || b.domain.some(d => String(d).toLowerCase().includes(domain)))
        .sort((a,b) => b.score - a.score);   // 记忆曲线分（近期+重要）降序，近期事件自然靠前
      const mainSlots = allRows.slice(0, mainCount);
      const mainIds = new Set(mainSlots.map(r => r.id));
      // 从剩余记忆中按importance加权随机抽取闪回
      const remaining = allRows.slice(mainCount).filter(r => !mainIds.has(r.id));
      const flashbacks = [];
      if (remaining.length > 0 && flashbackCount > 0) {
        const pick = Math.min(flashbackCount, remaining.length);
        const weights = remaining.map(r => Math.max(1, r.importance || 5));
        const totalW = weights.reduce((a,b) => a+b, 0);
        const chosen = new Set();
        for (let i = 0; i < pick; i++) {
          let rand = Math.random() * totalW;
          for (let j = 0; j < remaining.length; j++) {
            if (chosen.has(j)) continue;
            rand -= weights[j];
            if (rand <= 0) { chosen.add(j); flashbacks.push({...remaining[j], _flashback: true}); break; }
          }
        }
      }
      const output = [...mainSlots, ...flashbacks];
      res.json({ ok: true, data: output });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/buckets/search?q=
  app.get('/api/buckets/search', (req, res) => {
    const db = openDb(true);
    try {
      const q = (req.query.q || '').toLowerCase().trim();
      if (!q) return res.json({ ok: true, data: [] });
      const like = `%${q}%`;
      const rows = db.prepare(`
        SELECT * FROM buckets WHERE ${searchableOrdinaryWhere()}
        AND (lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)
        ORDER BY created_at DESC LIMIT 20
      `).all(like, like, like, like).map(parseBucket).sort((a,b) => b.score - a.score);
      const slim = rows.map(b => {
        const match = (b.content||'').match(/---RIFUGIO---\n摘要[：:](.*?)\n/);
        return {
          id: b.id, name: b.name,
          summary: match ? match[1].trim() : (b.content||'').slice(0,100) + '…',
          tags: b.tags, domain: b.domain,
          importance: b.importance, occurred_at: b.occurred_at, score: b.score
        };
      });
      res.json({ ok: true, data: slim });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // POST /api/buckets/dream — legacy/backfill Dream for old ordinary memories.
  // New memories should be reflected by Claude through MCP dream(), not this LLM batch path.
  app.post('/api/buckets/dream', async (req, res) => {
    try {
      const body = req.body || {};
      const hasManualAnalysis = body.analysis !== undefined;
      const includeNew = body.include_new === true || body.includeNew === true ||
        req.query.include_new === 'true' || req.query.includeNew === 'true' ||
        ['all', 'review', 'current'].includes(String(body.mode || req.query.mode || '').toLowerCase());
      const cutoff = includeNew
        ? ''
        : (body.cutoff || body.before || body.until || req.query.cutoff || req.query.before || req.query.until || (hasManualAnalysis ? '' : DEFAULT_BACKFILL_DREAM_CUTOFF));
      const result = await runDreamCycle({ ...body, limit: body.limit || req.query.limit, cutoff });
      res.json(result);
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

  // GET /api/buckets/feel — dedicated feel channel
  app.get('/api/buckets/feel', async (req, res) => {
    const db = openDb(true);
    try {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || req.query.top) || 20));
      const query = String(req.query.q || req.query.query || '').trim().toLowerCase();
      let rows;
      if (query) {
        try {
          const mod = embedding();
          if (typeof mod.semanticSearch !== 'function') throw new Error('semanticSearch unavailable');
          rows = await mod.semanticSearch(query, limit, { domain: 'feel', include_feel: true });
          if (rows.length) return res.json({ ok: true, data: rows.map(parseBucket), fallback: false });
          throw new Error('no feel vector match');
        } catch(e) {
          const mod = embedding();
          if (typeof mod.keywordSearch === 'function') {
            rows = mod.keywordSearch(query, limit, { domain: 'feel', include_feel: true });
          } else {
            const like = `%${query}%`;
            rows = db.prepare(`
              SELECT * FROM buckets
              WHERE bucket_type='feel'
                AND (lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)
              ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
              LIMIT ?
            `).all(like, like, like, like, limit);
          }
          return res.json({ ok: true, data: rows.map(parseBucket), fallback: 'keyword', reason: e.message });
        }
      } else {
        rows = db.prepare(`
          SELECT * FROM buckets
          WHERE bucket_type='feel'
          ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
          LIMIT ?
        `).all(limit);
      }
      res.json({ ok: true, data: rows.map(parseBucket) });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/buckets/deleted — recoverable recycle bin (30 days)
  app.get('/api/buckets/deleted', (req, res) => {
    const db = openDb();
    try {
      const purged = purgeExpiredSoftDeleted(db);
      const rows = db.prepare(`
        SELECT * FROM buckets
        WHERE deleted_at IS NOT NULL
        ORDER BY datetime(deleted_at) DESC
      `).all().map(parseBucket);
      res.json({ ok: true, retention_days: SOFT_DELETE_RETENTION_DAYS, purged, data: rows });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // GET /api/buckets/:id
  app.get('/api/buckets/:id', (req, res) => {
    const db = openDb(true);
    try {
      const row = db.prepare('SELECT * FROM buckets WHERE id=? AND deleted_at IS NULL').get(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, data: parseBucket(row) });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // POST /api/buckets/:id/restore — restore a soft-deleted bucket within 30 days
  app.post('/api/buckets/:id/restore', (req, res) => {
    const db = openDb();
    try {
      purgeExpiredSoftDeleted(db);
      const row = db.prepare('SELECT * FROM buckets WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'not found or restore window expired' });
      const metadata = normalizeMetadata(row.metadata, {});
      const tombstone = metadata.soft_delete || {};
      const original = tombstone.original || {};
      const restoredTypeRaw = String(original.bucket_type || metadata.type || 'dynamic').toLowerCase();
      const restoredType = RESTORABLE_BUCKET_TYPES.has(restoredTypeRaw) ? restoredTypeRaw : 'dynamic';
      const restoredResolved = original.resolved ? 1 : 0;
      const restoredDigested = original.digested ? 1 : 0;
      const restoredDigestedAt = original.digested_at || null;
      const restoredPinned = original.pinned ? 1 : 0;
      metadata.type = restoredType;
      metadata.soft_delete = { ...tombstone, restored_at: new Date().toISOString() };
      db.prepare(`
        UPDATE buckets
        SET deleted_at=NULL, bucket_type=?, resolved=?, digested=?, digested_at=?, pinned=?, metadata=?
        WHERE id=? AND deleted_at IS NOT NULL
      `).run(restoredType, restoredResolved, restoredDigested, restoredDigestedAt, restoredPinned, toJson(metadata), row.id);
      const restored = db.prepare('SELECT * FROM buckets WHERE id=?').get(row.id);
      if (restoredType !== 'archive') scheduleBucketEmbedding(row.id, 'restored');
      res.json({ ok: true, data: parseBucket(restored) });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // POST /api/buckets/hold — create a normal memory, or a feel when feel=true
  app.post('/api/buckets/hold', (req, res) => {
    const db = openDb();
    try {
      const body = req.body || {};
      // MCP hold may create only an ordinary memory or a feel; callers cannot smuggle self/archive types.
      const data = insertBucket(db, { ...body, bucket_type: isFeelInput(body) ? 'feel' : 'dynamic' });
      res.json({ ok: true, data });
    } catch(e) { res.status(400).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // POST /api/buckets — create
  app.post('/api/buckets', (req, res) => {
    const db = openDb();
    try {
      const { name } = req.body || {};
      if (!name) return res.json({ ok: false, error: 'name required' });
      res.json({ ok: true, data: insertBucket(db, req.body || {}) });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // PATCH /api/buckets/:id — update any fields
  app.patch('/api/buckets/:id', (req, res) => {
    const db = openDb();
    try {
      const existing = db.prepare('SELECT * FROM buckets WHERE id=? AND deleted_at IS NULL').get(req.params.id);
      if (!existing) return res.status(404).json({ ok: false, error: 'not found' });

      const allowed = ['name','content','valence','arousal','domain','tags',
                       'importance','bucket_type','metadata','occurred_at','resolved','digested','digested_at','pinned','personas'];
      const sets = [], params = [];
      let shouldRefreshVector = false;
      for (const f of allowed) {
        if (req.body[f] === undefined) continue;
        if (f === 'importance' && existing.pinned) continue; // pinned → importance locked
        let v = req.body[f];
        if (['domain','tags','personas','metadata'].includes(f)) v = toJson(v);
        if (f === 'valence' || f === 'arousal') v = Math.max(0,Math.min(1,v));
        if (f === 'importance') v = Math.max(1,Math.min(10,v));
        if (f === 'resolved' || f === 'pinned' || f === 'digested') v = v ? 1 : 0;
        if (['name','content','domain','tags','bucket_type'].includes(f)) shouldRefreshVector = true;
        sets.push(`${f}=?`); params.push(v);
      }
      if (!sets.length) return res.json({ ok: false, error: 'nothing to update' });
      params.push(req.params.id);
      db.prepare(`UPDATE buckets SET ${sets.join(',')} WHERE id=?`).run(...params);
      const updated = parseBucket(db.prepare('SELECT * FROM buckets WHERE id=?').get(req.params.id));
      if (shouldRefreshVector) {
        if (updated.bucket_type === 'archive') {
          db.prepare('DELETE FROM bucket_vectors WHERE bucket_id=?').run(req.params.id);
        } else {
          invalidateBucketEmbedding(req.params.id, 'patched');
        }
      }
      res.json({ ok: true, data: updated });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // POST /api/buckets/:id/touch — activate
  app.post('/api/buckets/:id/touch', (req, res) => {
    const db = openDb();
    try {
      const before = db.prepare('SELECT activation_count FROM buckets WHERE id=?').get(req.params.id);
      touchBuckets(db, [req.params.id]);
      const after = db.prepare('SELECT activation_count FROM buckets WHERE id=?').get(req.params.id);
      res.json({ ok: true, touched: !!before && !!after && after.activation_count !== before.activation_count });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  function updateBucketStatus(req, res, status) {
    const db = openDb();
    try {
      const patch = statusToPatch(status);
      if (!patch) return res.json({ ok: false, error: 'unknown status' });
      const info = db.prepare('UPDATE buckets SET resolved=?, digested=?, digested_at=? WHERE id=? AND deleted_at IS NULL')
        .run(patch.resolved, patch.digested, patch.digested_at, req.params.id);
      if (!info.changes) return res.status(404).json({ ok: false, error: 'not found' });
      const row = db.prepare('SELECT * FROM buckets WHERE id=? AND deleted_at IS NULL').get(req.params.id);
      res.json({ ok: true, data: parseBucket(row) });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  }

  // POST /api/buckets/:id/quiet — resolved=1 compatibility, shown as 已沉底
  app.post('/api/buckets/:id/quiet', (req, res) => updateBucketStatus(req, res, 'quiet'));

  // POST /api/buckets/:id/activate — return to active surfacing
  app.post('/api/buckets/:id/activate', (req, res) => updateBucketStatus(req, res, 'active'));

  // POST /api/buckets/:id/digest — mark as dream-digested
  app.post('/api/buckets/:id/digest', (req, res) => updateBucketStatus(req, res, 'digested'));

  // POST /api/buckets/:id/resolve — legacy alias for quiet
  app.post('/api/buckets/:id/resolve', (req, res) => {
    updateBucketStatus(req, res, 'quiet');
  });

  // POST /api/buckets/:id/archive
  app.post('/api/buckets/:id/archive', (req, res) => {
    const db = openDb();
    try {
      const info = db.prepare("UPDATE buckets SET bucket_type='archive' WHERE id=? AND deleted_at IS NULL").run(req.params.id);
      if (!info.changes) return res.status(404).json({ ok: false, error: 'not found' });
      db.prepare("DELETE FROM bucket_vectors WHERE bucket_id=?").run(req.params.id);
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // DELETE /api/buckets/:id — soft delete; recoverable for 30 days
  app.delete('/api/buckets/:id', (req, res) => {
    const db = openDb();
    try {
      purgeExpiredSoftDeleted(db);
      const row = db.prepare('SELECT * FROM buckets WHERE id=? AND deleted_at IS NULL').get(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      const deletedAt = new Date().toISOString();
      const restoreUntil = new Date(Date.now() + SOFT_DELETE_RETENTION_DAYS * 86400000).toISOString();
      const metadata = normalizeMetadata(row.metadata, {});
      metadata.soft_delete = {
        deleted_at: deletedAt,
        restore_until: restoreUntil,
        original: {
          bucket_type: row.bucket_type,
          resolved: !!row.resolved,
          digested: !!row.digested,
          digested_at: row.digested_at || null,
          pinned: !!row.pinned,
        },
      };
      db.transaction(() => {
        db.prepare(`
          UPDATE buckets
          SET deleted_at=?, bucket_type='archive', resolved=1, metadata=?
          WHERE id=? AND deleted_at IS NULL
        `).run(deletedAt, toJson(metadata), row.id);
        // Keep the vector for lossless restore, but stop queued embedding work while deleted.
        db.prepare('DELETE FROM embedding_jobs WHERE bucket_id=?').run(row.id);
      })();
      res.json({ ok: true, deleted_at: deletedAt, restore_until: restoreUntil });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // ── POST /api/buckets/import ──────────────────────────────────────────────
  // 支持 Claude.ai 插件导出 MD / ChatGPT JSON / Claude JSON / TXT
  // 自动按对话轮次分块，每块 ~10 组对话，大文件多次调 LLM 合并结果
  app.post('/api/buckets/import', async (req, res) => {
    const db = openDb();
    try {
      const {
        content, filename = '', format = 'auto',
        personas = { user: '用户', ai: '伴侣' },
        dry_run = false,
        llm_base_url, llm_api_key, llm_model
      } = req.body;

      if (!content) return res.json({ ok: false, error: 'content required' });

      // 1. 从文件名提取日期
      let fileDate = null;
      const dm = filename.match(/(\d{4})[-._](\d{2})[-._](\d{2})/);
      if (dm) fileDate = `${dm[1]}-${dm[2]}-${dm[3]}`;

      // 2. LLM 配置
      const { baseUrl, model, apiKey } = getLLMConfig(db, { llm_base_url, llm_api_key, llm_model });
      if (!apiKey) return res.json({ ok: false, error: 'no LLM API key configured' });

      // 3. 格式检测 + 解析成对话轮次数组
      const detectedFormat = format === 'auto' ? detectFormat(filename, content) : format;
      let turns = []; // [{ role, text, date }]

      if (detectedFormat === 'json') {
        turns = parseJsonToTurns(content, personas);
      } else {
        turns = parseClaudeMarkdownToTurns(content, personas);
      }

      if (!turns.length) {
        return res.json({ ok: false, error: '未能从文件中解析出对话内容，请检查格式' });
      }

      // 4. 分块策略：Gemini 2.5 Pro 有 100万 token 上下文，小文件直接一次发
      //    文本 < 800KB 一次性处理，更大的才分块（每块 50 组对话）
      const CHUNK_SIZE = 50;
      const ONE_SHOT_LIMIT = 800000; // 800KB chars ≈ ~200k tokens，Gemini 完全能吃
      const chunks = [];

      const fullText = turns.map(t => `[${t.date||''}] ${t.role}: ${t.text}`).join('\n\n');

      if (fullText.length <= ONE_SHOT_LIMIT) {
        // 一次性处理
        chunks.push({ text: fullText, startDate: turns[0]?.date || fileDate });
      } else {
        // 超大文件才分块
        for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
          const slice = turns.slice(i, i + CHUNK_SIZE);
          const text = slice.map(t => `[${t.date||''}] ${t.role}: ${t.text}`).join('\n\n');
          if (text.trim().length > 100) chunks.push({ text, startDate: slice[0]?.date || fileDate });
        }
      }

      const systemPrompt = `${getBucketImportPrompt(db)}

【当前导入上下文】
- 用户真实姓名：「${personas.user}」。禁止写"用户""User"。
- AI名字：「${personas.ai}」。叙述AI的行为/想法/对话时，统一用第一人称"我"。绝对禁止在正文/摘要里用「${personas.ai}」「Claude」等第三人称指代AI自己（产品名如 Claude Code、命令行 claude 除外）。
- occurred_at 提取不到时用 "${fileDate || new Date().toISOString().slice(0,10)}".`;

      // 5. 依次处理每个 chunk
      const allBuckets = [];
      const errors = [];

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        try {
          const llmResp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
              model, temperature: 0.15, max_tokens: 8000,
              messages: [
                { role: 'system', content: stripLoneSurrogates(systemPrompt) },
                { role: 'user', content: stripLoneSurrogates(`对话片段 ${ci+1}/${chunks.length}：\n\n${chunk.text.slice(0, 900000)}`) }
              ]
            })
          });

          if (!llmResp.ok) {
            const errBody = await llmResp.text().catch(() => '');
            console.error(`[bucket-import] chunk${ci+1} LLM ${llmResp.status} model=${model} base=${baseUrl} body=${errBody.slice(0, 600)}`);
            errors.push(`chunk${ci+1}: LLM ${llmResp.status} ${errBody.slice(0, 300)}`);
            continue;
          }

          const llmData = await llmResp.json();
          const raw = llmData.choices?.[0]?.message?.content || '[]';

          let parsed;
          const cleaned = raw.replace(/```json|```/g, '').trim();
          try {
            parsed = JSON.parse(cleaned);
          } catch(e) {
            // DeepSeek 偶发在数组外再包一层说明文字/残缺字符——截最外层 [] 再试一次
            const s = cleaned.indexOf('['), t = cleaned.lastIndexOf(']');
            try { parsed = (s > -1 && t > s) ? JSON.parse(cleaned.slice(s, t + 1)) : null; }
            catch(e2) { parsed = null; }
            if (parsed === null) {
              console.error(`[bucket-import] chunk${ci+1} JSON parse fail, raw head: ${cleaned.slice(0, 300)}`);
              errors.push(`chunk${ci+1}: JSON parse fail`);
              continue;
            }
          }
          if (!Array.isArray(parsed)) parsed = [];

          // 没有日期的用 chunk 的起始日期补；同时规范化候选字段。
          parsed = parsed.map(raw => {
            const b = raw && typeof raw === 'object' ? raw : {};
            return normalizeImportItem(
              { ...b, occurred_at: b.occurred_at || chunk.startDate || fileDate },
              chunk.startDate || fileDate
            );
          }).filter(b => b.content);
//          const aiAlias = personas.ai || 'Claude';
//          parsed.forEach(b => {
//            if (!b.occurred_at) b.occurred_at = chunk.startDate || fileDate;
//            // 无论 LLM 用什么名字写 AI，统一替换为目标人称
//            const normalize = (s) => s ? s
//              .replace(/克劳德/g, aiAlias)
//              .replace(/\bClaude\b/g, aiAlias)
//              .replace(/\bclaude\b/g, aiAlias)
//              .replace(/伴侣/g, aiAlias) : s;
//            b.content  = normalize(b.content);
//            b.summary  = normalize(b.summary);
//            if (Array.isArray(b.original_quotes))
//              b.original_quotes = b.original_quotes.map(normalize);
//          });
          allBuckets.push(...parsed);

          // 300ms 间隔防限速
          if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
        } catch(e) {
          errors.push(`chunk${ci+1}: ${e.message}`);
        }
      }

      if (dry_run) {
        return res.json({ ok: true, dry_run: true, preview: true, count: allBuckets.length, chunks: chunks.length, buckets: allBuckets, candidates: allBuckets, errors });
      }

      // 6. 写入数据库
      const now = new Date().toISOString();
      const created = [];
      db.transaction(() => {
        for (const b of allBuckets) {
          const row = insertBucket(db, {
            name: b.name || '未命名',
            content: buildEnrichedContent(b),
            valence: b.valence ?? 0.5,
            arousal: b.arousal ?? 0.3,
            domain: b.domain || [],
            tags: b.tags || [],
            importance: b.importance || 5,
            bucket_type: 'dynamic',
            occurred_at: b.occurred_at || fileDate || now,
            personas: { user: personas.user, ai: personas.ai },
            source: 'import',
            defer_embedding: true,
          });
          created.push({ id: row.id, name: row.name, occurred_at: row.occurred_at, summary: b.summary, deduped: row.deduped });
        }
      })();
      created.filter(b => !b.deduped).forEach(b => scheduleBucketEmbedding(b.id, 'import'));

      res.json({ ok: true, created: created.length, chunks: chunks.length, errors, format: detectedFormat, buckets: created });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // POST /api/buckets/import-confirm — write edited preview candidates only.
  app.post('/api/buckets/import-confirm', (req, res) => {
    const db = openDb();
    try {
      const { items = [], personas = { user: '用户', ai: '伴侣' } } = req.body || {};
      if (!Array.isArray(items)) return res.json({ ok: false, error: 'items required' });
      const selected = items
        .filter(item => item && item.selected !== false)
        .map(item => normalizeImportItem(item))
        .filter(item => item.content);

      const now = new Date().toISOString();
      const created = [];
      const skippedDuplicates = [];
      db.transaction(() => {
        for (const b of selected) {
          const lightDuplicate = findLightImportDuplicate(db, b);
          if (lightDuplicate) {
            skippedDuplicates.push({
              name: b.name || '未命名',
              duplicate_of: lightDuplicate.id,
              duplicate_name: lightDuplicate.name,
              similarity: lightDuplicate.similarity,
            });
            continue;
          }
          const row = insertBucket(db, {
            name: b.name || '未命名',
            content: buildEnrichedContent(b),
            valence: b.valence ?? 0.5,
            arousal: b.arousal ?? 0.3,
            domain: b.domain || [],
            tags: b.tags || [],
            importance: b.importance || 5,
            bucket_type: 'dynamic',
            occurred_at: b.occurred_at || now,
            personas: { user: personas.user, ai: personas.ai },
            source: 'import-confirm',
            defer_embedding: true,
          });
          created.push({ id: row.id, name: row.name, occurred_at: row.occurred_at, summary: b.summary, deduped: row.deduped });
        }
      })();
      created.filter(b => !b.deduped).forEach(b => scheduleBucketEmbedding(b.id, 'import-confirm'));
      if (created.some(b => !b.deduped)) runPostImportDedupSoon(Math.min(50, Math.max(10, created.length)));
      res.json({ ok: true, created: created.length, buckets: created, skipped_duplicates: skippedDuplicates });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  console.log('[buckets] Routes mounted on /api/buckets');
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function detectFormat(filename, content) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'txt';
  try { JSON.parse(content); return 'json'; } catch(e) {}
  return 'markdown';
}

// 解析 Claude.ai 插件导出的 Markdown 格式
// ## Prompt:\n2026/4/26 19:24:11\n内容\n## Response:\n时间\n内容
function cleanMarkdownTurnText(text) {
  return String(text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/(`{3,})([^\n`]*)\n([\s\S]*?)\n\1/g, (match, fence, info, body) => {
      const lang = String(info || '').trim().toLowerCase();
      if (/(^|\b)(thinking|thought|reasoning|chain-of-thought|cot)(\b|$)/.test(lang)) return '';
      if (body.length > 4000) {
        return `${fence}${info || ''}\n${body.slice(0, 4000)}\n[code block truncated]\n${fence}`;
      }
      return match;
    });
}

function parseClaudeMarkdownToTurns(content, personas) {
  const turns = [];

  // 从文件头提取日期
  let headerDate = null;
  const createdMatch = content.match(/\*\*Created:\*\*\s*(\d+)\/(\d+)\/(\d+)/);
  if (createdMatch) {
    headerDate = `${createdMatch[3]}-${createdMatch[1].padStart(2,'0')}-${createdMatch[2].padStart(2,'0')}`;
  }

  const sections = content.split(/\n## (Prompt|Response):\n/);
  let currentRole = null;

  for (let i = 0; i < sections.length; i++) {
    const part = sections[i];
    if (part === 'Prompt') { currentRole = personas.user; continue; }
    if (part === 'Response') { currentRole = personas.ai; continue; }
    if (!currentRole) continue;

    const lines = part.trim().split('\n');
    let date = headerDate;
    let textStart = 0;

    // 第一行可能是时间戳 "2026/4/26 19:24:11"
    const dateLine = lines[0]?.trim();
    const dm = dateLine?.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (dm) {
      date = `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`;
      textStart = 1;
    }

    let text = cleanMarkdownTurnText(lines.slice(textStart).join('\n')).trim();

    if (text.length > 5) turns.push({ role: currentRole, text, date });
    currentRole = null;
  }

  return turns;
}

// 解析 Claude JSON / ChatGPT JSON 导出为 turns
function parseJsonToTurns(content, personas) {
  let data;
  try { data = JSON.parse(content); } catch(e) { return []; }
  const turns = [];

  if (data.chat_messages) {
    for (const msg of data.chat_messages) {
      const role = msg.sender === 'human' ? personas.user : personas.ai;
      const text = Array.isArray(msg.content)
        ? msg.content.map(c => c.text || '').join(' ')
        : (msg.text || msg.content || '');
      const date = msg.created_at ? msg.created_at.slice(0,10) : null;
      if (text.trim()) turns.push({ role, text: text.trim(), date });
    }
    return turns;
  }

  if (data.mapping) {
    const nodes = Object.values(data.mapping)
      .filter(n => n.message?.content?.parts?.length)
      .sort((a,b) => (a.message.create_time||0)-(b.message.create_time||0));
    for (const node of nodes) {
      const msg = node.message;
      const role = msg.author?.role === 'user' ? personas.user : personas.ai;
      const text = msg.content.parts.join(' ').trim();
      const date = msg.create_time ? new Date(msg.create_time*1000).toISOString().slice(0,10) : null;
      if (text) turns.push({ role, text, date });
    }
    return turns;
  }

  // Rifugio 内部存储格式: { messages: [{role, time, say}] }
  if (Array.isArray(data.messages) && data.messages.length > 0 && data.messages[0].say !== undefined) {
    for (const msg of data.messages) {
      const role = msg.role === 'human' ? personas.user : personas.ai;
      let text = msg.say || '';
      // 去掉 assistant thinking chain（"xxx\nDone\n\n实际回复"）
      if (msg.role === 'assistant') {
        const doneIdx = text.indexOf('Done\n\n');
        if (doneIdx !== -1) text = text.slice(doneIdx + 7).trim();
      }
      // 解析时间格式 "6/3/2026 4:00:45" → "2026-06-03"
      let date = null;
      if (msg.time) {
        const m = msg.time.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) date = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
      }
      if (text.trim().length > 3) turns.push({ role, text: text.trim(), date });
    }
    if (turns.length) return turns;
  }

  // 兜底：顶层是数组 [{role, say/content}]
  if (Array.isArray(data)) {
    for (const msg of data) {
      if (!msg.role) continue;
      const role = (msg.role === 'human' || msg.role === 'user') ? personas.user : personas.ai;
      const text = (msg.say || msg.content || msg.text || '').toString().trim();
      let date = null;
      if (msg.time) {
        const m = msg.time.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) date = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
      }
      if (text.length > 3) turns.push({ role, text, date });
    }
    if (turns.length) return turns;
  }

  return [];
}

// 把 LLM 返回的 bucket 序列化成富文本 content（含摘要/关键词/原句）
function buildEnrichedContent(b) {
  const parts = [b.content || ''];
  if (b.summary) parts.push(`\n---RIFUGIO---\n摘要：${b.summary}`);
  if (b.reason) parts.push(`保存理由：${b.reason}`);
  if (Array.isArray(b.keywords) && b.keywords.length) parts.push(`关键词：${b.keywords.join(' · ')}`);
  if (Array.isArray(b.original_quotes) && b.original_quotes.length) {
    parts.push(`原句：\n${b.original_quotes.map(q => `"${q}"`).join('\n')}`);
  }
  return parts.join('\n');
}

module.exports = {
  initBuckets,
  mountBucketRoutes,
  calcScore,
  parseBucket,
  insertBucket,
  runDreamCycle,
  statusToPatch,
  purgeExpiredSoftDeleted,
};
