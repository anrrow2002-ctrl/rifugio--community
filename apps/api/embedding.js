// ============================================================
// embedding.js — Rifugio vector lifecycle
// ============================================================
const crypto = require('crypto');

const DEFAULT_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';
const SECRET = process.env.RIFUGIO_SECRET || 'dev-only-rifugio-secret';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bucket_vectors (
  bucket_id   TEXT PRIMARY KEY,
  vector_blob BLOB NOT NULL,
  model       TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
  dimension   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(bucket_id) REFERENCES buckets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vec_bucket ON bucket_vectors(bucket_id);
CREATE INDEX IF NOT EXISTS idx_vec_model ON bucket_vectors(model);

CREATE TABLE IF NOT EXISTS embedding_jobs (
  bucket_id   TEXT PRIMARY KEY,
  reason      TEXT NOT NULL DEFAULT 'pending',
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status, updated_at);
`;

let _dbPath = null;
let _queueTimer = null;

function initEmbedding(dbPath) {
  _dbPath = dbPath;
  const Database = require('./modules/sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  migrateEmbeddingSchema(db);
  db.close();
  processQueueSoon();
}

function openDb(readonly = false) {
  if (!_dbPath) throw new Error('embedding dbPath is not initialized');
  const Database = require('./modules/sqlite');
  return new Database(_dbPath, readonly ? { readonly: true } : {});
}

function migrateEmbeddingSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(bucket_vectors)").all().map(c => c.name));
  if (!columns.has('dimension')) db.exec('ALTER TABLE bucket_vectors ADD COLUMN dimension INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function tryParse(str, fallback) {
  try { return JSON.parse(str || ''); } catch(e) { return fallback; }
}

function decrypt(text) {
  const [ivHex, encrypted] = String(text || '').split(':');
  if (!ivHex || !encrypted) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    crypto.createHash('sha256').update(SECRET).digest(),
    Buffer.from(ivHex, 'hex')
  );
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

function isMissingApiKeyError(err) {
  return /API Key 未配置|api key/i.test(String(err && err.message || err || ''));
}

function getEmbeddingConfig(dbOrOverride = null, override = {}) {
  let db = null;
  let closeDb = false;
  if (dbOrOverride && typeof dbOrOverride.prepare === 'function') db = dbOrOverride;
  else {
    override = dbOrOverride || {};
    try { db = openDb(true); closeDb = true; } catch(e) {}
  }

  let baseUrl = override.base_url || override.baseUrl || override.llm_base_url || DEFAULT_BASE_URL;
  let model = override.model || override.llm_model || DEFAULT_MODEL;
  let apiKey = override.api_key || override.apiKey || override.llm_api_key || process.env.SILICONFLOW_API_KEY || process.env.EMBEDDING_API_KEY || '';

  try {
    if (db) {
      const row = db.prepare("SELECT value FROM app_settings WHERE key='embedding'").get();
      if (row) {
        const cfg = tryParse(row.value, {});
        baseUrl = cfg.base_url || cfg.baseUrl || baseUrl;
        model = cfg.model || model;
        if (cfg.api_key_enc) apiKey = decrypt(cfg.api_key_enc);
        else if (cfg.api_key && !String(cfg.api_key).includes('***')) apiKey = cfg.api_key;
      }
    }
  } finally {
    if (closeDb && db) db.close();
  }

  return {
    baseUrl: String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: String(model || DEFAULT_MODEL),
    apiKey,
  };
}

async function getEmbedding(text, override = {}) {
  const { baseUrl, model, apiKey } = getEmbeddingConfig(override);
  if (!apiKey) throw new Error('Embedding API Key 未配置，请在记忆设置页填写');

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: String(text || '').slice(0, 8192), encoding_format: 'float' }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`Embedding ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      const vec = data.data?.[0]?.embedding;
      if (!Array.isArray(vec) || !vec.length) throw new Error('Embedding API returned empty vector');
      return { vector: vec.map(Number), model, dimension: vec.length };
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
    }
  }
  throw lastErr || new Error('Embedding API 请求失败');
}

