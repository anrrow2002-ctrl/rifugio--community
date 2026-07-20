const crypto = require('crypto');
const Database = require('./modules/sqlite');

const DB_PATH = process.env.RIFUGIO_DB || require('./modules/community-config').dataPath('rifugio-memory.db');

function db() {
  const d = new Database(DB_PATH);
  d.exec(`
    CREATE TABLE IF NOT EXISTS ai_stickers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      data_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      semantic TEXT NOT NULL DEFAULT '',
      stolen_from TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT 'ai',
      resident INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try { d.exec(`ALTER TABLE ai_stickers ADD COLUMN resident INTEGER NOT NULL DEFAULT 0;`); } catch (_) {}
  return d;
}

const tools = [
  {
    name: "ai_sticker_list",
    description: "按情绪、意图或分组查询已有的 AI 表情。只有常驻高频区没有合适表情且确实要发送时才调用；同一轮最多一次，必须使用本次结果或放弃发送，不要连续换词查询。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "情绪或意图，如委屈、期待、无语" },
        category: { type: "string", description: "可选分组名" },
        limit: { type: "number", description: "最多15，默认12" },
        residentOnly: { type: "boolean", description: "只看常驻高频区" },
        includePreview: { type: "boolean", description: "整理常驻区时返回预览URL，普通查询不要开启" }
      }
    }
  },
  {
    name: "ai_sticker_set_resident",
    description: "把已有 AI 表情加入或移出常驻高频区，最多50张。只能整理库存，不能新增、盗图或删除。",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, maxItems: 50 },
        resident: { type: "boolean" }
      },
      required: ["ids", "resident"]
    }
  }
];

function send(id, result, error = null) {
  process.stdout.write(JSON.stringify(error
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: String(error.message || error) } }
    : { jsonrpc: '2.0', id, result }) + '\n');
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function rowFromArgs(args = {}) {
  const url = String(args.url || args.imageUrl || '').trim();
  const semantic = String(args.semantic || args.meaning || args.name || '').trim().slice(0, 300);
  const name = String(args.name || semantic || 'AI表情包').trim().slice(0, 120);
  return {
    id: String(args.id || crypto.randomUUID()),
    name,
    url,
    data_url: String(args.dataUrl || args.data_url || '').trim(),
    category: String(args.category || args.group || 'AI专属').trim().slice(0, 80),
    keywords: String(args.keywords || args.aliases || '').trim().slice(0, 300),
    semantic,
    stolen_from: String(args.stolenFrom || args.stolen_from || url).trim().slice(0, 300),
    created_by: 'ai',
  };
}

function handleCall(id, name, args = {}) {
  const d = db();
  try {
    if (name === "ai_sticker_list") {
      const q = String(args.query || "").trim().toLowerCase();
      const category = String(args.category || "").trim().toLowerCase();
      const residentOnly = args.residentOnly === true;
      if (!q && !category && !residentOnly) throw new Error("query、category 或 residentOnly 至少提供一个");
      const limit = Math.max(1, Math.min(15, Number(args.limit || 12) || 12));
      const includePreview = args.includePreview === true;
      const all = d.prepare("SELECT id,name,url,data_url,category,keywords,semantic,resident FROM ai_stickers ORDER BY resident DESC, datetime(updated_at) DESC, name ASC").all();
      const rows = all.filter(s => {
        if (residentOnly && !Number(s.resident || 0)) return false;
        if (category && !String(s.category || "").toLowerCase().includes(category)) return false;
        return !q || [s.name, s.category, s.keywords, s.semantic].some(v => String(v || "").toLowerCase().includes(q));
      }).slice(0, limit).map(s => {
        const item = { id:s.id, name:s.name, category:s.category, semantic:s.semantic, keywords:s.keywords, resident:!!s.resident };
        if (includePreview && s.url) item.preview_url = s.url;
        return item;
      });
      const residentCount = Number(d.prepare("SELECT COUNT(*) AS n FROM ai_stickers WHERE resident=1").get()?.n || 0);
      return send(id, text({ query:q || null, category:category || null, resident_count:residentCount, stickers:rows }));
    }
    if (name === "ai_sticker_set_resident") {
      const ids = Array.from(new Set((Array.isArray(args.ids) ? args.ids : []).map(v => String(v || "").trim()).filter(Boolean))).slice(0, 50);
      if (!ids.length) throw new Error("ids required");
      const want = args.resident !== false;
      const placeholders = ids.map(() => "?").join(",");
      const found = d.prepare("SELECT id,resident FROM ai_stickers WHERE id IN (" + placeholders + ")").all(...ids);
      if (!found.length) throw new Error("没有找到这些表情");
      if (want) {
        const current = Number(d.prepare("SELECT COUNT(*) AS n FROM ai_stickers WHERE resident=1").get()?.n || 0);
        const adding = found.filter(s => !Number(s.resident || 0)).length;
        if (current + adding > 50) throw new Error("常驻高频区最多50张，请先移出一些");
      }
      const update = d.prepare("UPDATE ai_stickers SET resident=?, updated_at=CURRENT_TIMESTAMP WHERE id=?");
      d.transaction(() => found.forEach(s => update.run(want ? 1 : 0, s.id)))();
      const residents = d.prepare("SELECT id,name,category,semantic FROM ai_stickers WHERE resident=1 ORDER BY datetime(updated_at) DESC, name ASC").all();
      return send(id, text({ ok:true, changed:found.length, resident:want, resident_count:residents.length, residents }));
    }
    throw new Error('unknown tool: ' + name);
  } finally {
    d.close();
  }
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    if (msg.method === 'initialize') send(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rifugio-stickers', version: '1.0.0' } });
    else if (msg.method === 'tools/list') send(msg.id, { tools });
    else if (msg.method === 'tools/call') {
      try { handleCall(msg.id, msg.params?.name, msg.params?.arguments || {}); }
      catch (e) { send(msg.id, null, e); }
    } else if (msg.id) send(msg.id, {});
  }
});
