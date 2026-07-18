const crypto = require('crypto');
const Database = require('better-sqlite3');

function createTalkConvos(ctx = {}) {
  const {
    DB_PATH,
    isClaudeSessionId,
    syncClaudeTalkConversation,
  } = ctx;

  const TOOL_USE_MARKER_RE = /\n?\[Using [^\]\n]+…\]\n?/g;
  function stripToolUseMarkersText(v) {
    return String(v || '').replace(TOOL_USE_MARKER_RE, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function sanitizeTalkMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(m => {
      if (!m || typeof m !== 'object') return m;
      if (m.role !== 'assistant' || !m.content) return m;
      const clean = stripToolUseMarkersText(m.content);
      return clean === m.content ? m : { ...m, content: clean };
    });
  }

  {
    const _db = new Database(DB_PATH);
    _db.exec(`CREATE TABLE IF NOT EXISTS chat_convos (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      session_id  TEXT,
      model       TEXT,
      messages    TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT,
      updated_at  TEXT
    )`);
    const cols = new Set(_db.prepare(`PRAGMA table_info(chat_convos)`).all().map(r => r.name));
    if (!cols.has('group_name')) _db.exec(`ALTER TABLE chat_convos ADD COLUMN group_name TEXT DEFAULT ''`);
    if (!cols.has('remark')) _db.exec(`ALTER TABLE chat_convos ADD COLUMN remark TEXT DEFAULT ''`);
    if (!cols.has('pinned')) _db.exec(`ALTER TABLE chat_convos ADD COLUMN pinned INTEGER DEFAULT 0`);
    // 列表元数据列（2026-07-02）：列表接口不再回传/解析几十 MB 的 messages JSON。
    // 写入路径（PUT 带 messages / POST merge）负责维护这三列；下面做一次性回填。
    if (!cols.has('message_count')) {
      _db.exec(`ALTER TABLE chat_convos ADD COLUMN message_count INTEGER DEFAULT 0`);
      _db.exec(`ALTER TABLE chat_convos ADD COLUMN last_content TEXT DEFAULT ''`);
      _db.exec(`ALTER TABLE chat_convos ADD COLUMN last_time TEXT DEFAULT ''`);
      try {
        _db.exec(`UPDATE chat_convos SET
          message_count = COALESCE(json_array_length(messages), 0),
          last_content  = COALESCE(substr(json_extract(messages, '$[#-1].content'), 1, 200), ''),
          last_time     = COALESCE(json_extract(messages, '$[#-1].time'), '')`);
      } catch (e) { console.warn('[chat_convos] meta backfill failed:', e.message); }
    }
    _db.exec(`CREATE TABLE IF NOT EXISTS talk_moments (
      id          TEXT PRIMARY KEY,
      author      TEXT NOT NULL DEFAULT '',
      avatar      TEXT NOT NULL DEFAULT '',
      text        TEXT NOT NULL DEFAULT '',
      images      TEXT NOT NULL DEFAULT '[]',
      comments    TEXT NOT NULL DEFAULT '[]',
      time        TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_talk_moments_created
      ON talk_moments(created_at DESC);`);
    _db.close();
  }

  function safeJsonArray(raw, fallback = []) {
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(v) ? v : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function talkMomentCreatedAt(m) {
    const direct = String(m?.createdAt || m?.created_at || '').trim();
    if (direct) return direct.slice(0, 80);
    const match = String(m?.id || '').match(/moment-(\d{10,})/);
    if (match) {
      const d = new Date(Number(match[1]));
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
  }

  function sanitizeTalkMomentImage(img) {
    if (!img || typeof img !== 'object') return null;
    const dataUrl = String(img.dataUrl || img.data_url || '').trim();
    const url = String(img.url || '').trim();
    if (!dataUrl && !url) return null;
    return {
      id: String(img.id || crypto.randomUUID()).slice(0, 120),
      name: String(img.name || '').slice(0, 240),
      kind: String(img.kind || 'moment').slice(0, 40),
      dataUrl,
      url,
    };
  }

  function sanitizeTalkMomentComment(comment) {
    if (!comment || typeof comment !== 'object') return null;
    const text = String(comment.text || '').trim();
    if (!text) return null;
    return {
      id: String(comment.id || crypto.randomUUID()).slice(0, 120),
      author: String(comment.author || '').slice(0, 120),
      avatar: String(comment.avatar || '').slice(0, 20000),
      text: text.slice(0, 2000),
      time: String(comment.time || '').slice(0, 80),
    };
  }

  function sanitizeTalkMoment(input) {
    const m = input && typeof input === 'object' ? input : {};
    const id = String(m.id || ('moment-' + Date.now() + '-' + crypto.randomUUID())).slice(0, 120);
    return {
      id,
      author: String(m.author || '').slice(0, 120),
      avatar: String(m.avatar || '').slice(0, 20000),
      text: String(m.text || '').slice(0, 12000),
      images: safeJsonArray(m.images).slice(0, 9).map(sanitizeTalkMomentImage).filter(Boolean),
      comments: safeJsonArray(m.comments).slice(0, 200).map(sanitizeTalkMomentComment).filter(Boolean),
      time: String(m.time || '').slice(0, 80),
      created_at: talkMomentCreatedAt(m),
    };
  }

  function talkMomentRowToJson(row) {
    return {
      id: row.id,
      author: row.author || '',
      avatar: row.avatar || '',
      text: row.text || '',
      images: safeJsonArray(row.images),
      comments: safeJsonArray(row.comments),
      time: row.time || '',
      createdAt: row.created_at || '',
      updatedAt: row.updated_at || '',
    };
  }

  function upsertTalkMoment(db, moment) {
    db.prepare(`INSERT INTO talk_moments (id, author, avatar, text, images, comments, time, created_at, updated_at)
      VALUES (@id, @author, @avatar, @text, @images, @comments, @time, @created_at, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        author=excluded.author,
        avatar=excluded.avatar,
        text=excluded.text,
        images=excluded.images,
        comments=excluded.comments,
        time=excluded.time,
        created_at=COALESCE(NULLIF(excluded.created_at, ''), talk_moments.created_at),
        updated_at=datetime('now')`).run({
      ...moment,
      images: JSON.stringify(moment.images),
      comments: JSON.stringify(moment.comments),
    });
  }

  // 派生元数据：写入路径维护 message_count/last_content/last_time 三列，列表接口零 JSON 解析
  function talkConvoDerivedMeta(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const last = list[list.length - 1] || null;
    return {
      message_count: list.length,
      last_content: String(last?.content || (last?.attachments?.length ? '[附件]' : '') || '').slice(0, 200),
      last_time: String(last?.time || ''),
    };
  }
  function talkConvoRowToMeta(r, activeByConversation) {
    const activeSid = activeByConversation.get(r.id);
    const sid = isClaudeSessionId(activeSid) ? activeSid : (isClaudeSessionId(r.session_id) ? r.session_id : '');
    return {
      id: r.id, name: r.name, session_id: sid, model: r.model || 'opus',
      created_at: r.created_at, updated_at: r.updated_at,
      group_name: r.group_name || '', group: r.group_name || '',
      remark: r.remark || '', pinned: Boolean(r.pinned),
      message_count: Number(r.message_count || 0) || 0,
      last_content: r.last_content || '',
      last_time: r.last_time || '',
    };
  }
  const TALK_CONVO_META_COLS = 'id, name, session_id, model, created_at, updated_at, group_name, remark, pinned, message_count, last_content, last_time';

  function mountTalkConvoRoutes(app, opts = {}) {
    const { markTalkActivityFromMessages } = opts;

    app.get('/api/talk/convos', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80) || 80));
        const offset = Math.max(0, Number(req.query.offset || 0) || 0);
        // fields=meta（推荐）：只回元数据+最后一条预览，不解析/传输 messages（列表曾 40+MB，是加载慢的元凶）
        const metaOnly = String(req.query.fields || '') === 'meta' || String(req.query.include_messages ?? '1') === '0';
        const total = db.prepare('SELECT COUNT(*) AS n FROM chat_convos').get()?.n || 0;
        const rows = db.prepare(`SELECT ${metaOnly ? TALK_CONVO_META_COLS : '*'} FROM chat_convos ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
        const activeRows = db.prepare('SELECT id, active_claude_session_id FROM claude_conversations').all();
        const activeByConversation = new Map(activeRows.map(r => [r.id, r.active_claude_session_id]));
        const convos = rows.map(r => ({
          ...talkConvoRowToMeta(r, activeByConversation),
          messages: metaOnly ? [] : sanitizeTalkMessages((() => { try { return JSON.parse(r.messages); } catch { return []; } })()),
        }));
        res.json({ ok: true, convos, total, limit, offset, next_offset: offset + convos.length, has_more: offset + convos.length < total, fields: metaOnly ? 'meta' : 'full' });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // 单个对话消息分页：默认从末尾取 30 条。before 是消息数组中的结束游标（不含）。
    app.get('/api/talk/convos/:id/messages', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const r = db.prepare('SELECT messages FROM chat_convos WHERE id=?').get(req.params.id);
        if (!r) return res.status(404).json({ ok: false, error: 'not found' });
        const all = sanitizeTalkMessages(safeJsonArray(r.messages));
        const total = all.length;
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30) || 30));
        const requestedBefore = req.query.before === undefined ? total : Number(req.query.before);
        const before = Math.max(0, Math.min(total, Number.isFinite(requestedBefore) ? Math.floor(requestedBefore) : total));
        const start = Math.max(0, before - limit);
        res.json({ ok:true, messages:all.slice(start, before), total, start, before, next_before:start, has_more:start > 0, limit });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // 单个对话全量（仅供必须拿完整历史的安全同步流程）
    app.get('/api/talk/convos/:id', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const r = db.prepare('SELECT * FROM chat_convos WHERE id=?').get(req.params.id);
        if (!r) return res.status(404).json({ ok: false, error: 'not found' });
        const activeRows = db.prepare('SELECT id, active_claude_session_id FROM claude_conversations WHERE id=?').all(req.params.id);
        const activeByConversation = new Map(activeRows.map(x => [x.id, x.active_claude_session_id]));
        res.json({ ok: true, convo: {
          ...talkConvoRowToMeta(r, activeByConversation),
          messages: sanitizeTalkMessages((() => { try { return JSON.parse(r.messages); } catch { return []; } })()),
        } });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.put('/api/talk/convos/:id', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const { name, session_id, model, messages, created_at, group_name, group, remark, pinned } = req.body || {};
        const existing = db.prepare('SELECT session_id FROM chat_convos WHERE id=?').get(req.params.id);
        const requestedSessionId = session_id === undefined ? (existing?.session_id || '') : (session_id || '');
        // messages 不传 = 纯元数据更新（改名/置顶/分组），不动已存历史。
        // ⚠️ 以前 undefined 会被 sanitize 成 [] 直接把整段历史抹掉。
        const metaOnly = messages === undefined && Boolean(existing);
        // 半截覆盖护栏（2026-07-03）：前端懒加载没拉完时误发的全量 PUT 会把长历史砍成几十条。
        // 已存 >50 条时，来的全量若不足现存一半直接拒收——正常的重发/重新生成只会删末尾几条，
        // 砍掉一半以上的只可能是"拿不完整内存状态当完整历史"的事故写入。
        if (!metaOnly && Array.isArray(messages)) {
          const existingCount = Number(db.prepare('SELECT COALESCE(json_array_length(messages),0) n FROM chat_convos WHERE id=?').get(req.params.id)?.n || 0);
          if (existingCount > 50 && messages.length < existingCount / 2) {
            console.warn(`[talk-convos] 拒绝疑似半截全量 PUT: ${req.params.id} 现存${existingCount}条 来${messages.length}条`);
            return res.status(409).json({ ok: false, error: `full PUT rejected: ${messages.length} msgs would overwrite ${existingCount}` });
          }
        }
        const convo = {
          id: req.params.id,
          name: name || '新对话',
          session_id: isClaudeSessionId(requestedSessionId) ? requestedSessionId : null,
          model: model || 'opus',
          messages: metaOnly ? null : sanitizeTalkMessages(messages),
          created_at: created_at || new Date().toISOString(),
          group_name: String(group_name ?? group ?? '').trim().slice(0, 80),
          remark: String(remark || '').trim().slice(0, 120),
          pinned: pinned ? 1 : 0,
        };
        if (metaOnly) {
          db.prepare(`UPDATE chat_convos SET name=@name, session_id=@session_id, model=@model,
            group_name=@group_name, remark=@remark, pinned=@pinned, updated_at=datetime('now') WHERE id=@id`).run({
            id: convo.id, name: convo.name, session_id: convo.session_id, model: convo.model,
            group_name: convo.group_name, remark: convo.remark, pinned: convo.pinned,
          });
        } else {
          const derived = talkConvoDerivedMeta(convo.messages);
          db.prepare(`INSERT INTO chat_convos (id, name, session_id, model, messages, created_at, updated_at, group_name, remark, pinned, message_count, last_content, last_time)
            VALUES (@id, @name, @session_id, @model, @messages, @created_at, datetime('now'), @group_name, @remark, @pinned, @message_count, @last_content, @last_time)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, session_id=excluded.session_id, model=excluded.model,
              messages=excluded.messages, group_name=excluded.group_name, remark=excluded.remark,
              pinned=excluded.pinned, updated_at=datetime('now'),
              message_count=excluded.message_count, last_content=excluded.last_content, last_time=excluded.last_time`).run({
            ...convo,
            ...derived,
            messages: JSON.stringify(convo.messages),
          });
        }
        if (!metaOnly) {
          try { syncClaudeTalkConversation(convo); } catch (_) {}
          try { markTalkActivityFromMessages(convo); } catch (_) {}
        }
        res.json({ ok: true, meta_only: metaOnly });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // 增量消息同步（2026-07-02）：前端每轮只 POST 最近几条，按 id 合并（有则替换、无则追加）。
    // 之前每条消息都 PUT 整个 messages 数组（活跃对话 5.9MB，流式期间一分钟好几次）——手机上行直接被打爆。
    app.post('/api/talk/convos/:id/messages', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const { name, session_id, model, messages, created_at, group_name, group, remark, pinned } = req.body || {};
        const incoming = sanitizeTalkMessages(Array.isArray(messages) ? messages : []);
        const existing = db.prepare('SELECT * FROM chat_convos WHERE id=?').get(req.params.id);
        let stored = [];
        if (existing) { try { stored = JSON.parse(existing.messages || '[]'); } catch (_) { stored = []; } }
        if (!Array.isArray(stored)) stored = [];
        const byId = new Map();
        stored.forEach((m, i) => { if (m && m.id != null) byId.set(String(m.id), i); });
        for (const m of incoming) {
          if (!m || m.id == null) { stored.push(m); continue; }
          const at = byId.get(String(m.id));
          if (at === undefined) { byId.set(String(m.id), stored.length); stored.push(m); }
          else stored[at] = m;
        }
        const requestedSessionId = session_id === undefined ? (existing?.session_id || '') : (session_id || '');
        const convo = {
          id: req.params.id,
          name: name || existing?.name || '新对话',
          session_id: isClaudeSessionId(requestedSessionId) ? requestedSessionId : null,
          model: model || existing?.model || 'opus',
          messages: stored,
          created_at: created_at || existing?.created_at || new Date().toISOString(),
          group_name: String(group_name ?? group ?? existing?.group_name ?? '').trim().slice(0, 80),
          remark: String(remark ?? existing?.remark ?? '').trim().slice(0, 120),
          pinned: (pinned === undefined ? Boolean(existing?.pinned) : Boolean(pinned)) ? 1 : 0,
        };
        const derived = talkConvoDerivedMeta(stored);
        db.prepare(`INSERT INTO chat_convos (id, name, session_id, model, messages, created_at, updated_at, group_name, remark, pinned, message_count, last_content, last_time)
          VALUES (@id, @name, @session_id, @model, @messages, @created_at, datetime('now'), @group_name, @remark, @pinned, @message_count, @last_content, @last_time)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, session_id=excluded.session_id, model=excluded.model,
            messages=excluded.messages, group_name=excluded.group_name, remark=excluded.remark,
            pinned=excluded.pinned, updated_at=datetime('now'),
            message_count=excluded.message_count, last_content=excluded.last_content, last_time=excluded.last_time`).run({
          ...convo,
          ...derived,
          messages: JSON.stringify(stored),
        });
        try { syncClaudeTalkConversation(convo); } catch (_) {}
        try { markTalkActivityFromMessages(convo); } catch (_) {}
        res.json({ ok: true, message_count: stored.length, merged: incoming.length });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    // 轻量截断：重发/重新生成时按消息 id 在服务端原子删除尾部，避免手机先下载再上传整段历史。
    app.post('/api/talk/convos/:id/truncate', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const fromMessageId = String(req.body?.from_message_id ?? '').trim();
        if (!fromMessageId) return res.status(400).json({ ok: false, error: 'from_message_id required' });
        const existing = db.prepare('SELECT * FROM chat_convos WHERE id=?').get(req.params.id);
        if (!existing) return res.status(404).json({ ok: false, error: 'not found' });
        let stored = safeJsonArray(existing.messages);
        const idx = stored.findIndex(m => m && String(m.id) === fromMessageId);
        if (idx < 0) return res.status(409).json({ ok: false, error: 'message not found', message_count: stored.length });
        stored = sanitizeTalkMessages(stored.slice(0, idx));
        const derived = talkConvoDerivedMeta(stored);
        db.prepare(`UPDATE chat_convos SET messages=@messages, message_count=@message_count,
          last_content=@last_content, last_time=@last_time, updated_at=datetime('now') WHERE id=@id`).run({
          id: req.params.id,
          messages: JSON.stringify(stored),
          ...derived,
        });
        const convo = {
          id: existing.id, name: existing.name, session_id: existing.session_id,
          model: existing.model, messages: stored, created_at: existing.created_at,
          group_name: existing.group_name || '', remark: existing.remark || '', pinned: existing.pinned ? 1 : 0,
        };
        try { syncClaudeTalkConversation(convo); } catch (_) {}
        try { markTalkActivityFromMessages(convo); } catch (_) {}
        res.json({ ok: true, message_count: stored.length, truncated_from: fromMessageId });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.delete('/api/talk/convos/:id', (req, res) => {
      const db = new Database(DB_PATH);
      try { db.prepare('DELETE FROM chat_convos WHERE id = ?').run(req.params.id); res.json({ ok: true }); }
      catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.get('/api/talk/moments', (req, res) => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80) || 80));
        const rows = db.prepare('SELECT * FROM talk_moments ORDER BY datetime(created_at) DESC, datetime(updated_at) DESC LIMIT ?').all(limit);
        res.json({ ok: true, moments: rows.map(talkMomentRowToJson) });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.put('/api/talk/moments', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const moments = safeJsonArray(req.body?.moments).slice(0, 80).map(sanitizeTalkMoment);
        const replace = req.body?.replace !== false;
        const tx = db.transaction((rows) => {
          rows.forEach(m => upsertTalkMoment(db, m));
          if (replace) {
            if (rows.length) {
              const placeholders = rows.map(() => '?').join(',');
              db.prepare(`DELETE FROM talk_moments WHERE id NOT IN (${placeholders})`).run(...rows.map(m => m.id));
            } else {
              db.prepare('DELETE FROM talk_moments').run();
            }
          }
        });
        tx(moments);
        res.json({ ok: true, count: moments.length });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.put('/api/talk/moments/:id', (req, res) => {
      const db = new Database(DB_PATH);
      try {
        const moment = sanitizeTalkMoment({ ...(req.body || {}), id: req.params.id });
        upsertTalkMoment(db, moment);
        res.json({ ok: true, moment });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });

    app.delete('/api/talk/moments/:id', (req, res) => {
      const db = new Database(DB_PATH);
      try { db.prepare('DELETE FROM talk_moments WHERE id=?').run(String(req.params.id || '')); res.json({ ok: true }); }
      catch (e) { res.status(500).json({ ok: false, error: e.message }); }
      finally { db.close(); }
    });
  }

  return {
    sanitizeTalkMessages,
    mountTalkConvoRoutes,
  };
}

module.exports = { createTalkConvos };
