const Database = require('better-sqlite3');

// Three-database layout (2026-07-03):
//   rifugio-chat.db    — all chat/Claude conversation tables (the big one)
//   rifugio-memory.db  — buckets, health, diary, app_settings, stickers, etc.
//   rifugio-settings.db — passkey credentials and terminal auth windows only
const CHAT_DB_PATH     = process.env.RIFUGIO_CHAT_DB     || require('./community-config').dataPath('rifugio-chat.db');
const MEMORY_DB_PATH   = process.env.RIFUGIO_MEMORY_DB   || require('./community-config').dataPath('rifugio-memory.db');
const SETTINGS_DB_PATH = process.env.RIFUGIO_SETTINGS_DB || require('./community-config').dataPath('rifugio-settings.db');
// DB_PATH kept as legacy alias so sibling files (buckets.js, health.js, embedding.js) need zero changes.
const DB_PATH = MEMORY_DB_PATH;

function readAppSetting(key, fallback = '') {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(String(key || ''));
    return row ? row.value : fallback;
  } catch (_) {
    return fallback;
  } finally {
    db.close();
  }
}

function writeAppSetting(key, value) {
  const db = new Database(DB_PATH);
  try {
    db.prepare(`INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).run(String(key || ''), String(value ?? ''));
  } finally {
    db.close();
  }
}

function readJsonSetting(key, fallback) {
  try {
    const raw = readAppSetting(key, '');
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJsonSetting(key, value) {
  writeAppSetting(key, JSON.stringify(value ?? null));
}

module.exports = {
  DB_PATH,
  CHAT_DB_PATH,
  MEMORY_DB_PATH,
  SETTINGS_DB_PATH,
  readAppSetting,
  writeAppSetting,
  readJsonSetting,
  writeJsonSetting,
};
