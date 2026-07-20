const Database = require('./sqlite');

const ALLOWED_TABLES = [
  'memories','facts','conversations','log_conversations','log_messages',
  'echi','tracce','aforismi','diario','posta',
  'frammenti','anima','sperimentato','da_esplorare','sussurri','musics','galleria','piani'
];

const CHAT_TABLES = new Set(['log_conversations', 'log_messages']);

function quoteSqlIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function validatedBodyKeys(db, table, body) {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const keys = Object.keys(data);
  const allowed = new Set(db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all().map(row => row.name));
  return {
    data,
    keys,
    invalid: keys.filter(key => !allowed.has(key)),
  };
}

function mountDbCrudRoutes(app, { DB_PATH, CHAT_DB_PATH }) {
  // DB_PATH = rifugio-memory.db, CHAT_DB_PATH = rifugio-chat.db
  const tableDb = (name) => CHAT_TABLES.has(name) ? CHAT_DB_PATH : DB_PATH;
  app.use('/api/:table', (req, res, next) => {
    if (req.params.table === 'log') return next(); // 专用路由在后面处理
    if (req.params.table === 'settings') return next(); // 专用 settings 路由不走表白名单
    if (!ALLOWED_TABLES.includes(req.params.table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }
    next();
  });

  // ============================================================
  // LOG CONVERSATIONS (after whitelist middleware)
  // ============================================================
  app.get('/api/log/conversations', (req, res) => {
    const db = new Database(tableDb('log_conversations'), { readonly: true });
    try {
      const convs = db.prepare("SELECT * FROM log_conversations ORDER BY created_at DESC").all();
      const result = convs.map(c => ({
        ...c,
        messages: db.prepare("SELECT * FROM log_messages WHERE conv_id=? ORDER BY seq").all(c.id)
      }));
      res.json({ ok: true, data: result });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });
  app.post('/api/log/conversations', (req, res) => {
    const db = new Database(tableDb('log_conversations'));
    try {
      const { name, source, messages } = req.body;
      if (!name || !Array.isArray(messages)) return res.json({ ok: false, error: 'name and messages required' });
      const existing = db.prepare("SELECT id FROM log_conversations WHERE name=?").get(name);
      if (existing) return res.json({ ok: true, id: existing.id, skipped: true });
      const info = db.prepare("INSERT INTO log_conversations (name, source) VALUES (?, ?)").run(name, source || '');
      const convId = info.lastInsertRowid;
      const stmt = db.prepare("INSERT INTO log_messages (conv_id, sender, text, thinking, time, seq) VALUES (?, ?, ?, ?, ?, ?)");
      messages.forEach((m, i) => stmt.run(convId, m.sender, m.text, m.thinking || '', m.time || '', i));
      res.json({ ok: true, id: convId });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });
  app.delete('/api/log/conversations/:id', (req, res) => {
    const db = new Database(tableDb('log_conversations'));
    try {
      db.prepare("DELETE FROM log_messages WHERE conv_id=?").run(req.params.id);
      db.prepare("DELETE FROM log_conversations WHERE id=?").run(req.params.id);
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.put('/api/log/conversations/:id', (req, res) => {
    const db = new Database(tableDb('log_conversations'));
    try {
      const { name } = req.body;
      if (name) db.prepare("UPDATE log_conversations SET name=? WHERE id=?").run(name, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.get('/api/:table', (req, res) => {
    const db = new Database(tableDb(req.params.table), { readonly: true });
    const data = db.prepare(`SELECT * FROM ${req.params.table} ORDER BY id DESC`).all();
    db.close();
    res.json({ ok: true, data });
  });

  app.post('/api/:table', (req, res) => {
    const db = new Database(tableDb(req.params.table));
    try {
      const { data, keys, invalid } = validatedBodyKeys(db, req.params.table, req.body);
      if (!keys.length) return res.status(400).json({ ok: false, error: 'empty body' });
      if (invalid.length) return res.status(400).json({ ok: false, error: 'invalid columns' });
      const values = keys.map(key => data[key]);
      const placeholders = keys.map(() => '?').join(', ');
      const columns = keys.map(quoteSqlIdentifier).join(', ');
      const info = db.prepare(`INSERT INTO ${req.params.table} (${columns}) VALUES (${placeholders})`).run(...values);
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.put('/api/:table/:id', (req, res) => {
    const db = new Database(tableDb(req.params.table));
    try {
      const { data, keys, invalid } = validatedBodyKeys(db, req.params.table, req.body);
      if (!keys.length) return res.status(400).json({ ok: false, error: 'empty body' });
      if (invalid.length) return res.status(400).json({ ok: false, error: 'invalid columns' });
      const values = keys.map(key => data[key]);
      const sets = keys.map(key => `${quoteSqlIdentifier(key)} = ?`).join(', ');
      values.push(Number(req.params.id));
      const idCol = ['memories','facts','conversations'].includes(req.params.table) ? 'rowid' : 'id';
      db.prepare(`UPDATE ${req.params.table} SET ${sets} WHERE ${idCol} = ?`).run(...values);
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.delete('/api/:table/:id', (req, res) => {
    const db = new Database(tableDb(req.params.table));
    const idCol = ['memories','facts','conversations'].includes(req.params.table) ? 'rowid' : 'id';
    try {
      db.prepare(`DELETE FROM ${req.params.table} WHERE ${idCol} = ?`).run(Number(req.params.id));
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });
}

module.exports = { mountDbCrudRoutes };