function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function blobToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (!normA || !normB) ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function bucketText(row) {
  const plainContent = String(row.content || '').split('\n---RIFUGIO---')[0].trim();
  return `${row.name || ''}\n${plainContent}\n${row.domain || ''}\n${row.tags || ''}`.slice(0, 2400);
}

function isEmbeddableBucket(row) {
  return row && String(row.bucket_type || '').toLowerCase() !== 'archive';
}

async function embedBucket(bucketId, name, content) {
  const db = openDb();
  let row;
  try {
    row = db.prepare('SELECT id, name, content, domain, tags, bucket_type FROM buckets WHERE id=?').get(bucketId);
    if (!row && name !== undefined) row = { id: bucketId, name, content, domain: '[]', tags: '[]', bucket_type: 'dynamic' };
    if (!isEmbeddableBucket(row)) return null;
  } finally {
    db.close();
  }

  const { vector, model, dimension } = await getEmbedding(bucketText(row));
  const writeDb = openDb();
  try {
    writeDb.prepare(`
      INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(bucketId, vecToBlob(vector), model, dimension);
    writeDb.prepare("DELETE FROM embedding_jobs WHERE bucket_id=?").run(bucketId);
  } finally {
    writeDb.close();
  }
  return vector;
}

function scheduleEmbed(bucketId, reason = 'changed') {
  if (!bucketId) return;
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO embedding_jobs (bucket_id, reason, status, attempts, error, updated_at)
      VALUES (?, ?, 'pending', 0, '', datetime('now'))
      ON CONFLICT(bucket_id) DO UPDATE SET
        reason=excluded.reason, status='pending', attempts=0, error='', updated_at=datetime('now')
    `).run(bucketId, reason);
  } finally {
    db.close();
  }
  processQueueSoon();
}

function invalidateBucketVector(bucketId, reason = 'changed') {
  if (!bucketId) return;
  const db = openDb();
  try {
    db.prepare('DELETE FROM bucket_vectors WHERE bucket_id=?').run(bucketId);
  } finally {
    db.close();
  }
  scheduleEmbed(bucketId, reason);
}

function processQueueSoon(delayMs = 50) {
  if (!_dbPath || _queueTimer) return;
  _queueTimer = setTimeout(() => {
    _queueTimer = null;
    processEmbeddingQueue(5).catch(() => {});
  }, delayMs);
}

async function processEmbeddingQueue(limit = 10) {
  const db = openDb();
  let jobs;
  try {
    jobs = db.prepare(`
      SELECT j.bucket_id
      FROM embedding_jobs j
      JOIN buckets b ON b.id = j.bucket_id
      WHERE j.status IN ('pending','error')
        AND COALESCE(j.attempts,0) < 3
        AND b.bucket_type!='archive'
      ORDER BY datetime(j.updated_at) ASC
      LIMIT ?
    `).all(limit);
  } finally {
    db.close();
  }

  const results = { ok: 0, fail: 0, errors: [] };
  for (const job of jobs) {
    try {
      const markDb = openDb();
      try {
        markDb.prepare("UPDATE embedding_jobs SET status='running', attempts=attempts+1, updated_at=datetime('now') WHERE bucket_id=?").run(job.bucket_id);
      } finally {
        markDb.close();
      }
      await embedBucket(job.bucket_id);
      results.ok++;
    } catch (e) {
      results.fail++;
      results.errors.push({ id: job.bucket_id, error: e.message });
      const errDb = openDb();
      try {
        if (isMissingApiKeyError(e)) {
          errDb.prepare("UPDATE embedding_jobs SET status='error', attempts=0, error=?, updated_at=datetime('now') WHERE bucket_id=?").run(e.message, job.bucket_id);
        } else {
          errDb.prepare("UPDATE embedding_jobs SET status='error', error=?, updated_at=datetime('now') WHERE bucket_id=?").run(e.message, job.bucket_id);
        }
      } finally {
        errDb.close();
      }
    }
  }
  return results;
}

function currentVectorWhere(model) {
  return `
    bv.bucket_id IS NOT NULL
    AND bv.model=?
    AND COALESCE(bv.dimension, length(bv.vector_blob)/4) > 0
  `;
}

