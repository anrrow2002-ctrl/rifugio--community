'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

function mountClaudeChatRoute(app, deps = {}) {
  const {
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
  } = deps;

  app.post('/api/chat', (req, res) => {
    // 鉴权已由上面的全局 AUTH GATE 统一处理（cookie 或内部 token）
    const { message, session_id, model, effort, thinking, system_prompt, character_prompt, images, conversation_id, bootstrap_context, force_new_session, auto_session_relay, auto_session_relay_turns } = req.body || {};
    if ((!message || typeof message !== 'string' || !message.trim()) && !(Array.isArray(images) && images.length)) {
      return res.status(400).json({ ok: false, error: 'message required' });
    }
    const conversationId = String(conversation_id || '').trim() || 'default';
    const cliModel = resolveCliModel(model);
    const thinkBudget = resolveThinkBudget(effort);
    // 所有模型统一：effort→MAX_THINKING_TOKENS，spawn 带 --thinking-display summarized 拿摘要。
    // body 传 thinking:false 或 effort:off 可强制关闭。
    const useThinking = thinking !== false && Boolean(thinkBudget);

    // 思维链需要 stream-json 流；不开则用普通 json（更快更省）
    const ct = buildChatTools();   // 动态：合并用户加的 MCP + 对应权限

    let routePlan = planClaudeSessionRoute(conversationId, session_id, {
      forceNewSession: force_new_session,
      autoSessionRelay: auto_session_relay,
      autoSessionRelayTurns: auto_session_relay_turns,
      currentPrompt: message,
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
        currentPrompt: message,
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
    const bridgePlan = crossSurfaceBridgePlan(conversationId, 'agent', sid, { currentPrompt: message });
    const runtimePayload = buildRuntimeContextPayload(system_prompt, {
      conversation_id: conversationId,
      session_id: sid,
      is_new_session: !shouldResume,
      bridge_context: shouldResume ? bridgePlan.text : '',
    });
    const promptText = attachRuntimeContextToPrompt(promptWithImages(message, images), runtimePayload);
    const args = ['-p', promptText, '--model', cliModel, '--allowedTools', ct.allowed,
      '--mcp-config', ct.configPath, '--strict-mcp-config', '--permission-mode', 'dontAsk'];
    if (ct.disallow.length) args.push('--disallowedTools', ct.disallow.join(','));
    if (useThinking) args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--thinking-display', 'summarized');
    else args.push('--output-format', 'json');

    let initialBootstrapContext = '';
    let initialSystemPromptText = '';
    if (shouldResume) {
      args.push('--resume', sid);
    } else {
      const relayBootstrap = [routePlan.relaySummary, bootstrap_context].filter(Boolean).join('\n\n');
      initialBootstrapContext = buildInAppSessionBootstrap(conversationId, relayBootstrap, { currentPrompt: message, previousSessionId: previousSid });
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

    logAppendPromptDebug('api/chat', {
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
    });
    const child = spawn('claude', args, { cwd: '/root', env, timeout: CLAUDE_SPAWN_TIMEOUT_MS });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => {
      try { restoreClaudeAutoRelayStart(routePlan); } catch (_) {}
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'spawn failed: ' + e.message });
    });
    child.on('close', code => {
      if (res.headersSent) return;
      if (code !== 0) {
        const detail = err || out || '';
        if (shouldResume && isDeferredToolMarkerMiss(detail)) {
          clearStaleClaudeSessionForConversation(conversationId, sid, 'api_chat_deferred_marker_miss');
          return res.status(409).json({
            ok: false,
            code: 'resume_deferred_miss',
            error: 'resumed Claude session lost deferred tool marker; stale session cleared',
            retry: 'force_new_session',
            conversation_id: conversationId,
            stale_session_id: sid,
          });
        }
        return res.status(500).json({ ok: false, error: `claude exited ${code}: ${detail.slice(0, 300)}` });
      }
      try {
        let reply = '', thinkText = '', msgThink = '', outSid = sid, cost = 0, dur = 0, isErr = false;
        if (!useThinking) {
          const j = JSON.parse(out);
          reply = j.result || ''; outSid = j.session_id || sid; cost = j.total_cost_usd || 0; dur = j.duration_ms || 0; isErr = j.is_error;
        } else {
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            let d; try { d = JSON.parse(line); } catch { continue; }
            const ev = d.event && typeof d.event === 'object' ? d.event : null;
            if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta') {
              thinkText += ev.delta.thinking || '';
            }
            const msg = d.message && typeof d.message === 'object' ? d.message : null;
            if (msg && Array.isArray(msg.content)) {
              for (const blk of msg.content) if (blk && blk.type === 'thinking') msgThink += blk.thinking || '';
            }
            if (d.type === 'result') {
              reply = d.result || ''; outSid = d.session_id || sid; cost = d.total_cost_usd || 0; dur = d.duration_ms || 0; isErr = d.is_error;
            }
          }
        }
        if (isErr) return res.status(500).json({ ok: false, error: reply || 'claude error' });
        try {
          const finalSidForRelay = isClaudeSessionId(outSid) ? outSid : sid;
          recordClaudeAutoRelayTurn(conversationId, finalSidForRelay, { success: true });
          maybePrepareClaudeAutoRelaySummary(conversationId, finalSidForRelay, { autoSessionRelayTurns: auto_session_relay_turns });
        } catch (_) {}
        try {
          const ledgerDb = openLedgerDb(false);
          try {
            const finalSid = isClaudeSessionId(outSid) ? outSid : sid;
            upsertClaudeConversationRecord(ledgerDb, conversationId, {
              activeSessionId: finalSid,
              userId: CLAUDE_LEDGER_USER_ID,
              projectId: CLAUDE_LEDGER_PROJECT_ID,
            });
            try {
              ledgerDb.prepare('UPDATE chat_convos SET session_id=?, updated_at=datetime(\'now\') WHERE id=?').run(finalSid, conversationId);
            } catch (_) {}
            recordClaudeAgentSession(ledgerDb, {
              conversationId,
              claudeSessionId: finalSid,
              route: useThinking ? 'stream-json' : 'json',
              status: 'closed',
              lastOffset: 1,
              closedAt: ledgerNow(),
            });
            appendClaudeConversationMessages(ledgerDb, {
              conversationId,
              surface: 'agent',
              turnId: crypto.randomUUID(),
              userText: message,
              assistantText: reply,
              claudeSessionId: finalSid,
            });
          } finally {
            ledgerDb.close();
          }
        } catch (_) {}
        res.json({
          ok: true,
          reply,
          thinking: (thinkText || msgThink).trim(),
          session_id: outSid,
          model: cliModel,
          cost_usd: cost,
          duration_ms: dur,
          session_route: {
            new_session: !shouldResume,
            automatic_relay: Boolean(routePlan.relayReason && routePlan.relayReason !== 'manual_force_new_session'),
            relay_reason: routePlan.relayReason || '',
            relay_turns_in_active_session: routePlan.turnsInActiveSession,
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
          },
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: 'parse failed: ' + (out || err).slice(0, 300) });
      }
    });
  });
}

module.exports = { mountClaudeChatRoute };
