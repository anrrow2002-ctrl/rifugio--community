const Database = require('./sqlite');
const { USER_NAME, COMPANION_NAME } = require('./community-config');

function createSettingsMemoryRoutes(ctx = {}) {
  const {
    DB_PATH,
    maskKey,
    encrypt,
    decrypt,
  } = ctx;

  async function getLLMConfig() {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
      if (!row) return null;
      const cfg = JSON.parse(row.value);
      if (cfg.api_key_enc) cfg.api_key = decrypt(cfg.api_key_enc);
      return cfg;
    } finally { db.close(); }
  }

  function mountPreMigrationRoutes(app) {
    // --- SYNC ---
    app.get('/api/sync', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const data = {};
        data.memories = db.prepare('SELECT rowid as id, category, content, created_at FROM memories ORDER BY created_at DESC').all();
        data.facts = db.prepare('SELECT rowid as id, key, value, created_at FROM facts ORDER BY created_at DESC').all();
        data.conversations = db.prepare('SELECT rowid as id, summary, mood, created_at FROM conversations ORDER BY created_at DESC LIMIT 20').all();

        const tables = ['echi','tracce','aforismi','diario','posta','frammenti','anima','sperimentato','da_esplorare','sussurri','musics','galleria','piani'];
        tables.forEach(t => {
          data[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id DESC`).all();
        });

        // Settings
        const llmRow = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
        let settings = { llm: null };
        if (llmRow) {
          try {
            const parsed = JSON.parse(llmRow.value);
            if (parsed.api_key_enc) {
              parsed.api_key = maskKey(decrypt(parsed.api_key_enc));
              delete parsed.api_key_enc;
            }
            settings.llm = parsed;
          } catch(e) { settings.llm = null; }
        }
        data.settings = settings;

        res.json({ ok: true, data, synced_at: new Date().toISOString() });
      } catch (err) {
        res.json({ ok: false, error: err.message });
      } finally { db.close(); }
    });

    // --- Posta special routes ---
    app.put('/api/posta/:id/read', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        db.prepare('UPDATE posta SET is_read=1 WHERE id=?').run(Number(req.params.id));
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.put('/api/posta/:id/archive', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        db.prepare('UPDATE posta SET archived=1 WHERE id=?').run(Number(req.params.id));
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.post('/api/posta/archive-old', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const info = db.prepare("UPDATE posta SET archived=1 WHERE archived=0 AND created_at < datetime('now','-7 days')").run();
        res.json({ ok: true, archived: info.changes });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // --- Echi pin ---
    app.put('/api/echi/:id/pin', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const pinned = req.body.pinned ? 1 : 0;
        db.prepare('UPDATE echi SET pinned=? WHERE id=?').run(pinned, Number(req.params.id));
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // --- LLM Settings ---
    app.get('/api/settings/llm', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const row = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
        if (!row) return res.json({ ok: true, data: null });
        const parsed = JSON.parse(row.value);
        if (parsed.api_key_enc) {
          parsed.api_key = maskKey(decrypt(parsed.api_key_enc));
          delete parsed.api_key_enc;
        }
        res.json({ ok: true, data: parsed });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.put('/api/settings/llm', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const { base_url, api_key, model, merge_prompt } = req.body;
        const existing = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
        let stored = {};
        if (existing) { try { stored = JSON.parse(existing.value); } catch(e){} }

        stored.base_url = base_url || stored.base_url;
        stored.model = model || stored.model;
        stored.merge_prompt = merge_prompt !== undefined ? merge_prompt : stored.merge_prompt;

        // If api_key is masked, keep old; otherwise encrypt new
        if (api_key && !api_key.includes('***')) {
          stored.api_key_enc = encrypt(api_key);
        }

        db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('llm', ?, datetime('now'))").run(JSON.stringify(stored));
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.post('/api/settings/llm/test', async (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        let { base_url, api_key, model } = req.body;
        // If masked, get real key from db
        if (!api_key || api_key.includes('***')) {
          const row = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
          if (row) {
            const parsed = JSON.parse(row.value);
            if (parsed.api_key_enc) api_key = decrypt(parsed.api_key_enc);
          }
        }
        db.close();
        if (!api_key) return res.json({ ok: false, error: 'No API key configured' });

        const endpoint = String(base_url || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/models';
        const resp = await fetch(endpoint, {
          headers: { 'Authorization': 'Bearer ' + api_key }
        });
        if (resp.ok) {
          const payload = await resp.json().catch(() => ({}));
          const data = (payload.data || payload.models || []).map(item => ({
            id: item && (item.id || item.name || item.model),
          })).filter(item => item.id);
          res.json({ ok: true, data });
        } else {
          const body = await resp.text();
          res.json({ ok: false, error: `${resp.status}: ${body.slice(0, 200)}` });
        }
      } catch(e) {
        try { db.close(); } catch(x){}
        res.json({ ok: false, error: e.message });
      }
    });

    // --- Memories merge ---
    app.post('/api/memories/merge', async (req, res) => {
      const { ids, prompt } = req.body;
      if (!ids || ids.length < 2) return res.json({ ok: false, error: 'Need ≥2 memories' });

      const db = new Database(DB_PATH);
      try {
        // Get LLM config
        const settingsRow = db.prepare("SELECT value FROM app_settings WHERE key='llm'").get();
        if (!settingsRow) return res.json({ ok: false, error: 'No LLM configured' });
        const settings = JSON.parse(settingsRow.value);
        let apiKey = settings.api_key_enc ? decrypt(settings.api_key_enc) : null;
        if (!apiKey) return res.json({ ok: false, error: 'No API key' });

        // Get memories
        const placeholders = ids.map(() => '?').join(',');
        const memories = db.prepare(`SELECT rowid as id, content, category, created_at FROM memories WHERE rowid IN (${placeholders}) ORDER BY created_at ASC`).all(...ids);
        if (memories.length < 2) return res.json({ ok: false, error: 'Not enough memories found' });

        const memText = memories.map(m => `[${m.created_at}] [${m.category}] ${m.content}`).join('\n');

        // Call LLM
        const llmResp = await fetch((settings.base_url || 'https://api.openai.com/v1') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body: JSON.stringify({
            model: settings.model || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: prompt || settings.merge_prompt || 'Merge these memories into one concise entry.' },
              { role: 'user', content: memText }
            ],
            max_tokens: 500
          })
        });

        if (!llmResp.ok) {
          const errBody = await llmResp.text();
          return res.json({ ok: false, error: `LLM ${llmResp.status}: ${errBody.slice(0, 200)}` });
        }

        const llmData = await llmResp.json();
        const merged = llmData.choices?.[0]?.message?.content;
        if (!merged) return res.json({ ok: false, error: 'Empty LLM response' });

        // Transaction: insert merged + delete originals
        const txn = db.transaction(() => {
          const info = db.prepare("INSERT INTO memories (category, content) VALUES ('合并', ?)").run(merged);
          db.prepare(`DELETE FROM memories WHERE rowid IN (${placeholders})`).run(...ids);
          return info.lastInsertRowid;
        });
        const newId = txn();

        res.json({ ok: true, new_id: newId });
      } catch(e) {
        res.json({ ok: false, error: e.message });
      } finally { db.close(); }
    });
  }

  function mountPostMigrationRoutes(app) {
    // ============================================================
    // EMBEDDING SETTINGS
    // ============================================================
    app.get('/api/settings/embedding', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const row = db.prepare("SELECT value FROM app_settings WHERE key='embedding'").get();
        if (!row) {
          // Fall back to env defaults
          return res.json({ ok: true, data: {
            base_url: 'https://api.siliconflow.cn/v1',
            api_key: maskKey(process.env.SILICONFLOW_API_KEY || ''),
            model: 'BAAI/bge-m3'
          }});
        }
        const parsed = JSON.parse(row.value);
        if (parsed.api_key_enc) {
          parsed.api_key = maskKey(decrypt(parsed.api_key_enc));
          delete parsed.api_key_enc;
        }
        res.json({ ok: true, data: parsed });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.put('/api/settings/embedding', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const { base_url, api_key, model } = req.body;
        const existing = db.prepare("SELECT value FROM app_settings WHERE key='embedding'").get();
        let stored = {};
        if (existing) { try { stored = JSON.parse(existing.value); } catch(e){} }
        const oldModel = stored.model || '';
        stored.base_url = base_url || stored.base_url;
        stored.model = model || stored.model;
        if (api_key && !api_key.includes('***')) {
          stored.api_key_enc = encrypt(api_key);
        }
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('embedding', ?, datetime('now'))").run(JSON.stringify(stored));
        db.prepare("UPDATE embedding_jobs SET attempts=0, status='pending', error='', updated_at=datetime('now') WHERE status IN ('error','pending')").run();
        if (model && model !== oldModel) {
          const rows = db.prepare("SELECT id FROM buckets WHERE bucket_type!='archive'").all();
          const stmt = db.prepare(`
            INSERT INTO embedding_jobs (bucket_id, reason, status, attempts, error, updated_at)
            VALUES (?, 'model-changed', 'pending', 0, '', datetime('now'))
            ON CONFLICT(bucket_id) DO UPDATE SET reason='model-changed', status='pending', attempts=0, error='', updated_at=datetime('now')
          `);
          rows.forEach(r => stmt.run(r.id));
        }
        setTimeout(() => {
          try { require('../embedding').processEmbeddingQueue(10).catch(() => {}); } catch(e) {}
        }, 50);
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // ============================================================
    // DEDUP
    // ============================================================
    app.post('/api/buckets/dedup', (req, res) => {
      try {
        const { runDedup } = require('../dedup');
        const result = runDedup(DB_PATH, req.body || {});
        res.json(result);
      } catch(e) { res.json({ ok: false, error: e.message }); }
    });

    // ============================================================
    // CHECKINS (Calendar)
    // ============================================================
    app.get('/api/checkins', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const { year, month } = req.query;
        let rows;
        if (year && month) {
          const prefix = `${year}-${String(month).padStart(2,'0')}`;
          rows = db.prepare("SELECT * FROM checkins WHERE date LIKE ? ORDER BY date").all(`${prefix}%`);
        } else {
          rows = db.prepare("SELECT * FROM checkins ORDER BY date DESC LIMIT 200").all();
        }
        res.json({ ok: true, data: rows });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.post('/api/checkins', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const { date, user, note } = req.body;
        if (!date || !user) return res.json({ ok: false, error: 'date and user required' });
        db.prepare("INSERT OR IGNORE INTO checkins (date, user, note) VALUES (?, ?, ?)").run(date, user, note||'');
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.delete('/api/checkins/:date/:user', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        db.prepare("DELETE FROM checkins WHERE date=? AND user=?").run(req.params.date, req.params.user);
        res.json({ ok: true });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // ============================================================
    // SAVE CONVERSATION AS MEMORY
    // ============================================================
    app.post('/api/conversations/save-to-memory', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const { messages, title, occurred_at } = req.body;
        if (!messages || !messages.length) return res.json({ ok: false, error: 'no messages' });
        const content = messages.map(m => `【${m.role === 'user' ? USER_NAME : COMPANION_NAME}】${m.content}`).join('\n\n');
        const id = Math.random().toString(36).slice(2, 14);
        db.prepare(`INSERT INTO buckets (id, name, content, bucket_type, occurred_at, personas, domain, tags, importance)
          VALUES (?, ?, ?, 'chat_log', ?, ?, '["对话"]', '["家庭","聊天记录"]', 7)`)
          .run(id, title || `对话 ${occurred_at || new Date().toISOString().slice(0,10)}`, content, occurred_at || new Date().toISOString().slice(0,10), JSON.stringify({ user: USER_NAME, ai: COMPANION_NAME }));
        try { require('../embedding').scheduleEmbed(id, 'chat_log'); } catch(e) {}
        res.json({ ok: true, id });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // ============================================================
    // POSTA - 带权限过滤的路由（放在 generic :table 路由之前生效）
    // ============================================================
    app.get('/api/posta/inbox', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const rows = db.prepare("SELECT * FROM posta WHERE is_read=0 AND archived=0 ORDER BY created_at DESC").all();
        res.json({ ok: true, data: rows });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.get('/api/posta/archive', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const rows = db.prepare("SELECT * FROM posta WHERE archived=1 ORDER BY created_at DESC").all();
        res.json({ ok: true, data: rows });
      } catch(e) { res.json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });
  }

  return {
    getLLMConfig,
    mountPreMigrationRoutes,
    mountPostMigrationRoutes,
  };
}

module.exports = { createSettingsMemoryRoutes };