async function semanticSearch(query, topK = 8, options = {}) {
  const { vector: queryVector, model, dimension } = await getEmbedding(`query: ${query}`);
  const queryVec = new Float32Array(queryVector);
  const db = openDb(true);
  try {
    const includeDigested = options.include_digested === true || options.includeDigested === true;
    const includeQuiet = options.include_quiet === true || options.includeQuiet === true;
    const includeFeel = options.domain === 'feel' || options.include_feel === true;
    const domain = String(options.domain || '').toLowerCase();
    const conds = [currentVectorWhere(model)];
    const params = [model];

    if (includeFeel) conds.push("b.bucket_type='feel'");
    else conds.push("b.bucket_type NOT IN ('archive','feel','self')");
    if (!includeDigested && !includeFeel) conds.push('COALESCE(b.digested,0)=0');
    if (!includeQuiet && !includeFeel) conds.push('COALESCE(b.resolved,0)=0');

    const rows = db.prepare(`
      SELECT b.*, bv.bucket_id, bv.vector_blob, bv.model, bv.dimension
      FROM bucket_vectors bv JOIN buckets b ON b.id = bv.bucket_id
      WHERE ${conds.join(' AND ')}
    `).all(...params);

    const scored = rows
      .filter(row => !row.dimension || row.dimension === dimension)
      .map(row => {
        const domainArr = tryParse(row.domain, []);
        const tagsArr = tryParse(row.tags, []);
        if (domain && !includeFeel && !domainArr.some(d => String(d).toLowerCase().includes(domain))) return null;
        const sim = cosineSim(queryVec, blobToVec(row.vector_blob));
        return {
          ...row,
          domain: domainArr,
          tags: tagsArr,
          resolved: !!row.resolved,
          digested: !!row.digested,
          pinned: !!row.pinned,
          similarity: Math.round(sim * 1000) / 1000,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
    return scored;
  } finally {
    db.close();
  }
}

function keywordSearch(query, topK = 8, options = {}) {
  const db = openDb(true);
  try {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const like = `%${q}%`;
    const includeDigested = options.include_digested === true || options.includeDigested === true;
    const includeQuiet = options.include_quiet === true || options.includeQuiet === true;
    const includeFeel = options.domain === 'feel' || options.include_feel === true;
    const conds = ['(lower(name) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ? OR lower(domain) LIKE ?)'];
    const params = [like, like, like, like];
    if (includeFeel) conds.push("bucket_type='feel'");
    else conds.push("bucket_type NOT IN ('archive','feel','self')");
    if (!includeDigested && !includeFeel) conds.push('COALESCE(digested,0)=0');
    if (!includeQuiet && !includeFeel) conds.push('COALESCE(resolved,0)=0');
    return db.prepare(`SELECT * FROM buckets WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, topK)
      .map(row => ({
        ...row,
        domain: tryParse(row.domain, []),
        tags: tryParse(row.tags, []),
        resolved: !!row.resolved,
        digested: !!row.digested,
        pinned: !!row.pinned,
        similarity: 0,
        fallback: 'keyword',
      }));
  } finally {
    db.close();
  }
}

function staleVectorCondition(model) {
  return `(bv.bucket_id IS NULL OR bv.model IS NULL OR bv.model != ?)`;
}

function getEmbeddingStatus() {
  const db = openDb(true);
  try {
    const { model } = getEmbeddingConfig(db);
    const total = db.prepare("SELECT COUNT(*) as n FROM buckets WHERE bucket_type NOT IN ('archive','feel','self')").get().n;
    const feelTotal = db.prepare("SELECT COUNT(*) as n FROM buckets WHERE bucket_type='feel'").get().n;
    const current = db.prepare(`
      SELECT COUNT(*) as n
      FROM buckets b JOIN bucket_vectors bv ON bv.bucket_id=b.id
      WHERE b.bucket_type NOT IN ('archive','feel','self') AND bv.model=?
    `).get(model).n;
    const feelCurrent = db.prepare(`
      SELECT COUNT(*) as n
      FROM buckets b JOIN bucket_vectors bv ON bv.bucket_id=b.id
      WHERE b.bucket_type='feel' AND bv.model=?
    `).get(model).n;
    const stale = db.prepare(`
      SELECT COUNT(*) as n
      FROM buckets b LEFT JOIN bucket_vectors bv ON bv.bucket_id=b.id
      WHERE b.bucket_type NOT IN ('archive','feel','self') AND ${staleVectorCondition(model)}
    `).get(model).n;
    const feelStale = db.prepare(`
      SELECT COUNT(*) as n
      FROM buckets b LEFT JOIN bucket_vectors bv ON bv.bucket_id=b.id
      WHERE b.bucket_type='feel' AND ${staleVectorCondition(model)}
    `).get(model).n;
    const queued = db.prepare("SELECT COUNT(*) as n FROM embedding_jobs WHERE status IN ('pending','running','error')").get().n;
    return {
      total,
      vectorized: current,
      current,
      stale,
      queued,
      model,
      coverage: total ? Math.round(current / total * 100) : 0,
      feel_total: feelTotal,
      feel_vectorized: feelCurrent,
      feel_stale: feelStale,
      feel_coverage: feelTotal ? Math.round(feelCurrent / feelTotal * 100) : 0,
    };
  } finally {
    db.close();
  }
}

function mountEmbeddingRoutes(app, dbPath) {
  _dbPath = dbPath;

  app.post('/api/embed/batch', async (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.body?.limit || req.query.limit) || 50));
    const db = openDb();
    let buckets;
    try {
      const { model } = getEmbeddingConfig(db);
      buckets = db.prepare(`
        SELECT b.id, b.name, b.content
        FROM buckets b LEFT JOIN bucket_vectors bv ON bv.bucket_id = b.id
        WHERE b.bucket_type!='archive' AND ${staleVectorCondition(model)}
        ORDER BY datetime(COALESCE(b.occurred_at, b.created_at)) DESC
        LIMIT ?
      `).all(model, limit);
      const stmt = db.prepare(`
        INSERT INTO embedding_jobs (bucket_id, reason, status, attempts, error, updated_at)
        VALUES (?, 'batch', 'pending', 0, '', datetime('now'))
        ON CONFLICT(bucket_id) DO UPDATE SET reason='batch', status='pending', attempts=0, error='', updated_at=datetime('now')
      `);
      db.transaction(() => buckets.forEach(b => stmt.run(b.id)))();
    } finally {
      db.close();
    }

    const results = await processEmbeddingQueue(limit);
    res.json({ ok: true, processed: buckets.length, ...results, status: getEmbeddingStatus() });
  });

  app.post('/api/embed/:id', async (req, res) => {
    try {
      await embedBucket(req.params.id);
      res.json({ ok: true, bucket_id: req.params.id });
    } catch(e) {
      scheduleEmbed(req.params.id, 'manual-failed');
      res.json({ ok: false, bucket_id: req.params.id, error: e.message });
    }
  });

  app.get('/api/search/semantic', async (req, res) => {
    const q = (req.query.q || req.query.query || '').trim();
    const top = Math.min(30, Number(req.query.top || req.query.limit) || 8);
    if (!q) return res.json({ ok: false, error: 'q required' });
    try {
      const results = await semanticSearch(q, top, {
        include_quiet: req.query.include_quiet === 'true',
        include_digested: req.query.include_digested === 'true',
        domain: req.query.domain || '',
      });
      res.json({ ok: true, data: results, fallback: false });
    } catch(e) {
      const rows = keywordSearch(q, top, {
        include_quiet: true,
        include_digested: true,
        domain: req.query.domain || '',
      });
      res.json({ ok: true, data: rows, fallback: 'keyword', reason: e.message });
    }
  });

  app.get('/api/embed/status', (req, res) => {
    try {
      res.json({ ok: true, data: getEmbeddingStatus() });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  initEmbedding,
  mountEmbeddingRoutes,
  getEmbeddingConfig,
  getEmbedding,
  embedBucket,
  scheduleEmbed,
  invalidateBucketVector,
  processEmbeddingQueue,
  semanticSearch,
  keywordSearch,
  getEmbeddingStatus,
  blobToVec,
  cosineSim,
};
