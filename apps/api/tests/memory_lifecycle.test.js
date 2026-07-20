const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let express, Database, buckets, embedding, dedup;
let depsError = null;
try {
  express = require('express');
  Database = require('../modules/sqlite');
  buckets = require('../buckets');
  embedding = require('../embedding');
  dedup = require('../dedup');
} catch (e) {
  depsError = e;
}

function lifecycleTest(name, fn) {
  test(name, depsError ? { skip: `missing dependency: ${depsError.message}` } : {}, fn);
}

function vecBlob(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

async function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rifugio-memory-'));
  const dbPath = path.join(dir, 'memory.db');
  buckets.initBuckets(dbPath);
  embedding.initEmbedding(dbPath);

  const app = express();
  app.use(express.json());
  buckets.mountBucketRoutes(app, dbPath);
  embedding.mountEmbeddingRoutes(app, dbPath);
  app.post('/api/buckets/dedup', (req, res) => res.json(dedup.runDedup(dbPath, req.body || {})));

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(base + url, opts);
    return resp.json();
  }

  function db() {
    return new Database(dbPath);
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { request, db, dbPath, close };
}

lifecycleTest('ordinary memory surfaces in ordinary breath', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', { name: 'normal', content: 'ordinary active memory', importance: 8 });
  assert.equal(created.ok, true);
  const breath = await h.request('GET', '/api/buckets/breath?limit=5');
  assert.equal(breath.ok, true);
  assert.ok(breath.data.some(b => b.id === created.data.id));
});

lifecycleTest('feel is isolated from ordinary breath and readable through feel channel', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const feel = await h.request('POST', '/api/buckets/hold', { name: 'felt pattern', content: 'A subjective relationship sediment.', feel: true });
  assert.equal(feel.data.bucket_type, 'feel');

  const ordinary = await h.request('GET', '/api/buckets/breath?limit=10');
  assert.ok(ordinary.data.every(b => b.id !== feel.data.id));

  const feels = await h.request('GET', '/api/buckets/breath?domain=feel');
  assert.ok(feels.data.some(b => b.id === feel.data.id));
});

lifecycleTest('breath query falls back to keyword when embedding fails', async t => {
  const h = await makeHarness();
  t.after(h.close);
  await h.request('POST', '/api/buckets', { name: 'semantic target', content: 'needle fallback memory content' });
  const res = await h.request('GET', '/api/buckets/breath?query=needle&limit=5');
  assert.equal(res.ok, true);
  assert.equal(res.fallback, 'keyword');
  assert.ok(res.data.some(b => /needle/.test(b.content)));
});

lifecycleTest('empty ordinary breath does not touch surfaced memories', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', { name: 'no touch', content: 'empty breath should not activate this memory', importance: 8 });
  const db = h.db();
  try {
    db.prepare("UPDATE buckets SET activation_count=1, last_active='2000-01-01T00:00:00.000Z' WHERE id=?").run(created.data.id);
  } finally {
    db.close();
  }
  const breath = await h.request('GET', '/api/buckets/breath?limit=5');
  assert.equal(breath.ok, true);
  const check = h.db();
  try {
    const row = check.prepare('SELECT activation_count FROM buckets WHERE id=?').get(created.data.id);
    assert.equal(row.activation_count, 1);
  } finally {
    check.close();
  }
});

lifecycleTest('feel query uses feel channel fallback without mixing ordinary memories', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const feel = await h.request('POST', '/api/buckets/hold', { name: 'feel query', content: 'subjective sediment about repair rhythm', feel: true });
  await h.request('POST', '/api/buckets', { name: 'ordinary subjective', content: 'subjective sediment ordinary event' });
  const res = await h.request('GET', '/api/buckets/feel?query=repair&limit=10');
  assert.equal(res.ok, true);
  assert.ok(res.data.some(b => b.id === feel.data.id));
  assert.ok(res.data.every(b => b.bucket_type === 'feel'));
});

lifecycleTest('http dream defaults to backfill cutoff and skips new ordinary candidates', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', {
    name: 'new after cutoff',
    content: 'this new memory belongs to Claude self dream',
    occurred_at: '2026-06-18',
  });
  const dry = await h.request('POST', '/api/buckets/dream', { dry_run: true, limit: 10 });
  assert.equal(dry.ok, true);
  assert.ok(!dry.candidates.some(b => b.id === created.data.id));

  const review = await h.request('POST', '/api/buckets/dream', { dry_run: true, limit: 10, include_new: true });
  assert.equal(review.ok, true);
  assert.ok(review.candidates.some(b => b.id === created.data.id));
});

