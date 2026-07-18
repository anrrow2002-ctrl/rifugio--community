'use strict';

const crypto = require('crypto');
const Database = require('better-sqlite3');

function createClaudeSessionRelay(deps = {}) {
  const {
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
    fireRelayHandoffSummary,
    ledgerCompactText,
    RELAY_MSG_COUNT,
    RELAY_TOTAL_MAX_CHARS,
    AUTO_SESSION_RELAY_TRIGGER_RATIO,
  } = deps;

  function readClaudeRelayState(db, conversationId) {
    const cid = String(conversationId || '').trim();
    if (!cid || !db) return null;
    try {
      return db.prepare('SELECT * FROM claude_session_relay_state WHERE conversation_id=?').get(cid) || null;
    } catch (_) {
      return null;
    }
  }
  function upsertClaudeRelayState(db, conversationId, patch = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid || !db) return null;
    const current = readClaudeRelayState(db, cid) || {};
    const now = ledgerNow();
    const row = {
      conversation_id: cid,
      active_claude_session_id: patch.activeClaudeSessionId != null ? String(patch.activeClaudeSessionId || '') : String(current.active_claude_session_id || ''),
      turns_in_active_session: patch.turnsInActiveSession != null ? Number(patch.turnsInActiveSession) || 0 : Number(current.turns_in_active_session || 0) || 0,
      total_turns: patch.totalTurns != null ? Number(patch.totalTurns) || 0 : Number(current.total_turns || 0) || 0,
      last_relay_at: patch.lastRelayAt != null ? String(patch.lastRelayAt || '') : String(current.last_relay_at || ''),
      last_relay_reason: patch.lastRelayReason != null ? String(patch.lastRelayReason || '') : String(current.last_relay_reason || ''),
      updated_at: now,
    };
    db.prepare(`
      INSERT INTO claude_session_relay_state (
        conversation_id, active_claude_session_id, turns_in_active_session,
        total_turns, last_relay_at, last_relay_reason, updated_at
      ) VALUES (
        @conversation_id, @active_claude_session_id, @turns_in_active_session,
        @total_turns, @last_relay_at, @last_relay_reason, @updated_at
      )
      ON CONFLICT(conversation_id) DO UPDATE SET
        active_claude_session_id=excluded.active_claude_session_id,
        turns_in_active_session=excluded.turns_in_active_session,
        total_turns=excluded.total_turns,
        last_relay_at=excluded.last_relay_at,
        last_relay_reason=excluded.last_relay_reason,
        updated_at=excluded.updated_at
    `).run(row);
    return row;
  }
  function buildAutoSessionRelaySummary(conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid) return '';
    const reason = String(opts.reason || 'auto_threshold').trim();
    const previousSessionId = String(opts.previousSessionId || '').trim();
    const threshold = autoRelayThreshold(opts.threshold);
    const triggerTurns = autoRelayTriggerTurns(threshold);
    const recent = buildTalkConversationSummary(cid, {
      count: RELAY_MSG_COUNT,
      totalMax: RELAY_TOTAL_MAX_CHARS,
      currentPrompt: opts.currentPrompt || '',
    });
    return [
      '【自动 Claude session 接力｜后台生成】',
      `conversation_id: ${cid}`,
      previousSessionId ? `previous_claude_session_id: ${previousSessionId}` : '',
      `relay_reason: ${reason}`,
      `relay_threshold_turns: ${threshold}`,
      `relay_trigger_turns: ${triggerTurns}`,
      '请把下面内容当作同一个前端对话的连续上下文。不要复述摘要，不要说“我收到交接”；直接自然回复用户本轮消息。',
      recent ? `\n【最近对话摘要】\n${recent}` : '',
    ].filter(Boolean).join('\n');
  }
  function planClaudeSessionRoute(conversationId, fallbackSessionId, opts = {}) {
    const cid = String(conversationId || '').trim() || 'default';
    const threshold = autoRelayThreshold(opts.autoSessionRelayTurns);
    const triggerTurns = autoRelayTriggerTurns(threshold);
    const enabled = autoRelayEnabled(opts.autoSessionRelay);
    const activeSid = resolveClaudeSessionForConversation(cid, fallbackSessionId);
    const forceNew = opts.forceNewSession === true || opts.forceNewSession === 'true' || opts.forceNewSession === 1 || opts.forceNewSession === '1';
    let relayState = null;
    let legacyTurns = 0;
    let contextChars = 0;
    try {
      const db = openLedgerDb(true);
      try {
        relayState = readClaudeRelayState(db, cid);
        const legacy = db.prepare('SELECT messages FROM chat_convos WHERE id=?').get(cid);
        const latestHandoff = db.prepare('SELECT summary, created_at FROM claude_handoff_summaries WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(cid) || null;
        try {
          const msgs = JSON.parse(legacy?.messages || '[]');
          legacyTurns = Array.isArray(msgs) ? msgs.filter(m => m && m.role === 'user').length : 0;
          contextChars = talkMessagesContextState(msgs, latestHandoff, currentPromptExtraChars(msgs, opts.currentPrompt)).estimated_context_chars;
        } catch (_) {}
      } finally { db.close(); }
    } catch (_) {}
    if (!contextChars) contextChars = estimateConversationContextChars(cid, { currentPrompt: opts.currentPrompt || '' });
    const stateSid = String(relayState?.active_claude_session_id || '').trim();
    const turns = stateSid && stateSid === activeSid
      ? Number(relayState?.turns_in_active_session || legacyTurns || 0) || 0
      : legacyTurns;
    const contextState = contextProgressState(contextChars);
    const contextMinTurns = autoRelayContextMinTurns(threshold);
    const autoByTurns = turns >= triggerTurns;
    const autoByContext = turns >= contextMinTurns && contextState.will_auto_relay_by_context;
    const canAutoRelay = enabled && isClaudeSessionId(activeSid);
    const autoNew = enabled && isClaudeSessionId(activeSid) && (autoByTurns || autoByContext);
    const shouldStartNew = forceNew || autoNew || !isClaudeSessionId(activeSid);
    const previousSid = isClaudeSessionId(activeSid) ? activeSid : '';
    const nextSid = shouldStartNew ? crypto.randomUUID() : activeSid;
    const reason = forceNew
      ? 'manual_force_new_session'
      : (canAutoRelay && autoByContext
        ? `context_chars>=${contextState.context_trigger_chars}(${Math.round(AUTO_SESSION_RELAY_TRIGGER_RATIO * 100)}% of ${contextState.context_window_chars}) and turns_in_active_session>=${contextMinTurns}`
        : (canAutoRelay && autoByTurns ? `turns_in_active_session>=${triggerTurns}(${Math.round(AUTO_SESSION_RELAY_TRIGGER_RATIO * 100)}% of ${threshold})` : ''));
    const relaySummary = shouldStartNew && previousSid
      ? buildAutoSessionRelaySummary(cid, {
          previousSessionId: previousSid,
          reason,
          threshold,
          currentPrompt: opts.currentPrompt || '',
        })
      : '';
    return {
      conversationId: cid,
      sid: nextSid,
      previousSid,
      shouldResume: !shouldStartNew && isClaudeSessionId(nextSid),
      shouldStartNew,
      relayReason: reason,
      relaySummary,
      threshold,
      triggerTurns,
      contextMinTurns,
      turnsInActiveSession: turns,
      totalTurns: Number(relayState?.total_turns || legacyTurns || 0) || 0,
      contextChars,
      contextWindowChars: contextState.context_window_chars,
      contextTriggerChars: contextState.context_trigger_chars,
      contextProgressPct: contextState.context_progress_pct,
      contextTriggerProgressPct: contextState.context_trigger_progress_pct,
      previousRelayAt: String(relayState?.last_relay_at || ''),
      previousRelayReason: String(relayState?.last_relay_reason || ''),
      currentPrompt: String(opts.currentPrompt || ''),
    };
  }
  function recordClaudeAutoRelayStart(plan) {
    if (!plan?.conversationId || !plan?.shouldStartNew) return;
    const db = openLedgerDb(false);
    try {
      upsertClaudeConversationRecord(db, plan.conversationId, {
        activeSessionId: plan.sid,
        userId: CLAUDE_LEDGER_USER_ID,
        projectId: CLAUDE_LEDGER_PROJECT_ID,
      });
      upsertClaudeRelayState(db, plan.conversationId, {
        activeClaudeSessionId: plan.sid,
        turnsInActiveSession: 0,
        lastRelayAt: plan.previousSid ? ledgerNow() : '',
        lastRelayReason: plan.relayReason || '',
      });
      if (plan.previousSid) {
        // 异步生成 DeepSeek 摘要写 handoff，不阻塞 Talk relay 主流程
        const _talkMsgs = (() => {
          try {
            const _d = new Database(DB_PATH, { readonly: true });
            try {
              const _r = _d.prepare('SELECT messages FROM chat_convos WHERE id=?').get(plan.conversationId);
              const _all = JSON.parse(_r?.messages || '[]');
              return Array.isArray(_all) ? _all.filter(m => m?.role === 'user' || m?.role === 'assistant') : [];
            } finally { _d.close(); }
          } catch (_) { return []; }
        })();
        const _last100Talk = _talkMsgs.slice(-RELAY_MSG_COUNT).map(m => ({ role: m.role, content: textFromTalkMessage ? textFromTalkMessage(m) : String(m.content || '') }));
        const _allTalk = _talkMsgs.map(m => ({ role: m.role, content: textFromTalkMessage ? textFromTalkMessage(m) : String(m.content || '') }));
        const _last100SnapTalk = buildTalkConversationSummary(plan.conversationId, { count: RELAY_MSG_COUNT, totalMax: RELAY_TOTAL_MAX_CHARS });
        (() => {
          let _db2;
          try { _db2 = openLedgerDb(false); } catch (_) { return; }
          fireRelayHandoffSummary(_db2, {
            conversationId: plan.conversationId,
            surface: 'talk',
            fromSessionId: plan.previousSid,
            toSessionId: plan.sid,
            allTurns: _allTalk,
            last5Turns: _last100Talk,
            last5Snapshot: _last100SnapTalk,
          }).finally(() => { try { _db2.close(); } catch (_) {} });
        })();
      }
    } finally {
      db.close();
    }
  }
  function restoreClaudeAutoRelayStart(plan) {
    if (!plan?.conversationId || !plan?.shouldStartNew || !plan?.previousSid) return;
    const db = openLedgerDb(false);
    try {
      upsertClaudeConversationRecord(db, plan.conversationId, {
        activeSessionId: plan.previousSid,
        userId: CLAUDE_LEDGER_USER_ID,
        projectId: CLAUDE_LEDGER_PROJECT_ID,
      });
      upsertClaudeRelayState(db, plan.conversationId, {
        activeClaudeSessionId: plan.previousSid,
        turnsInActiveSession: plan.turnsInActiveSession,
        totalTurns: plan.totalTurns,
        lastRelayAt: plan.previousRelayAt || '',
        lastRelayReason: plan.previousRelayReason || '',
      });
      try {
        db.prepare('UPDATE chat_convos SET session_id=?, updated_at=datetime(\'now\') WHERE id=?').run(plan.previousSid, plan.conversationId);
      } catch (_) {}
    } finally {
      db.close();
    }
  }
  function recordClaudeAutoRelayTurn(conversationId, sessionId, opts = {}) {
    const cid = String(conversationId || '').trim();
    const sid = String(sessionId || '').trim();
    if (!cid || !isClaudeSessionId(sid)) return;
    const db = openLedgerDb(false);
    try {
      const current = readClaudeRelayState(db, cid) || {};
      const sameSession = String(current.active_claude_session_id || '') === sid;
      const turns = (sameSession ? Number(current.turns_in_active_session || 0) || 0 : 0) + (opts.success === false ? 0 : 1);
      const total = (Number(current.total_turns || 0) || 0) + (opts.success === false ? 0 : 1);
      upsertClaudeConversationRecord(db, cid, {
        activeSessionId: sid,
        userId: CLAUDE_LEDGER_USER_ID,
        projectId: CLAUDE_LEDGER_PROJECT_ID,
      });
      try {
        db.prepare('UPDATE chat_convos SET session_id=?, updated_at=datetime(\'now\') WHERE id=?').run(sid, cid);
      } catch (_) {}
      upsertClaudeRelayState(db, cid, {
        activeClaudeSessionId: sid,
        turnsInActiveSession: turns,
        totalTurns: total,
        lastRelayAt: current.last_relay_at || '',
        lastRelayReason: current.last_relay_reason || '',
      });
    } finally {
      db.close();
    }
  }
  function maybePrepareClaudeAutoRelaySummary(conversationId, sessionId, opts = {}) {
    const cid = String(conversationId || '').trim();
    const sid = String(sessionId || '').trim();
    if (!cid || !isClaudeSessionId(sid)) return null;
    const threshold = autoRelayThreshold(opts.autoSessionRelayTurns);
    const triggerTurns = autoRelayTriggerTurns(threshold);
    const prepareAt = Math.max(1, triggerTurns - 2);
    const db = openLedgerDb(false);
    try {
      const state = readClaudeRelayState(db, cid) || {};
      const turns = Number(state.turns_in_active_session || 0) || 0;
      if (turns < prepareAt) return null;
      const id = `preheat:${cid}:${sid}`;
      const summary = buildAutoSessionRelaySummary(cid, {
        previousSessionId: sid,
        reason: `preheat_ready:${turns}/${triggerTurns}`,
        threshold,
        currentPrompt: '',
      });
      const snapshot = buildTalkConversationSummary(cid, { count: 12, totalMax: 16000 });
      db.prepare(`
        INSERT INTO claude_handoff_summaries (
          id, conversation_id, surface, from_claude_session_id, to_claude_session_id,
          summary, last_5_turns_snapshot, created_at
        ) VALUES (?, ?, 'talk', ?, '', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          summary=excluded.summary,
          last_5_turns_snapshot=excluded.last_5_turns_snapshot,
          created_at=excluded.created_at
      `).run(id, cid, sid, ledgerCompactText(summary, 20000), snapshot, ledgerNow());
      return { id, conversation_id: cid, from_session: sid, turns, trigger_turns: triggerTurns, summary_chars: summary.length };
    } finally {
      db.close();
    }
  }

  return {
    readClaudeRelayState,
    upsertClaudeRelayState,
    buildAutoSessionRelaySummary,
    planClaudeSessionRoute,
    recordClaudeAutoRelayStart,
    restoreClaudeAutoRelayStart,
    recordClaudeAutoRelayTurn,
    maybePrepareClaudeAutoRelaySummary,
  };
}

module.exports = { createClaudeSessionRelay };
