require("dotenv").config();

const IS_PROD = process.env.NODE_ENV === 'production';
const { createAppCore } = require('./modules/app-core');
const http = require('http');
const { app, clientIp } = createAppCore();
const { createAuthPasskey } = require('./modules/auth-passkey');
const authPasskey = createAuthPasskey({ IS_PROD, clientIp });
const { hasTerminalAuth, isAuthed } = authPasskey;
authPasskey.mountAuthRoutes(app);
const { mountCommunityRoutes } = require('./modules/community-routes');
mountCommunityRoutes(app);

// 挂载 ombre 路由（如果当前部署包带有 routes/ombre）
try {
  if (process.env.OMBRE_BASE_URL && process.env.OMBRE_API_KEY) {
    app.use('/memory-api/ombre', require('./routes/ombre'));
  }
} catch(e) {
  console.warn('[server] routes/ombre not mounted:', e.message);
}

const {
  DB_PATH,
  CHAT_DB_PATH,
  MEMORY_DB_PATH,
  SETTINGS_DB_PATH,
  readJsonSetting,
  writeJsonSetting,
} = require('./modules/db-settings');

const { createPushRoutes } = require('./modules/push-routes');
const { createTalkProactive } = require('./modules/talk-proactive');
const { mountTalkMediaRoutes } = require('./modules/talk-media');
const { createSettingsMemoryRoutes } = require('./modules/settings-memory-routes');
const { createTalkConvos } = require('./modules/talk-convos');
const { mountDbCrudRoutes } = require('./modules/db-crud-routes');
const { mountUploadRoutes } = require('./modules/upload-routes');
const { ensureCoreSchema, ensureSettingsSchema, runMigrations, runChatMigrations, addDehydratedColumn } = require('./modules/db-startup');
const { createSecretCrypto } = require('./modules/secret-crypto');
const { createClaudeRuntime } = require('./modules/claude-runtime');
const pushRoutes = createPushRoutes({ readJsonSetting, writeJsonSetting });
const { sendWebPushNotification } = pushRoutes;

// 确保各库 schema（必须在 bucket/auth 初始化之前）
ensureCoreSchema(MEMORY_DB_PATH);
ensureSettingsSchema(SETTINGS_DB_PATH);

// 挂载 bucket 记忆桶系统
const { initBuckets, mountBucketRoutes } = require('./buckets');
const { initEmbedding, mountEmbeddingRoutes } = require('./embedding');
initBuckets(MEMORY_DB_PATH);
initEmbedding(MEMORY_DB_PATH);
mountBucketRoutes(app, MEMORY_DB_PATH);
mountEmbeddingRoutes(app, MEMORY_DB_PATH);
const { initHealth, mountHealthRoutes } = require('./health');
initHealth(MEMORY_DB_PATH);
mountHealthRoutes(app, MEMORY_DB_PATH, { ingestToken: process.env.HEALTH_INGEST_TOKEN });
const { mountBooksRoutes } = require('./books');
mountBooksRoutes(app, { MEMORY_DB_PATH });
const { mountPetRoutes } = require('./modules/pet');
mountPetRoutes(app);
const { maskKey, encrypt, decrypt } = createSecretCrypto({ isProd: IS_PROD });
const { mountPetAiRoutes } = require('./modules/pet-ai');
mountPetAiRoutes(app, { DB_PATH: MEMORY_DB_PATH, maskKey, encrypt, decrypt, clientIp });

const settingsMemoryRoutes = createSettingsMemoryRoutes({ DB_PATH: MEMORY_DB_PATH, maskKey, encrypt, decrypt });
const { getLLMConfig } = settingsMemoryRoutes;

authPasskey.mountPasskeyRoutes(app, { DB_PATH: SETTINGS_DB_PATH });

settingsMemoryRoutes.mountPreMigrationRoutes(app);

// ============================================================
// DB MIGRATIONS (run once at startup)
// ============================================================
runMigrations(MEMORY_DB_PATH);
runChatMigrations(CHAT_DB_PATH);

settingsMemoryRoutes.mountPostMigrationRoutes(app);

