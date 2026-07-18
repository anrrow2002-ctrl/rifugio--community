// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTerminal = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted, nextTick } = Vue;
    with (ctx) {
            const talkSurface = ref('chat');
            const isLocalFilePreview = window.location.protocol === 'file:';
            const terminalState = ref(isLocalFilePreview ? 'local' : 'idle');
            const terminalMessage = ref(isLocalFilePreview
                ? '部署到 VPS 后连接终端'
                : '点“终端”后会先通过本机验证，再连接终端。');
            const claudeTerminalKey = ref(0);
            const claudeTerminalUrl = computed(() => CLAUDE_TERMINAL_ENDPOINT);
            const passkeyBusy = ref(false);
            const passkeyRegistered = ref(false);
            const TERMINAL_CHAT_LS = 'rifugio-terminal-chat-v1';
            const terminalChatScroll = ref(null);
            const terminalChatInputRef = ref(null);
            const terminalChat = reactive({
                view: 'raw',
                rawOpen: false,
                input: '',
                busy: false,
                status: '',
                session: '',
                lastTurnId: '',
                relayIndex: 0,
                turnsSinceRelay: 0,
                relayState: null,
                handoffState: null,
                forceRelayNext: false,
                messages: [],
                statuses: [],
                voiceActive: false,
                voiceStatus: '',
                voiceError: '',
                keyPanelOpen: true,
                keyPanelTab: 'control',
                panel: '',
                statusPanelOpen: false,
                statusLoading: false,
                statusError: '',
                statusUpdatedAt: '',
            });
            // 终端独立资料：与 Talk 完全隔离（各自 localStorage）。首次使用时把 Talk 资料里的人格/名字“提取”过来当初始值，之后两边互不影响。
            const TERMINAL_PROFILE_LS = 'rifugio-terminal-profile';
            const terminalProfile = reactive({ userName:'', claudeName:'', userAvatar:'', claudeAvatar:'', userBio:'', userLikes:'', userDislikes:'', claudeNotes:'' });
            (function initTerminalProfile(){
                let saved = null;
                try { saved = JSON.parse(localStorage.getItem(TERMINAL_PROFILE_LS) || 'null'); } catch(_) {}
                if (saved && typeof saved === 'object') { Object.assign(terminalProfile, saved); return; }
                // 没存过 → 从 Talk 资料种子一份（含人格 claudeNotes）。直接读 localStorage 'rifugio-talk-profile'，
                // 不走 ctx.talkProfile：因为 useTerminal 早于 useTalk 初始化，此刻 ctx.talkProfile 还没装上。
                let tp = {};
                try { tp = JSON.parse(localStorage.getItem('rifugio-talk-profile') || '{}') || {}; } catch(_) { tp = {}; }
                Object.assign(terminalProfile, {
                    userName:tp.userName||'', claudeName:tp.claudeName||'', userAvatar:tp.userAvatar||'', claudeAvatar:tp.claudeAvatar||'',
                    userBio:tp.userBio||'', userLikes:tp.userLikes||'', userDislikes:tp.userDislikes||'', claudeNotes:tp.claudeNotes||'' });
                try { localStorage.setItem(TERMINAL_PROFILE_LS, JSON.stringify({ ...terminalProfile })); } catch(_) {}
            })();
            const saveTerminalProfile = () => { try { localStorage.setItem(TERMINAL_PROFILE_LS, JSON.stringify({ ...terminalProfile })); } catch(_) {} };
            const uploadTerminalAvatar = (ev, who) => {
                const file = ev?.target?.files?.[0]; if (!file) return;
                const reader = new FileReader();
                reader.onload = () => { if (who === 'user') terminalProfile.userAvatar = reader.result; else terminalProfile.claudeAvatar = reader.result; saveTerminalProfile(); };
                reader.readAsDataURL(file);
            };
            const buildTerminalContext = () => {
                const lines = [];
                if (terminalProfile.userName) lines.push(`用户名字：${terminalProfile.userName}`);
                if (terminalProfile.claudeName) lines.push(`助手名字：${terminalProfile.claudeName}`);
                if (terminalProfile.userBio) lines.push(`用户资料：${terminalProfile.userBio}`);
                if (terminalProfile.userLikes) lines.push(`用户喜欢：${terminalProfile.userLikes}`);
                if (terminalProfile.userDislikes) lines.push(`用户不喜欢：${terminalProfile.userDislikes}`);
                if (terminalProfile.claudeNotes) lines.push(`用户填写的 Claude 设定：${terminalProfile.claudeNotes}`);
                return lines.join('\n');
            };
            const addStickerToTerminal = (sticker) => {
                const name = sticker?.name || '';
                if (name) terminalChat.input = (terminalChat.input ? terminalChat.input.replace(/\s*$/, ' ') : '') + `[[sticker:${name}]]`;
                terminalChat.panel = '';
            };
            const terminalCall = reactive({
                active: false,
                listening: false,
                speaking: false,
                muted: false,
                handsFree: true,
                status: '',
                liveText: '',
                error: '',
            });
            let terminalCallRecognition = null;
            let terminalCallAudio = null;
            try {
                const saved = JSON.parse(localStorage.getItem(TERMINAL_CHAT_LS) || 'null');
                if (saved && Array.isArray(saved.messages)) {
                    terminalChat.messages = saved.messages.slice(-80);
                    terminalChat.session = saved.session || '';
                    terminalChat.relayIndex = Number(saved.relayIndex || 0);
                    terminalChat.turnsSinceRelay = Number(saved.turnsSinceRelay || 0);
                }
            } catch (_) {}
            const saveTerminalChat = () => {
                try { localStorage.setItem(TERMINAL_CHAT_LS, JSON.stringify({ messages: terminalChat.messages.slice(-100), session: terminalChat.session, relayIndex:terminalChat.relayIndex, turnsSinceRelay:terminalChat.turnsSinceRelay })); } catch (_) {}
            };
            const scrollTerminalChatBottom = () => nextTick(() => {
                const el = terminalChatScroll.value;
                if (el) el.scrollTop = el.scrollHeight;
            });
            const terminalPasskeySupported = computed(() => Boolean(window.PublicKeyCredential && navigator.credentials && window.isSecureContext));
            const passkeySupported = terminalPasskeySupported;
            const base64UrlToBuffer = (value) => {
                const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
                const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
                const binary = atob(padded);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes.buffer;
            };
            const bufferToBase64Url = (buffer) => {
                const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
                let binary = '';
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
            };
            const toCreateCredentialOptions = (options) => ({
                ...options,
                challenge: base64UrlToBuffer(options.challenge),
                user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
                excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: base64UrlToBuffer(c.id) })),
            });
            const toGetCredentialOptions = (options) => ({
                ...options,
                challenge: base64UrlToBuffer(options.challenge),
                allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: base64UrlToBuffer(c.id) })),
            });
            const credentialToJson = (credential) => {
                const response = credential.response;
                const json = {
                    id: credential.id,
                    rawId: bufferToBase64Url(credential.rawId),
                    type: credential.type,
                    authenticatorAttachment: credential.authenticatorAttachment || undefined,
                    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
                    response: {
                        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                    },
                };
                if (response.attestationObject) {
                    json.response.attestationObject = bufferToBase64Url(response.attestationObject);
                    json.response.transports = response.getTransports ? response.getTransports() : [];
                    if (response.getPublicKey) {
                        const publicKey = response.getPublicKey();
                        if (publicKey) json.response.publicKey = bufferToBase64Url(publicKey);
                    }
                    if (response.getPublicKeyAlgorithm) json.response.publicKeyAlgorithm = response.getPublicKeyAlgorithm();
                } else {
                    json.response.authenticatorData = bufferToBase64Url(response.authenticatorData);
                    json.response.signature = bufferToBase64Url(response.signature);
                    json.response.userHandle = response.userHandle ? bufferToBase64Url(response.userHandle) : null;
                }
                return json;
            };
            const passkeyErrorText = (e) => {
                const name = e?.name || '';
                const msg = e?.message || '';
                if (/NotAllowedError/i.test(name)) return '系统验证被取消或超时。';
                if (/SecurityError/i.test(name) || /secure/i.test(msg)) return 'Passkey 需要 HTTPS 页面。';
                if (/not supported|unavailable/i.test(msg)) return '这台设备或浏览器暂时不支持 Passkey。';
                return msg || 'Passkey 验证没有完成。';
            };
            const apiJson = async (url, options = {}) => {
                const hasBody = options.body !== undefined;
                const r = await fetch(url, {
                    credentials: 'include',
                    ...options,
                    headers: {
                        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
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
            const loadPasskeyStatus = async () => {
                const j = await apiJson('/api/terminal-passkey/status');
                passkeyRegistered.value = Boolean(j.registered);
                return j;
            };
            const registerTerminalPasskey = async () => {
                if (!passkeySupported.value) throw new Error('Passkey not supported or page is not secure');
                terminalMessage.value = '第一次进入终端，需要先绑定这台设备。';
                const start = await apiJson('/api/terminal-passkey/register/options', { method:'POST', body:'{}' });
                const credential = await navigator.credentials.create({ publicKey: toCreateCredentialOptions(start.options) });
                await apiJson('/api/terminal-passkey/register/verify', {
                    method:'POST',
                    body: JSON.stringify({ ...credentialToJson(credential), device_name: navigator.platform || 'browser device' }),
                });
                passkeyRegistered.value = true;
            };
            const authenticateTerminalPasskey = async () => {
                if (!passkeySupported.value) throw new Error('Passkey not supported or page is not secure');
                let start;
                try {
                    start = await apiJson('/api/terminal-passkey/authenticate/options', { method:'POST', body:'{}' });
                } catch (e) {
                    if (e.status === 409 && e.data?.needs_registration) {
                        await registerTerminalPasskey();
                        start = await apiJson('/api/terminal-passkey/authenticate/options', { method:'POST', body:'{}' });
                    } else {
                        throw e;
                    }
                }
                terminalMessage.value = '请用这台设备确认你本人在场。';
                const credential = await navigator.credentials.get({
                    publicKey: { ...toGetCredentialOptions(start.options), userVerification: 'required' }
                });
                await apiJson('/api/terminal-passkey/authenticate/verify', {
                    method:'POST',
                    body: JSON.stringify(credentialToJson(credential)),
                });
            };
            const unlockTerminalWithPasskey = async (options = {}) => {
                if (passkeyBusy.value) return false;
                const shouldProbeRawTerminal = options.probe !== false;
                passkeyBusy.value = true;
                // 终端已在显示时别把状态打回 locked：iframe 是 v-if="ready"，
                // 一降级就整个拆掉重建（ttyd 重连），快捷键/手势每发一次黑屏一下。
                const wasReady = terminalState.value === 'ready';
                if (!wasReady) terminalState.value = 'locked';
                try {
                    const status = await loadPasskeyStatus().catch(() => null);
                    if (!status?.terminal_unlocked) {
                        if (!status?.registered) await registerTerminalPasskey();
                        await authenticateTerminalPasskey();
                    } else if (wasReady || !shouldProbeRawTerminal) {
                        terminalState.value = 'ready';
                        terminalMessage.value = '';
                        return true; // API 通行证有效；聊天发送不必再下载/探测整张 ttyd 页面
                    }
                    if (!shouldProbeRawTerminal) {
                        terminalState.value = 'ready';
                        terminalMessage.value = '';
                        return true;
                    }
                    terminalMessage.value = '验证通过，正在连接终端…';
                    await probeClaudeTerminal();
                    return terminalState.value === 'ready';
                } catch (e) {
                    terminalState.value = 'locked';
                    terminalMessage.value = passkeyErrorText(e);
                    return false;
                } finally {
                    passkeyBusy.value = false;
                }
            };
            const probeClaudeTerminal = async () => {
                if (isLocalFilePreview) {
                    terminalState.value = 'local';
                    terminalMessage.value = '部署到 VPS 后连接终端';
                    return false;
                }
                terminalState.value = 'checking';
                terminalMessage.value = '正在检查 VPS 上的 ttyd 服务…';
                if (isTerminalCrossOrigin()) {
                    try {
                        const auth = await fetch('/api/terminal-auth/check', { method:'GET', credentials:'include', cache:'no-store' });
                        if (auth.ok) {
                            terminalState.value = 'ready';
                            terminalMessage.value = '';
                            return true;
                        }
                        terminalState.value = 'locked';
                        terminalMessage.value = '终端通行证已过期，请重新做一次本机验证。';
                    } catch (_) {
                        terminalState.value = 'unavailable';
                        terminalMessage.value = '无法确认终端通行证。请确认已经登录主站并完成 Passkey。';
                    }
                    return false;
                }
                try {
                    const r = await fetch(CLAUDE_TERMINAL_ENDPOINT, { method:'GET', credentials:'include', cache:'no-store' });
                    let badPage = false;
                    if (r.ok) {
                        const preview = await r.clone().text().catch(() => '');
                        badPage = /<title>\s*error response|file not found|404 not found/i.test(preview.slice(0, 4000));
                    }
                    if (r.ok && !badPage) {
                        terminalState.value = 'ready';
                        terminalMessage.value = '';
                        return true;
                    }
                    if (r.status === 401 || r.status === 403) {
                        terminalState.value = 'locked';
                        terminalMessage.value = '终端通行证已过期，请重新做一次本机验证。';
                        return false;
                    }
                    terminalState.value = 'unavailable';
                    terminalMessage.value = `终端暂时没有响应（HTTP ${r.status}）。请确认 VPS 的 ttyd 与 Nginx /claude-terminal/ 配置。`;
                } catch (_) {
                    terminalState.value = 'unavailable';
                    terminalMessage.value = '无法连接 ttyd。请确认已经部署到 VPS，并检查 /claude-terminal/ 反向代理。';
                }
                return false;
            };
            const openTerminalMode = async () => {
                if (talkCall?.active) endTalkCall();
                if (talk) { talk.panel = ''; talk.appView = 'terminal'; }
                terminalChat.view = 'raw';
                terminalChat.panel = '';
                terminalChat.statusPanelOpen = false;
                talkSurface.value = 'terminal';
                await unlockTerminalWithPasskey();
            };
            const closeTerminalMode = () => { talkSurface.value = 'chat'; if (talk) talk.appView = 'chats'; };
            const showTalkChat = () => { talkSurface.value = 'chat'; if (talk) talk.appView = 'chats'; };
            const reloadClaudeTerminal = async () => {
                if (await unlockTerminalWithPasskey()) claudeTerminalKey.value += 1;
            };

            const terminalMessageSegments = (content) => {
                try { if (ctx.messageSegments) return ctx.messageSegments(content); } catch (_) {}
                const raw = String(content || '');
                const out = [];
                const re = /\[\[sticker:([^\]\n]{1,80})\]\]/gi;
                let last = 0, m;
                const findSticker = (ref) => {
                    const q = String(ref || '').trim().toLowerCase();
                    const lib = Array.isArray(ctx.stickerLibrary) ? ctx.stickerLibrary : [];
                    return lib.find(s => [s.id, s.name, s.keywords, s.category].some(v => String(v || '').toLowerCase().includes(q)));
                };
                while ((m = re.exec(raw))) {
                    const text = raw.slice(last, m.index).trim();
                    if (text) out.push({ type:'text', value:text });
                    const s = findSticker(m[1]);
                    if (s && (s.url || s.dataUrl)) out.push({ type:'sticker', value:s.url || s.dataUrl, name:s.name || m[1] });
                    last = re.lastIndex;
                }
                const rest = raw.slice(last).trim();
                if (rest) out.push({ type:'text', value:rest });
                return out;
            };
            const terminalDisplayName = (role) => role === 'user' ? (terminalProfile.userName || '你') : (terminalProfile.claudeName || 'Companion');
            const terminalAvatar = (role) => role === 'user' ? (terminalProfile.userAvatar || '') : (terminalProfile.claudeAvatar || '');
            const terminalRelayStatusText = computed(() => {
                const s = terminalChat.relayState || {};
                const usedChars = Number(s.context_chars_since_relay || s.total_chars || s.estimated_context_chars || 0) || 0;
                const triggerChars = Number(s.trigger_chars || 0) || 0;
                if (!triggerChars) return '等待同步';
                const pct = Number(s.trigger_progress_pct || 0) || 0;
                const turns = Number(s.turns_since_relay || 0) || 0;
                if (s.relay_pending) return `接力中：正在注入新上下文…`;
                if (s.relay_trigger) return `写摘要中：等待 CC 写入 relay.txt…`;
                const next = s.will_auto_relay_next_turn ? ' · 下条接力' : '';
                return `${usedChars.toLocaleString()} / ${triggerChars.toLocaleString()} 字（${pct}%）· ${turns} 轮${next}`;
            });
            const terminalContextStatusText = computed(() => {
                const s = terminalChat.relayState || {};
                const configChars = Number(s.overhead_chars || 0) || 0;
                const diagnosticChars = Number(s.effective_total_chars || s.effective_chars || 0) || 0;
                const histMsgs = Number(s.history_messages || 0) || 0;
                const fileExists = s.relay_file_exists ? '✓ relay.txt 存在' : '暂无 relay.txt';
                return `历史记录 ${histMsgs} 条；配置 ${configChars.toLocaleString()} 字；诊断 ${diagnosticChars.toLocaleString()} 字；${fileExists}`;
            });
            const terminalStatusUpdatedText = computed(() => {
                if (!terminalChat.statusUpdatedAt) return '还没刷新';
                return String(terminalChat.statusUpdatedAt).replace('T', ' ').slice(0, 19);
            });
            const terminalNowHM = () => {
                try { return ctx.nowHM ? ctx.nowHM() : new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }); }
                catch (_) { return ''; }
            };
            const terminalConversationId = () => String(ctx.activeConvo?.id || 'terminal-chat');
            const terminalSystemPrompt = () => {
                // 用终端自己的隔离资料注入（不再借 Talk 的人格）；机制与 Talk 相同——发送/加载对话时注入。
                try { return buildTerminalContext(); } catch (_) { return ''; }
            };
            const terminalBootstrapContext = () => {
                // 最近 Talk / Terminal 聊天由后端按 conversation_id 从数据库合并，前端不再重复塞一份摘要。
                return '';
            };
            const clearTerminalChat = () => {
                terminalChat.messages.splice(0);
                terminalChat.statuses.splice(0);
                terminalChat.status = '已清空本地聊天外壳；底层终端上下文不会被清除。';
                saveTerminalChat();
            };
            const terminalChatShortcut = async (key) => {
                try {
                    await unlockTerminalWithPasskey();
                    await apiJson('/api/terminal-chat/shortcut', { method:'POST', body:JSON.stringify({ target:'raw', conversation_id:terminalConversationId(), key }) });
                    terminalChat.status = `已发送 ${key}`;
                } catch (e) {
                    terminalChat.status = e.message || '快捷键发送失败';
                }
            };
            const terminalRawText = async (text, enter = true) => {
                try {
                    await unlockTerminalWithPasskey();
                    await apiJson('/api/terminal-chat/shortcut', { method:'POST', body:JSON.stringify({ target:'raw', conversation_id:terminalConversationId(), text:String(text || ''), enter: enter !== false }) });
                    terminalChat.status = enter ? `已发送 ${String(text || '').slice(0, 28)}` : '已粘贴到终端输入区';
                } catch (e) {
                    terminalChat.status = e.message || '终端文本发送失败';
                }
            };
            const terminalInsertInput = (text) => {
                const add = String(text || '');
                if (!add) return;
                terminalChat.input = terminalChat.input ? (terminalChat.input + add) : add;
                terminalChat.status = '已加入输入框，可编辑后发送';
                nextTick(() => {
                    try {
                        const el = terminalChatInputRef.value || document.querySelector('.terminal-imessage-composer textarea');
                        if (el) {
                            el.value = terminalChat.input;
                            el.dispatchEvent(new Event('input', { bubbles:true }));
                            el.focus({ preventScroll:true });
                            el.selectionStart = el.selectionEnd = el.value.length;
                        }
                    } catch (_) {}
                });
            };
            const terminalPasteClipboard = async (target = 'composer') => {
                try {
                    const text = await navigator.clipboard.readText();
                    if (!text) { terminalChat.status = '剪贴板里没有文字'; return; }
                    if (target === 'raw') await terminalRawText(text, false);
                    else terminalInsertInput(text);
                } catch (e) {
                    terminalChat.status = '无法读取剪贴板：请检查浏览器权限';
                }
            };
            const terminalCopyText = async (text, label = '内容') => {
                try { await navigator.clipboard.writeText(String(text || '')); terminalChat.status = `已复制${label}`; }
                catch (_) { terminalChat.status = '复制失败：浏览器没有给剪贴板权限'; }
            };
            const terminalCopyLastAssistant = () => {
                const msg = [...terminalChat.messages].reverse().find(m => m.role === 'assistant' && m.content);
                terminalCopyText(msg?.content || '', '最新回复');
            };
            const terminalCopyTranscript = () => {
                const text = terminalChat.messages.map(m => `${m.role === 'user' ? 'User' : 'Companion'}: ${m.content || ''}`).join('\n\n');
                terminalCopyText(text, '终端聊天记录');
            };
            const terminalCallBrowserSpeak = (text) => {
                if (!terminalCall.active || terminalCall.muted) return;
                if (!('speechSynthesis' in window)) { terminalCall.speaking = false; terminalCall.status = '浏览器不支持语音播放'; return; }
                try { window.speechSynthesis.cancel(); } catch (_) {}
                const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 1200));
                u.lang = 'zh-CN';
                const zh = window.speechSynthesis.getVoices?.().find(v => /^zh/i.test(v.lang));
                if (zh) u.voice = zh;
                u.onstart = () => { terminalCall.speaking = true; terminalCall.status = 'Companion 正在说话…'; };
                u.onend = () => { terminalCall.speaking = false; terminalCall.status = '我在听'; if (terminalCall.active && terminalCall.handsFree && !terminalCall.muted) setTimeout(startTerminalCallListening, 250); };
                u.onerror = () => { terminalCall.speaking = false; if (terminalCall.active && terminalCall.handsFree && !terminalCall.muted) setTimeout(startTerminalCallListening, 250); };
                window.speechSynthesis.speak(u);
            };
            const speakTerminalCallReply = async (text) => {
                const cleaned = String(text || '').replace(/\[\[sticker:[^\]]+\]\]/g, '').trim();
                if (!terminalCall.active || terminalCall.muted || !cleaned) return;
                terminalCall.speaking = true;
                terminalCall.status = 'Companion 正在说话…';
                try {
                    if (typeof ctx.callTts === 'function') {
                        const ttsText = typeof ctx.cleanForTts === 'function' ? ctx.cleanForTts(cleaned) : cleaned;
                        const url = await ctx.callTts(ttsText.slice(0, 1200));
                        if (!terminalCallAudio) terminalCallAudio = new Audio();
                        terminalCallAudio.src = url;
                        terminalCallAudio.onended = () => { terminalCall.speaking = false; terminalCall.status = '我在听'; if (terminalCall.active && terminalCall.handsFree && !terminalCall.muted) setTimeout(startTerminalCallListening, 250); };
                        terminalCallAudio.onerror = () => terminalCallBrowserSpeak(cleaned);
                        await terminalCallAudio.play();
                    } else {
                        terminalCallBrowserSpeak(cleaned);
                    }
                } catch (e) {
                    terminalCall.status = 'TTS 失败，改用浏览器语音：' + (e.message || '');
                    terminalCallBrowserSpeak(cleaned);
                }
            };
            const makeTerminalSpeechRecognition = () => {
                const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SR) return null;
                const rec = new SR();
                rec.lang = 'zh-CN';
                rec.interimResults = true;
                rec.continuous = false;
                return rec;
            };
            const startTerminalCallListening = () => {
                if (!terminalCall.active || terminalCall.muted || terminalCall.speaking || terminalChat.busy) return;
                if (terminalCallRecognition) { try { terminalCallRecognition.abort(); } catch (_) {} }
                terminalCallRecognition = makeTerminalSpeechRecognition();
                if (!terminalCallRecognition) { terminalCall.error = '这个浏览器暂时不支持语音通话输入。'; terminalCall.status = terminalCall.error; return; }
                let finalText = '';
                terminalCallRecognition.onstart = () => { terminalCall.listening = true; terminalCall.liveText = ''; terminalCall.status = '我在听…'; };
                terminalCallRecognition.onresult = (ev) => {
                    let interim = '';
                    for (let i = ev.resultIndex; i < ev.results.length; i++) {
                        const t = ev.results[i][0]?.transcript || '';
                        if (ev.results[i].isFinal) finalText += t; else interim += t;
                    }
                    terminalCall.liveText = interim || finalText || terminalCall.liveText;
                };
                terminalCallRecognition.onerror = (e) => { terminalCall.status = '语音识别失败：' + (e.error || 'unknown'); };
                terminalCallRecognition.onend = () => {
                    terminalCall.listening = false;
                    const text = String(finalText || '').trim();
                    if (!terminalCall.active) return;
                    if (text) {
                        terminalChat.input = text;
                        terminalCall.liveText = '我说：' + text;
                        sendTerminalChat({ fromCall:true });
                    } else if (terminalCall.handsFree && !terminalCall.muted && !terminalCall.speaking && !terminalChat.busy) {
                        setTimeout(startTerminalCallListening, 450);
                    }
                };
                try { terminalCallRecognition.start(); } catch (_) {}
            };
            const startTerminalCall = async () => {
                if (terminalCall.active) return;
                if (!(await unlockTerminalWithPasskey())) return;
                terminalCall.active = true;
                terminalCall.muted = false;
                terminalCall.status = '终端通话已连接';
                terminalCall.liveText = '';
                try {
                    if (!terminalCallAudio) terminalCallAudio = new Audio();
                    terminalCallAudio.src = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQgAAAAAAAAAAAAAAA==';
                    terminalCallAudio.play().catch(() => {});
                } catch (_) {}
                setTimeout(startTerminalCallListening, 250);
            };
            const endTerminalCall = () => {
                terminalCall.active = false;
                terminalCall.listening = false;
                terminalCall.speaking = false;
                terminalCall.status = '终端通话已结束';
                terminalCall.liveText = '';
                if (terminalCallRecognition) { try { terminalCallRecognition.abort(); } catch (_) {} terminalCallRecognition = null; }
                try { window.speechSynthesis?.cancel?.(); } catch (_) {}
                if (terminalCallAudio) { try { terminalCallAudio.pause(); } catch (_) {} }
            };
            const toggleTerminalCallMute = () => {
                terminalCall.muted = !terminalCall.muted;
                terminalCall.status = terminalCall.muted ? '已静音' : '我在听';
                if (terminalCall.muted && terminalCallRecognition) { try { terminalCallRecognition.abort(); } catch (_) {} }
                else if (terminalCall.active) setTimeout(startTerminalCallListening, 150);
            };
            const applyTerminalChatEvent = (evt, assistantMsg) => {
                if (!evt || !assistantMsg) return;
                if (evt.type === 'terminal_relay') {
                    terminalChat.session = evt.session || terminalChat.session;
                    terminalChat.relayIndex = Number(evt.relay_index || terminalChat.relayIndex || 0);
                    terminalChat.turnsSinceRelay = 0;
                    terminalChat.relayState = evt.relay_state || terminalChat.relayState;
                    terminalChat.forceRelayNext = false;
                    terminalChat.status = '已自动/手动接力到新的终端会话：' + (evt.reason || 'relay');
                } else if (evt.type === 'terminal_route') {
                    terminalChat.session = evt.session || terminalChat.session;
                    terminalChat.lastTurnId = evt.turn_id || terminalChat.lastTurnId;
                    terminalChat.relayIndex = Number(evt.relay_index || terminalChat.relayIndex || 0);
                    terminalChat.turnsSinceRelay = Number(evt.turns_since_relay || terminalChat.turnsSinceRelay || 0);
                    terminalChat.relayState = evt.relay_state || terminalChat.relayState;
                    terminalChat.status = evt.bootstrapping ? '正在把人格、资料、记忆和最近聊天带入终端…' : '终端会话已接上。';
                } else if (evt.type === 'terminal_status') {
                    const sts = Array.isArray(evt.statuses) ? evt.statuses : [];
                    terminalChat.statuses.splice(0, terminalChat.statuses.length, ...sts);
                    if (sts.length) {
                        assistantMsg.statuses = sts.map(s => ({ type:s.type || 'info', label:s.label || '' })).filter(s => s.label);
                        terminalChat.status = assistantMsg.statuses.map(s => s.label).join(' · ');
                    }
                } else if (evt.type === 'terminal_thinking') {
                    assistantMsg.thinking = String(evt.text || '').trim();
                    assistantMsg.thinkingOpen = assistantMsg.thinkingOpen || false;
                    if (assistantMsg.thinking) terminalChat.status = '✓✓ Claude Code transcript 思考摘要';
                } else if (evt.type === 'terminal_preview') {
                    assistantMsg.content = evt.text || assistantMsg.content;
                    assistantMsg.preview = true;
                } else if (evt.type === 'terminal_final') {
                    assistantMsg.content = evt.text || assistantMsg.content || '（Claude Code transcript 没有捕获到干净最终回复；请展开原始终端查看。）';
                    assistantMsg.preview = false;
                    assistantMsg.done = true;
                    terminalChat.status = evt.transcript ? '✓✓ Claude Code transcript' : (evt.pane_fallback ? 'transcript 未捕获，已用原始终端可见回复兜底' : 'transcript 未捕获最终回复，请查看原始终端');
                    terminalChat.session = evt.session || terminalChat.session;
                    terminalChat.relayIndex = Number(evt.relay_index || terminalChat.relayIndex || 0);
                    terminalChat.turnsSinceRelay = Number(evt.turns_since_relay || terminalChat.turnsSinceRelay || 0);
                    terminalChat.relayState = evt.relay_state || terminalChat.relayState;
                    terminalChat.forceRelayNext = false;
                    if (terminalCall.active && !assistantMsg.error) speakTerminalCallReply(assistantMsg.content);
                } else if (evt.type === 'error') {
                    assistantMsg.content = '终端聊天出错：' + (evt.error || evt.message || 'unknown error');
                    assistantMsg.preview = false;
                    assistantMsg.error = true;
                    terminalChat.status = assistantMsg.content;
                }
            };
            const sendTerminalChat = async () => {
                const text = String(terminalChat.input || '').trim();
                if (!text || terminalChat.busy) return;
                if (!(await unlockTerminalWithPasskey())) return;
                terminalChat.input = '';
                terminalChat.busy = true;
                terminalChat.statuses.splice(0);
                const userMsg = { id:'tu-' + Date.now(), role:'user', content:text, time:terminalNowHM() };
                const assistantMsg = { id:'ta-' + Date.now(), role:'assistant', content:'', thinking:'', thinkingOpen:false, time:terminalNowHM(), preview:true, done:false, statuses:[{ type:'thinking', label:'正在送进 Claude Code 终端…' }] };
                terminalChat.messages.push(userMsg, assistantMsg);
                saveTerminalChat();
                scrollTerminalChatBottom();
                try {
                    const r = await fetch('/api/terminal-chat/send', {
                        method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
                        body:JSON.stringify({
                            prompt:text,
                            conversation_id:terminalConversationId(),
                            system_prompt:terminalSystemPrompt(),
                            bootstrap_context:terminalBootstrapContext(),
                            force_relay: !!terminalChat.forceRelayNext,
                        }),
                    });
                    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
                    const reader = r.body.getReader();
                    const decoder = new TextDecoder();
                    let buf = '';
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream:true });
                        const chunks = buf.split(/\n\n/);
                        buf = chunks.pop() || '';
                        for (const chunk of chunks) {
                            const lines = chunk.split(/\n/).filter(x => x.startsWith('data:'));
                            for (const line of lines) {
                                const data = line.replace(/^data:\s*/, '');
                                if (!data || data === '[DONE]') continue;
                                try { applyTerminalChatEvent(JSON.parse(data), assistantMsg); }
                                catch (_) {}
                                scrollTerminalChatBottom();
                            }
                        }
                    }
                } catch (e) {
                    assistantMsg.content = '终端聊天连接失败：' + (e.message || 'unknown error');
                    assistantMsg.error = true;
                    terminalChat.status = assistantMsg.content;
                } finally {
                    terminalChat.busy = false;
                    terminalChat.statuses.splice(0);
                    refreshTerminalChatStatus().catch(() => {});
                    if (terminalCall.active && terminalCall.handsFree && !terminalCall.muted && !terminalCall.speaking && !terminalCall.listening) {
                        setTimeout(startTerminalCallListening, 350);
                    }
                    saveTerminalChat();
                    scrollTerminalChatBottom();
                }
            };

            const forceTerminalRelayNext = () => {
                terminalChat.forceRelayNext = true;
                terminalChat.status = '下条消息会接力到新的交互式终端 session；后端会自动注入资料、记忆和最近聊天。';
                saveTerminalChat();
            };

            const terminalChatEnter = (e) => {
                if (e && e.shiftKey) return;
                e?.preventDefault?.();
                sendTerminalChat();
            };
            let terminalVoiceRecognition = null;
            const toggleTerminalVoice = () => {
                if (terminalChat.voiceActive && terminalVoiceRecognition) {
                    try { terminalVoiceRecognition.stop(); } catch (_) {}
                    return;
                }
                const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SR) { terminalChat.voiceError = '这个浏览器暂时不支持语音输入。'; return; }
                terminalVoiceRecognition = new SR();
                terminalVoiceRecognition.lang = 'zh-CN';
                terminalVoiceRecognition.interimResults = true;
                terminalVoiceRecognition.continuous = false;
                terminalChat.voiceActive = true;
                terminalChat.voiceStatus = '听着呢…';
                terminalVoiceRecognition.onresult = (ev) => {
                    let final = '', interim = '';
                    for (let i = ev.resultIndex; i < ev.results.length; i++) {
                        const t = ev.results[i][0]?.transcript || '';
                        if (ev.results[i].isFinal) final += t; else interim += t;
                    }
                    terminalChat.voiceStatus = interim || final || terminalChat.voiceStatus;
                    if (final) terminalChat.input = (terminalChat.input ? terminalChat.input + ' ' : '') + final.trim();
                };
                terminalVoiceRecognition.onerror = (e) => { terminalChat.voiceError = e.error || '语音输入失败'; };
                terminalVoiceRecognition.onend = () => { terminalChat.voiceActive = false; terminalChat.voiceStatus = ''; };
                terminalVoiceRecognition.start();
            };
            const openTerminalRaw = async () => { terminalChat.view = 'raw'; await unlockTerminalWithPasskey(); };
            const openTerminalChat = async () => { terminalChat.view = 'chat'; if (await unlockTerminalWithPasskey()) refreshTerminalChatStatus().catch(() => {}); scrollTerminalChatBottom(); };
            const refreshTerminalChatStatus = async () => {
                terminalChat.statusLoading = true;
                terminalChat.statusError = '';
                try {
                    const q = encodeURIComponent(terminalConversationId());
                    const j = await apiJson(`/api/terminal-chat/status?conversation_id=${q}`);
                    terminalChat.session = j.session || terminalChat.session;
                    terminalChat.status = j.exists ? '终端聊天会话在线' : '终端聊天会话尚未启动';
                    terminalChat.relayIndex = Number(j.relay_index || 0);
                    terminalChat.turnsSinceRelay = Number(j.turns_since_relay || 0);
                    terminalChat.relayState = j.relay_state || null;
                    terminalChat.handoffState = j.handoff || null;
                    terminalChat.statusUpdatedAt = new Date().toISOString();
                } catch (e) {
                    terminalChat.statusError = e.status === 401 ? '登录或终端验证已过期；状态面板已打开，但后端没有授权返回详情。' : (e.message || '状态检查失败');
                    terminalChat.status = terminalChat.statusError;
                } finally {
                    terminalChat.statusLoading = false;
                }
            };
            const showTerminalStatusPanel = async () => {
                terminalChat.statusPanelOpen = true;
                await refreshTerminalChatStatus();
            };

        return { talkSurface, isLocalFilePreview, terminalState, terminalMessage, claudeTerminalKey, claudeTerminalUrl, passkeyBusy, passkeyRegistered, passkeySupported, base64UrlToBuffer, bufferToBase64Url, toCreateCredentialOptions, toGetCredentialOptions, credentialToJson, passkeyErrorText, apiJson, loadPasskeyStatus, registerTerminalPasskey, authenticateTerminalPasskey, unlockTerminalWithPasskey, probeClaudeTerminal, openTerminalMode, closeTerminalMode, showTalkChat, reloadClaudeTerminal, terminalChat, terminalCall, terminalChatScroll, terminalChatInputRef, terminalProfile, saveTerminalProfile, uploadTerminalAvatar, addStickerToTerminal, saveTerminalChat, scrollTerminalChatBottom, terminalMessageSegments, terminalDisplayName, terminalAvatar, terminalRelayStatusText, terminalContextStatusText, terminalStatusUpdatedText, terminalNowHM, clearTerminalChat, terminalChatShortcut, terminalRawText, terminalInsertInput, terminalPasteClipboard, terminalCopyLastAssistant, terminalCopyTranscript, sendTerminalChat, terminalChatEnter, toggleTerminalVoice, openTerminalRaw, openTerminalChat, refreshTerminalChatStatus, showTerminalStatusPanel, forceTerminalRelayNext, startTerminalCall, endTerminalCall, toggleTerminalCallMute, startTerminalCallListening };
    }
};