lifecycleTest('dream suggests by default and applies decisions only when requested', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const quietSource = await h.request('POST', '/api/buckets', { name: 'quiet source', content: 'memory to sink quietly' });
  const digestSource = await h.request('POST', '/api/buckets', { name: 'digest source', content: 'memory to digest fully' });
  const archiveSource = await h.request('POST', '/api/buckets', { name: 'archive source', content: 'memory suggested for archive' });
  const dream = await h.request('POST', '/api/buckets/dream', {
    analysis: {
      decisions: [
        { id: quietSource.data.id, status: 'quiet' },
        { id: digestSource.data.id, status: 'digested' },
        { id: archiveSource.data.id, status: 'archived' },
      ],
      feels: [],
    },
  });
  assert.equal(dream.ok, true);
  assert.equal(dream.quiet.length, 0);
  assert.equal(dream.digested.length, 0);
  assert.equal(dream.archived.length, 0);
  assert.equal(dream.suggested_quiet.length, 1);
  assert.equal(dream.suggested_digested.length, 1);
  assert.equal(dream.suggested_archived.length, 1);
  assert.equal(dream.dreamed_count, 3);

  const q = await h.request('GET', `/api/buckets/${quietSource.data.id}`);
  const d = await h.request('GET', `/api/buckets/${digestSource.data.id}`);
  const a = await h.request('GET', `/api/buckets/${archiveSource.data.id}`);
  assert.equal(q.data.status, 'active');
  assert.equal(d.data.status, 'active');
  assert.equal(a.data.status, 'active');
  assert.equal(q.data.metadata.dream.skip_dream, true);
  assert.equal(d.data.metadata.dream.skip_dream, true);
  assert.equal(a.data.metadata.dream.skip_dream, true);

  const applyQuiet = await h.request('POST', '/api/buckets', { name: 'apply quiet', content: 'memory to actually quiet' });
  const applyDigest = await h.request('POST', '/api/buckets', { name: 'apply digest', content: 'memory to actually digest' });
  const applied = await h.request('POST', '/api/buckets/dream', {
    apply_decisions: true,
    analysis: {
      decisions: [
        { id: applyQuiet.data.id, status: 'quiet' },
        { id: applyDigest.data.id, status: 'digested' },
      ],
      feels: [],
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.quiet.length, 1);
  assert.equal(applied.digested.length, 1);

  const q2 = await h.request('GET', `/api/buckets/${applyQuiet.data.id}`);
  const d2 = await h.request('GET', `/api/buckets/${applyDigest.data.id}`);
  assert.equal(q2.data.status, 'quiet');
  assert.equal(d2.data.status, 'digested');
});

lifecycleTest('dream creates feel and marks source_ids as source_of_feel without sinking by default', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const sourceA = await h.request('POST', '/api/buckets', { name: 'repair A', content: 'Direct repair after tension matters.' });
  const sourceB = await h.request('POST', '/api/buckets', { name: 'repair B', content: 'Soft follow-up also matters.' });
  const quietOnly = await h.request('POST', '/api/buckets', { name: 'quiet only', content: 'A suggested quiet memory.' });
  const archiveOnly = await h.request('POST', '/api/buckets', { name: 'archive only', content: 'A suggested archive memory.' });
  const first = await h.request('POST', '/api/buckets/dream', {
    analysis: {
      decisions: [
        { id: sourceA.data.id, status: 'active' },
        { id: sourceB.data.id, status: 'active' },
        { id: quietOnly.data.id, status: 'quiet' },
        { id: archiveOnly.data.id, status: 'archived' },
      ],
      feels: [{ name: 'repair feel', content: 'Direct acknowledgement helps tension settle.', source_ids: [sourceA.data.id, sourceB.data.id] }],
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.feels_created, 1);
  assert.equal(first.dreamed_count, 4);
  assert.equal(first.dream_reviewed_before, 0);
  assert.equal(first.dream_reviewed_added, 4);
  assert.equal(first.dream_reviewed_total, 4);
  assert.equal(first.digested.length, 0);
  assert.equal(first.suggested_digested.length, 0);

  const sourceAAfter = await h.request('GET', `/api/buckets/${sourceA.data.id}`);
  const sourceBAfter = await h.request('GET', `/api/buckets/${sourceB.data.id}`);
  const quietAfter = await h.request('GET', `/api/buckets/${quietOnly.data.id}`);
  const archiveAfter = await h.request('GET', `/api/buckets/${archiveOnly.data.id}`);
  assert.equal(sourceAAfter.data.status, 'active');
  assert.equal(sourceBAfter.data.status, 'active');
  assert.equal(sourceAAfter.data.metadata.dream.source_of_feel, true);
  assert.ok(sourceAAfter.data.metadata.dream.linked_feel_ids.length >= 1);
  assert.equal(quietAfter.data.status, 'active');
  assert.equal(archiveAfter.data.status, 'active');
  assert.equal(archiveAfter.data.bucket_type, 'dynamic');

  const stats = await h.request('GET', '/api/buckets/stats');
  assert.equal(stats.data.quiet, 0);
  assert.equal(stats.data.digested, 0);
  assert.equal(stats.data.source_of_feel, 2);
  assert.equal(stats.data.dream_reviewed, 4);

  const search = await h.request('GET', '/api/buckets/breath?query=Direct repair&limit=10');
  assert.ok(search.data.some(b => b.id === sourceA.data.id));

  const db = h.db();
  try {
    db.prepare("UPDATE buckets SET resolved=1, digested=1, digested_at=datetime('now') WHERE id=?").run(sourceA.data.id);
  } finally {
    db.close();
  }
  buckets.initBuckets(h.dbPath);
  const repaired = await h.request('GET', `/api/buckets/${sourceA.data.id}`);
  assert.equal(repaired.data.status, 'active');
  assert.equal(repaired.data.metadata.dream.source_of_feel, true);

  const dry = await h.request('POST', '/api/buckets/dream', { dry_run: true, limit: 10 });
  assert.ok(!dry.candidates.some(b => b.id === sourceA.data.id));
  assert.ok(!dry.candidates.some(b => b.id === sourceB.data.id));

  const second = await h.request('POST', '/api/buckets/dream', {
    analysis: {
      decisions: [{ id: sourceA.data.id, status: 'active' }],
      feels: [{ name: 'duplicate', content: 'Should not appear from already digested source.', source_ids: [sourceA.data.id] }],
    },
  });
  assert.equal(second.ok, true);
  assert.equal(second.feels_created, 0);
});

lifecycleTest('overlapping source_ids do not create near-duplicate feel', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const a = await h.request('POST', '/api/buckets', { name: 'a', content: 'source overlap a' });
  const b = await h.request('POST', '/api/buckets', { name: 'b', content: 'source overlap b' });
  const c = await h.request('POST', '/api/buckets', { name: 'c', content: 'source overlap c' });
  const existing = await h.request('POST', '/api/buckets/hold', {
    name: 'existing feel',
    content: 'An existing relationship sediment.',
    feel: true,
    source_ids: [a.data.id, b.data.id],
  });
  assert.equal(existing.ok, true);

  const dream = await h.request('POST', '/api/buckets/dream', {
    analysis: {
      decisions: [],
      feels: [{ name: 'near duplicate', content: 'A different wording for the same sediment.', source_ids: [a.data.id, c.data.id] }],
    },
  });
  assert.equal(dream.ok, true);
  assert.equal(dream.feels_created, 0);
});

lifecycleTest('feels_created zero is still a successful dream', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const plain = await h.request('POST', '/api/buckets', { name: 'plain', content: 'ordinary active memory' });
  const dream = await h.request('POST', '/api/buckets/dream', {
    analysis: { decisions: [], feels: [] },
  });
  assert.equal(dream.ok, true);
  assert.equal(dream.feels_created, 0);
  assert.equal(dream.reviewed_count, 1);
  assert.equal(dream.dreamed_count, 1);
  assert.equal(dream.dream_reviewed_added, 1);
  assert.equal(dream.dream_reviewed_total, 1);

  const after = await h.request('GET', `/api/buckets/${plain.data.id}`);
  assert.equal(after.data.status, 'active');
  assert.equal(after.data.metadata.dream.reviewed, true);
  assert.equal(after.data.metadata.dream.no_feel, true);
  assert.equal(after.data.metadata.dream.skip_dream, true);

  const stats = await h.request('GET', '/api/buckets/stats');
  assert.equal(stats.data.dream_reviewed, 1);

  const dry = await h.request('POST', '/api/buckets/dream', { dry_run: true, limit: 10 });
  assert.ok(!dry.candidates.some(b => b.id === plain.data.id));
});

