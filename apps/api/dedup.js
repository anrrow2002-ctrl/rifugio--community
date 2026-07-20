// ============================================================
// dedup.js — Rifugio bucket dedup module
// ============================================================
const Database = require('./modules/sqlite');
const { blobToVec, cosineSim } = require('./embedding');

function tryParse(str, fallback) {
  try { return JSON.parse(str || ''); } catch(e) { return fallback; }
}

function toJson(v) {
  return JSON.stringify(v || {});
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\n---RIFUGIO---[\s\S]*$/m, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenSet(s) {
  return new Set(normalizeText(s).split(/[\s,，。！？!?:：;；、·|/\\()[\]{}"']+/).filter(Boolean));
}

function jaccard(a, b) {
  const aa = tokenSet(a), bb = tokenSet(b);
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit++;
  return hit / Math.max(aa.size, bb.size);
}

function textSimilarity(a, b) {
  const name = jaccard(a.name, b.name);
  const content = jaccard(a.content, b.content);
  const tags = jaccard(JSON.stringify(a.tags || []), JSON.stringify(b.tags || []));
  const domain = jaccard(JSON.stringify(a.domain || []), JSON.stringify(b.domain || []));
  const sameDay = (a.occurred_at || '').slice(0, 10) && (a.occurred_at || '').slice(0, 10) === (b.occurred_at || '').slice(0, 10);
  return name * 0.25 + content * 0.5 + tags * 0.15 + domain * 0.07 + (sameDay ? 0.03 : 0);
}

function contentLength(item) {
  return normalizeText(item.content).length;
}

function chooseWinner(a, b) {
  if (a.pinned && !b.pinned) return a;
  if (b.pinned && !a.pinned) return b;
  if (a.pinned && b.pinned) return null;
  if ((a.importance || 0) !== (b.importance || 0)) return (a.importance || 0) > (b.importance || 0) ? a : b;
  if (contentLength(a) !== contentLength(b)) return contentLength(a) > contentLength(b) ? a : b;
  return String(a.created_at || '') >= String(b.created_at || '') ? a : b;
}

function parseItem(row) {
  return {
    ...row,
    domain: tryParse(row.domain, []),
    tags: tryParse(row.tags, []),
    metadata: tryParse(row.metadata, {}),
    pinned: !!row.pinned,
    resolved: !!row.resolved,
    digested: !!row.digested,
    vector: row.vector_blob ? blobToVec(row.vector_blob) : null,
  };
}

function loadVectorItems(db, options = {}) {
  const includeFeel = options.include_feel === true || options.domain === 'feel';
  const cond = includeFeel
    ? "b.bucket_type='feel' AND b.deleted_at IS NULL"
    : "b.bucket_type NOT IN ('archive','feel','self','permanent','core') AND b.deleted_at IS NULL";
  return db.prepare(`
    SELECT b.*, bv.vector_blob, bv.model, bv.dimension
    FROM buckets b
    JOIN bucket_vectors bv ON bv.bucket_id=b.id
    WHERE ${cond}
    ORDER BY datetime(COALESCE(b.occurred_at, b.created_at)) DESC
  `).all().map(parseItem);
}

function findDuplicatePairs(items, options = {}) {
  const vectorThreshold = Number(options.vector_threshold || options.threshold) || 0.94;
  const textThreshold = Number(options.text_threshold) || 0.85;
  const pairs = [];
  const archived = new Set();

  for (let i = 0; i < items.length; i++) {
    if (archived.has(items[i].id)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (archived.has(items[j].id)) continue;
      const a = items[i], b = items[j];
      if (!a.vector || !b.vector || a.vector.length !== b.vector.length) continue;
      if (a.model !== b.model) continue;

      const vectorSimilarity = cosineSim(a.vector, b.vector);
      const lexicalSimilarity = textSimilarity(a, b);
      const duplicate = (vectorSimilarity >= vectorThreshold && lexicalSimilarity >= 0.35)
        || lexicalSimilarity >= textThreshold;
      if (!duplicate) continue;

      const winner = chooseWinner(a, b);
      if (!winner) {
        pairs.push({ keep: null, duplicate: null, skipped: true, reason: 'both pinned', a: a.id, b: b.id, vectorSimilarity, lexicalSimilarity });
        continue;
      }
      const loser = winner.id === a.id ? b : a;
      archived.add(loser.id);
      pairs.push({
        keep: winner.id,
        duplicate: loser.id,
        keep_name: winner.name,
        duplicate_name: loser.name,
        vectorSimilarity: Math.round(vectorSimilarity * 1000) / 1000,
        lexicalSimilarity: Math.round(lexicalSimilarity * 1000) / 1000,
      });
      if (loser.id === a.id) break;
    }
  }
  return pairs;
}

function archiveDuplicates(db, pairs) {
  const now = new Date().toISOString();
  const getMeta = db.prepare('SELECT metadata FROM buckets WHERE id=?');
  const update = db.prepare(`
    UPDATE buckets
    SET bucket_type='archive', resolved=1, digested=1, digested_at=COALESCE(digested_at, ?), metadata=?
    WHERE id=? AND COALESCE(pinned,0)=0 AND deleted_at IS NULL
      AND bucket_type NOT IN ('self','permanent','core')
  `);
  const delVec = db.prepare('DELETE FROM bucket_vectors WHERE bucket_id=?');
  let archived = 0;
  db.transaction(() => {
    for (const p of pairs) {
      if (!p.duplicate || p.skipped) continue;
      const meta = tryParse(getMeta.get(p.duplicate)?.metadata, {});
      meta.dedup = {
        archived_at: now,
        keep: p.keep,
        vector_similarity: p.vectorSimilarity,
        lexical_similarity: p.lexicalSimilarity,
      };
      const info = update.run(now, toJson(meta), p.duplicate);
      if (info.changes) {
        delVec.run(p.duplicate);
        archived += info.changes;
      }
    }
  })();
  return archived;
}

function runDedup(dbPath, options = {}) {
  const db = new Database(dbPath);
  try {
    const items = loadVectorItems(db, options);
    if (items.length < 2) {
      return { ok: true, scanned: items.length, archived: 0, deleted: 0, pairs: [], message: '记忆数量不足以去重' };
    }
    const pairs = findDuplicatePairs(items, options);
    const archived = options.dry_run ? 0 : archiveDuplicates(db, pairs);
    return {
      ok: true,
      scanned: items.length,
      pairs,
      archived,
      deleted: 0,
      dry_run: !!options.dry_run,
    };
  } finally {
    db.close();
  }
}

function findExactDuplicate(db, input = {}) {
  const content = normalizeText(input.content);
  if (!content || content.length < 20) return null;
  const rows = db.prepare(`
    SELECT * FROM buckets
    WHERE bucket_type NOT IN ('archive','feel','self','permanent','core') AND deleted_at IS NULL
    ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
    LIMIT 200
  `).all().map(parseItem);
  return rows.find(r => normalizeText(r.content) === content) || null;
}

function findSimilarFeel(db, input = {}) {
  const content = normalizeText(input.content);
  if (!content || content.length < 12) return null;
  const rows = db.prepare("SELECT * FROM buckets WHERE bucket_type='feel' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200").all().map(parseItem);
  return rows.find(r => normalizeText(r.content) === content || jaccard(r.content, content) >= 0.9) || null;
}

module.exports = {
  runDedup,
  findDuplicatePairs,
  findExactDuplicate,
  findSimilarFeel,
  normalizeText,
  textSimilarity,
  chooseWinner,
};

if (require.main === module) {
  const dbPath = process.env.RIFUGIO_DB || require('./modules/community-config').dataPath('rifugio-memory.db');
  const result = runDedup(dbPath, { dry_run: process.argv.includes('--dry-run') });
  console.log(JSON.stringify(result, null, 2));
}
