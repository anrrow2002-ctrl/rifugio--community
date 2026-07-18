'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

function mountClaudeAgentStreamRoutes(app, deps = {}) {
  const {
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
  } = deps;

  const liveGens = new Map();
  const LIVE_GEN_TTL_MS = 5 * 60 * 1000;
  function sseHead(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // 关掉 nginx 对本响应的缓冲，保证逐字流式
    });
  }
  function startLiveGen(sid, meta = {}) {
    const entry = {
      sid,
      conversationId: String(meta.conversationId || '').trim(),
      turnId: String(meta.turnId || crypto.randomUUID()).trim(),
      surface: String(meta.surface || 'agent').trim() || 'agent',
      route: String(meta.route || 'print').trim() || 'print',
      lines: [],
      done: false,
      startedAt: Date.now(),
      finishedAt: 0,
      subscribers: new Set(),
      child: null,
      finalStatus: 'closed',
      db: null,
    };
    if (entry.conversationId) {
      try {
        entry.db = openLedgerDb(false);
        recordClaudeAgentSession(entry.db, {
          conversationId: entry.conversationId,
          claudeSessionId: sid,
          route: entry.route,
          status: 'active',
          transcriptPath: '',
          lastOffset: 0,
        });
      } catch (_) {
        try { if (entry.db) entry.db.close(); } catch (_) {}
        entry.db = null;
      }
    }
    liveGens.set(sid, entry);   // 新一轮生成覆盖同 sid 的旧记录
    return entry;
  }
  function findLiveGenByConversation(conversationId) {
    const cid = String(conversationId || '').trim();
    if (!cid) return null;
    const entries = Array.from(liveGens.values())
      .filter(e => e && e.conversationId === cid)
      .sort((a, b) => (Number(b.startedAt || b.finishedAt || 0) - Number(a.startedAt || a.finishedAt || 0)));
    return entries.find(e => !e.done) || entries[0] || null;
  }
  function attachSubscriber(entry, res) { entry.subscribers.add(res); }
  function broadcastLine(entry, line) {
    entry.lines.push(line);
    if (entry.db && entry.conversationId) {
      try {
        const block = classifyClaudePreviewBlock(line);
        if (block) {
          appendClaudePreviewBlock(entry.db, {
            conversationId: entry.conversationId,
            surface: entry.surface || 'agent',
            turnId: entry.turnId || entry.sid,
            type: block.type,
            content: block.content,
            claudeSessionId: entry.sid,
          });
        }
      } catch (_) {}
    }
    const msg = `data: ${line}\n\n`;
    for (const s of entry.subscribers) { try { s.write(msg); } catch (_) {} }
  }
  function finishLiveGen(entry) {
    if (entry.done) return;
    entry.done = true;
    entry.finishedAt = Date.now();
    if (entry.db && entry.conversationId) {
      try {
        appendClaudePreviewBlock(entry.db, {
          conversationId: entry.conversationId,
          surface: entry.surface || 'agent',
          turnId: entry.turnId || entry.sid,
          type: 'done',
          content: entry.finalStatus || 'done',
          claudeSessionId: entry.sid,
        });
      } catch (_) {}
      try {
        recordClaudeAgentSession(entry.db, {
          conversationId: entry.conversationId,
          claudeSessionId: entry.sid,
          route: entry.route || 'print',
          status: entry.finalStatus || 'closed',
          transcriptPath: '',
          lastOffset: entry.lines.length,
          closedAt: ledgerNow(),
        });
      } catch (_) {}
      try { entry.db.close(); } catch (_) {}
      entry.db = null;
    }
    for (const s of entry.subscribers) { try { s.write('data: [DONE]\n\n'); s.end(); } catch (_) {} }
    entry.subscribers.clear();
    setTimeout(() => { if (liveGens.get(entry.sid) === entry) liveGens.delete(entry.sid); }, LIVE_GEN_TTL_MS);
  }

  app.post('/api/claude-agent/stream', (req, res) => {
    const { prompt, session_id, model, effort, thinking, system_prompt, character_prompt, images, conversation_id, bootstrap_context, force_new_session, auto_session_relay, auto_session_relay_turns } = req.body || {};
    const rawText = promptWithImages((typeof prompt === 'string' ? prompt : '').trim(), images);
    if (!rawText) return res.status(400).json({ ok: false, error: 'prompt required' });
    const conversationId = String(conversation_id || '').trim() || 'default';

    const cliModel = resolveCliModel(model);
    const thinkBudget = resolveThinkBudget(effort);
    // 与 /api/chat 同一套：所有模型统一 effort→MAX_THINKING_TOKENS + --thinking-display summarized。
    const useThinking = thinking !== false && Boolean(thinkBudget);

    const ct = buildChatTools();   // 动态：合并用户加的 MCP + 对应权限

    let routePlan = planClaudeSessionRoute(conversationId, session_id, {
      forceNewSession: force_new_session,
      autoSessionRelay: auto_session_relay,
      autoSessionRelayTurns: auto_session_relay_turns,
      currentPrompt: rawText,
    });
    const sessionBootstrapHash = buildSessionBootstrapHash(system_prompt, ct, { characterPrompt: character_prompt });
    const existingBootstrapHash = routePlan.shouldResume ? getSessionBootstrapHash(conversationId, routePlan.sid) : '';
    const resumeBootstrapMatches = routePlan.shouldResume && sessionHasBootstrapHash(conversationId, routePlan.sid, sessionBootstrapHash);
    // 资料面板/交流偏好变化不再强制当作“新会话接力”。已有 bootstrap 记录但 hash 不同：
    // 继续 resume 当前 session，并通过 runtime profile update 注入更新资料，避免粘贴最近聊天上下文。
    const frontendContextUpdateOnly = Boolean(routePlan.shouldResume && existingBootstrapHash && !resumeBootstrapMatches);
    if (routePlan.shouldResume && !resumeBootstrapMatches && !frontendContextUpdateOnly) {
      routePlan = forceFreshRouteForBootstrap(conversationId, session_id, {
        autoSessionRelay: auto_session_relay,
        autoSessionRelayTurns: auto_session_relay_turns,
        currentPrompt: rawText,
      });
    }
    const sid = routePlan.sid;
    const previousSid = routePlan.previousSid;
    const shouldResume = routePlan.shouldResume;
    try {
      setActiveClaudeSessionForConversation(conversationId, sid);
      recordClaudeAutoRelayStart(routePlan);
    } catch (_) {}

    const initialProfileMeta = { conversation_id: conversationId, session_id: sid, is_new_session: !shouldResume };
    const initialProfilePlan = profileInjectionPlan(system_prompt, initialProfileMeta);
    const initialDynamicPlan = frontendDynamicContextPlan(system_prompt, initialProfileMeta);
    const bridgePlan = crossSurfaceBridgePlan(conversationId, 'agent', sid, { currentPrompt: rawText });
    const runtimePayload = buildRuntimeContextPayload(system_prompt, {
      conversation_id: conversationId,
      session_id: sid,
      is_new_session: !shouldResume,
      bridge_context: shouldResume ? bridgePlan.text : '',
    });
    const text = attachRuntimeContextToPrompt(rawText, runtimePayload);
    const args = ['-p', text, '--model', cliModel,
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--allowedTools', ct.allowed,
      '--mcp-config', ct.configPath, '--strict-mcp-config', '--permission-mode', 'dontAsk'];
    if (useThinking) args.push('--thinking-display', 'summarized');
    if (ct.disallow.length) args.push('--disallowedTools', ct.disallow.join(','));

    let initialBootstrapContext = '';
    let initialSystemPromptText = '';
    if (shouldResume) {
      args.push('--resume', sid);
    } else {
      const relayBootstrap = [routePlan.relaySummary, bootstrap_context].filter(Boolean).join('\n\n');
      initialBootstrapContext = buildInAppSessionBootstrap(conversationId, relayBootstrap, { currentPrompt: rawText, previousSessionId: previousSid });
      initialSystemPromptText = buildInitialSystemPrompt(system_prompt, ct, initialBootstrapContext, { conversation_id: conversationId, session_id: sid, previous_session_id: previousSid, profilePlan: initialProfilePlan, dynamicPlan: initialDynamicPlan, characterPrompt: character_prompt });
      args.push('--session-id', sid, '--append-system-prompt', initialSystemPromptText);
    }
    if (!shouldResume) {
      if (initialProfilePlan.inject) markProfileInjected(system_prompt, { conversation_id: conversationId, session_id: sid }, 'system_prompt_full');
      if (initialDynamicPlan.inject) markFrontendDynamicContextInjected(system_prompt, { conversation_id: conversationId, session_id: sid }, 'system_prompt_dynamic_full');
    } else {
      let updatedBootstrapContext = false;
      if (/^full/.test(runtimePayload.profileMode || '')) {
        markProfileInjected(system_prompt, { conversation_id: conversationId, session_id: sid }, 'runtime_profile_full_once');
        updatedBootstrapContext = true;
      }
      if (/^full/.test(runtimePayload.dynamicMode || '')) {
        markFrontendDynamicContextInjected(system_prompt, { conversation_id: conversationId, session_id: sid }, 'runtime_dynamic_full_once');
        updatedBootstrapContext = true;
      }
      if (updatedBootstrapContext) markSessionBootstrapInjected({ conversation_id: conversationId, session_id: sid }, sessionBootstrapHash, 'runtime_context_update');
    }
    if (!shouldResume) markSessionBootstrapInjected({ conversation_id: conversationId, session_id: sid }, sessionBootstrapHash, 'append_system_prompt');
    if (bridgePlan.hash && (!shouldResume || bridgePlan.text)) markCrossSurfaceBridgeInjected(bridgePlan, shouldResume ? 'agent_runtime' : 'agent_bootstrap');

    const env = { ...process.env, HOME: '/root' };
    // 去掉从父 Claude Code 会话继承来的环境，否则子进程被当成"嵌套子会话"，思维链会被吞
    for (const k of Object.keys(env)) {
      if (/^CLAUDE/i.test(k) || /^AI_AGENT/i.test(k)) delete env[k];
    }
    if (useThinking) env.MAX_THINKING_TOKENS = thinkBudget;

    const entry = startLiveGen(sid, { conversationId, turnId: crypto.randomUUID(), surface: 'agent', route: 'print' });   // 登记成可续传
    entry.routePlan = routePlan;

    sseHead(res);
    res.write(': connected\n\n');                       // 尽早开流
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    attachSubscriber(entry, res);
    // 让前端知道当前真实 Claude Code session。force_new_session 时，UI 仍保持同一个 Talk conversation。
    broadcastLine(entry, JSON.stringify({
      type: 'session_route',
      session_id: sid,
      conversation_id: conversationId,
      new_session: !shouldResume,
      forced: routePlan.relayReason === 'manual_force_new_session',
      automatic_relay: Boolean(routePlan.relayReason && routePlan.relayReason !== 'manual_force_new_session'),
      relay_reason: routePlan.relayReason || '',
      relay_turns_in_active_session: shouldResume ? routePlan.turnsInActiveSession : 0,
      relay_threshold_turns: routePlan.threshold,
      relay_trigger_turns: routePlan.triggerTurns,
      relay_context_min_turns: routePlan.contextMinTurns,
      profile_injection: {
        mode: !shouldResume ? (initialProfilePlan.inject ? 'system_prompt_full' : 'system_prompt_skipped') : runtimePayload.profileMode,
        inject: !shouldResume ? Boolean(initialProfilePlan.inject) : /^full/.test(runtimePayload.profileMode || ''),
        reason: !shouldResume ? (initialProfilePlan.reason || '') : (runtimePayload.profileMode || ''),
        hash: initialProfilePlan.hash || runtimePayload.profileHash || '',
        known_hash: initialProfilePlan.knownHash || '',
        bootstrap_hash: sessionBootstrapHash,
        bootstrap_known: Boolean(sessionBootstrapHash && sessionHasBootstrapHash(conversationId, sid, sessionBootstrapHash)),
        bootstrap_refreshed: Boolean(routePlan.bootstrapRefresh),
        profile_chars: String(initialProfilePlan.text || '').length,
        append_system_prompt_chars: initialSystemPromptText.length,
        bootstrap_context_chars: initialBootstrapContext.length,
        append_has_profile_block: initialSystemPromptText.includes(FRONTEND_PROFILE_MARKER) || initialSystemPromptText.includes(FRONTEND_PROFILE_UPDATE_MARKER),
        append_has_chat_persona: false,
        append_has_character_prompt: Boolean(String(character_prompt || '').trim() && initialSystemPromptText.includes(String(character_prompt || '').trim().slice(0, 80))),
        append_has_sticker_list: initialSystemPromptText.includes('个可用表情包'),
        append_has_memory: initialSystemPromptText.includes('以下是你们之间一些重要的记忆') || initialSystemPromptText.includes('以下是长期沉淀'),
      },
      dynamic_context_injection: {
        mode: !shouldResume ? (initialDynamicPlan.inject ? 'system_prompt_dynamic_context_full' : 'system_prompt_dynamic_context_skipped') : runtimePayload.dynamicMode,
        inject: !shouldResume ? Boolean(initialDynamicPlan.inject) : /^full/.test(runtimePayload.dynamicMode || ''),
        reason: !shouldResume ? (initialDynamicPlan.reason || '') : (runtimePayload.dynamicMode || ''),
        hash: initialDynamicPlan.hash || runtimePayload.dynamicHash || '',
        known_hash: initialDynamicPlan.knownHash || '',
        dynamic_chars: String(initialDynamicPlan.text || '').length,
        append_has_dynamic_context_block: initialSystemPromptText.includes(FRONTEND_DYNAMIC_CONTEXT_MARKER) || initialSystemPromptText.includes(FRONTEND_DYNAMIC_CONTEXT_UPDATE_MARKER),
      },
      estimated_context_chars: routePlan.contextChars,
      context_window_chars: routePlan.contextWindowChars,
      context_trigger_chars: routePlan.contextTriggerChars,
      context_progress_pct: routePlan.contextProgressPct,
      context_trigger_progress_pct: routePlan.contextTriggerProgressPct,
      previous_session_id: !shouldResume ? previousSid || null : null,
    }));

    let buf = '', errBuf = '', sawResult = false, resultCost = 0;

    const handleClose = code => {
      if (entry.done) return;
      entry.finalStatus = code === 0 ? 'closed' : 'failed';
      try {
        recordClaudeAutoRelayTurn(conversationId, sid, { success: code === 0 });
        if (code === 0) maybePrepareClaudeAutoRelaySummary(conversationId, sid, { autoSessionRelayTurns: auto_session_relay_turns });
      } catch (_) {}
      if (buf.trim()) broadcastLine(entry, buf.trim());
      if (code !== 0 && !sawResult) {
        if (shouldResume && isDeferredToolMarkerMiss(errBuf)) {
          clearStaleClaudeSessionForConversation(conversationId, sid, 'stream_deferred_marker_miss');
          broadcastLine(entry, JSON.stringify({
            type: 'resume_deferred_miss',
            code: 'resume_deferred_miss',
            conversation_id: conversationId,
            stale_session_id: sid,
            retry: 'force_new_session',
          }));
        } else {
          broadcastLine(entry, JSON.stringify({ type: 'error', error: { message: `claude exited ${code}: ${(errBuf || '').slice(0, 300)}` } }));
        }
      }
      // -p 月度额度累加 + 到 $18 预警（前端据此弹横幅、存 handoff、提示切终端 resume；实际额度/缓存以 Claude Code 服务端为准）
      try {
        const usage = addPqUsage(resultCost);
        if (usage.cost_usd >= PQ_WARN_USD) {
          broadcastLine(entry, JSON.stringify({ type: 'quota_warning', scope: 'p', used_usd: usage.cost_usd, warn_usd: PQ_WARN_USD, budget_usd: PQ_BUDGET_USD, session_id: sid, resume_command: 'claude --resume ' + sid }));
        }
      } catch (_) {}
      finishLiveGen(entry);
    };

    // claude CLI 在自动更新那一两秒里符号链接会暂时消失 → spawn ENOENT。等一下自动重试一次，别让用户看到报错。
    const launch = (attempt) => {
      buf = ''; errBuf = ''; sawResult = false; resultCost = 0;
      logAppendPromptDebug('claude-agent/stream', {
        args,
        conversationId,
        shouldResume,
        sid,
        previousSid,
        force_new_session,
      routePlan,
      effort,
      thinkBudget,
      system_prompt,
        character_prompt,
        initialSystemPromptText,
        initialProfilePlan,
        initialDynamicPlan,
        initialBootstrapContext,
        sessionBootstrapHash,
        profileMode: shouldResume ? runtimePayload.profileMode : (initialProfilePlan.inject ? 'system_prompt_full' : 'system_prompt_skipped'),
        dynamicMode: shouldResume ? runtimePayload.dynamicMode : (initialDynamicPlan.inject ? 'system_prompt_dynamic_context_full' : 'system_prompt_dynamic_context_skipped'),
        attempt,
      });
      const child = spawn('claude', args, { cwd: '/root', env, timeout: CLAUDE_SPAWN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
      entry.child = child;
      child.stdout.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';                            // 末尾半行留到下次
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (t.includes('"type":"result"')) {
            sawResult = true;
            try { const r = JSON.parse(t); if (typeof r.total_cost_usd === 'number') resultCost = r.total_cost_usd; } catch (_) {}
          }
          broadcastLine(entry, t);                           // 缓存 + 推给所有在听的连接（claude 的 JSONL 单行原样转发）
        }
      });
      child.stderr.on('data', d => { errBuf += d.toString(); });
      child.on('error', e => {
        entry.finalStatus = 'failed';
        if (e && e.code === 'ENOENT' && attempt < 2 && !entry.done) {   // 正在自更新，稍等重试
          setTimeout(() => { if (!entry.done) launch(attempt + 1); }, 900);
          return;
        }
        try { restoreClaudeAutoRelayStart(routePlan); } catch (_) {}
        broadcastLine(entry, JSON.stringify({ type: 'error', error: { message: 'spawn failed: ' + e.message } }));
        finishLiveGen(entry);
      });
      child.on('close', handleClose);
    };
    launch(1);
    // 客户端断开：只把这条连接从订阅里摘掉，不杀子进程——让回复继续生成、缓存住，等切回来 resume 续传。
    // 子进程自带可配置 timeout，默认 15 分钟，避免长 MCP 工具调用被 3 分钟截断。
    res.on('close', () => { entry.subscribers.delete(res); });
  });

  // 切屏续传：重连某条 sid 的生成，回放已缓存的全部行，再跟随直到结束。没缓存(切太久/早结束)就回 resume_miss。
  app.get('/api/claude-agent/stream/resume', (req, res) => {
    const sid = String(req.query.session_id || '').trim();
    const conversationId = String(req.query.conversation_id || '').trim();
    sseHead(res);
    res.write(': connected\n\n');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const entry = (sid && liveGens.get(sid)) || findLiveGenByConversation(conversationId);
    if (!entry) {
      res.write(`data: ${JSON.stringify({ type: 'resume_miss', session_id: sid || null, conversation_id: conversationId || null })}\n\n`);
      if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n');
      return res.end();
    }
    for (const t of entry.lines) res.write(`data: ${t}\n\n`);   // 回放从头到现在
    if (entry.done) { res.write('data: [DONE]\n\n'); return res.end(); }
    attachSubscriber(entry, res);
    res.on('close', () => { entry.subscribers.delete(res); });
  });
}

module.exports = { mountClaudeAgentStreamRoutes };
