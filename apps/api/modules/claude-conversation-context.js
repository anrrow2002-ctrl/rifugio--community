'use strict';

const { USER_NAME, COMPANION_NAME } = require('./community-config');

const Database = require('./sqlite');

function createClaudeConversationContext(deps = {}) {
  const {
    DB_PATH,
    compactContextText,
    loadClaudeLedgerMessages,
    ledgerCompactText,
    talkSourceMessages,
    isClaudeSessionId,
    terminalReadState,
    terminalCompactText,
    openLedgerDb,
  } = deps;
  const sanitizeTalkMessages = value => deps.sanitizeTalkMessages(value);
  const stripToolUseMarkersText = deps.stripToolUseMarkersText || (value => String(value || ''));

  // 100 轮原文按 user+assistant 共 200 条消息计算。
  const RELAY_MSG_COUNT = Math.max(20, Math.min(240, Number(process.env.RIFUGIO_RELAY_MSG_COUNT || 200) || 200));
  const RELAY_MSG_MAX_CHARS = Math.max(600, Math.min(5000, Number(process.env.RIFUGIO_RELAY_MSG_MAX_CHARS || 1800) || 1800));
  const RELAY_TOTAL_MAX_CHARS = Math.max(6000, Math.min(160000, Number(process.env.RIFUGIO_RELAY_TOTAL_MAX_CHARS || 120000) || 120000));
  const AUTO_SESSION_RELAY_DEFAULT_TURNS = Math.max(80, Math.min(240, Number(process.env.RIFUGIO_AUTO_SESSION_RELAY_TURNS || 120) || 120));
  const AUTO_SESSION_RELAY_TRIGGER_RATIO = Math.max(0.8, Math.min(1, Number(process.env.RIFUGIO_AUTO_SESSION_RELAY_TRIGGER_RATIO || 0.85) || 0.85));
  const AGENT_CONTEXT_WINDOW_CHARS = Math.max(40000, Math.min(800000, Number(process.env.RIFUGIO_AGENT_CONTEXT_WINDOW_CHARS || 180000) || 180000));
  function autoRelayEnabled(value) {
    if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
    return true;
  }
  function autoRelayThreshold(value) {
    const n = Number(value || AUTO_SESSION_RELAY_DEFAULT_TURNS);
    return Number.isFinite(n) ? Math.max(80, Math.min(240, Math.floor(n))) : AUTO_SESSION_RELAY_DEFAULT_TURNS;
  }
  function autoRelayTriggerTurns(threshold) {
    return Math.max(1, Math.floor(autoRelayThreshold(threshold) * AUTO_SESSION_RELAY_TRIGGER_RATIO));
  }
  function autoRelayContextMinTurns(threshold) {
    return Math.max(8, Math.floor(autoRelayTriggerTurns(threshold) * 0.75));
  }
  function agentContextTriggerChars() {
    return Math.max(1000, Math.floor(AGENT_CONTEXT_WINDOW_CHARS * AUTO_SESSION_RELAY_TRIGGER_RATIO));
  }
  function contextProgressState(estimatedChars) {
    const chars = Math.max(0, Number(estimatedChars || 0) || 0);
    const trigger = agentContextTriggerChars();
    return {
      estimated_context_chars: chars,
      context_window_chars: AGENT_CONTEXT_WINDOW_CHARS,
      context_trigger_chars: trigger,
      context_progress_pct: Math.min(100, Math.round((chars / AGENT_CONTEXT_WINDOW_CHARS) * 100)),
      context_trigger_progress_pct: Math.min(100, Math.round((chars / trigger) * 100)),
      will_auto_relay_by_context: chars >= trigger,
    };
  }
  function talkMessagesContextState(messages, latestHandoff = null, extraChars = 0) {
    const clean = Array.isArray(messages) ? sanitizeTalkMessages(messages) : [];
    const textChars = clean.reduce((sum, m) => sum + String(textFromTalkMessage(m) || m?.content || '').length, 0);
    const handoffChars = String(latestHandoff?.summary || '').length;
    const estimated = textChars + Math.min(handoffChars, 12000) + Math.max(0, Number(extraChars || 0) || 0);
    return {
      talk_messages: clean.length,
      user_turns: clean.filter(m => m?.role === 'user').length,
      estimated_text_chars: textChars,
      latest_handoff_summary_chars: handoffChars,
      latest_handoff_at: latestHandoff?.created_at || '',
      ...contextProgressState(estimated),
    };
  }
  function currentPromptExtraChars(messages, currentPrompt) {
    const prompt = String(currentPrompt || '').trim();
    if (!prompt || !Array.isArray(messages) || !messages.length) return prompt.length;
    const last = messages[messages.length - 1];
    const lastText = last?.content != null ? String(last.content || '') : textFromTalkMessage(last);
    if (last?.role === 'user' && approxSameUserPrompt(lastText, prompt)) return 0;
    return prompt.length;
  }
  function estimateConversationContextChars(conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid) return 0;
    let db;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT messages FROM chat_convos WHERE id=?').get(cid);
      const latestHandoff = db.prepare('SELECT summary, created_at FROM claude_handoff_summaries WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(cid) || null;
      let messages = [];
      try { messages = JSON.parse(row?.messages || '[]'); } catch (_) { messages = []; }
      const extra = opts.currentPrompt != null ? currentPromptExtraChars(messages, opts.currentPrompt) : (Number(opts.extraChars || 0) || 0);
      return talkMessagesContextState(messages, latestHandoff, extra).estimated_context_chars;
    } catch (_) {
      return 0;
    } finally {
      try { db?.close?.(); } catch (_) {}
    }
  }
  function approxSameUserPrompt(a, b) {
    const norm = x => stripToolUseMarkersText(String(x || ''))
      .replace(/\[[a-zA-Z][a-zA-Z ]*\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const aa = norm(a);
    const bb = norm(b);
    if (!aa || !bb) return false;
    if (aa === bb) return true;
    const aShort = aa.slice(0, 600);
    const bShort = bb.slice(0, 600);
    return aShort.length > 40 && bShort.length > 40 && (aShort.includes(bShort) || bShort.includes(aShort));
  }
  function cleanHandoffText(v, max = 1200) {
    return stripToolUseMarkersText(String(v || ''))
      .replace(/\[[a-zA-Z][a-zA-Z ]*\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }
  function textFromTalkMessage(m) {
    if (!m || typeof m !== 'object') return '';
    const parts = [];
    const content = cleanHandoffText(m.content, RELAY_MSG_MAX_CHARS);
    if (content) parts.push(content);
    for (const a of (Array.isArray(m.attachments) ? m.attachments : [])) {
      if (a?.kind === 'voice') parts.push(`语音：${cleanHandoffText(a.transcript || a.name || '', 360) || '未识别'}`);
      else if (a?.kind === 'sticker') parts.push(`表情包：${cleanHandoffText(a.semantic || a.name || '', 240) || '未命名'}`);
      else if (a?.name) parts.push(`图片：${cleanHandoffText(a.name, 240)}`);
      else parts.push('图片');
    }
    return parts.filter(Boolean).join('；');
  }
  function buildTalkConversationSummary(conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid) return '';
    const count = Math.max(8, Math.min(240, Number(opts.count || RELAY_MSG_COUNT) || RELAY_MSG_COUNT));
    const totalMax = Math.max(6000, Math.min(160000, Number(opts.totalMax || RELAY_TOTAL_MAX_CHARS) || RELAY_TOTAL_MAX_CHARS));
    const currentPrompt = opts.currentPrompt ? String(opts.currentPrompt) : '';
    let db;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare('SELECT name, session_id, messages FROM chat_convos WHERE id=?').get(cid);
      if (!row) return '';

      let messages = loadClaudeLedgerMessages(cid, 'talk', count).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: ledgerCompactText(m.content || '', 16000),
      }));
      if (!messages.length) {
        try { messages = JSON.parse(row.messages || '[]'); } catch (_) { messages = []; }
        messages = (opts.excludeTerminalTurns ? talkSourceMessages(messages) : sanitizeTalkMessages(messages))
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && textFromTalkMessage(m));
      }

      // 前端会先把本轮 user message 落进 chat_convos，再请求新 session。
      // 如果最后一条 user 与本轮 prompt 基本相同，接力摘要里去掉它，避免新 session 在 system prompt 和 -p prompt 里读到重复问题。
      if (currentPrompt && messages.length) {
        const last = messages[messages.length - 1];
        const lastText = last?.content != null ? ledgerCompactText(last.content, 4000) : textFromTalkMessage(last);
        if (last?.role === 'user' && approxSameUserPrompt(lastText, currentPrompt)) messages = messages.slice(0, -1);
      }

      const picked = messages.slice(-count);
      const lines = [];
      let used = 0;
      for (const m of picked) {
        const text = m?.content != null ? ledgerCompactText(m.content, 1600) : textFromTalkMessage(m);
        let line = `${m.role === 'user' ? USER_NAME : COMPANION_NAME}: ${text}`;
        if (!line.trim()) continue;
        if (used + line.length > totalMax) {
          const remain = Math.max(0, totalMax - used - 80);
          if (remain > 300) lines.push(line.slice(0, remain) + '…');
          break;
        }
        lines.push(line);
        used += line.length + 1;
      }
      return [
        `conversation_id: ${cid}`,
        `conversation_name: ${row.name || '新对话'}`,
        `db_session_id: ${isClaudeSessionId(row.session_id) ? row.session_id : '(unknown)'}`,
        `relay_policy: recent ${lines.length}/${messages.length} cleaned messages, max ${totalMax} chars`,
        `recent_messages:`,
        lines.join('\n') || '暂无可用最近消息',
      ].join('\n');
    } catch (_) { return ''; }
    finally { try { db?.close?.(); } catch (_) {} }
  }

  function findConversationIdForSessionRef(sessionRef, opts = {}) {
    const ref = String(sessionRef || '').trim();
    const exclude = String(opts.excludeConversationId || '').trim();
    if (!ref) return '';
    let db;
    const pick = rows => {
      for (const row of rows || []) {
        const cid = String(row?.conversation_id || row?.id || '').trim();
        if (cid && cid !== exclude) return cid;
      }
      return '';
    };
    try {
      db = new Database(DB_PATH, { readonly: true });
      return pick(db.prepare(`
        SELECT id FROM claude_conversations
        WHERE active_claude_session_id=?
        ORDER BY updated_at DESC LIMIT 5
      `).all(ref))
        || pick(db.prepare(`
          SELECT conversation_id FROM claude_agent_sessions
          WHERE claude_session_id=?
          ORDER BY updated_at DESC LIMIT 5
        `).all(ref))
        || pick(db.prepare(`
          SELECT id FROM chat_convos
          WHERE session_id=?
          ORDER BY updated_at DESC LIMIT 5
        `).all(ref))
        || pick(db.prepare(`
          SELECT conversation_id FROM claude_handoff_summaries
          WHERE from_claude_session_id=? OR to_claude_session_id=?
          ORDER BY created_at DESC LIMIT 5
        `).all(ref, ref));
    } catch (_) {
      return '';
    } finally {
      try { db?.close?.(); } catch (_) {}
    }
  }

  function buildTerminalContextForInAppSession(conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    if (!cid) return '';
    const count = Math.max(6, Math.min(240, Number(opts.terminalCount || RELAY_MSG_COUNT) || RELAY_MSG_COUNT));
    const totalMax = Math.max(3000, Math.min(160000, Number(opts.terminalTotalMax || RELAY_TOTAL_MAX_CHARS) || RELAY_TOTAL_MAX_CHARS));
    const handoffMax = Math.max(0, Math.min(20000, Number(opts.terminalHandoffMax || 12000) || 12000));
    let messages = loadClaudeLedgerMessages(cid, 'terminal', count).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: terminalCompactText(m.content || '', 5000),
    }));
    let activeSession = '';
    let relayIndex = 0;
    if (!messages.length) {
      try {
        const st = terminalReadState();
        const rec = st?.conversations?.[cid] || null;
        activeSession = rec?.active_session || rec?.session || '';
        relayIndex = Number(rec?.relay_index || 0) || 0;
        messages = (Array.isArray(rec?.messages) ? rec.messages : []).slice(-count).map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: terminalCompactText(m.content || '', 5000),
        }));
      } catch (_) {}
    }

    const rows = [];
    let used = 0;
    for (const m of messages.slice(-count)) {
      const text = terminalCompactText(m.content, 1200);
      if (!text) continue;
      const line = `${m.role === 'user' ? USER_NAME : COMPANION_NAME}: ${text}`;
      if (used + line.length > totalMax) {
        const remain = Math.max(0, totalMax - used - 80);
        if (remain > 300) rows.push(line.slice(0, remain) + '…');
        break;
      }
      rows.push(line);
      used += line.length + 1;
    }

    let latestHandoff = null;
    if (handoffMax > 0) {
      let db;
      try {
        db = openLedgerDb(true);
        latestHandoff = db.prepare(`
          SELECT from_claude_session_id, to_claude_session_id, summary, last_5_turns_snapshot, created_at
          FROM claude_handoff_summaries
          WHERE conversation_id=? AND surface='terminal'
          ORDER BY created_at DESC
          LIMIT 1
        `).get(cid) || null;
      } catch (_) {
        latestHandoff = null;
      } finally {
        try { db?.close?.(); } catch (_) {}
      }
    }

    if (!rows.length && !latestHandoff) return '';
    const handoffText = latestHandoff
      ? terminalCompactText(latestHandoff.last_5_turns_snapshot || (!rows.length ? latestHandoff.summary : ''), handoffMax)
      : '';
    return [
      `conversation_id: ${cid}`,
      activeSession ? `terminal_session: ${activeSession}` : '',
      `terminal_relay_index: ${relayIndex}`,
      rows.length ? `recent_terminal_messages (${rows.length}/${messages.length}):\n${rows.join('\n')}` : '',
      latestHandoff ? `latest_terminal_handoff_at: ${latestHandoff.created_at || ''}` : '',
      handoffText ? `latest_terminal_handoff_snapshot:\n${handoffText}` : '',
    ].filter(Boolean).join('\n');
  }

  function latestTalkHandoffRowForBootstrap(conversationId, opts = {}) {
    const cid = String(conversationId || '').trim();
    const previousConversationId = String(opts.previousConversationId || '').trim();
    const previousSessionId = String(opts.previousSessionId || opts.previous_session_id || '').trim();
    let db;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const byConversation = id => id ? db.prepare(`
        SELECT conversation_id, surface, from_claude_session_id, to_claude_session_id,
               summary, last_5_turns_snapshot, created_at
        FROM claude_handoff_summaries
        WHERE conversation_id=? AND surface='talk'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(id) || null : null;
      const bySession = (sessionId, excludeConversationId = '') => sessionId ? db.prepare(`
          SELECT conversation_id, surface, from_claude_session_id, to_claude_session_id,
                 summary, last_5_turns_snapshot, created_at
          FROM claude_handoff_summaries
          WHERE surface='talk'
            AND (from_claude_session_id=? OR to_claude_session_id=?)
            AND (?='' OR conversation_id<>?)
          ORDER BY created_at DESC
          LIMIT 1
        `).get(sessionId, sessionId, excludeConversationId, excludeConversationId) || null : null;
      return bySession(previousSessionId, cid)
        || (previousConversationId && previousConversationId !== cid ? byConversation(previousConversationId) : null)
        || byConversation(cid)
        || bySession(previousSessionId);
    } catch (_) {
      return null;
    } finally {
      try { db?.close?.(); } catch (_) {}
    }
  }

  function buildLatestTalkHandoffContext(conversationId, opts = {}) {
    const row = latestTalkHandoffRowForBootstrap(conversationId, opts);
    const body = compactContextText(row?.last_5_turns_snapshot || row?.summary || '', opts.max || RELAY_TOTAL_MAX_CHARS);
    if (!row || !body) return '';
    return [
      `handoff_conversation_id: ${row.conversation_id || conversationId || ''}`,
      row.created_at ? `handoff_created_at: ${row.created_at}` : '',
      row.from_claude_session_id ? `from_session: ${row.from_claude_session_id}` : '',
      row.to_claude_session_id ? `to_session: ${row.to_claude_session_id}` : '',
      `handoff_body:\n${body}`,
    ].filter(Boolean).join('\n');
  }

  function buildInAppSessionBootstrap(conversationId, explicitBootstrap, opts = {}) {
    const dbSummary = buildTalkConversationSummary(conversationId, opts);
    const previousSessionId = String(opts.previousSessionId || opts.previous_session_id || '').trim();
    const previousConversationId = findConversationIdForSessionRef(previousSessionId, { excludeConversationId: conversationId });
    const previousDbSummary = previousConversationId
      ? buildTalkConversationSummary(previousConversationId, { ...opts, currentPrompt: '' })
      : '';
    const latestHandoff = buildLatestTalkHandoffContext(conversationId, {
      previousSessionId,
      previousConversationId,
      max: opts.handoffMax || RELAY_TOTAL_MAX_CHARS,
    });
    const terminalSummary = buildTerminalContextForInAppSession(conversationId, opts);
    const frontendSummary = compactContextText(explicitBootstrap, 8000);
    return [
      dbSummary ? `

  【最近聊天记录｜后端从 chat_convos 生成】
  ${dbSummary}` : '',
      previousDbSummary ? `

  【上一 Claude session 所属对话的最近记录｜previous_session_id 反查】
  ${previousDbSummary}` : '',
      latestHandoff ? `

  【最新 handoff / 接力摘要｜后端记录】
  ${latestHandoff}` : '',
      terminalSummary ? `

  【Terminal iMessage / 交互式 Claude Code 最近上下文｜后端自动合并】
  下面是同一个前端 conversation_id 在 Terminal 区发生的最近对话/接力信息。请把它当作同一段关系和任务的连续上下文，自然接上；不要复述这段说明。
  ${terminalSummary}` : '',
      frontendSummary ? `

  【前端补充交接摘要】
  ${frontendSummary}` : '',
    ].filter(Boolean).join('\n');
  }

  return {
    RELAY_MSG_COUNT,
    RELAY_MSG_MAX_CHARS,
    RELAY_TOTAL_MAX_CHARS,
    AUTO_SESSION_RELAY_DEFAULT_TURNS,
    AUTO_SESSION_RELAY_TRIGGER_RATIO,
    AGENT_CONTEXT_WINDOW_CHARS,
    autoRelayEnabled,
    autoRelayThreshold,
    autoRelayTriggerTurns,
    autoRelayContextMinTurns,
    agentContextTriggerChars,
    contextProgressState,
    talkMessagesContextState,
    currentPromptExtraChars,
    estimateConversationContextChars,
    approxSameUserPrompt,
    cleanHandoffText,
    textFromTalkMessage,
    buildTalkConversationSummary,
    findConversationIdForSessionRef,
    buildTerminalContextForInAppSession,
    latestTalkHandoffRowForBootstrap,
    buildLatestTalkHandoffContext,
    buildInAppSessionBootstrap,
  };
}

module.exports = { createClaudeConversationContext };