lifecycleTest('dream skips legacy reviewed memories even without skip_dream', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const oldReviewed = await h.request('POST', '/api/buckets', {
    name: 'legacy reviewed',
    content: 'already counted as dream reviewed before skip flag existed',
  });
  const db = h.db();
  try {
    db.prepare('UPDATE buckets SET metadata=? WHERE id=?').run(JSON.stringify({
      dream: { reviewed: true, status: 'reviewed_no_feel' },
    }), oldReviewed.data.id);
  } finally {
    db.close();
  }
  const stats = await h.request('GET', '/api/buckets/stats');
  assert.equal(stats.data.dream_reviewed, 1);

  const dry = await h.request('POST', '/api/buckets/dream', { dry_run: true, limit: 10 });
  assert.ok(!dry.candidates.some(b => b.id === oldReviewed.data.id));
});

lifecycleTest('dream scans past reviewed recent rows to find older unreviewed candidates', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const older = await h.request('POST', '/api/buckets', {
    name: 'older unreviewed',
    content: 'this older memory still needs dream',
    occurred_at: '2026-05-01',
  });
  const db = h.db();
  try {
    const stmt = db.prepare('INSERT INTO buckets (id,name,content,occurred_at,created_at,last_active,bucket_type,metadata,resolved,digested,pinned,importance,valence,arousal,domain,tags,personas,activation_count) VALUES (?,?,?,?,?,?,?,?,0,0,0,5,0.5,0.3,?,?,?,1)');
    for (let i = 0; i < 80; i++) {
      stmt.run(
        `reviewed-${i}`,
        `reviewed ${i}`,
        'already reviewed recent memory',
        `2026-05-${String(2 + (i % 20)).padStart(2, '0')}`,
        `2026-05-${String(2 + (i % 20)).padStart(2, '0')}T00:00:00.000Z`,
        `2026-05-${String(2 + (i % 20)).padStart(2, '0')}T00:00:00.000Z`,
        'dynamic',
        JSON.stringify({ dream: { reviewed: true, status: 'reviewed_no_feel' } }),
        '[]',
        '[]',
        '{}',
      );
    }
  } finally {
    db.close();
  }
  const dry = await h.request('POST', '/api/buckets/dream', { dry_run: true, limit: 5, include_new: true });
  assert.equal(dry.ok, true);
  assert.ok(dry.candidates.some(b => b.id === older.data.id));
});

