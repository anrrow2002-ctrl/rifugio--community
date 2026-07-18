'use strict';

const Database = require('better-sqlite3');
const { publicConfig, dataPath } = require('./community-config');

function mountCommunityRoutes(app) {
  app.get('/api/community/health', (_req, res) => {
    const db = new Database(process.env.RIFUGIO_MEMORY_DB || dataPath('rifugio-memory.db'));
    try {
      db.exec('BEGIN IMMEDIATE; CREATE TEMP TABLE __rifugio_rw_probe(value TEXT); INSERT INTO __rifugio_rw_probe VALUES (\'ok\');');
      const value = db.prepare('SELECT value FROM __rifugio_rw_probe LIMIT 1').pluck().get();
      db.exec('ROLLBACK');
      res.json({ ok: value === 'ok', storage: 'sqlite', writable: value === 'ok' });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      res.status(503).json({ ok: false, storage: 'sqlite', writable: false, error: error.message });
    } finally { db.close(); }
  });

  app.get('/api/community/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...publicConfig() });
  });
}

module.exports = { mountCommunityRoutes };
