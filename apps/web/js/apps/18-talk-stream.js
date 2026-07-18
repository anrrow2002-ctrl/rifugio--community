// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.applyTerminalTurnSnapshot = function(snapshot, assistantMsg, applyEvent) {
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    let hasFinal = false;
    for (const evt of events) {
        if (evt?.type === 'terminal_final') hasFinal = true;
        applyEvent(evt);
    }
    if (snapshot?.done && !hasFinal && assistantMsg) {
        assistantMsg.content = assistantMsg.content || '本轮已经结束，但没有收到可用的最终回复。请查看原始终端。';
        assistantMsg.preview = false;
        assistantMsg.done = true;
        assistantMsg.pendingReconnect = false;
        assistantMsg.error = true;
    }
    return { done:Boolean(snapshot?.done), hasFinal };
};
window.Rifugio.useTalkStream = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            let relayStateRequestSeq = 0;
            const talkUsesApi = () => talkSettings.provider === 'openai-compatible';

            const relayStatusText = Vue.computed(() => {
                const s = talk.relayState || {};
                const sid = String(s.active_claude_session_id || '').slice(0, 8) || '----';
                const turns = Number(s.turns_in_active_session || 0) || 0;
                const trigger = Number(s.trigger_turns || 0) || 0;
                const threshold = Number(s.threshold_turns || 0) || 0;
                if (!threshold) return '后端 relay 状态等待同步';
                const pct = Number(s.trigger_progress_pct || 0) || 0;
                const next = s.will_auto_relay_next_turn ? ' · 下条会自动接力' : '';
                const reason = s.last_relay_reason ? ` · 原因：${String(s.last_relay_reason).slice(0, 48)}` : '';
                return `Claude ${sid}：${turns}/${threshold} 轮；${trigger} 轮触发自动接力（${pct}%）${next}${reason}`;
            });

            const relayContextText = Vue.computed(() => {
                const c = talk.relayContext || {};
                const msgs = Number(c.talk_messages || 0) || 0;
                const chars = Number(c.estimated_text_chars || 0) || 0;
                const hchars = Number(c.latest_handoff_summary_chars || 0) || 0;
                const hat = c.latest_handoff_at ? ` · 最近交接 ${String(c.latest_handoff_at).replace('T', ' ').slice(0, 16)}` : '';
                return `上下文约 ${chars} 字 / ${msgs} 条消息；交接摘要 ${hchars} 字${hat}`;
            });

            const talkExecutionStatusText = Vue.computed(() => {
                if (talkUsesApi()) return talk.thinking ? `API · ${talkSettings.apiModel || '未选择模型'} · 正在回答…` : `API · ${talkSettings.apiModel || '未选择模型'}`;
                if (talkSettings.executionMode === 'terminal') {
                    if (talk.terminalStatusLoading) return 'Terminal 状态同步中…';
                    return talk.terminalStatus || 'Terminal Claude Code 待连接';
                }
                return talk.thinking ? '-p 正在回答…' : '-p 低权限对话';
            });

            const talkTerminalRelayText = Vue.computed(() => {
                const s = talk.terminalRelayState || {};
                const turns = Number(s.turns_since_relay || talk.terminalTurnsSinceRelay || 0) || 0;
                const used = Number(s.context_chars_since_relay || s.total_chars || s.estimated_context_chars || 0) || 0;
                const trigger = Number(s.trigger_chars || 0) || 0;
                if (!trigger) return 'Terminal relay 状态等待同步';
                const pct = Number(s.trigger_progress_pct || 0) || 0;
                const next = s.will_auto_relay_next_turn ? ' · 下条自动接力' : '';
                return `Terminal：${used.toLocaleString()}/${trigger.toLocaleString()} 字；${turns}轮（${pct}%）${next}`;
            });

            const talkTerminalContextText = Vue.computed(() => {
                const s = talk.terminalRelayState || {};
                const config = Number(s.overhead_chars || 0) || 0;
                const diagnostic = Number(s.effective_total_chars || s.effective_chars || 0) || 0;
                const handoff = talk.terminalHandoffState ? ` · 最近交接 ${String(talk.terminalHandoffState.created_at || '').replace('T', ' ').slice(0, 16)} / ${talk.terminalHandoffState.summary_chars || 0}字` : ' · 暂无 terminal 交接记录';
                return `Terminal 配置 ${config.toLocaleString()} 字；诊断 ${diagnostic.toLocaleString()} 字${handoff}`;
            });

            const talkTerminalStatusUpdatedText = Vue.computed(() => {
                if (!talk.terminalStatusUpdatedAt) return '还没刷新';
                return String(talk.terminalStatusUpdatedAt).replace('T', ' ').slice(0, 19);
            });

            const compactSessionId = (value) => {
                const raw = String(value || '').trim();
                if (!raw) return '等待创建';
                return raw.length > 18 ? raw.slice(0, 8) + '…' + raw.slice(-6) : raw;
            };

            const formatContextChars = (n) => {
                const v = Math.max(0, Number(n || 0) || 0);
                if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万字';
                return v + '字';
            };

            const describeProfileInjection = (info) => {
                const p = info && typeof info === 'object' ? info : null;
                if (!p) return '';
                const profileChars = Number(p.profile_chars || 0) || 0;
                const promptChars = Number(p.append_system_prompt_chars || 0) || 0;
                const bootstrapChars = Number(p.bootstrap_context_chars || 0) || 0;
                const hasRolePrompt = !!(p.append_has_chat_persona || p.append_has_character_prompt);
                const hasAllAppend = !!p.append_has_profile_block;
                const hash = p.bootstrap_hash || p.hash || '';
                const shortHash = hash ? ` · ${String(hash).slice(0, 8)}` : '';
                const reason = p.bootstrap_refreshed
                    ? '旧 session 资料过期，已自动换新'
                    : (p.reason ? String(p.reason).slice(0, 40) : '');
                if (p.mode === 'session_bootstrap_recorded' || (p.bootstrap_known && !promptChars)) {
                    return `当前 session 已记录完整前端资料，本轮不重复占上下文${shortHash}`;
                }
                if (promptChars > 0) {
                    const pieces = [
                        hasRolePrompt ? '备注' : '',
                        p.append_has_profile_block ? '资料' : '',
                        p.append_has_sticker_list ? '表情' : '',
                        p.append_has_memory ? '记忆' : '',
                    ].filter(Boolean).join('/');
                    const ok = hasAllAppend ? '已送入新 session' : '已送入，但内容不完整';
                    return `${ok}：${pieces || 'append'} · ${promptChars}字 / 资料${profileChars}字 / 摘要${bootstrapChars}字${reason ? ' · ' + reason : ''}${shortHash}`;
                }
                if (/^full/.test(String(p.mode || ''))) {
                    return `资料更新已随本轮轻量补入：${profileChars}字${reason ? ' · ' + reason : ''}${shortHash}`;
                }
                return `资料已注入过，本轮不重复占上下文${reason ? ' · ' + reason : ''}${shortHash}`;
            };

            const describeDynamicContextInjection = (info) => {
                const p = info && typeof info === 'object' ? info : null;
                if (!p) return '';
                const chars = Number(p.dynamic_chars || 0) || 0;
                const hash = p.hash || '';
                const shortHash = hash ? ` · ${String(hash).slice(0, 8)}` : '';
                const reason = p.reason ? String(p.reason).slice(0, 44) : '';
                if (/^full/.test(String(p.mode || '')) || p.inject) {
                    return `表情/互动区已随本轮补入：${chars}字${reason ? ' · ' + reason : ''}${shortHash}`;
                }
                return `表情/互动区未变化，本轮不重复占上下文${reason ? ' · ' + reason : ''}${shortHash}`;
            };

            const profileInjectionText = Vue.computed(() => [
                describeProfileInjection(talk.profileInjection || talk.relayState?.profile_injection),
                describeDynamicContextInjection(talk.dynamicContextInjection || talk.relayState?.dynamic_context_injection),
            ].filter(Boolean).join(' ｜ '));

            const talkActiveSessionId = Vue.computed(() => {
                if (talkUsesApi()) return `api:${talkSettings.apiModel || 'model'}`;
                if (talkSettings.executionMode === 'terminal') return talk.terminalSession || '';
                return talk.relayState?.active_claude_session_id || activeConvo.value?.session_id || '';
            });

            const talkActiveSessionShort = Vue.computed(() => compactSessionId(talkActiveSessionId.value));

            const talkActiveTurnsText = Vue.computed(() => {
                if (talkUsesApi()) return 'API';
                if (talkSettings.executionMode === 'terminal') {
                    const s = talk.terminalRelayState || {};
                    const turns = Number(s.turns_since_relay || talk.terminalTurnsSinceRelay || 0) || 0;
                    const pct = Number(s.trigger_progress_pct || 0) || 0;
                    return pct ? `${turns}轮 · ${pct}%` : `${turns}轮`;
                }
                const s = talk.relayState || {};
                const turns = Number(s.turns_in_active_session || 0) || 0;
                const trigger = Number(s.trigger_turns || 0) || 0;
                const threshold = Number(s.threshold_turns || 0) || 0;
                return `${turns}/${trigger || threshold || 0}`;
            });

            const talkContextWindowPct = Vue.computed(() => {
                if (talkUsesApi()) return 0;
                if (talkSettings.executionMode === 'terminal') {
                    const s = talk.terminalRelayState || {};
                    return Math.min(100, Math.max(0, Number(s.context_progress_pct || s.trigger_progress_pct || s.tail_progress_pct || s.tail_trigger_progress_pct || 0) || 0));
                }
                const s = talk.relayState || {};
                const c = talk.relayContext || {};
                return Math.min(100, Math.max(0, Number(s.context_progress_pct || c.context_progress_pct || 0) || 0));
            });

            const talkContextWindowText = Vue.computed(() => {
                if (talkUsesApi()) return '由上游 API 管理';
                if (talkSettings.executionMode === 'terminal') {
                    const s = talk.terminalRelayState || {};
                    const used = Number(s.context_chars_since_relay || s.total_chars || s.estimated_context_chars || s.visible_context_chars || 0) || 0;
                    const trigger = Number(s.trigger_chars || 50000) || 50000;
                    const config = Number(s.overhead_chars || 0) || 0;
                    const diagnostic = Number(s.effective_total_chars || s.effective_chars || 0) || 0;
                    if (!used) return '等待同步';
                    return `${used.toLocaleString()} / ${trigger.toLocaleString()} 字 · 配置 ${config.toLocaleString()} · 诊断 ${diagnostic.toLocaleString()}`;
                }
                const s = talk.relayState || {};
                const c = talk.relayContext || {};
                const used = Number(s.estimated_context_chars || c.estimated_context_chars || 0) || 0;
                const windowChars = Number(s.context_window_chars || c.context_window_chars || 0) || 0;
                const triggerPct = Number(s.context_trigger_progress_pct || c.context_trigger_progress_pct || 0) || 0;
                if (!windowChars) return '等待同步';
                return `${formatContextChars(used)} / ${formatContextChars(windowChars)} · ${talkContextWindowPct.value}%（触发 ${triggerPct}%）`;
            });

            const talkAutoRelayText = Vue.computed(() => {
                if (talkUsesApi()) return 'API 大脑（Claude 已断开）';
                if (talkSettings.executionMode === 'terminal') {
                    const s = talk.terminalRelayState || {};
                    if (s.relay_pending) return '接力中';
                    if (s.relay_trigger) return '写摘要中';
                    return s.will_auto_relay_next_turn ? '下条接力' : '待命';
                }
                const s = talk.relayState || {};
                if (s.will_auto_relay_by_context) return '窗口接近触发线，下条会换新 session';
                return s.will_auto_relay_next_turn ? '下条会换新 session' : '自动接力待命';
            });

            const talkHasPendingPreview = Vue.computed(() => {
                const msgs = activeConvo.value?.messages || [];
                return msgs.some(m => m && m.role !== 'user' && m.preview && !m.done && !m.content);
            });

            const refreshTalkRelayState = async (c = activeConvo.value) => {
                if (talkUsesApi()) {
                    ++relayStateRequestSeq;
                    talk.relayStateLoading = false;
                    talk.relayState = null;
                    talk.relayContext = null;
                    return null;
                }
                if (!c?.id) { talk.relayState = null; talk.relayContext = null; return null; }
                const seq = ++relayStateRequestSeq;
                talk.relayStateLoading = true;
                talk.relayState = null;
                talk.relayContext = null;
                try {
                    const qs = new URLSearchParams({
                        auto_session_relay:String(talkSettings.autoSessionRelay !== false),
                        auto_session_relay_turns:String(talkSettings.autoSessionRelayTurns || 40),
                    });
                    const r = await fetch(`/api/conversations/${encodeURIComponent(c.id)}/state?${qs.toString()}`, { cache:'no-store' });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || j.ok === false) throw new Error(j.error || 'state failed');
                    if (seq !== relayStateRequestSeq) return null;
                    talk.relayState = j.relayState || null;
                    talk.relayContext = j.contextState || null;
                    const sid = j?.conversation?.active_claude_session_id || j?.latestSession?.claude_session_id || '';
                    if (sid) c.session_id = sid;
                    return j;
                } catch (_) {
                    return null;
                } finally {
                    talk.relayStateLoading = false;
                }
            };

            const extractTextFromClaudeContent = (content) => {
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) return content.map(b => typeof b === 'string' ? b : (b?.text || '')).join('');
                return '';
            };

            const applyClaudeStreamEvent = (obj, assistantMsg, convo) => {
                if (!obj) return;
                if (obj.type === 'resume_miss') {                           // 切回来时后端已经没缓存了（切太久/早结束）
                    if (assistantMsg) assistantMsg._resumeMiss = true;
                    return;
                }
                if (obj.type === 'resume_deferred_miss' || obj.code === 'resume_deferred_miss') {
                    if (assistantMsg) assistantMsg._resumeDeferredMiss = true;
                    if (convo) {
                        if (!obj.stale_session_id || convo.session_id === obj.stale_session_id) convo.session_id = '';
                        convo.force_new_session = true;
                    }
                    talk.sessionNotice = '旧 Claude Code session 已失效，正在自动换新 session 重发。';
                    return;
                }
                if (obj.type === 'session_route') {                          // 后端告知本轮真实 Claude Code session
                    if (obj.session_id && convo) convo.session_id = obj.session_id;
                    const profileInjection = obj.profile_injection && typeof obj.profile_injection === 'object' ? obj.profile_injection : null;
                    const dynamicContextInjection = obj.dynamic_context_injection && typeof obj.dynamic_context_injection === 'object' ? obj.dynamic_context_injection : null;
                    if (profileInjection) talk.profileInjection = profileInjection;
                    if (dynamicContextInjection) talk.dynamicContextInjection = dynamicContextInjection;
                    if (convo) {
                        const turns = Number(obj.relay_turns_in_active_session || talk.relayState?.turns_in_active_session || 0) || 0;
                        const threshold = Number(obj.relay_threshold_turns || talk.relayState?.threshold_turns || 0) || 0;
                        const trigger = Number(obj.relay_trigger_turns || talk.relayState?.trigger_turns || 0) || 0;
                        talk.relayState = {
                            ...(talk.relayState || {}),
                            conversation_id: convo.id,
                            active_claude_session_id: obj.session_id || convo.session_id || '',
                            turns_in_active_session: turns,
                            total_turns: Math.max(Number(talk.relayState?.total_turns || 0) || 0, turns),
                            threshold_turns: threshold,
                            trigger_turns: trigger,
                            trigger_ratio: Number(talk.relayState?.trigger_ratio || 0.75) || 0.75,
                            progress_pct: threshold ? Math.min(100, Math.round((turns / threshold) * 100)) : 0,
                            trigger_progress_pct: trigger ? Math.min(100, Math.round((turns / trigger) * 100)) : 0,
                            estimated_context_chars: Number(obj.estimated_context_chars || talk.relayState?.estimated_context_chars || 0) || 0,
                            context_window_chars: Number(obj.context_window_chars || talk.relayState?.context_window_chars || 0) || 0,
                            context_trigger_chars: Number(obj.context_trigger_chars || talk.relayState?.context_trigger_chars || 0) || 0,
                            context_progress_pct: Number(obj.context_progress_pct || talk.relayState?.context_progress_pct || 0) || 0,
                            context_trigger_progress_pct: Number(obj.context_trigger_progress_pct || talk.relayState?.context_trigger_progress_pct || 0) || 0,
                            will_auto_relay_by_context: Boolean(Number(obj.context_trigger_progress_pct || 0) >= 100 || talk.relayState?.will_auto_relay_by_context),
                            will_auto_relay_next_turn: !!obj.automatic_relay,
                            last_relay_reason: obj.relay_reason || talk.relayState?.last_relay_reason || '',
                            profile_injection: profileInjection || talk.relayState?.profile_injection || null,
                            dynamic_context_injection: dynamicContextInjection || talk.relayState?.dynamic_context_injection || null,
                        };
                    }
                    if (obj.new_session && convo) {
                        convo.sessionRelayAnchorTurns = countTalkUserTurns(convo);
                        convo.force_new_session = false;
                        const profileText = describeProfileInjection(profileInjection);
                        const suffix = profileText ? ` · ${profileText}` : '';
                        talk.sessionNotice = obj.automatic_relay
                            ? '后端已自动切到新的 Claude Code session，并注入前端资料/最近聊天。' + suffix
                            : (obj.forced
                            ? '已手动切到新的 Claude Code session，并注入前端资料/最近聊天。' + suffix
                            : '已创建新的 Claude Code session，并注入前端资料/最近聊天。' + suffix);
                    } else if (obj.forced && convo) convo.force_new_session = false;
                    return;
                }
                if (obj.type === 'quota_warning') {                         // 后端 -p 月度额度到阈值($18)
                    if (convo && !convo._quotaWarned) {                     // 每个对话只自动提醒+存交接一次
                        convo._quotaWarned = true;
                        terminalResume.sessionId = obj.session_id || terminalResume.sessionId;
                        try { writeTerminalHandoff(); } catch (_) {}        // 自动把交接摘要存到 VPS handoffs/
                        const cmd = obj.resume_command || (obj.session_id ? `claude --resume ${obj.session_id}` : 'claude --continue');
                        const used = Number(obj.used_usd || 0).toFixed(2);
                        talk.sessionNotice = `本月 -p 额度 $${used}/$${obj.budget_usd || 20} 快满了。已自动存好交接——去「终端」跑 ${cmd} 续聊（上下文在；实际额度/缓存以 Claude Code 服务端为准）。`;
                        talk.quotaBanner = { show:true, text:`本月 -p 额度 $${used}/$${obj.budget_usd || 20} 快满了，已自动存好交接。可去「+ → 会话工具」打开 Terminal 续聊。` };
                    }
                    return;
                }
                // Claude Code Agent SDK partial messages: { type:'stream_event', event:{...}, session_id }
                const ev = obj.event || obj;
                const streamError = obj.error?.message || obj.error || (obj.type === 'error' ? obj.message : '');
                if (streamError) assistantMsg.streamError = String(streamError);
                if (obj.session_id && convo) convo.session_id = obj.session_id;
                if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id && convo) convo.session_id = obj.session_id;
                if (obj.type === 'assistant' && obj.message?.content) {
                    const t = extractTextFromClaudeContent(obj.message.content);
                    if (t && !assistantMsg.content.includes(t)) assistantMsg.content += t;
                }
                if (obj.type === 'result') {
                    if (obj.session_id && convo) convo.session_id = obj.session_id;
                    if (obj.is_error) assistantMsg.streamError = String(obj.result || obj.error || 'Claude Agent 请求失败');
                    else if (obj.result && !assistantMsg.content) assistantMsg.content = String(obj.result);
                    assistantMsg.done = true;
                }
                if (ev.type === 'content_block_delta') {
                    const d = ev.delta || {};
                    if (d.type === 'text_delta' && d.text) assistantMsg.content += d.text;
                    if ((d.type === 'thinking_delta' && d.thinking) || d.type === 'signature_delta') {
                        if (d.thinking) assistantMsg.thinking = (assistantMsg.thinking || '') + d.thinking;
                    }
                    if (d.type === 'input_json_delta' && d.partial_json) {
                        assistantMsg.toolText = (assistantMsg.toolText || '') + d.partial_json;
                    }
                }
                if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
                    const name = ev.content_block.name || 'tool';
                    assistantMsg.toolUses = Array.isArray(assistantMsg.toolUses) ? assistantMsg.toolUses : [];
                    assistantMsg.toolUses.push({ id: ev.content_block.id || '', name, time: nowHM() });
                    return;
                }
                if (ev.type === 'message_delta' && ev.usage) assistantMsg.usage = ev.usage;
                if (ev.type === 'message_stop' || ev.type === 'content_block_stop') assistantMsg.done = true;
            };
            // —— 切屏不丢回复：续传协调 ——
            // 后端断开不杀进程、缓存整条回复；前端把"进行中的流"记到 localStorage，切回来/重载后用 /resume 续传。

            const RESUME_KEY = 'rifugio-pending-stream';
            const TERMINAL_RESUME_KEY = 'rifugio-pending-terminal-turn';

            const RESUME_ENDPOINT = CLAUDE_AGENT_ENDPOINT.replace(/\/stream\/?$/, '/stream/resume');
            const setPendingTerminalTurn = (p) => { try { p ? localStorage.setItem(TERMINAL_RESUME_KEY, JSON.stringify(p)) : localStorage.removeItem(TERMINAL_RESUME_KEY); } catch (_) {} };
            const getPendingTerminalTurn = () => { try { return JSON.parse(localStorage.getItem(TERMINAL_RESUME_KEY) || 'null'); } catch (_) { return null; } };
            let terminalResumePromise = null;

            const setPendingStream = (p) => { try { p ? localStorage.setItem(RESUME_KEY, JSON.stringify(p)) : localStorage.removeItem(RESUME_KEY); } catch (_) {} };

            const getPendingStream = () => { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch (_) { return null; } };

            let streamAbort = null;       // 当前进行中的本地流的 AbortController

            let lastChunkAt = 0;          // 最近一次收到数据的时间（卡死看门狗用）

            let staleTimer = null;

            let resumePromise = null;     // 正在进行的续传（多处触发时共享同一个）

            const STREAM_STALE_RESUME_MS = 12 * 60 * 1000;

            const STREAM_SILENCE_NOTE_MS = 2 * 60 * 1000;

            const stopStaleWatch = () => { if (staleTimer) { clearInterval(staleTimer); staleTimer = null; } };

            const startStaleWatch = () => {
                stopStaleWatch();
                let notedLongSilence = false;
                staleTimer = setInterval(() => {
                    if (!talk.thinking) { stopStaleWatch(); return; }
                    const silentFor = lastChunkAt ? Date.now() - lastChunkAt : 0;
                    if (!notedLongSilence && silentFor > STREAM_SILENCE_NOTE_MS) {
                        notedLongSilence = true;
                        talk.sessionNotice = 'Claude 可能正在跑长工具调用，我会继续等，不会马上截断。';
                    }
                    if (lastChunkAt && silentFor > STREAM_STALE_RESUME_MS) {
                        stopStaleWatch();
                        try { streamAbort && streamAbort.abort(); } catch (_) {}
                    }
                }, 5000);
            };

            const streamClaudeLikeResponse = async (response, assistantMsg, convo, markPending = false) => {
                const reader = response.body?.getReader?.();
                if (!reader) {
                    const j = await response.json();
                    applyClaudeStreamEvent(j, assistantMsg, convo);
                    updateCallVoicePipeline(assistantMsg.content);
                    if (assistantMsg.streamError) throw new Error(assistantMsg.streamError);
                    return;
                }
                const decoder = new TextDecoder();
                let buffer = '', pendingMarked = false;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    lastChunkAt = Date.now();
                    buffer += decoder.decode(value, { stream: true });
                    const parts = buffer.split(/\r?\n/);
                    buffer = parts.pop() || '';
                    for (let line of parts) {
                        line = line.trim();
                        if (!line || line === 'data: [DONE]') continue;
                        if (line.startsWith('event:')) continue;
                        if (line.startsWith('data:')) line = line.slice(5).trim();
                        try {
                            applyClaudeStreamEvent(JSON.parse(line), assistantMsg, convo);
                            updateCallVoicePipeline(assistantMsg.content);
                        } catch (_) { /* ignore heartbeat / partial line */ }
                    }
                    // 续传只按 conversation_id 找后端活跃流；Claude session id 留在后端管理。
                    if (markPending && !pendingMarked && convo?.id) {
                        setPendingStream({ convoId: convo.id, assistantMsgId: assistantMsg.id, startedAt: Date.now() });
                        pendingMarked = true;
                    }
                    saveTalk(); scrollTalkBottom();
                }
                if (buffer.trim()) {
                    let line = buffer.trim(); if (line.startsWith('data:')) line = line.slice(5).trim();
                    try {
                        applyClaudeStreamEvent(JSON.parse(line), assistantMsg, convo);
                        updateCallVoicePipeline(assistantMsg.content);
                    } catch(_) {}
                }
                if (assistantMsg.streamError) throw new Error(assistantMsg.streamError);
            };
            // 续传：重连后端缓存的那条生成，从头回放+跟随直到结束。返回 true=已接管收尾（不要再报错）。

            const resumeInFlight = () => {
                if (resumePromise) return resumePromise;
                const p = getPendingStream();
                if (!p || !(p.convoId || p.sid)) return Promise.resolve(false);
                if (p.startedAt && Date.now() - p.startedAt > 6 * 60 * 1000) { setPendingStream(null); return Promise.resolve(false); }
                resumePromise = (async () => {
                    const c = talk.convos.find(x => x.id === p.convoId);
                    if (!c) return false;
                    let assistantMsg = c.messages.find(m => m.id === p.assistantMsgId);
                    if (!assistantMsg) {
                        assistantMsg = { id:p.assistantMsgId, role:'assistant', content:'', thinking:'', thinkingOpen:false, time:nowHM(), model:c.model, preview:true, done:false };
                        c.messages.push(assistantMsg);
                    }
                    talk.thinking = true; talk.error = '';
                    try {
                        const qs = new URLSearchParams();
                        if (p.convoId) qs.set('conversation_id', p.convoId);
                        else qs.set('session_id', p.sid);
                        const r = await fetch(`${RESUME_ENDPOINT}?${qs.toString()}`, { cache:'no-store' });
                        if (!r.ok) throw new Error('resume HTTP ' + r.status);
                        assistantMsg.content = ''; assistantMsg.thinking = ''; assistantMsg.streamError = ''; assistantMsg._resumeMiss = false;
                        startStaleWatch();
                        await streamClaudeLikeResponse(r, assistantMsg, c, false);
                        if (assistantMsg._resumeMiss) {
                            const age = Date.now() - Number(p.startedAt || Date.now());
                            if (age < 45000) {
                                // 请求刚送达时后端缓存可能尚未登记；不能把这个短暂空窗误报成 load failed。
                                assistantMsg._resumeMiss = false;
                                assistantMsg.preview = true;
                                assistantMsg.done = false;
                                talk.sessionNotice = '消息已经送出，正在重新接回回复…';
                                if (document.visibilityState === 'visible') setTimeout(maybeResume, 1400);
                                return false;
                            }
                            if (!assistantMsg.content) {
                                const idx = c.messages.findIndex(m => m.id === assistantMsg.id);
                                if (idx >= 0 && !assistantMsg.thinking) c.messages.splice(idx, 1);
                                const lastU = [...c.messages].reverse().find(x => x.role === 'user');
                                if (lastU) lastU.failed = true;
                                talk.error = '刚才那条回复没能接回来，点一下重新发送即可。';
                            }
                            setPendingStream(null);
                            saveTalk(); safePushConvoFull(c);
                            return false;
                        }
                        if (!assistantMsg.content) assistantMsg.content = '（空回复）';
                        assistantMsg.preview = false;
                        assistantMsg.done = true;
                        talk.thinking = false;
                        stopStaleWatch();
                        setPendingStream(null);
                        saveTalk(); pushConvo(c); scrollTalkBottom(); playTalkNotification(); showTalkToast(assistantMsg, c);
                        await synthesizeAssistantVoice(assistantMsg, c);
                        return true;
                    } catch (e) {
                        // 网络仍在切换时保留 pending，回前台/联网后继续接，不把已送达的消息标成失败。
                        talk.sessionNotice = '连接正在恢复，消息不会重复发送。';
                        return false;
                    } finally {
                        stopStaleWatch(); talk.thinking = false; saveTalk();
                    }
                })().finally(() => { resumePromise = null; });
                return resumePromise;
            };
            // 切回前台 / 重新联网 / 整页重载：如果还有进行中的流，就接回来

            const maybeResume = () => {
                const p = getPendingStream();
                if (!p || resumePromise) return;
                // 本地流还活着且仍在正常流动（如桌面切标签页）→ 别打扰
                if (talk.thinking && streamAbort && lastChunkAt && (Date.now() - lastChunkAt < 8000)) return;
                if (streamAbort) { try { streamAbort.abort(); } catch (_) {} streamAbort = null; }
                resumeInFlight();
            };
            // 切回前台 / 重新联网 / 整页重载(含 PWA 被系统杀掉重开) → 有进行中的流就接回来
            const resumePendingResponses = () => {
                maybeResume();
                if (getPendingTerminalTurn()) resumeTalkTerminalTurn();
            };
            document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(resumePendingResponses, 300); });
            window.addEventListener('online', () => setTimeout(resumePendingResponses, 400));
            window.addEventListener('pageshow', () => setTimeout(resumePendingResponses, 400));
            setTimeout(resumePendingResponses, 1200);   // 首次加载：等对话从库里拉回来后探一次

            const formatClaudeAgentFailure = (status, detail='') => {
                const raw = String(detail || '');
                const isHtml = /<!doctype|<html|<head|<body/i.test(raw);
                const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (status === 429 || /quota|usage limit|monthly limit|rate.?limit|额度|限额|用完/i.test(text)) {
                    return 'Claude Agent 月度额度已用完，请等待额度重置。请求已停止，未切换到 Anthropic 按量付费 API。';
                }
                if (status === 401 || status === 403 || /not logged|login|oauth|unauthorized|forbidden|未登录/i.test(text)) {
                    return 'VPS 上的 Claude Pro 登录已失效，请重新登录 Claude Code。请求已停止，未切换到按量付费 API。';
                }
                return `Claude Agent 连接失败${status ? `（HTTP ${status}）` : ''}${text && !isHtml ? `：${text.slice(0,180)}` : ''}`;
            };

            const talkApiJson = async (url, options = {}) => {
                if (typeof ctx.apiJson === 'function') return ctx.apiJson(url, options);
                const hasBody = options.body !== undefined;
                const r = await fetch(url, {
                    credentials:'include',
                    ...options,
                    headers:{
                        ...(hasBody ? { 'Content-Type':'application/json' } : {}),
                        ...(options.headers || {}),
                    },
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok || j.ok === false) {
                    const err = new Error(j.error || `HTTP ${r.status}`);
                    err.status = r.status;
                    err.data = j;
                    throw err;
                }
                return j;
            };

            const refreshTalkTerminalStatus = async (c = activeConvo.value) => {
                if (talkUsesApi()) {
                    talk.terminalStatusLoading = false;
                    talk.terminalStatusError = '';
                    return null;
                }
                talk.terminalStatusLoading = true;
                talk.terminalStatusError = '';
                try {
                    const q = encodeURIComponent(c?.id || 'terminal-chat');
                    const j = await talkApiJson(`/api/terminal-chat/status?conversation_id=${q}`);
                    talk.terminalSession = j.session || talk.terminalSession;
                    talk.terminalStatus = j.exists ? 'Terminal Claude Code 会话在线' : 'Terminal Claude Code 会话尚未启动';
                    talk.terminalRelayIndex = Number(j.relay_index || 0);
                    talk.terminalTurnsSinceRelay = Number(j.turns_since_relay || 0);
                    talk.terminalRelayState = j.relay_state || null;
                    talk.terminalHandoffState = j.handoff || null;
                    talk.terminalPermission = j.permission || null;
                    talk.terminalStatusUpdatedAt = new Date().toISOString();
                    return j;
                } catch (e) {
                    talk.terminalStatusError = e.status === 401 ? '需要先完成 Terminal 本机验证，才能查看高权限会话详情。' : (e.message || 'Terminal 状态检查失败');
                    talk.terminalStatus = talk.terminalStatusError;
                    return null;
                } finally {
                    talk.terminalStatusLoading = false;
                }
            };

            const setTalkExecutionMode = async (mode) => {
                const next = mode === 'terminal' ? 'terminal' : 'agent';
                if (next === 'terminal') {
                    talk.sessionNotice = '正在打开 Terminal Claude Code 模式，需要通过终端验证。';
                    const ok = typeof ctx.unlockTerminalWithPasskey === 'function' ? await ctx.unlockTerminalWithPasskey({ probe:false }) : true;
                    if (!ok) {
                        talk.error = 'Terminal Claude Code 需要先通过终端验证；当前仍停留在 -p。';
                        talk.sessionNotice = 'Terminal 模式未开启：终端验证没有完成。';
                        talkSettings.executionMode = 'agent';
                        talkSettings.claudeExecutionMode = 'agent';
                        saveTalkSettings();
                        return false;
                    }
                    talkSettings.provider = 'claude-code';
                    talkSettings.executionMode = 'terminal';
                    talkSettings.claudeExecutionMode = 'terminal';
                    talk.terminalStatusPanelOpen = true;
                    talk.error = '';
                    talk.sessionNotice = '已切到 Terminal Claude Code；下条消息会走高权限终端。';
                    await refreshTalkTerminalStatus(activeConvo.value);
                } else {
                    talkSettings.executionMode = 'agent';
                    talkSettings.claudeExecutionMode = 'agent';
                    talk.error = '';
                    talk.sessionNotice = '已切回 -p 低权限对话。';
                }
                saveTalkSettings();
                return true;
            };

            const forceTalkTerminalRelayNext = () => {
                talk.terminalForceRelayNext = true;
                talk.sessionNotice = '下条 Terminal 模式消息会接力到新的交互式终端 session。';
            };

            const setTalkTerminalStatuses = (statuses, assistantMsg = null) => {
                const clean = (Array.isArray(statuses) ? statuses : [])
                    .map(s => ({ type:s.type || 'info', label:s.label || '' }))
                    .filter(s => s.label);
                talk.terminalStatuses.splice(0, talk.terminalStatuses.length, ...clean);
                if (assistantMsg) assistantMsg.statuses = clean;
                if (clean.length) talk.terminalStatus = clean.map(s => s.label).join(' · ');
            };

            const applyTalkTerminalEvent = (evt, assistantMsg, convo) => {
                if (!evt || !assistantMsg) return;
                assistantMsg.engine = 'terminal';
                assistantMsg.model = 'Terminal Claude Code';
                if (evt.type === 'terminal_relay') {
                    talk.terminalSession = evt.session || talk.terminalSession;
                    talk.terminalRelayIndex = Number(evt.relay_index || talk.terminalRelayIndex || 0);
                    talk.terminalTurnsSinceRelay = 0;
                    talk.terminalRelayState = evt.relay_state || talk.terminalRelayState;
                    talk.terminalForceRelayNext = false;
                    talk.terminalStatus = '已接力到新的 Terminal Claude Code 会话：' + (evt.reason || 'relay');
                    setTalkTerminalStatuses([{ type:'tool', label:'Terminal 已接力' }], assistantMsg);
                } else if (evt.type === 'terminal_route') {
                    talk.terminalSession = evt.session || talk.terminalSession;
                    if (convo) convo.terminal_session = talk.terminalSession;
                    talk.terminalRelayIndex = Number(evt.relay_index || talk.terminalRelayIndex || 0);
	                    talk.terminalTurnsSinceRelay = Number(evt.turns_since_relay || talk.terminalTurnsSinceRelay || 0);
	                    talk.terminalRelayState = evt.relay_state || talk.terminalRelayState;
	                    talk.terminalStatus = evt.bootstrapping ? '正在把前端资料/最近上下文带入 Terminal…' : 'Terminal Claude Code 已接上。';
	                    setTalkTerminalStatuses([{ type:'thinking', label:talk.terminalStatus }], assistantMsg);
                } else if (evt.type === 'terminal_status') {
                    setTalkTerminalStatuses(evt.statuses, assistantMsg);
                } else if (evt.type === 'terminal_model') {
                    const label = evt.applied ? `模型已切换：${evt.model}` : `模型切换未确认，将在下轮重试：${evt.model}`;
                    talk.terminalStatus = label;
                    setTalkTerminalStatuses([{ type:evt.applied ? 'info' : 'permission', label }], assistantMsg);
                } else if (evt.type === 'terminal_permission_request') {
                    talk.terminalPermission = {
                        id:evt.id || '',
                        prompt:evt.prompt || 'Claude Code 正在等待权限确认。',
                        actions:Array.isArray(evt.actions) ? evt.actions : [],
                        conversation_id:convo?.id || 'terminal-chat',
                    };
                    talk.terminalPermissionStatus = '等待你确认 Terminal 权限';
                    talk.terminalStatus = 'Terminal 正在等待权限确认';
                    setTalkTerminalStatuses([{ type:'permission', label:'等待权限确认' }], assistantMsg);
                } else if (evt.type === 'terminal_thinking') {
                    assistantMsg.thinking = String(evt.text || '').trim();
                    assistantMsg.thinkingOpen = assistantMsg.thinkingOpen || false;
                    if (assistantMsg.thinking) {
                        talk.terminalStatus = '✓✓ Terminal transcript 💭碎碎念';
                        setTalkTerminalStatuses([{ type:'thinking', label:'💭碎碎念已同步' }], assistantMsg);
                    }
                } else if (evt.type === 'terminal_preview') {
                    assistantMsg.content = evt.text || assistantMsg.content;
                    assistantMsg.preview = true;
                    // 只有本轮 Claude JSONL transcript 才能进入实时 TTS。
                    // tmux pane fallback 可能在终端重绘时夹带历史回复或用户输入，只用于画面兜底。
                    if (evt.source === 'transcript') updateCallVoicePipeline(assistantMsg.content);
                } else if (evt.type === 'terminal_final') {
                    assistantMsg.content = evt.text || assistantMsg.content || '（Terminal transcript 没有捕获到干净最终回复；请展开原始终端查看。）';
                    // transcript final 可继续流式收尾；pane fallback 由 sendCallTurn 在最终确认后一次性 finish，
                    // 不允许它在事件阶段抢先污染 WSS。
                    if (evt.transcript === true) updateCallVoicePipeline(assistantMsg.content);
                    assistantMsg.preview = false;
                    assistantMsg.done = true;
                    talk.terminalStatus = evt.interrupted ? '本轮工具调用被拒绝/中断，已收口' : (evt.transcript ? '✓✓ Terminal transcript' : (evt.pane_fallback ? 'transcript 未捕获，已用原始终端可见回复兜底' : 'transcript 未捕获最终回复，请查看原始终端'));
                    talk.terminalSession = evt.session || talk.terminalSession;
                    talk.terminalRelayIndex = Number(evt.relay_index || talk.terminalRelayIndex || 0);
                    talk.terminalTurnsSinceRelay = Number(evt.turns_since_relay || talk.terminalTurnsSinceRelay || 0);
                    talk.terminalRelayState = evt.relay_state || talk.terminalRelayState;
                    talk.terminalForceRelayNext = false;
                    talk.terminalPermission = null;
                    talk.terminalPermissionStatus = '';
                    talk.terminalStatuses.splice(0);
                } else if (evt.type === 'error') {
                    assistantMsg.content = 'Terminal Claude Code 出错：' + (evt.error || evt.message || 'unknown error');
                    assistantMsg.preview = false;
                    assistantMsg.error = true;
                    talk.terminalStatus = assistantMsg.content;
                }
            };

            const resumeTalkTerminalTurn = () => {
                if (terminalResumePromise) return terminalResumePromise;
                const pending = getPendingTerminalTurn();
                if (!pending?.convoId) return Promise.resolve(false);
                terminalResumePromise = (async () => {
                    const c = talk.convos.find(x => x.id === pending.convoId);
                    if (!c) return false;
                    let assistantMsg = c.messages.find(m => String(m.id) === String(pending.assistantMsgId));
                    if (!assistantMsg) {
                        assistantMsg = { id:pending.assistantMsgId, role:'assistant', content:'', thinking:'', thinkingOpen:false, time:nowHM(), model:'Terminal Claude Code', engine:'terminal', statuses:[], preview:true, done:false };
                        c.messages.push(assistantMsg);
                    }
                    const qs = new URLSearchParams({ conversation_id:pending.convoId });
                    if (pending.turnId) qs.set('turn_id', pending.turnId);
                    try {
                        const r = await fetch('/api/terminal-chat/resume?' + qs.toString(), { credentials:'include', cache:'no-store' });
                        if (r.status === 404) {
                            if (Date.now() - Number(pending.startedAt || 0) < 45000) {
                                talk.sessionNotice = '消息已经送出，正在等待 Terminal 建立续接点…';
                                if (document.visibilityState === 'visible') setTimeout(resumeTalkTerminalTurn, 1400);
                                return false;
                            }
                            // The turn cache is intentionally in memory. A backend restart can
                            // remove it after the visible reply was already streamed to this
                            // bubble. Reconcile locally instead of leaving talk.thinking stuck.
                            const hadVisibleReply = Boolean(String(assistantMsg.content || '').trim());
                            assistantMsg.content = assistantMsg.content || '本轮续接点已经失效，请重新发送这条消息。';
                            assistantMsg.preview = false;
                            assistantMsg.done = true;
                            assistantMsg.pendingReconnect = false;
                            assistantMsg.error = !hadVisibleReply;
                            setPendingTerminalTurn(null);
                            talk.thinking = false;
                            talk.terminalStatuses.splice(0);
                            talk.error = '';
                            talk.sessionNotice = hadVisibleReply
                                ? '后端续接点已重建；已收到的回复已正常收口。'
                                : '后端续接点已失效，请重新发送本条消息。';
                            saveTalk();
                            pushConvo(c).then(() => refreshTalkTerminalStatus(c));
                            scrollTalkBottom();
                            return hadVisibleReply;
                        }
                        const j = await r.json().catch(() => ({}));
                        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                        pending.turnId = j.turn_id || pending.turnId || '';
                        setPendingTerminalTurn(pending);
                        window.Rifugio.applyTerminalTurnSnapshot(j, assistantMsg, evt => applyTalkTerminalEvent(evt, assistantMsg, c));
                        saveTalk(); scrollTalkBottom();
                        if (!j.done) {
                            talk.thinking = true;
                            talk.sessionNotice = 'Terminal 仍在运行，回复已重新接上。';
                            if (document.visibilityState === 'visible') setTimeout(resumeTalkTerminalTurn, 1100);
                            return false;
                        }
                        setPendingTerminalTurn(null);
                        assistantMsg.preview = false;
                        assistantMsg.done = true;
                        assistantMsg.pendingReconnect = false;
                        talk.thinking = false;
                        talk.error = '';
                        saveTalk(); pushConvo(c).then(() => refreshTalkTerminalStatus(c));
                        scrollTalkBottom(); playTalkNotification(); showTalkToast(assistantMsg, c);
                        await synthesizeAssistantVoice(assistantMsg, c);
                        return true;
                    } catch (e) {
                        talk.sessionNotice = 'Terminal 回复正在后台继续，联网后会自动接回。';
                        return false;
                    }
                })().finally(() => { terminalResumePromise = null; });
                return terminalResumePromise;
            };

            const respondTalkTerminalPermission = async (action) => {
                const c = activeConvo.value;
                const permission = talk.terminalPermission;
                if (!permission || talk.terminalPermissionBusy) return;
                const conversationId = permission.conversation_id || c?.id || 'terminal-chat';
                talk.terminalPermissionBusy = true;
                talk.terminalPermissionStatus = '正在把选择送回 Terminal…';
                // 立即收起卡片并锁住重复点击；请求失败时再原样恢复。
                talk.terminalPermission = null;
                const actionMeta = (permission.actions || []).find(a => a.id === action) || {};
                const isDeny = action === 'deny' || action === 'esc' || actionMeta.role === 'deny';
                try {
                    const r = await fetch('/api/terminal-chat/permission', {
                        method:'POST',
                        credentials:'include',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ conversation_id:conversationId, action, permission_id:permission.id || '' }),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (r.status === 409) {
                        // 弹窗内容已变（新的权限请求顶上来了）：恢复卡片等下一条 permission_request 事件刷新，别按错。
                        talk.terminalPermission = permission;
                        talk.terminalPermissionStatus = '权限弹窗已更新，请按最新内容重新选择';
                        return;
                    }
                    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                    // 别无条件报"已批准"——后端 cleared 会如实说明弹窗是否真的消失（bug#16：按错键时前端谎报批准成功）。
                    const doneText = isDeny
                        ? (j.cleared === false ? '拒绝已发送，等待 Terminal 确认…' : '已拒绝权限请求')
                        : (j.cleared === false ? '选择已发送，但弹窗似乎还在——请稍等或去原始终端确认' : '已允许，Claude 会继续执行');
                    talk.terminalPermissionStatus = doneText;
                    talk.sessionNotice = doneText;
                    appendTalkSystemMessage(
                        isDeny ? '已拒绝本次 Terminal 权限请求。'
                        : (j.cleared === false ? '权限选择已发送（未确认弹窗关闭，请留意原始终端）。' : '已批准本次 Terminal 权限请求。'),
                        { kind:'permission' });
                    setTimeout(() => {
                        if (talk.terminalPermissionStatus === doneText) talk.terminalPermissionStatus = '';
                    }, 1800);
                    refreshTalkTerminalStatus(c);
                } catch(e) {
                    if (!talk.terminalPermission) talk.terminalPermission = permission;
                    talk.terminalPermissionStatus = '权限回传失败：' + (e.message || 'unknown');
                } finally {
                    talk.terminalPermissionBusy = false;
                }
            };

            const sendTalkViaTerminal = async (prompt, assistantMsg, convo, images = []) => {
                const ok = typeof ctx.unlockTerminalWithPasskey === 'function' ? await ctx.unlockTerminalWithPasskey({ probe:false }) : true;
                if (!ok) {
                    const err = new Error('Terminal Claude Code 需要先通过终端验证。');
                    err.status = 401;
                    throw err;
                }
                assistantMsg.engine = 'terminal';
                assistantMsg.model = 'Terminal Claude Code';
                assistantMsg.preview = true;
                assistantMsg.done = false;
                setTalkTerminalStatuses([{ type:'thinking', label:'正在送进 Terminal Claude Code…' }], assistantMsg);
                const pending = { convoId:convo?.id || 'terminal-chat', assistantMsgId:assistantMsg.id, turnId:'', startedAt:Date.now() };
                setPendingTerminalTurn(pending);
                const terminalAbort = new AbortController();
                let terminalLastChunkAt = Date.now();
                const terminalStaleTimer = setInterval(() => {
                    if (Date.now() - terminalLastChunkAt > 15 * 60 * 1000) terminalAbort.abort();
                }, 5000);
                try {
                    const r = await fetch('/api/terminal-chat/send', {
                        method:'POST',
                        credentials:'include',
                        headers:{ 'Content-Type':'application/json' },
                        signal:terminalAbort.signal,
                        body:JSON.stringify({
                            prompt,
                            conversation_id:convo?.id || 'terminal-chat',
                            system_prompt:buildTalkContext(),
                            character_prompt:buildTalkCharacterPrompt(convo),
                            bootstrap_context:'',
                            force_relay:!!talk.terminalForceRelayNext,
                            images:Array.isArray(images) ? images : [],
                            model:talkSettings.claudeModel || convo?.model || 'default',
                            effort:talkSettings.claudeEffort || 'medium',
                        }),
                    });
                    if (!r.ok || !r.body) {
                        const detail = await r.text().catch(() => '');
                        setPendingTerminalTurn(null);
                        const msg = r.status === 401 || r.status === 403
                            ? 'Terminal Claude Code 需要先完成终端验证。'
                            : `Terminal Claude Code 连接失败（HTTP ${r.status}）${detail ? '：' + detail.slice(0, 160) : ''}`;
                        const err = new Error(msg); err.status = r.status; throw err;
                    }
                    const reader = r.body.getReader();
                    const decoder = new TextDecoder();
                    let buf = '';
                    try {
                        while (true) {
                            const { value, done } = await reader.read();
                            if (done) break;
                            terminalLastChunkAt = Date.now();
                            buf += decoder.decode(value, { stream:true });
                            const chunks = buf.split(/\n\n/);
                            buf = chunks.pop() || '';
                            for (const chunk of chunks) {
                                const lines = chunk.split(/\n/).filter(x => x.startsWith('data:'));
                                for (const line of lines) {
                                    const data = line.replace(/^data:\s*/, '');
                                    if (!data || data === '[DONE]') continue;
                                    try {
                                        const evt = JSON.parse(data);
                                        if (evt.turn_id) { pending.turnId = evt.turn_id; setPendingTerminalTurn(pending); }
                                        applyTalkTerminalEvent(evt, assistantMsg, convo);
                                    } catch (_) {}
                                    saveTalk(); scrollTalkBottom();
                                }
                            }
                        }
                    } catch (_) {
                        // App 切后台时 reader 常被系统掐掉；后端仍继续跑，下面改走缓存续接。
                    }
                    if (assistantMsg.done) {
                        setPendingTerminalTurn(null);
                        assistantMsg.preview = false;
                        return true;
                    }
                    assistantMsg.pendingReconnect = true;
                    talk.sessionNotice = '消息已经送出，正在重新接回 Terminal 回复…';
                    await resumeTalkTerminalTurn();
                    return Boolean(assistantMsg.done);
                } catch (e) {
                    if (e?.status) throw e;
                    assistantMsg.pendingReconnect = true;
                    assistantMsg.preview = true;
                    talk.error = '';
                    talk.sessionNotice = '消息已经送出，Terminal 会在后台继续。';
                    if (document.visibilityState === 'visible') setTimeout(resumeTalkTerminalTurn, 700);
                    return false;
                } finally {
                    clearInterval(terminalStaleTimer);
                }
            };

            const sendTalkMessage = async (text, attachments=[], internalRetry = {}) => {
                const retryInfo = internalRetry && typeof internalRetry === 'object' ? internalRetry : {};
                const extraInstruction = String(retryInfo.extraInstruction || '').trim();
                const displayText = String(retryInfo.displayText || text || '').trim();
                text = String(text || '').trim();
                attachments = (attachments || []).map(a => ({ ...a }));
                if ((!text && !attachments.length) || talk.thinking) return null;
                let c = activeConvo.value;
                if (!c) { newTalk(); c = activeConvo.value; }
                const selectedProvider = String(talkSettings.provider || 'claude-code');
                const isApiProvider = selectedProvider === 'openai-compatible';
                const isTerminalMode = !isApiProvider && talkSettings.executionMode === 'terminal';
                const responseEngine = isApiProvider ? 'api' : (isTerminalMode ? 'terminal' : 'agent');
                const shareText = socialShareCopyFromText(displayText || text);
                const socialCards = socialLinksFromText(displayText || text).map(item => socialPlaceholder({ ...item, shareText }));
                const storedContent = socialCards.length ? stripSocialLinksForDisplay(displayText || text) : (displayText || text);
                const userMsg = { id:Date.now(), role:'user', content:storedContent, attachments, ...(socialCards.length ? { socialCards, socialSourceText:displayText || text } : {}), time:nowHM(), engine:responseEngine };
                c.messages.push(userMsg);
                if (c.name === '新对话' && c.messages.filter(m => m.role === 'user').length === 1) {
                    const seed = storedContent || shareText || (socialCards[0]?.platform === 'xhs' ? '小红书分享' : (socialCards.length ? 'X 分享' : '')) || attachments[0]?.name || '图片对话';
                    c.name = seed.slice(0, 18) + (seed.length > 18 ? '…' : '');
                }
                const assistantMsg = {
                    id:Date.now()+1,
                    role:'assistant',
                    content:'',
                    thinking:'',
                    thinkingOpen:false,
                    time:nowHM(),
                    model:isApiProvider ? (talkSettings.apiModel || 'API') : (isTerminalMode ? 'Terminal Claude Code' : (talkSettings.claudeModel || c.model)),
                    engine:responseEngine,
                    statuses:[],
                    preview:isTerminalMode,
                    done:false,
                };
                talk.error = ''; talk.thinking = true;
                saveTalk(); pushConvo(c); scrollTalkBottom();
                try {
                    if (socialCards.length) {
                        userMsg.socialCards = await hydrateSocialCards(socialCards);
                        saveTalk(); await pushConvo(c); scrollTalkBottom();
                    }
                    const modelText = socialCards.length ? stripSocialLinksForDisplay(text) : text;
                    const promptParts = [promptWithAttachments(modelText, attachments) || '请自然回应我分享的内容。'];
                    const socialContext = socialCardsPrompt(userMsg.socialCards || []);
                    if (socialContext) promptParts.push(socialContext);
                    if (talkSettings.timestampUserMessages !== false) promptParts.unshift(`[time: ${nowForModel()}]`);
                    if (extraInstruction) promptParts.push(`【前端附加指令】${extraInstruction}`);
                    const prompt = promptParts.join('\n\n');
                    const modelImages = attachments.filter(shouldSendAttachmentImage).map(attachmentUrl).filter(Boolean);
                    const modelAttachments = attachments.map(attachmentPayloadForModel);
                    c.messages.push(assistantMsg); saveTalk(); scrollTalkBottom();
                    await pushConvo(c); // 先把当前消息快照落到后端，后端再从 chat_convos 生成接力/新 session 上下文
                    if (!isApiProvider) await refreshTalkRelayState(c);
                    if (isTerminalMode) {
                        const terminalCompleted = await sendTalkViaTerminal(prompt, assistantMsg, c, modelImages);
                        if (!terminalCompleted) {
                            assistantMsg.preview = true;
                            assistantMsg.done = false;
                            talk.thinking = false;
                            saveTalk(); pushConvo(c); scrollTalkBottom();
                            return assistantMsg;
                        }
                        handleAssistantCallRequest(assistantMsg, c);
                        assistantMsg.preview = false;
                        assistantMsg.done = true;
                        talk.thinking = false;
                        saveTalk();
                        pushConvo(c).then(() => refreshTalkTerminalStatus(c));
                        scrollTalkBottom();
                        playTalkNotification();
                        showTalkToast(assistantMsg, c);
                        await synthesizeAssistantVoice(assistantMsg, c);
                        return assistantMsg;
                    }
                    if (isApiProvider) {
                        const base = String(talkSettings.baseUrl || '').trim().replace(/\/+$/, '');
                        if (!base) throw new Error('OpenAI Compatible API 模式需要填写 Base URL；不会回退到 Claude Code。');
                        if (!String(talkSettings.apiKey || '').trim()) throw new Error('OpenAI Compatible API 模式需要填写 API Key；不会回退到 Claude Code。');
                        const history = c.messages.slice(-24)
                            .filter(m => m.id !== assistantMsg.id && (m.role === 'user' || m.role === 'assistant'))
                            .map(m => ({ role:m.role, content:messageContentForModel(m) || (m.role === 'assistant' ? '' : '新消息') }));
                        const userContext = buildTalkContext();
                        const characterContext = buildTalkCharacterPrompt(c);
                        const timeContext = talkSettings.timestampUserMessages !== false ? `[time: ${nowForModel()}]` : '';
                        const systemMessages = [timeContext, userContext, characterContext].filter(Boolean).map(content => ({ role:'system', content }));
                        const messages = [...systemMessages, ...history];
                        const r = await fetch('/api/talk-api/v1/chat/completions', {
                            method:'POST',
                            credentials:'include',
                            headers:{ 'Content-Type':'application/json' },
                            body:JSON.stringify({
                                provider:'auto',
                                base_url:base,
                                api_key:talkSettings.apiKey,
                                model:talkSettings.apiModel || c.model || 'gpt-4o-mini',
                                messages,
                                temperature:.85,
                                rifugio_experience:true,
                                cache_namespace:'talk:' + c.id,
                            }),
                        });
                        if (!r.ok) {
                            const detail = await r.text().catch(() => '');
                            throw new Error(`API 桥连接失败（HTTP ${r.status}）${detail ? '：' + detail.slice(0, 240) : ''}`);
                        }
                        const j = await r.json();
                        if (j.rifugio?.cache) {
                            const cache = j.rifugio.cache;
                            talk.sessionNotice = `API 缓存：命中 ${cache.hit_tokens || 0} · 写入 ${cache.write_tokens || 0} · 未命中 ${cache.miss_tokens || 0}`;
                        }
                        const msg = j.choices?.[0]?.message || {};
                        assistantMsg.content = (msg.content || '').trim() || '（空回复）';
                        assistantMsg.thinking = (msg.reasoning_content || msg.reasoning || '').trim();
                        assistantMsg.preview = false;
                        assistantMsg.done = true;
                        handleAssistantCallRequest(assistantMsg, c);
                        talk.thinking = false;
                        saveTalk(); pushConvo(c); scrollTalkBottom(); playTalkNotification(); showTalkToast(assistantMsg, c);
                        await synthesizeAssistantVoice(assistantMsg, c);
                        return assistantMsg;
                    }
                    const controller = new AbortController();
                    streamAbort = controller; lastChunkAt = Date.now();
                    setPendingStream({ convoId:c.id, assistantMsgId:assistantMsg.id, startedAt:Date.now() });
                    const r = await fetch(CLAUDE_AGENT_ENDPOINT, {
                        method:'POST',
                        headers:{ 'Content-Type':'application/json' },
                        signal:controller.signal,
                        body:JSON.stringify({
                            prompt,
                            conversation_id:c.id,
                            bootstrap_context:'', // 新 session 接力摘要由后端根据 conversation_id/chat_convos 生成
                            force_new_session:!!c.force_new_session,
                            auto_session_relay: talkSettings.autoSessionRelay,
                            auto_session_relay_turns: talkSettings.autoSessionRelayTurns,
                            images:modelImages,
                            attachments:modelAttachments,
                            model:talkSettings.claudeModel || c.model || llm.model || 'default',   // 统一用 claudeModel（设置和头部选择器都绑它）
                            effort:talkSettings.claudeEffort || 'medium',
                            system_prompt:buildTalkContext(),
                            character_prompt:buildTalkCharacterPrompt(c),
                            options:{ include_partial_messages:true, includePartialMessages:true },
                            stream:true,
                        }),
                    });
                    if (!r.ok) {
                        const detail = await r.text().catch(() => '');
                        setPendingStream(null); // 明确的 HTTP 错误不是切屏断线，不应进入续接等待。
                        throw new Error(formatClaudeAgentFailure(r.status, detail));
                    }
                    startStaleWatch();
                    try {
                        await streamClaudeLikeResponse(r, assistantMsg, c, true);
                        if (assistantMsg._resumeDeferredMiss && !retryInfo.resumeDeferredMiss) {
                            stopStaleWatch();
                            setPendingStream(null);
                            const blankIndex = c.messages.findIndex(m => m.id === assistantMsg.id);
                            if (blankIndex >= 0) c.messages.splice(blankIndex, 1);
                            const userIndex = c.messages.findIndex(m => m.id === userMsg.id);
                            if (userIndex >= 0) c.messages.splice(userIndex, 1);
                            userMsg.failed = false;
                            c.session_id = '';
                            c.force_new_session = true;
                            saveTalk(); await safePushConvoFull(c);   // 刚 splice 删了两条，必须全量
                            return await sendTalkMessage(text, attachments, { ...retryInfo, resumeDeferredMiss:true });
                        }
                    } catch (streamError) {
                        stopStaleWatch();
                        // 流断了/被中止/卡死——后端没杀进程、还在生成并缓存，试着续传接回来
                        if (getPendingStream()) {
                            const ok = await resumeInFlight();
                            if (ok) return assistantMsg;
                        }
                        throw new Error(formatClaudeAgentFailure(0, streamError.message || streamError));
                    } finally {
                        stopStaleWatch();
                        if (streamAbort === controller) streamAbort = null;
                    }
                    setPendingStream(null);
                    if (!c.messages.find(m => m.id === assistantMsg.id)) c.messages.push(assistantMsg);
                    if (!assistantMsg.content) assistantMsg.content = '（空回复）';
                    assistantMsg.preview = false;
                    assistantMsg.done = true;
                    handleAssistantCallRequest(assistantMsg, c);
                    if (c.force_new_session) c.force_new_session = false;
                    talk.thinking = false;
                    saveTalk(); pushConvo(c).then(() => refreshTalkRelayState(c)); scrollTalkBottom(); playTalkNotification(); showTalkToast(assistantMsg, c);
                    await synthesizeAssistantVoice(assistantMsg, c);
                    return assistantMsg;
                } catch (e) {
                    const pending = getPendingStream();
                    const samePending = pending && pending.convoId === c.id && String(pending.assistantMsgId) === String(assistantMsg.id);
                    if (samePending) {
                        assistantMsg.preview = true;
                        assistantMsg.done = false;
                        assistantMsg.pendingReconnect = true;
                        talk.error = '';
                        talk.sessionNotice = '消息已经送出，正在重新接回回复…';
                        if (document.visibilityState === 'visible') setTimeout(maybeResume, 700);
                        return assistantMsg;
                    }
                    if (!assistantMsg.content) {
                        const blankIndex = c.messages.findIndex(m => m.id === assistantMsg.id);
                        if (blankIndex >= 0) { c.messages.splice(blankIndex, 1); c._needsFullPush = true; }
                    } else if (!c.messages.find(m => m.id === assistantMsg.id)) {
                        c.messages.push(assistantMsg);
                    }
                    talk.error = '出问题了：' + (e.message || e);
                    userMsg.failed = true;
                    return null;
                } finally {
                    talk.thinking = false;
                    saveTalk();
                    if (c._needsFullPush) { safePushConvoFull(c); }
                    else pushConvo(c);
                }
            };
            // 重发：把这条用户消息（连同它后面出错的助手气泡）删掉，原样重新发一次，不用重打

            const retryMessage = async (m, options = {}) => {
                const c = activeConvo.value;
                if (!c || talk.thinking || !m || talk.retryingMessageId) return null;
                const idx = c.messages.findIndex(x => x.id === m.id);
                if (idx < 0) return null;
                const text = m.socialSourceText || m.content || '';
                const attachments = (m.attachments || []).map(a => ({ ...a }));
                talk.retryingMessageId = String(m.id);
                talk.error = '';
                talk.sessionNotice = '正在重新发送…';
                try {
                    // 服务端按 id 原子截断尾部：不再为了重发下载并上传几 MB 的完整历史。
                    const r = await fetch('/api/talk/convos/' + encodeURIComponent(c.id) + '/truncate', {
                        method:'POST',
                        credentials:'include',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ from_message_id:m.id }),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                    c.messages.splice(idx);
                    c.message_count = Number(j.message_count || c.messages.length) || c.messages.length;
                    c._messagesLoaded = true;
                    saveTalk(); scrollTalkBottom();
                    return await sendTalkMessage(text, attachments, options);
                } catch (e) {
                    talk.error = '重新发送失败：' + (e.message || e);
                    return null;
                } finally {
                    talk.retryingMessageId = '';
                    if (talk.sessionNotice === '正在重新发送…') talk.sessionNotice = '';
                }
            };
            // 错误条上的「重新发送」：重发最后一条用户消息

            const retryLastFailed = () => {
                const c = activeConvo.value;
                if (!c || talk.thinking) return;
                for (let i = c.messages.length - 1; i >= 0; i--) {
                    if (c.messages[i].role === 'user') { retryMessage(c.messages[i]); return; }
                }
            };
            // 重新生成：把这条回复撤掉，用它对应的那条用户消息原样重问一遍 → 换个答案

            const regenerateMessage = (assistantMsg) => {
                const c = activeConvo.value;
                if (!c || talk.thinking || !assistantMsg) return;
                const idx = c.messages.findIndex(x => x.id === assistantMsg.id);
                if (idx < 0) return;
                let u = idx - 1;
                while (u >= 0 && c.messages[u].role !== 'user') u--;   // 往前找对应的用户消息
                if (u < 0) return;
                retryMessage(c.messages[u], { extraInstruction:'对方不满意你当前回答，重新构思吧。请不要复读上一版，换一个更贴近对方需求、更自然的回答。' });
            };

            const isLastTalkMessage = (m) => {
                const msgs = activeConvo.value?.messages;
                return !!(msgs && msgs.length && msgs[msgs.length - 1].id === m.id);
            };

            return { relayStateRequestSeq, relayStatusText, relayContextText, talkExecutionStatusText, talkTerminalRelayText, talkTerminalContextText, talkTerminalStatusUpdatedText, compactSessionId, formatContextChars, describeProfileInjection, describeDynamicContextInjection, profileInjectionText, talkActiveSessionId, talkActiveSessionShort, talkActiveTurnsText, talkContextWindowPct, talkContextWindowText, talkAutoRelayText, talkHasPendingPreview, refreshTalkRelayState, extractTextFromClaudeContent, applyClaudeStreamEvent, RESUME_KEY, RESUME_ENDPOINT, setPendingStream, getPendingStream, streamAbort, lastChunkAt, staleTimer, resumePromise, STREAM_STALE_RESUME_MS, STREAM_SILENCE_NOTE_MS, stopStaleWatch, startStaleWatch, streamClaudeLikeResponse, resumeInFlight, maybeResume, formatClaudeAgentFailure, talkApiJson, refreshTalkTerminalStatus, setTalkExecutionMode, forceTalkTerminalRelayNext, setTalkTerminalStatuses, applyTalkTerminalEvent, setPendingTerminalTurn, getPendingTerminalTurn, resumeTalkTerminalTurn, respondTalkTerminalPermission, sendTalkViaTerminal, sendTalkMessage, retryMessage, retryLastFailed, regenerateMessage, isLastTalkMessage };
    }
};