lifecycleTest('dedup archives lower priority duplicate and protects pinned/high-importance memory', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const keep = await h.request('POST', '/api/buckets', { name: 'keep pinned', content: 'same duplicate theme content', importance: 3, pinned: true });
  const dup = await h.request('POST', '/api/buckets', { name: 'duplicate low', content: 'same duplicate theme content extended', importance: 9 });
  const db = h.db();
  try {
    db.prepare("DELETE FROM embedding_jobs").run();
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'test-model', 3)").run(keep.data.id, vecBlob([1, 0, 0]));
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'test-model', 3)").run(dup.data.id, vecBlob([1, 0, 0]));
  } finally {
    db.close();
  }
  const result = dedup.runDedup(h.dbPath, { threshold: 0.85 });
  assert.equal(result.ok, true);
  const kept = await h.request('GET', `/api/buckets/${keep.data.id}`);
  const archived = await h.request('GET', `/api/buckets/${dup.data.id}`);
  assert.equal(kept.data.pinned, true);
  assert.equal(kept.data.bucket_type, 'dynamic');
  assert.equal(archived.data.bucket_type, 'archive');
});

lifecycleTest('dedup never archives self versions and ignores medium-confidence similarity', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const self = await h.request('POST', '/api/buckets', {
    name: 'I v-test', content: 'same relationship identity with a meaningful new chapter', bucket_type: 'self', importance: 5,
  });
  const ordinary = await h.request('POST', '/api/buckets', {
    name: 'ordinary reflection', content: 'same relationship identity with a different lived chapter', importance: 9,
  });
  const db = h.db();
  try {
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'test-model', 3)").run(self.data.id, vecBlob([1, 0, 0]));
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'test-model', 3)").run(ordinary.data.id, vecBlob([0.93, 0.367, 0]));
  } finally {
    db.close();
  }
  const result = dedup.runDedup(h.dbPath);
  assert.ok(result.pairs.every(pair => pair.a !== self.data.id && pair.b !== self.data.id && pair.keep !== self.data.id && pair.duplicate !== self.data.id));
  const keptSelf = await h.request('GET', `/api/buckets/${self.data.id}`);
  const keptOrdinary = await h.request('GET', `/api/buckets/${ordinary.data.id}`);
  assert.equal(keptSelf.data.bucket_type, 'self');
  assert.equal(keptOrdinary.data.bucket_type, 'dynamic');
});