const { mountVoiceSttRoutes } = require('./modules/voice-stt');
const voiceRoutes = mountVoiceSttRoutes(app, { DB_PATH: MEMORY_DB_PATH, maskKey, encrypt, decrypt });

// ============================================================
// EMOTION LABEL AUTO-TAGGING
// ============================================================

const { buildChatTools, mountToolRoutes } = require('./modules/tool-routes');
let sanitizeTalkMessages = value => value;
const claudeRuntime = createClaudeRuntime(app, {
  DB_PATH: CHAT_DB_PATH,
  MEMORY_DB_PATH,
  getLLMConfig,
  hasTerminalAuth,
  sanitizeTalkMessages: value => sanitizeTalkMessages(value),
});
const {
  CLAUDE_SPAWN_TIMEOUT_MS,
  buildInitialSystemPrompt,
  isClaudeSessionId,
  syncClaudeTalkConversation,
  resolveCliModel,
} = claudeRuntime;

const { mountChatroomCcRoutes } = require('./modules/chatroom-cc');
mountChatroomCcRoutes(app, { resolveCliModel });

const { mountChatroomApiRoutes, mountTalkApiRoutes } = require('./modules/chatroom-api');
mountChatroomApiRoutes(app);
mountTalkApiRoutes(app);

const talkProactive = createTalkProactive({
  DB_PATH: CHAT_DB_PATH,
  readJsonSetting,
  writeJsonSetting,
  sanitizeTalkMessages: value => sanitizeTalkMessages(value),
  sendWebPushNotification,
});
const {
  TALK_PROACTIVE_POLL_MS,
  markTalkActivityFromMessages,
  maybeRunTalkProactive,
  pushTalkProactiveEvent,
} = talkProactive;
const talkConvos = createTalkConvos({
  DB_PATH: CHAT_DB_PATH,
  isClaudeSessionId,
  syncClaudeTalkConversation,
  onMomentEvent: pushTalkProactiveEvent,
  sendWebPushNotification,
});
sanitizeTalkMessages = talkConvos.sanitizeTalkMessages;
talkConvos.mountTalkConvoRoutes(app, { markTalkActivityFromMessages });
talkProactive.mountTalkProactiveRoutes(app);

pushRoutes.mountPushRoutes(app);
mountTalkMediaRoutes(app, { DB_PATH: MEMORY_DB_PATH });
const { mountSocialLinkRoutes } = require('./modules/social-links');
mountSocialLinkRoutes(app);

// ============================================================
// DEHYDRATION + BREATH (自建，不依赖原版 Python 服务)
// ============================================================
addDehydratedColumn(MEMORY_DB_PATH);

// POST /api/buckets/dehydrate  body: { ids?: string[] }
// 对没有脱水版的记忆调 LLM 压缩，每批 ≤15 条
// GET /api/buckets/breath?top=5
// 衰减评分取 top N，返回脱水版注入 Claude 上下文
// --- Generic CRUD (table whitelist) ---
// ── 搜索路由（必须在table middleware之前）──────────────────────────────
mountToolRoutes(app, { hasTerminalAuth });
setInterval(() => { maybeRunTalkProactive().catch(e => console.warn('[talk proactive]', e.message)); }, TALK_PROACTIVE_POLL_MS);
setTimeout(() => { maybeRunTalkProactive().catch(() => {}); }, 5000);

mountDbCrudRoutes(app, { DB_PATH: MEMORY_DB_PATH, CHAT_DB_PATH });
mountUploadRoutes(app);

const server = http.createServer(app);
const { mountTalkCallWebSocket } = require('./modules/talk-call-ws-v2');
mountTalkCallWebSocket(server, { isAuthed, loadTtsSettings: voiceRoutes.loadTtsSettings });
const API_PORT = Math.max(1, Number(process.env.PORT || process.env.RIFUGIO_API_PORT || 3457));
const API_HOST = process.env.RIFUGIO_API_HOST || '0.0.0.0';
server.listen(API_PORT, API_HOST, () => console.log(`Rifugio API + TalkCall WSS on ${API_HOST}:${API_PORT}`));
