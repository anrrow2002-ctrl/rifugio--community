'use strict';

const crypto = require('crypto');
const Database = require('./sqlite');

function createClaudeLedger(deps = {}) {
  const { DB_PATH } = deps;
  const textFromTalkMessage = (...args) => deps.textFromTalkMessage(...args);
  const sanitizeTalkMessages = value => deps.sanitizeTalkMessages(value);
  const autoRelayThreshold = (...args) => deps.autoRelayThreshold(...args);
  const autoRelayTriggerTurns = (...args) => deps.autoRelayTriggerTurns(...args);
  const autoRelayContextMinTurns = (...args) => deps.autoRelayContextMinTurns(...args);
  const talkMessagesContextState = (...args) => deps.talkMessagesContextState(...args);
  const autoRelayEnabled = (...args) => deps.autoRelayEnabled(...args);
  const getProfileRecord = (...args) => deps.getProfileRecord(...args);
  const autoSessionRelayTriggerRatio = () => Number(deps.getAutoSessionRelayTriggerRatio?.() || 0.85) || 0.85;

  // ============================================================
  // CLAUDE LEDGER — conversation_id 驱动的安全层
  // Claude 原始 JSONL 只读；真正的会话映射、预览块、交接摘要都落在自己的表里。
  // ============================================================
  const CLAUDE_LEDGER_USER_ID = process.env.CLAUDE_LEDGER_USER_ID || 'owner';
  const CLAUDE_LEDGER_PROJECT_ID = process.env.CLAUDE_LEDGER_PROJECT_ID || 'rifugio';
  const CLAUDE_SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

  function ledgerNow() {
    return new Date().toISOString();
  }
  function openLedgerDb(readonly = false) {
    return readonly ? new Database(DB_PATH, { readonly: true }) : new Database(DB_PATH);
  }
  function ledgerCompactText(value, max = 16000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function ledgerMessageText(message) {
    try {
      if (typeof textFromTalkMessage === 'function') {
        const t = textFromTalkMessage(message);
        if (t) return ledgerCompactText(t, 8000);
      }
    } catch (_) {}
    if (!message || typeof message !== 'object') return '';
    return ledgerCompactText(message.content || '', 8000);
  }
  function isTerminalModeTalkMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const engine = String(message.engine || message.source || message.surface || '').toLowerCase();
    if (engine === 'terminal') return true;
    const model = String(message.model || '').toLowerCase();
    return message.role === 'assistant' && model.includes('terminal claude code');
  }
  function talkSourceMessages(messages) {
    const list = sanitizeTalkMessages(Array.isArray(messages) ? messages : []);
    return list.filter((m, i) => {
      if (!m || typeof m !== 'object') return false;
      if (m.role !== 'user' && m.role !== 'assistant') return false;
      if (isTerminalModeTalkMessage(m)) return false;
      if (m.role === 'user') {
        const next = list[i + 1];
        if (next?.role === 'assistant' && isTerminalModeTalkMessage(next)) return false;
      }
      return true;
    });
  }
  function ensureClaudeLedgerSchema() {
    const db = openLedgerDb(false);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS claude_conversations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          active_claude_session_id TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS claude_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          surface TEXT NOT NULL DEFAULT 'talk',
          turn_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'final',
          claude_session_id TEXT DEFAULT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_claude_messages_conversation_surface
          ON claude_messages(conversation_id, surface, created_at);
        CREATE INDEX IF NOT EXISTS idx_claude_messages_session
          ON claude_messages(claude_session_id, created_at);
        CREATE TABLE IF NOT EXISTS claude_preview_blocks (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          surface TEXT NOT NULL DEFAULT 'agent',
          turn_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          claude_session_id TEXT DEFAULT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_claude_preview_blocks_conversation_surface
          ON claude_preview_blocks(conversation_id, surface, created_at);
        CREATE TABLE IF NOT EXISTS claude_agent_sessions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          claude_session_id TEXT NOT NULL UNIQUE,
          route TEXT NOT NULL,
          status TEXT NOT NULL,
          transcript_path TEXT NOT NULL DEFAULT '',
          last_offset INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_claude_agent_sessions_conversation
          ON claude_agent_sessions(conversation_id, updated_at);
        CREATE TABLE IF NOT EXISTS claude_handoff_summaries (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          surface TEXT NOT NULL DEFAULT 'talk',
          from_claude_session_id TEXT NOT NULL DEFAULT '',
          to_claude_session_id TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          last_5_turns_snapshot TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_claude_handoff_summaries_conversation
          ON claude_handoff_summaries(conversation_id, created_at);
        CREATE TABLE IF NOT EXISTS claude_session_relay_state (
          conversation_id TEXT PRIMARY KEY,
          active_claude_session_id TEXT NOT NULL DEFAULT '',
          turns_in_active_session INTEGER NOT NULL DEFAULT 0,
          total_turns INTEGER NOT NULL DEFAULT 0,
          last_relay_at TEXT NOT NULL DEFAULT '',
          last_relay_reason TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }
  }
  ensureClaudeLedgerSchema();

  function upsertClaudeConversationRecord(db, conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid || !db) return null;
    const now = ledgerNow();
    const userId = String(opts.userId || CLAUDE_LEDGER_USER_ID || 'owner').trim() || 'owner';
    const projectId = String(opts.projectId || CLAUDE_LEDGER_PROJECT_ID || 'rifugio').trim() || 'rifugio';
    const rawActiveSessionId = opts.activeSessionId == null ? '' : String(opts.activeSessionId).trim();
    const activeSessionId = CLAUDE_SESSION_ID_RE.test(rawActiveSessionId) ? rawActiveSessionId : null;
    try {
      const existing = db.prepare('SELECT active_claude_session_id FROM claude_conversations WHERE id=?').get(cid);
      if (existing?.active_claude_session_id && !CLAUDE_SESSION_ID_RE.test(String(existing.active_claude_session_id || '').trim())) {
        db.prepare('UPDATE claude_conversations SET active_claude_session_id=NULL WHERE id=?').run(cid);
      }
    } catch (_) {}
    db.prepare(`
      INSERT INTO claude_conversations (id, user_id, project_id, active_claude_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id,
        project_id=excluded.project_id,
        active_claude_session_id=COALESCE(NULLIF(excluded.active_claude_session_id, ''), claude_conversations.active_claude_session_id),
        updated_at=excluded.updated_at
    `).run(cid, userId, projectId, activeSessionId, now, now);
    return { id: cid, user_id: userId, project_id: projectId, active_claude_session_id: activeSessionId, updated_at: now };
  }
  function isClaudeSessionId(value) {
    return CLAUDE_SESSION_ID_RE.test(String(value || '').trim());
  }
  function resolveClaudeSessionForConversation(conversationId, fallbackSessionId = '') {
    const cid = String(conversationId || '').trim();
    const fallback = String(fallbackSessionId || '').trim();
    if (!cid) return isClaudeSessionId(fallback) ? fallback : '';
    const db = openLedgerDb(true);
    try {
      const conversation = db.prepare('SELECT active_claude_session_id FROM claude_conversations WHERE id=?').get(cid);
      if (isClaudeSessionId(conversation?.active_claude_session_id)) return conversation.active_claude_session_id;

      const latest = db.prepare(`
        SELECT claude_session_id
        FROM claude_agent_sessions
        WHERE conversation_id=?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(cid);
      if (isClaudeSessionId(latest?.claude_session_id)) return latest.claude_session_id;

      const legacy = db.prepare('SELECT session_id FROM chat_convos WHERE id=?').get(cid);
      if (isClaudeSessionId(legacy?.session_id)) return legacy.session_id;
    } catch (_) {
      // chat_convos may not exist yet during first boot; fall through to the compatible fallback.
    } finally {
      db.close();
    }
    return isClaudeSessionId(fallback) ? fallback : '';
  }
  function isDeferredToolMarkerMiss(text) {
    return /No deferred tool marker found in the resumed session/i.test(String(text || ''));
  }
  function clearStaleClaudeSessionForConversation(conversationId, sessionId, reason = 'resume_deferred_miss') {
    const cid = String(conversationId || '').trim();
    const sid = String(sessionId || '').trim();
    if (!cid || !isClaudeSessionId(sid)) return false;
    const db = openLedgerDb(false);
    try {
      db.prepare(`
        UPDATE claude_conversations
        SET active_claude_session_id=NULL, updated_at=?
        WHERE id=? AND active_claude_session_id=?
      `).run(ledgerNow(), cid, sid);
      try {
        db.prepare(`
          UPDATE chat_convos
          SET session_id=NULL, updated_at=datetime('now')
          WHERE id=? AND session_id=?
        `).run(cid, sid);
      } catch (_) {}
      try {
        db.prepare(`DELETE FROM claude_agent_sessions WHERE conversation_id=? AND claude_session_id=?`).run(cid, sid);
      } catch (_) {}
      console.warn('[resume-deferred-miss]', JSON.stringify({ conversationId: cid, sessionId: sid, reason }));
      return true;
    } finally {
      db.close();
    }
  }
  function setActiveClaudeSessionForConversation(conversationId, sessionId) {
    const cid = String(conversationId || '').trim();
    const sid = String(sessionId || '').trim();
    if (!cid || !isClaudeSessionId(sid)) return null;
    const db = openLedgerDb(false);
    try {
      const rec = upsertClaudeConversationRecord(db, cid, {
        activeSessionId: sid,
        userId: CLAUDE_LEDGER_USER_ID,
        projectId: CLAUDE_LEDGER_PROJECT_ID,
      });
      try {
        db.prepare('UPDATE chat_convos SET session_id=?, updated_at=datetime(\'now\') WHERE id=?').run(sid, cid);
      } catch (_) {}
      return rec;
    } finally {
      db.close();
    }
  }
  function syncClaudeTalkConversation(convo) {
    const cid = String(convo?.id || '').trim();
    if (!cid) return null;
    const db = openLedgerDb(false);
    try {
      upsertClaudeConversationRecord(db, cid, {
        activeSessionId: convo?.session_id || null,
        userId: CLAUDE_LEDGER_USER_ID,
        projectId: CLAUDE_LEDGER_PROJECT_ID,
      });
      db.prepare(`DELETE FROM claude_messages WHERE conversation_id=? AND surface='talk'`).run(cid);
      const messages = talkSourceMessages(Array.isArray(convo?.messages) ? convo.messages : []);
      const insert = db.prepare(`
        INSERT INTO claude_messages (id, conversation_id, surface, turn_id, role, content, status, claude_session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          surface=excluded.surface,
          turn_id=excluded.turn_id,
          role=excluded.role,
          content=excluded.content,
          status=excluded.status,
          claude_session_id=excluded.claude_session_id,
          created_at=excluded.created_at
      `);
      let turnIndex = 0;
      let currentTurnId = '';
      for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        if (role === 'user' || !currentTurnId) currentTurnId = `turn-${String(++turnIndex).padStart(4, '0')}`;
        const content = ledgerMessageText(m);
        if (!content) continue;
        const status = role === 'assistant' && (m.failed || m.streamError) ? 'failed' : 'final';
        const rowId = `talk:${cid}:${String(m.id || `${turnIndex}-${role}`).slice(0, 80)}`;
        insert.run(rowId, cid, 'talk', currentTurnId, role, content, status, convo?.session_id || null, ledgerNow());
      }
      return { conversation_id: cid, rows: messages.length };
    } finally {
      db.close();
    }
  }
  function loadClaudeLedgerMessages(conversationId, surface = 'talk', limit = 120) {
    const cid = String(conversationId || '').trim();
    if (!cid) return [];
    const db = openLedgerDb(true);
    try {
      return db.prepare(`
        SELECT role, content, turn_id, created_at
        FROM claude_messages
        WHERE conversation_id=? AND surface=?
        ORDER BY rowid ASC
      `).all(cid, surface).slice(-Math.max(8, Math.min(240, Number(limit || 120) || 120)));
    } catch (_) {
      return [];
    } finally {
      db.close();
    }
  }
  function appendClaudeConversationMessages(db, opts = {}) {
    const cid = String(opts.conversationId || '').trim();
    if (!cid || !db) return null;
    const surface = String(opts.surface || 'terminal').trim() || 'terminal';
    const turnId = String(opts.turnId || crypto.randomUUID()).trim();
    const claudeSessionId = opts.claudeSessionId == null ? null : String(opts.claudeSessionId).trim() || null;
    const userText = ledgerCompactText(opts.userText || '', 4000);
    const assistantText = ledgerCompactText(opts.assistantText || '', 8000);
    const now = ledgerNow();
    const activeSessionId = isClaudeSessionId(claudeSessionId) ? claudeSessionId : (isClaudeSessionId(opts.activeSessionId) ? opts.activeSessionId : null);
    upsertClaudeConversationRecord(db, cid, {
      activeSessionId,
      userId: opts.userId || CLAUDE_LEDGER_USER_ID,
      projectId: opts.projectId || CLAUDE_LEDGER_PROJECT_ID,
    });
    const insert = db.prepare(`
      INSERT INTO claude_messages (id, conversation_id, surface, turn_id, role, content, status, claude_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        surface=excluded.surface,
        turn_id=excluded.turn_id,
        role=excluded.role,
        content=excluded.content,
        status=excluded.status,
        claude_session_id=excluded.claude_session_id,
        created_at=excluded.created_at
    `);
    if (userText) insert.run(`${surface}:${cid}:${turnId}:user`, cid, surface, turnId, 'user', userText, 'final', claudeSessionId, now);
    if (assistantText) insert.run(`${surface}:${cid}:${turnId}:assistant`, cid, surface, turnId, 'assistant', assistantText, 'final', claudeSessionId, now);
    return { conversation_id: cid, turn_id: turnId };
  }
  function appendClaudePreviewBlock(db, opts = {}) {
    const cid = String(opts.conversationId || '').trim();
    if (!cid || !db) return null;
    const surface = String(opts.surface || 'agent').trim() || 'agent';
    const type = String(opts.type || 'status').trim() || 'status';
    const content = ledgerCompactText(opts.content || type, 12000);
    const turnId = String(opts.turnId || opts.turn_id || opts.claudeSessionId || crypto.randomUUID()).trim();
    const claudeSessionId = opts.claudeSessionId == null ? null : String(opts.claudeSessionId).trim() || null;
    const id = `${surface}:${cid}:${turnId}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
    db.prepare(`
      INSERT INTO claude_preview_blocks (id, conversation_id, surface, turn_id, type, content, claude_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cid, surface, turnId, type, content, claudeSessionId, ledgerNow());
    return id;
  }
  function recordClaudeAgentSession(db, opts = {}) {
    const sid = String(opts.claudeSessionId || opts.sessionId || '').trim();
    const cid = String(opts.conversationId || '').trim();
    if (!sid || !cid || !db) return null;
    const now = ledgerNow();
    const route = String(opts.route || 'print').trim() || 'print';
    const status = String(opts.status || 'active').trim() || 'active';
    const transcriptPath = String(opts.transcriptPath || '').trim();
    const lastOffset = Number(opts.lastOffset || 0) || 0;
    const closedAt = opts.closedAt == null ? null : String(opts.closedAt).trim() || null;
    db.prepare(`
      INSERT INTO claude_agent_sessions (id, conversation_id, claude_session_id, route, status, transcript_path, last_offset, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(claude_session_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        route=excluded.route,
        status=excluded.status,
        transcript_path=excluded.transcript_path,
        last_offset=excluded.last_offset,
        updated_at=excluded.updated_at,
        closed_at=COALESCE(excluded.closed_at, claude_agent_sessions.closed_at)
    `).run(sid, cid, sid, route, status, transcriptPath, lastOffset, now, now, closedAt);
    upsertClaudeConversationRecord(db, cid, {
      activeSessionId: sid,
      userId: opts.userId || CLAUDE_LEDGER_USER_ID,
      projectId: opts.projectId || CLAUDE_LEDGER_PROJECT_ID,
    });
    return { conversation_id: cid, claude_session_id: sid, route, status };
  }
  function recordClaudeHandoffSummary(db, opts = {}) {
    const cid = String(opts.conversationId || '').trim();
    if (!cid || !db) return null;
    const id = String(opts.id || `handoff:${cid}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`).trim();
    const surface = String(opts.surface || 'talk').trim() || 'talk';
    const now = ledgerNow();
    db.prepare(`
      INSERT INTO claude_handoff_summaries (
        id, conversation_id, surface, from_claude_session_id, to_claude_session_id,
        summary, last_5_turns_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cid,
      surface,
      String(opts.fromSessionId || opts.from_claude_session_id || '').trim(),
      String(opts.toSessionId || opts.to_claude_session_id || '').trim(),
      ledgerCompactText(opts.summary || '', 20000),
      String(opts.last5TurnsSnapshot || opts.last_5_turns_snapshot || ''),
      now
    );
    return { id, conversation_id: cid };
  }
  function classifyClaudePreviewBlock(line) {
    const raw = String(line || '').trim();
    if (!raw) return null;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (_) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'session_route') {
      return { type: 'status', content: `session_route:${obj.new_session ? 'new' : 'resume'}:${obj.session_id || ''}` };
    }
    if (obj.type === 'quota_warning') {
      return { type: 'status', content: `quota_warning:${obj.used_usd ?? ''}/${obj.budget_usd ?? ''}` };
    }
    if (obj.type === 'resume_miss') {
      return { type: 'status', content: 'resume_miss' };
    }
    if (obj.type === 'terminal_route' || obj.type === 'terminal_status') {
      return { type: 'status', content: ledgerCompactText(raw, 6000) };
    }
    if (obj.type === 'terminal_preview') {
      return { type: 'assistant_delta', content: ledgerCompactText(obj.text || '', 12000) };
    }
    if (obj.type === 'terminal_final') {
      return { type: 'done', content: ledgerCompactText(obj.text || '', 12000) };
    }
    if (obj.type === 'error') {
      const errText = obj.error?.message || obj.message || raw;
      return { type: 'error', content: ledgerCompactText(errText, 6000) };
    }
    if (obj.type === 'result') {
      return { type: 'done', content: ledgerCompactText(obj.result || raw, 12000) };
    }
    if (obj.type === 'assistant' && obj.message?.content) {
      const t = typeof transcriptContentToText === 'function'
        ? transcriptContentToText(obj.message.content, { allowString: true })
        : '';
      return t ? { type: 'assistant_delta', content: ledgerCompactText(t, 12000) } : null;
    }
    const ev = obj.event || obj;
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      return { type: 'tool_running', content: ledgerCompactText(ev.content_block.name || 'tool_use', 1200) };
    }
    if (ev?.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) return { type: 'assistant_delta', content: ledgerCompactText(d.text, 6000) };
      if (d.type === 'input_json_delta' && d.partial_json) return { type: 'tool_result', content: ledgerCompactText(d.partial_json, 6000) };
      if ((d.type === 'thinking_delta' && d.thinking) || d.type === 'signature_delta') {
        return { type: 'status', content: 'thinking' };
      }
    }
    return null;
  }
  function loadClaudeConversationState(conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid) return null;
    const db = openLedgerDb(true);
    try {
      const conversation = db.prepare('SELECT * FROM claude_conversations WHERE id=?').get(cid) || null;
      if (conversation && !isClaudeSessionId(conversation.active_claude_session_id)) conversation.active_claude_session_id = '';
      const legacyConversation = db.prepare('SELECT name, session_id, messages FROM chat_convos WHERE id=?').get(cid) || null;
      const latestSession = db.prepare('SELECT * FROM claude_agent_sessions WHERE conversation_id=? ORDER BY updated_at DESC LIMIT 1').get(cid) || null;
      const latestHandoff = db.prepare('SELECT * FROM claude_handoff_summaries WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(cid) || null;
      const relayRaw = db.prepare('SELECT * FROM claude_session_relay_state WHERE conversation_id=?').get(cid) || null;
      const threshold = autoRelayThreshold(opts.autoSessionRelayTurns);
      const triggerTurns = autoRelayTriggerTurns(threshold);
      const contextMinTurns = autoRelayContextMinTurns(threshold);
      const legacyTurns = (() => {
        try {
          const msgs = JSON.parse(legacyConversation?.messages || '[]');
          return Array.isArray(msgs) ? msgs.filter(m => m && m.role === 'user').length : 0;
        } catch (_) { return 0; }
      })();
      let legacyMessages = [];
      try { legacyMessages = JSON.parse(legacyConversation?.messages || '[]'); } catch (_) { legacyMessages = []; }
      const contextState = talkMessagesContextState(legacyMessages, latestHandoff);
      const turns = Number(relayRaw?.turns_in_active_session || legacyTurns || 0) || 0;
      const relayState = relayRaw ? {
        ...relayRaw,
        threshold_turns: threshold,
        trigger_turns: triggerTurns,
        context_min_turns: contextMinTurns,
        trigger_ratio: autoSessionRelayTriggerRatio(),
        progress_pct: Math.min(100, Math.round((turns / threshold) * 100)),
        trigger_progress_pct: Math.min(100, Math.round((turns / triggerTurns) * 100)),
        context_window_chars: contextState.context_window_chars,
        context_trigger_chars: contextState.context_trigger_chars,
        estimated_context_chars: contextState.estimated_context_chars,
        context_progress_pct: contextState.context_progress_pct,
        context_trigger_progress_pct: contextState.context_trigger_progress_pct,
        will_auto_relay_by_context: contextState.will_auto_relay_by_context,
        will_auto_relay_next_turn: autoRelayEnabled(opts.autoSessionRelay) && (turns >= triggerTurns || (turns >= contextMinTurns && contextState.will_auto_relay_by_context)),
      } : {
        conversation_id: cid,
        active_claude_session_id: [conversation?.active_claude_session_id, latestSession?.claude_session_id, legacyConversation?.session_id].find(isClaudeSessionId) || '',
        turns_in_active_session: turns,
        total_turns: turns,
        last_relay_at: '',
        last_relay_reason: '',
        threshold_turns: threshold,
        trigger_turns: triggerTurns,
        context_min_turns: contextMinTurns,
        trigger_ratio: autoSessionRelayTriggerRatio(),
        progress_pct: Math.min(100, Math.round((turns / threshold) * 100)),
        trigger_progress_pct: Math.min(100, Math.round((turns / triggerTurns) * 100)),
        context_window_chars: contextState.context_window_chars,
        context_trigger_chars: contextState.context_trigger_chars,
        estimated_context_chars: contextState.estimated_context_chars,
        context_progress_pct: contextState.context_progress_pct,
        context_trigger_progress_pct: contextState.context_trigger_progress_pct,
        will_auto_relay_by_context: contextState.will_auto_relay_by_context,
        will_auto_relay_next_turn: autoRelayEnabled(opts.autoSessionRelay) && (turns >= triggerTurns || (turns >= contextMinTurns && contextState.will_auto_relay_by_context)),
        };
        try {
          const activeSidForProfile = String(relayState.active_claude_session_id || '').trim();
          const { session } = getProfileRecord({ conversation_id: cid, session_id: activeSidForProfile });
          if (session?.bootstrap_hash) {
            relayState.profile_injection = {
              mode: 'session_bootstrap_recorded',
              inject: false,
              reason: 'current_session_has_recorded_bootstrap',
              bootstrap_hash: session.bootstrap_hash,
              bootstrap_known: true,
              bootstrap_refreshed: false,
              append_system_prompt_chars: 0,
              bootstrap_context_chars: 0,
            };
          }
        } catch (_) {}
        const messageCounts = db.prepare('SELECT surface, COUNT(*) AS count FROM claude_messages WHERE conversation_id=? GROUP BY surface').all(cid);
      const previewCounts = db.prepare('SELECT surface, COUNT(*) AS count FROM claude_preview_blocks WHERE conversation_id=? GROUP BY surface').all(cid);
      return { conversation, latestSession, latestHandoff, relayState, contextState, messageCounts, previewCounts };
    } catch (_) {
      return null;
    } finally {
      db.close();
    }
  }

  return {
    CLAUDE_LEDGER_USER_ID,
    CLAUDE_LEDGER_PROJECT_ID,
    ledgerNow,
    openLedgerDb,
    ledgerCompactText,
    ledgerMessageText,
    isTerminalModeTalkMessage,
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
  };
}

module.exports = { createClaudeLedger };
