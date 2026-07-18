const Database = require('better-sqlite3');

// Creates tables that live in rifugio-settings.db (passkeys + terminal auth).
function ensureSettingsSchema(SETTINGS_DB_PATH) {
  const db = new Database(SETTINGS_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      webauthn_user_id TEXT NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_type TEXT DEFAULT '',
      backed_up INTEGER NOT NULL DEFAULT 0,
      transports TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user
      ON passkey_credentials(user_id);
    CREATE TABLE IF NOT EXISTS passkey_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      challenge TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_challenges_lookup
      ON passkey_challenges(user_id, purpose, expires_at);
    CREATE TABLE IF NOT EXISTS terminal_passkeys (
      credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key BLOB NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      device_name TEXT NOT NULL DEFAULT '',
      terminal_enabled INTEGER NOT NULL DEFAULT 1,
      revoked INTEGER NOT NULL DEFAULT 0,
      transports TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_passkeys_user
      ON terminal_passkeys(user_id, terminal_enabled, revoked);
    CREATE TABLE IF NOT EXISTS terminal_passkey_register_windows (
      user_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.close();
}

// Creates tables that live in rifugio-memory.db (app_settings, stickers — bootstrap only).
// buckets/health tables are created by their own init functions; this just ensures
// app_settings and ai_stickers exist before anything tries to read them.
function ensureCoreSchema(MEMORY_DB_PATH) {
  const db = new Database(MEMORY_DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_stickers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      data_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL DEFAULT '',
      semantic TEXT NOT NULL DEFAULT '',
      stolen_from TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT 'user',
      resident INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_stickers_lookup
      ON ai_stickers(name, category, keywords, semantic);
  `);
  db.close();
}

// Migrations that touch rifugio-memory.db (buckets columns, checkins table).
function runMigrations(MEMORY_DB_PATH) {
  const db = new Database(MEMORY_DB_PATH);
  try { db.exec(`ALTER TABLE buckets ADD COLUMN emotion_label TEXT DEFAULT NULL;`); } catch(e) { /* already exists */ }
  try { db.exec(`ALTER TABLE ai_stickers ADD COLUMN resident INTEGER NOT NULL DEFAULT 0;`); } catch(e) { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      user TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, user)
    );
  `);
  db.close();
}

// Migrations that touch rifugio-chat.db (log tables).
function runChatMigrations(CHAT_DB_PATH) {
  const db = new Database(CHAT_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS log_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS log_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id INTEGER NOT NULL REFERENCES log_conversations(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      thinking TEXT DEFAULT '',
      time TEXT DEFAULT '',
      seq INTEGER DEFAULT 0
    );
  `);
  db.close();
}

function addDehydratedColumn(MEMORY_DB_PATH) {
  const db = new Database(MEMORY_DB_PATH);
  try { db.exec(`ALTER TABLE buckets ADD COLUMN dehydrated TEXT DEFAULT NULL;`); } catch(e) {}
  db.close();
}

module.exports = {
  ensureCoreSchema,
  ensureSettingsSchema,
  runMigrations,
  runChatMigrations,
  addDehydratedColumn,
};
