const { promptWithImages } = require('./chat-images');
const { createClaudeStatusQuota } = require('./claude-status-quota');
const { mountClaudeChatRoute } = require('./claude-chat-route');
const { mountClaudeAgentStreamRoutes } = require('./claude-agent-stream');
const { mountTerminalHandoffRoute } = require('./terminal-handoff');
const { createTerminalChat } = require('./terminal-chat');
const { createClaudeProfileBootstrap } = require('./claude-profile-bootstrap');
const { createClaudeSessionRelay } = require('./claude-session-relay');
const { createClaudeConversationContext } = require('./claude-conversation-context');
const { createClaudeLedger } = require('./claude-ledger');
const { mountClaudeConversationStateRoute } = require('./claude-conversation-state');
const { createClaudeMemoryContext } = require('./claude-memory-context');
const {
  CLAUDE_SPAWN_TIMEOUT_MS,
  resolveCliModel,
  resolveThinkBudget,
} = require('./claude-cli-config');
const { sseHead } = require('./sse-utils');
const { buildChatTools } = require('./tool-routes');
const { PERSONA_TEXT } = require('./community-config');

function createClaudeRuntime(app, deps) {
  const {
    DB_PATH,
    MEMORY_DB_PATH = DB_PATH,
    getLLMConfig,
    hasTerminalAuth,
    sanitizeTalkMessages = value => value,
  } = deps;

  let conversationContext = null;
  let sessionRelay = null;
  let terminalReadState = () => ({ conversations: {} });
  let terminalCompactText = (value, max = 1200) => String(value || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
  let fireRelayHandoffSummary = async () => {};
  let getProfileRecord = () => null;

  let RELAY_MSG_COUNT = 200;
  let RELAY_TOTAL_MAX_CHARS = 120000;
  let AUTO_SESSION_RELAY_TRIGGER_RATIO = 0.85;

  function autoRelayEnabled(...args) { return conversationContext.autoRelayEnabled(...args); }
  function autoRelayThreshold(...args) { return conversationContext.autoRelayThreshold(...args); }
  function autoRelayTriggerTurns(...args) { return conversationContext.autoRelayTriggerTurns(...args); }
  function autoRelayContextMinTurns(...args) { return conversationContext.autoRelayContextMinTurns(...args); }
  function contextProgressState(...args) { return conversationContext.contextProgressState(...args); }
  function talkMessagesContextState(...args) { return conversationContext.talkMessagesContextState(...args); }
  function currentPromptExtraChars(...args) { return conversationContext.currentPromptExtraChars(...args); }
  function estimateConversationContextChars(...args) { return conversationContext.estimateConversationContextChars(...args); }
  function textFromTalkMessage(...args) { return conversationContext.textFromTalkMessage(...args); }
  function buildTalkConversationSummary(...args) { return conversationContext.buildTalkConversationSummary(...args); }
  function buildTerminalContextForInAppSession(...args) { return conversationContext.buildTerminalContextForInAppSession(...args); }
  function buildInAppSessionBootstrap(...args) { return conversationContext.buildInAppSessionBootstrap(...args); }

  function buildAutoSessionRelaySummary(...args) { return sessionRelay.buildAutoSessionRelaySummary(...args); }
  function planClaudeSessionRoute(...args) { return sessionRelay.planClaudeSessionRoute(...args); }
  function recordClaudeAutoRelayStart(...args) { return sessionRelay.recordClaudeAutoRelayStart(...args); }
  function restoreClaudeAutoRelayStart(...args) { return sessionRelay.restoreClaudeAutoRelayStart(...args); }
  function recordClaudeAutoRelayTurn(...args) { return sessionRelay.recordClaudeAutoRelayTurn(...args); }
  function maybePrepareClaudeAutoRelaySummary(...args) { return sessionRelay.maybePrepareClaudeAutoRelaySummary(...args); }

  const claudeLedger = createClaudeLedger({
    DB_PATH,
    textFromTalkMessage: (...args) => textFromTalkMessage(...args),
    sanitizeTalkMessages: value => sanitizeTalkMessages(value),
    autoRelayThreshold: (...args) => autoRelayThreshold(...args),
    autoRelayTriggerTurns: (...args) => autoRelayTriggerTurns(...args),
    autoRelayContextMinTurns: (...args) => autoRelayContextMinTurns(...args),
    talkMessagesContextState: (...args) => talkMessagesContextState(...args),
    autoRelayEnabled: (...args) => autoRelayEnabled(...args),
    getProfileRecord: (...args) => getProfileRecord(...args),
    getAutoSessionRelayTriggerRatio: () => AUTO_SESSION_RELAY_TRIGGER_RATIO,
  });
  const {
    CLAUDE_LEDGER_USER_ID,
    CLAUDE_LEDGER_PROJECT_ID,
    ledgerNow,
    openLedgerDb,
    ledgerCompactText,
    talkSourceMessages,
    upsertClaudeConversationRecord,
    isClaudeSessionId,
    resolveClaudeSessionForConversation,
    isDeferredToolMarkerMiss,
    clearStaleClaudeSessionForConversation,
    setActiveClaudeSessionForConversation,
    syncClaudeTalkConversation,
    loadClaudeLedgerMessages,
    appendClaudeConversationMessages,
    appendClaudePreviewBlock,
    recordClaudeAgentSession,
    recordClaudeHandoffSummary,
    classifyClaudePreviewBlock,
    loadClaudeConversationState,
  } = claudeLedger;

  const claudeStatusQuota = createClaudeStatusQuota();
  const { addPqUsage, PQ_WARN_USD, PQ_BUDGET_USD } = claudeStatusQuota;

  // （2026-07-01 修复，2026-07-02 重打）Opus 4.7/4.8 API 默认 thinking display="omitted"（块在、文本空），
  // 但 CLI 有隐藏 flag `--thinking-display summarized`（不在 --help，2.1.196+ 实测可用）能强制返回摘要。
  // 所以不再按模型关 thinking——所有模型一视同仁，靠 MAX_THINKING_TOKENS + 该 flag 拿思维链。
  // ⚠️ 别再加回 modelOmitsThinking 死函数（GPT/codex 的包里带，部署时要挡）。
  const { buildMemoryContext, compactContextText } = createClaudeMemoryContext({ DB_PATH: MEMORY_DB_PATH });

  const profileBootstrap = createClaudeProfileBootstrap({
    compactContextText,
    buildMemoryContext,
    buildTerminalContextForInAppSession,
    buildTalkConversationSummary,
    planClaudeSessionRoute,
    buildAutoSessionRelaySummary,
    getRelayMsgCount: () => RELAY_MSG_COUNT,
    getRelayTotalMaxChars: () => RELAY_TOTAL_MAX_CHARS,
    defaultPersona: PERSONA_TEXT,
  });
  getProfileRecord = profileBootstrap.getProfileRecord;
  const {
    writeJsonStateAtomic,
    profileInjectionPlan,
    frontendDynamicContextPlan,
    buildRuntimeContextPayload,
    attachRuntimeContextToPrompt,
    profileBlock,
    frontendDynamicContextBlock,
    buildTerminalProfileUpdateBootstrap,
    buildTerminalDynamicUpdateBootstrap,
    crossSurfaceBridgePlan,
    markCrossSurfaceBridgeInjected,
    resolveCharacterPrompt,
    buildSessionBootstrapHash,
    buildTerminalFrontendProfileHash,
    buildTerminalProfileCoreHash,
    sessionHasBootstrapHash,
    getSessionBootstrapHash,
    markProfileInjected,
    markFrontendDynamicContextInjected,
    markSessionBootstrapInjected,
    forceFreshRouteForBootstrap,
    logAppendPromptDebug,
    logTerminalBootstrapDebug,
    buildInitialSystemPrompt,
    FRONTEND_PROFILE_MARKER,
    FRONTEND_PROFILE_UPDATE_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER,
  } = profileBootstrap;

  conversationContext = createClaudeConversationContext({
    DB_PATH,
    compactContextText,
    loadClaudeLedgerMessages,
    ledgerCompactText,
    talkSourceMessages,
    isClaudeSessionId,
    terminalReadState: (...args) => terminalReadState(...args),
    terminalCompactText: (...args) => terminalCompactText(...args),
    openLedgerDb,
    sanitizeTalkMessages: value => sanitizeTalkMessages(value),
  });
  RELAY_MSG_COUNT = conversationContext.RELAY_MSG_COUNT;
  RELAY_TOTAL_MAX_CHARS = conversationContext.RELAY_TOTAL_MAX_CHARS;
  AUTO_SESSION_RELAY_TRIGGER_RATIO = conversationContext.AUTO_SESSION_RELAY_TRIGGER_RATIO;

  sessionRelay = createClaudeSessionRelay({
    DB_PATH,
    openLedgerDb,
    ledgerNow,
    upsertClaudeConversationRecord,
    CLAUDE_LEDGER_USER_ID,
    CLAUDE_LEDGER_PROJECT_ID,
    isClaudeSessionId,
    resolveClaudeSessionForConversation,
    autoRelayThreshold,
    autoRelayTriggerTurns,
    autoRelayEnabled,
    autoRelayContextMinTurns,
    contextProgressState,
    estimateConversationContextChars,
    talkMessagesContextState,
    currentPromptExtraChars,
    buildTalkConversationSummary,
    textFromTalkMessage,
    fireRelayHandoffSummary: (...args) => fireRelayHandoffSummary(...args),
    ledgerCompactText,
    RELAY_MSG_COUNT,
    RELAY_TOTAL_MAX_CHARS,
    AUTO_SESSION_RELAY_TRIGGER_RATIO,
  });

  mountClaudeChatRoute(app, {
    promptWithImages,
    resolveCliModel,
    resolveThinkBudget,
    buildChatTools,
    planClaudeSessionRoute,
    buildSessionBootstrapHash,
    getSessionBootstrapHash,
    sessionHasBootstrapHash,
    forceFreshRouteForBootstrap,
    setActiveClaudeSessionForConversation,
    recordClaudeAutoRelayStart,
    profileInjectionPlan,
    frontendDynamicContextPlan,
    crossSurfaceBridgePlan,
    buildRuntimeContextPayload,
    attachRuntimeContextToPrompt,
    buildInAppSessionBootstrap,
    buildInitialSystemPrompt,
    markProfileInjected,
    markFrontendDynamicContextInjected,
    markSessionBootstrapInjected,
    markCrossSurfaceBridgeInjected,
    restoreClaudeAutoRelayStart,
    isDeferredToolMarkerMiss,
    clearStaleClaudeSessionForConversation,
    openLedgerDb,
    upsertClaudeConversationRecord,
    CLAUDE_LEDGER_USER_ID,
    CLAUDE_LEDGER_PROJECT_ID,
    ledgerNow,
    recordClaudeAgentSession,
    appendClaudeConversationMessages,
    recordClaudeAutoRelayTurn,
    maybePrepareClaudeAutoRelaySummary,
    isClaudeSessionId,
    CLAUDE_SPAWN_TIMEOUT_MS,
    FRONTEND_PROFILE_MARKER,
    FRONTEND_PROFILE_UPDATE_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER,
    logAppendPromptDebug,
  });

  claudeStatusQuota.mountClaudeAgentStatusRoute(app);

  const terminalChat = createTerminalChat(app, {
    DB_PATH,
    writeJsonStateAtomic,
    resolveCliModel,
    resolveThinkBudget,
    sseHead,
    hasTerminalAuth,
    openLedgerDb,
    appendClaudeConversationMessages,
    recordClaudeHandoffSummary,
    getLLMConfig,
    promptWithImages,
    profileInjectionPlan,
    crossSurfaceBridgePlan,
    profileBlock,
    frontendDynamicContextBlock,
    resolveCharacterPrompt,
    buildMemoryContext,
    compactContextText,
    buildTerminalFrontendProfileHash,
    buildTerminalProfileCoreHash,
    frontendDynamicContextHash: profileBootstrap.frontendDynamicContextHash,
    buildTerminalProfileUpdateBootstrap,
    buildTerminalDynamicUpdateBootstrap,
    buildTalkConversationSummary,
    RELAY_MSG_COUNT,
    RELAY_TOTAL_MAX_CHARS,
    logTerminalBootstrapDebug,
    markProfileInjected,
    markFrontendDynamicContextInjected,
    markCrossSurfaceBridgeInjected,
  });
  terminalReadState = terminalChat.terminalReadState;
  terminalCompactText = terminalChat.terminalCompactText;
  fireRelayHandoffSummary = terminalChat.fireRelayHandoffSummary;

  mountTerminalHandoffRoute(app, {
    resolveClaudeSessionForConversation,
    compactContextText,
    buildTalkConversationSummary,
    profileBlock,
    resolveCharacterPrompt,
    buildMemoryContext,
    markProfileInjected,
    openLedgerDb,
    recordClaudeHandoffSummary,
  });

  claudeStatusQuota.mountQuotaRoute(app);

  mountClaudeAgentStreamRoutes(app, {
    openLedgerDb,
    recordClaudeAgentSession,
    appendClaudePreviewBlock,
    classifyClaudePreviewBlock,
    ledgerNow,
    promptWithImages,
    resolveCliModel,
    resolveThinkBudget,
    buildChatTools,
    planClaudeSessionRoute,
    buildSessionBootstrapHash,
    getSessionBootstrapHash,
    sessionHasBootstrapHash,
    forceFreshRouteForBootstrap,
    setActiveClaudeSessionForConversation,
    recordClaudeAutoRelayStart,
    profileInjectionPlan,
    frontendDynamicContextPlan,
    crossSurfaceBridgePlan,
    buildRuntimeContextPayload,
    attachRuntimeContextToPrompt,
    buildInAppSessionBootstrap,
    buildInitialSystemPrompt,
    markProfileInjected,
    markFrontendDynamicContextInjected,
    markSessionBootstrapInjected,
    markCrossSurfaceBridgeInjected,
    restoreClaudeAutoRelayStart,
    isDeferredToolMarkerMiss,
    clearStaleClaudeSessionForConversation,
    recordClaudeAutoRelayTurn,
    maybePrepareClaudeAutoRelaySummary,
    isClaudeSessionId,
    addPqUsage,
    PQ_WARN_USD,
    PQ_BUDGET_USD,
    CLAUDE_SPAWN_TIMEOUT_MS,
    FRONTEND_PROFILE_MARKER,
    FRONTEND_PROFILE_UPDATE_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_MARKER,
    FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER,
    logAppendPromptDebug,
  });

  mountClaudeConversationStateRoute(app, { loadClaudeConversationState });

  return {
    CLAUDE_SPAWN_TIMEOUT_MS,
    buildInitialSystemPrompt,
    isClaudeSessionId,
    syncClaudeTalkConversation,
    resolveCliModel,
  };
}

module.exports = { createClaudeRuntime };