lifecycleTest('hold cannot smuggle protected bucket types', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const held = await h.request('POST', '/api/buckets/hold', {
    name: 'normal hold', content: 'ordinary memory through the MCP write path', bucket_type: 'self',
  });
  assert.equal(held.ok, true);
  assert.equal(held.data.bucket_type, 'dynamic');
});

lifecycleTest('delete is recoverable for 30 days and restore preserves state and vector', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', {
    name: 'recover me', content: 'soft deletion must be reversible', importance: 8, pinned: true,
  });
  const db = h.db();
  try {
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'test-model', 3)").run(created.data.id, vecBlob([1, 0, 0]));
  } finally {
    db.close();
  }
  const deleted = await h.request('DELETE', `/api/buckets/${created.data.id}`);
  assert.equal(deleted.ok, true);
  assert.ok(deleted.restore_until);
  const hidden = await h.request('GET', `/api/buckets/${created.data.id}`);
  assert.equal(hidden.ok, false);
  const recycle = await h.request('GET', '/api/buckets/deleted');
  assert.ok(recycle.data.some(b => b.id === created.data.id && b.status === 'deleted'));
  const check = h.db();
  try {
    const row = check.prepare('SELECT deleted_at, bucket_type FROM buckets WHERE id=?').get(created.data.id);
    assert.ok(row.deleted_at);
    assert.equal(row.bucket_type, 'archive');
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM bucket_vectors WHERE bucket_id=?').get(created.data.id).n, 1);
  } finally {
    check.close();
  }
  const restored = await h.request('POST', `/api/buckets/${created.data.id}/restore`);
  assert.equal(restored.ok, true);
  assert.equal(restored.data.bucket_type, 'dynamic');
  assert.equal(restored.data.pinned, true);
  assert.equal(restored.data.deleted_at, null);
});

lifecycleTest('expired soft deletes are physically purged with vectors and jobs', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', { name: 'expire me', content: 'expired recycle bin entry' });
  await h.request('DELETE', `/api/buckets/${created.data.id}`);
  const db = h.db();
  try {
    db.prepare("UPDATE buckets SET deleted_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(created.data.id);
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'test-model', 3)").run(created.data.id, vecBlob([1, 0, 0]));
    db.prepare("INSERT OR REPLACE INTO embedding_jobs (bucket_id, reason, status, updated_at) VALUES (?, 'test', 'pending', datetime('now'))").run(created.data.id);
  } finally {
    db.close();
  }
  const recycle = await h.request('GET', '/api/buckets/deleted');
  assert.equal(recycle.purged, 1);
  const check = h.db();
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM buckets WHERE id=?').get(created.data.id).n, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM bucket_vectors WHERE bucket_id=?').get(created.data.id).n, 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM embedding_jobs WHERE bucket_id=?').get(created.data.id).n, 0);
  } finally {
    check.close();
  }
});

lifecycleTest('patching bucket content invalidates vector and queues embedding', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', { name: 'mutable', content: 'old content' });
  const db = h.db();
  try {
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'old-model', 3)").run(created.data.id, vecBlob([0, 1, 0]));
  } finally {
    db.close();
  }
  await h.request('PATCH', `/api/buckets/${created.data.id}`, { content: 'new content' });
  const check = h.db();
  try {
    assert.equal(check.prepare('SELECT COUNT(*) as n FROM bucket_vectors WHERE bucket_id=?').get(created.data.id).n, 0);
    assert.equal(check.prepare('SELECT COUNT(*) as n FROM embedding_jobs WHERE bucket_id=?').get(created.data.id).n, 1);
  } finally {
    check.close();
  }
});

lifecycleTest('embedding status treats model mismatch as stale', async t => {
  const h = await makeHarness();
  t.after(h.close);
  const created = await h.request('POST', '/api/buckets', { name: 'model drift', content: 'content' });
  const db = h.db();
  try {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('embedding', ?)").run(JSON.stringify({ model: 'new-model' }));
    db.prepare("INSERT OR REPLACE INTO bucket_vectors (bucket_id, vector_blob, model, dimension) VALUES (?, ?, 'old-model', 3)").run(created.data.id, vecBlob([0, 0, 1]));
  } finally {
    db.close();
  }
  const status = embedding.getEmbeddingStatus();
  assert.equal(status.stale >= 1, true);
});
