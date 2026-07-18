// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTalkCall = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const talkCall = reactive({
                active:false, startedAt:0, elapsed:0, input:'', liveText:'', latestReply:'',
                listening:false, speaking:false, muted:false, handsFree:true, status:'准备好听你说', error:'',
                video:false, cameraActive:false, cameraStream:null,
                incoming:false, incomingReason:'',
                minimized:false,               // 收起成悬浮胶囊，通话继续
                voiceContext:null,              // 后端识别出的情绪/笑声等结构化线索
            });

            const callVideoRef = ref(null);

            const talkCallElapsed = computed(() => {
                const total = Math.max(0, talkCall.elapsed || 0);
                const mm = String(Math.floor(total / 60)).padStart(2,'0');
                const ss = String(total % 60).padStart(2,'0');
                return `${mm}:${ss}`;
            });

            let talkCallTimer = null;

            let callRecognition = null;

            let callListenToken = 0;

            let callRestartTimer = null;

            let callAutoSendTimer = null;

            let callAiHangupPending = false;   // 回复里带了 [[hangup]]，说完这句就挂

            let callMicStream = null;

            let callMicPromise = null;

            let callMicAudioCtx = null;

            let callMicSource = null;

            let callMicAnalyser = null;

            let callRecorder = null;

            let callRecordStream = null;

            let callRecordAudioCtx = null;

            let callRecordMonitorTimer = null;

            let callRecordStopTimer = null;

            let callRecordChunks = [];

            let callRecorderFallbackUntil = 0;

            let callAudio = null;   // 通话中我的语音音频对象（用普通变量，避免被 Vue 响应式代理坏掉）

            let callVoicePipeline = null; // Claude 流式文本 → 按句 TTS → 顺序播放

            let callVoicePipelineSeq = 0;

            let callTtsStreamController = null;

            let callSocket = null;

            let callSocketReconnectTimer = null;

            const sendCallSocketEvent = (type, payload = {}) => {
                if (!callSocket || callSocket.readyState !== WebSocket.OPEN) return false;
                try { callSocket.send(JSON.stringify({ type, ...payload })); return true; } catch(_) { return false; }
            };

            const ensureCallTtsStreamController = () => {
                if (callTtsStreamController) return callTtsStreamController;
                if (typeof window.Rifugio?.createTalkTtsStreamController !== 'function') return null;
                callTtsStreamController = window.Rifugio.createTalkTtsStreamController({
                    send:sendCallSocketEvent,
                    isSocketOpen:() => !!callSocket && callSocket.readyState === WebSocket.OPEN,
                    getProvider:() => normalizeTtsProvider(talkSettings.ttsProvider),
                    getStreamOptions:() => buildTtsPayload('。'),
                    cleanText:(content) => stripCallTokens(String(content || '')),
                    getName:() => talkProfile.claudeName || 'Companion',
                    onStatus:(status) => { if (talkCall.active) talkCall.status = status; },
                    onSpeaking:(speaking) => { if (talkCall.active) talkCall.speaking = speaking; },
                    onComplete:() => afterCallSpeak(),
                    onFallback:(text) => speakCallReply(text),
                });
                return callTtsStreamController;
            };

            const connectCallSocket = () => {
                if (!talkCall.active || typeof WebSocket === 'undefined') return;
                if (callSocket && (callSocket.readyState === WebSocket.OPEN || callSocket.readyState === WebSocket.CONNECTING)) return;
                const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const socket = new WebSocket(`${scheme}//${location.host}/ws/talk-call`);
                callSocket = socket;
                socket.onopen = () => sendCallSocketEvent('call.start', { video:!!talkCall.video, protocol:'rifugio-talkcall-v2' });
                socket.onmessage = (event) => ensureCallTtsStreamController()?.handleSocketMessage(event.data);
                socket.onclose = () => {
                    ensureCallTtsStreamController()?.handleSocketClose();
                    if (callSocket === socket) callSocket = null;
                    if (talkCall.active) {
                        clearTimeout(callSocketReconnectTimer);
                        callSocketReconnectTimer = setTimeout(connectCallSocket, 1200);
                    }
                };
                socket.onerror = () => {};
            };

            const closeCallSocket = () => {
                clearTimeout(callSocketReconnectTimer);
                callSocketReconnectTimer = null;
                if (callSocket) {
                    sendCallSocketEvent('call.stop', { duration:talkCall.elapsed || 0 });
                    try { callSocket.close(1000, 'call ended'); } catch(_) {}
                    callSocket = null;
                }
            };

            const callTokenPattern = /\[\[call(?::([^\]\n]{0,120}))?\]\]/gi;

            const hangupTokenPattern = /\[\[\s*(?:hangup|挂断)\s*\]\]/gi;

            const extractCallRefs = (content) => {
                const refs = [];
                String(content || '').replace(callTokenPattern, (_, ref) => { refs.push(String(ref || '').trim()); return ''; });
                return refs;
            };

            const stripCallTokens = (content) => String(content || '').replace(callTokenPattern, '').replace(hangupTokenPattern, '').replace(/\n{3,}/g, '\n\n').trim();

            const triggerAiTalkCall = (reason = '', options = {}) => {
                if (talkSettings.aiIncomingCallEnabled === false || talkCall.active || talkCall.incoming) return false;
                const name = talkProfile.claudeName || 'Companion';
                const cleanReason = String(reason || `${name} 想和你通话`).replace(/\s+/g, ' ').trim().slice(0, 120) || `${name} 想和你通话`;
                talkCall.incoming = true;
                talkCall.incomingReason = cleanReason;
                appendTalkSystemMessage(`${name} 发起了通话请求：${cleanReason}`, { kind:'call' });
                playTalkNotification();
                return true;
            };

            const handleAssistantCallRequest = (assistantMsg, convo = activeConvo.value) => {
                if (!assistantMsg?.content) return false;
                const refs = extractCallRefs(assistantMsg.content);
                if (!refs.length) return false;
                const clean = stripCallTokens(assistantMsg.content);
                assistantMsg.content = clean || '我想打给你。';
                assistantMsg.callRequested = true;
                return triggerAiTalkCall(refs[0] || clean || '', { source:'assistant', convo });
            };

            const requestAiTalkCall = (reason = '') => {
                triggerAiTalkCall(reason, { source:'internal' });
            };

            const rejectAiTalkCall = async () => {
                if (!talkCall.incoming) return;
                talkCall.incoming = false;
                const name = talkProfile.claudeName || 'Companion';
                appendTalkSystemMessage(`你拒绝了 ${name} 的通话请求。`, { kind:'call' });
                await sendTalkMessage(
                    'Rifugio Call System Prompt: The recipient has declined your request. Please try again or inquire about the reason.',
                    [],
                    { displayText:'（已拒绝通话）' }
                );
            };

            const acceptAiTalkCall = () => {
                talkCall.incoming = false;
                startTalkCall({ incoming:true });
            };

            const clearCallTimers = () => {
                if (callRestartTimer) clearTimeout(callRestartTimer);
                if (callAutoSendTimer) clearTimeout(callAutoSendTimer);
                callRestartTimer = null;
                callAutoSendTimer = null;
            };

            const callMicConstraints = () => ({
                audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true },
            });

            const isCallMicLive = () => !!callMicStream?.getAudioTracks?.().some(track => track.readyState === 'live');

            const warmCallMicStream = async (stream) => {
                if (!stream || callMicAnalyser) return callMicAnalyser;
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return null;
                try {
                    callMicAudioCtx = new AudioContextClass();
                    await callMicAudioCtx.resume?.();
                    callMicSource = callMicAudioCtx.createMediaStreamSource(stream);
                    callMicAnalyser = callMicAudioCtx.createAnalyser();
                    callMicAnalyser.fftSize = 1024;
                    callMicSource.connect(callMicAnalyser);
                    return callMicAnalyser;
                } catch(_) {
                    try { callMicAudioCtx?.close?.(); } catch(__) {}
                    callMicAudioCtx = null;
                    callMicSource = null;
                    callMicAnalyser = null;
                    return null;
                }
            };

            const ensureCallMicStream = async () => {
                if (!navigator.mediaDevices?.getUserMedia) return null;
                if (isCallMicLive()) return callMicStream;
                if (callMicPromise) return callMicPromise;
                callMicPromise = navigator.mediaDevices.getUserMedia(callMicConstraints())
                    .then(async (stream) => {
                        if (!talkCall.active || talkCall.muted) {
                            try { stream.getTracks?.().forEach(track => track.stop()); } catch(_) {}
                            return null;
                        }
                        callMicStream = stream;
                        stream.getAudioTracks?.().forEach((track) => {
                            track.addEventListener?.('ended', () => {
                                if (callMicStream === stream) {
                                    callMicStream = null;
                                    callMicSource = null;
                                    callMicAnalyser = null;
                                    try { callMicAudioCtx?.close?.(); } catch(_) {}
                                    callMicAudioCtx = null;
                                }
                            });
                        });
                        await warmCallMicStream(stream).catch(() => null);
                        if (!talkCall.active || talkCall.muted) {
                            if (callMicStream === stream) releaseCallMicStream();
                            else {
                                try { stream.getTracks?.().forEach(track => track.stop()); } catch(_) {}
                            }
                            return null;
                        }
                        return stream;
                    })
                    .finally(() => { callMicPromise = null; });
                return callMicPromise;
            };

            const releaseCallMicStream = () => {
                const stream = callMicStream;
                callMicStream = null;
                callMicPromise = null;
                callMicSource = null;
                callMicAnalyser = null;
                try { callMicAudioCtx?.close?.(); } catch(_) {}
                callMicAudioCtx = null;
                try { stream?.getTracks?.().forEach(track => track.stop()); } catch(_) {}
            };

            const cleanupCallRecording = () => {
                if (callRecordMonitorTimer) clearInterval(callRecordMonitorTimer);
                if (callRecordStopTimer) clearTimeout(callRecordStopTimer);
                callRecordMonitorTimer = null;
                callRecordStopTimer = null;
                try { callRecordAudioCtx?.close?.(); } catch(_) {}
                try {
                    if (callRecordStream && callRecordStream !== callMicStream) {
                        callRecordStream.getTracks?.().forEach(track => track.stop());
                    }
                } catch(_) {}
                callRecordAudioCtx = null;
                callRecordStream = null;
                callRecorder = null;
                callRecordChunks = [];
            };

            const abortCallRecording = () => {
                const recorder = callRecorder;
                if (recorder) {
                    recorder.ondataavailable = null;
                    recorder.onstop = null;
                    try { if (recorder.state !== 'inactive') recorder.stop(); } catch(_) {}
                }
                cleanupCallRecording();
            };

            const stopCallListening = () => {
                callListenToken += 1;
                clearCallTimers();
                abortCallRecording();
                if (callRecognition) {
                    try { callRecognition.abort(); } catch(_) {}
                    callRecognition = null;
                }
                talkCall.listening = false;
            };

            const scheduleCallListening = (delay = 220) => {
                if (!talkCall.active || !talkCall.handsFree || talkCall.muted || talkCall.speaking || talk.thinking) return;
                if (callRestartTimer) clearTimeout(callRestartTimer);
                callRestartTimer = setTimeout(() => {
                    callRestartTimer = null;
                    startCallListening();
                }, delay);
            };

            const joinCallTranscript = (...parts) => parts
                .map(part => String(part || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .join(' ')
                .trim();
            // 说完后的收尾：免提时自动接着听

            const afterCallSpeak = () => {
                if (callAiHangupPending) { callAiHangupPending = false; endTalkCall('ai'); return; }
                talkCall.speaking = false; talkCall.status = '我在听';
                scheduleCallListening(80);
            };
            // 浏览器自带语音（没配 TTS 时的兜底，声音比较机器）

            const speakCallReplyBrowser = (text) => {
                if (!('speechSynthesis' in window)) { afterCallSpeak(); return; }
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text.replace(/\[[^\]]+\]/g,''));
                utterance.lang = 'zh-CN'; utterance.rate = .96; utterance.pitch = 1.03;
                const voice = window.speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang));
                if (voice) utterance.voice = voice;
                utterance.onstart = () => { talkCall.speaking = true; talkCall.status = `${talkProfile.claudeName || 'Companion'} 回答中…`; };
                utterance.onend = afterCallSpeak;
                window.speechSynthesis.speak(utterance);
            };

            const playCallAudioUrl = (url, token) => new Promise((resolve, reject) => {
                if (!talkCall.active || token !== callVoicePipelineSeq) { resolve(); return; }
                if (!callAudio) callAudio = new Audio();
                callAudio.onended = resolve;
                callAudio.onerror = () => reject(new Error('音频播放失败'));
                callAudio.src = url;
                callAudio.play().catch(reject);
            });

            const playCallBrowserSentence = (text, token) => new Promise((resolve) => {
                if (!talkCall.active || token !== callVoicePipelineSeq || !('speechSynthesis' in window)) { resolve(); return; }
                const utterance = new SpeechSynthesisUtterance(String(text || '').replace(/\[[^\]]+\]/g,''));
                utterance.lang = 'zh-CN'; utterance.rate = .96; utterance.pitch = 1.03;
                const voice = window.speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang));
                if (voice) utterance.voice = voice;
                utterance.onend = resolve;
                utterance.onerror = resolve;
                window.speechSynthesis.speak(utterance);
            });

            const pumpCallVoicePipeline = async (pipeline) => {
                if (!pipeline || pipeline.playing || pipeline.token !== callVoicePipelineSeq) return;
                pipeline.playing = true;
                try {
                    while (pipeline.queue.length && talkCall.active && pipeline.token === callVoicePipelineSeq) {
                        const item = pipeline.queue.shift();
                        talkCall.speaking = true;
                        talkCall.status = `${talkProfile.claudeName || 'Companion'} 回答中…`;
                        const audio = await item.audio;
                        if (!talkCall.active || pipeline.token !== callVoicePipelineSeq) return;
                        if (audio.url) {
                            try { await playCallAudioUrl(audio.url, pipeline.token); }
                            catch (_) { await playCallBrowserSentence(item.text, pipeline.token); }
                        } else await playCallBrowserSentence(item.text, pipeline.token);
                    }
                } finally {
                    pipeline.playing = false;
                }
                if (pipeline.finished && !pipeline.queue.length && pipeline.token === callVoicePipelineSeq) {
                    callVoicePipeline = null;
                    afterCallSpeak();
                }
            };

            const enqueueCallVoiceSentence = (pipeline, sentence) => {
                const text = String(sentence || '').replace(/\s+/g, ' ').trim();
                if (!pipeline || !text || pipeline.token !== callVoicePipelineSeq) return;
                // 切出一句就立即开始合成；播放仍严格按原文顺序。
                const audio = isTtsReady.value
                    ? callTts(text).then(url => ({ url }), error => ({ error }))
                    : Promise.resolve({ error:new Error('TTS 未配置') });
                pipeline.queue.push({ text, audio });
                pumpCallVoicePipeline(pipeline);
            };

            const drainCallVoiceSentences = (pipeline, flush = false) => {
                if (!pipeline || pipeline.token !== callVoicePipelineSeq) return;
                // 句号/问号/感叹号/分号、逗号/冒号/换行均可触发低延迟切句。
                const boundary = /[。！？!?；;，,：:\n]/g;
                let match = null;
                while ((match = boundary.exec(pipeline.buffer))) {
                    const cut = match.index + match[0].length;
                    const sentence = pipeline.buffer.slice(0, cut);
                    pipeline.buffer = pipeline.buffer.slice(cut);
                    boundary.lastIndex = 0;
                    enqueueCallVoiceSentence(pipeline, sentence);
                }
                if (flush && pipeline.buffer.trim()) {
                    enqueueCallVoiceSentence(pipeline, pipeline.buffer);
                    pipeline.buffer = '';
                }
            };

            const startCallVoicePipeline = () => {
                if (!talkCall.active || !isTtsReady.value) return false;
                if ('speechSynthesis' in window) window.speechSynthesis.cancel();
                if (callAudio) { try { callAudio.pause(); } catch(_) {} }
                return ensureCallTtsStreamController()?.start() === true;
            };

            const updateCallVoicePipeline = (content) => {
                if (!talkCall.active) return false;
                return ensureCallTtsStreamController()?.update(content) === true;
            };

            const finishCallVoicePipeline = (content = '') => {
                return ensureCallTtsStreamController()?.finish(content) === true;
            };

            const cancelCallVoicePipeline = () => {
                callVoicePipelineSeq += 1;
                callVoicePipeline = null;
                callTtsStreamController?.cancel();
                if ('speechSynthesis' in window) window.speechSynthesis.cancel();
                if (callAudio) { try { callAudio.pause(); } catch(_) {} }
            };

            const speakCallReply = async (text) => {
                if (!talkCall.active || !text) return;
                // 优先用配好的 TTS（我的真实声音，带情绪标签）；没配才退回浏览器机器音
                if (isTtsReady.value) {
                    talkCall.speaking = true;
                    talkCall.status = `${talkProfile.claudeName || 'Companion'} 回答中…`;
                    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
                    try {
                        const url = await callTts(text);
                        if (!talkCall.active) return;
                        if (!callAudio) callAudio = new Audio();   // 复用通话开始时已解锁的元素，避免自动播放被拦
                        callAudio.src = url;
                        callAudio.onended = afterCallSpeak;
                        callAudio.onerror = () => speakCallReplyBrowser(text);
                        await callAudio.play();
                        return;
                    } catch(e) {
                        talkCall.status = 'TTS 失败，改用浏览器语音：' + e.message;
                        speakCallReplyBrowser(text);
                        return;
                    }
                }
                speakCallReplyBrowser(text);
            };

            const startCallRecorderListening = async (listenToken) => {
                if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return false;
                talkCall.status = isCallMicLive() ? '我在听' : '正在准备麦克风…';
                let stream = null;
                try {
                    stream = await ensureCallMicStream();
                } catch(e) {
                    talkCall.status = e?.name === 'NotAllowedError' ? '请允许麦克风权限' : '麦克风没打开，改用浏览器识别';
                    return false;
                }
                if (!stream) return false;
                if (listenToken !== callListenToken || !talkCall.active || talkCall.muted || talkCall.speaking || talk.thinking) {
                    return true;
                }
                const mime = bestAudioMime();
                let recorder = null;
                try {
                    recorder = new MediaRecorder(stream, speechRecorderOptions(mime));
                } catch(_) {
                    try {
                        if (stream !== callMicStream) stream.getTracks?.().forEach(track => track.stop());
                    } catch(__) {}
                    return false;
                }
                callRecorder = recorder;
                callRecordStream = stream;
                callRecordChunks = [];
                talkCall.listening = true;
                talkCall.liveText = '';
                talkCall.status = '我在听';

                // MediaRecorder 继续保存整句给后端做最终校正；SpeechRecognition 同时负责边说边出字幕。
                let browserFinalText = '';
                let browserInterimText = '';
                const liveRecognition = makeSpeechRecognition();
                if (liveRecognition) {
                    liveRecognition.continuous = true;
                    liveRecognition.maxAlternatives = 1;
                    callRecognition = liveRecognition;
                    liveRecognition.onresult = (event) => {
                        if (listenToken !== callListenToken || stopping) return;
                        let interim = '';
                        for (let i=event.resultIndex; i<event.results.length; i++) {
                            const part = String(event.results[i][0].transcript || '').trim();
                            if (!part) continue;
                            if (event.results[i].isFinal) browserFinalText = joinCallTranscript(browserFinalText, part);
                            else interim = joinCallTranscript(interim, part);
                        }
                        browserInterimText = interim;
                        talkCall.liveText = joinCallTranscript(browserFinalText, browserInterimText);
                        sendCallSocketEvent(browserInterimText ? 'stt.interim' : 'stt.final', { text:talkCall.liveText });
                    };
                    liveRecognition.onerror = () => {};
                    liveRecognition.onend = () => {
                        if (callRecognition === liveRecognition) callRecognition = null;
                    };
                    try { liveRecognition.start(); } catch(_) { if (callRecognition === liveRecognition) callRecognition = null; }
                }

                const startedAt = Date.now();
                let heardSpeech = false;
                let lastVoiceAt = 0;
                let voiceHits = 0;
                let voiceMonitorReliable = false;
                let stopping = false;
                const stopRecording = () => {
                    if (stopping) return;
                    stopping = true;
                    if (callRecordMonitorTimer) clearInterval(callRecordMonitorTimer);
                    if (callRecordStopTimer) clearTimeout(callRecordStopTimer);
                    callRecordMonitorTimer = null;
                    callRecordStopTimer = null;
                    try {
                        if (recorder.state !== 'inactive') recorder.stop();
                    } catch(_) {
                        cleanupCallRecording();
                        if (listenToken === callListenToken && talkCall.active) scheduleCallListening(600);
                    }
                };

                recorder.ondataavailable = (event) => {
                    if (event.data && event.data.size) callRecordChunks.push(event.data);
                };
                recorder.onstop = async () => {
                    const chunks = callRecordChunks.slice();
                    const recordedSpeech = heardSpeech || !voiceMonitorReliable;
                    const recorderMime = recorder.mimeType || mime || 'audio/webm';
                    const browserTranscript = joinCallTranscript(browserFinalText, browserInterimText);
                    if (callRecognition === liveRecognition) {
                        try { liveRecognition.abort(); } catch(_) {}
                        callRecognition = null;
                    }
                    cleanupCallRecording();
                    talkCall.listening = false;
                    if (listenToken !== callListenToken || !talkCall.active || talkCall.muted) return;
                    if (!recordedSpeech || !chunks.length) {
                        talkCall.liveText = '';
                        scheduleCallListening(500);
                        return;
                    }
                    const blob = new Blob(chunks, { type:recorderMime });
                    if (!blob.size || blob.size < 600) {
                        talkCall.liveText = '';
                        scheduleCallListening(500);
                        return;
                    }
                    talkCall.status = '正在转文字…';
                    try {
                        const backendResult = await transcribeVoiceBlob(blob, recorderMime, 0, true);
                        if (listenToken !== callListenToken || !talkCall.active || talkCall.muted) return;
                        const voiceContext = backendResult?.voiceContext || null;
                        const events = Array.isArray(voiceContext?.events) ? voiceContext.events : [];
                        const eventFallback = events.includes('laughter') ? '（笑了一声）'
                            : (events.includes('crying') ? '（有哭声）' : '');
                        const text = String(backendResult?.text || browserTranscript || eventFallback || '').trim();
                        if (!text) throw Object.assign(new Error('empty transcript'), { code:'empty_audio' });
                        talkCall.voiceContext = voiceContext;
                        talkCall.liveText = text;
                        talkCall.input = text;
                        sendCallSocketEvent('voice.context', { context:voiceContext });
                        sendCallTurn();
                    } catch(e) {
                        if (listenToken !== callListenToken || !talkCall.active || talkCall.muted) return;
                        if (browserTranscript) {
                            talkCall.liveText = browserTranscript;
                            talkCall.input = browserTranscript;
                            sendCallTurn();
                            return;
                        }
                        if (e?.code && e.code !== 'empty_audio') callRecorderFallbackUntil = Date.now() + 60000;
                        talkCall.liveText = '';
                        talkCall.status = e?.code === 'stt_api_error' ? '转文字接口没配好，改用浏览器识别' : '这句没转出来，再听一次';
                        scheduleCallListening(500);
                    }
                };

                try {
                    let analyser = callMicAnalyser || await warmCallMicStream(stream);
                    if (analyser && callMicAudioCtx) {
                        try { await callMicAudioCtx.resume?.(); } catch(_) {}
                        if (callMicAudioCtx.state !== 'running') analyser = null;
                    }
                    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                    if (analyser) {
                        voiceMonitorReliable = true;
                        const samples = new Uint8Array(analyser.fftSize);
                        callRecordMonitorTimer = setInterval(() => {
                            if (listenToken !== callListenToken || !talkCall.active || talkCall.muted || talkCall.speaking || talk.thinking) {
                                stopRecording();
                                return;
                            }
                            analyser.getByteTimeDomainData(samples);
                            let sum = 0;
                            for (let i=0; i<samples.length; i++) {
                                const v = (samples[i] - 128) / 128;
                                sum += v * v;
                            }
                            const level = Math.sqrt(sum / samples.length);
                            const now = Date.now();
                            if (level > 0.012) {
                                voiceHits += 1;
                                if (voiceHits >= 2) {
                                    heardSpeech = true;
                                    lastVoiceAt = now;
                                    talkCall.status = '听到了，停顿一下就发送';
                                }
                            } else {
                                voiceHits = 0;
                            }
                            if (heardSpeech && now - lastVoiceAt > callSilenceMs() && now - startedAt > 1400) stopRecording();
                            else if (!heardSpeech && now - startedAt > 16000) stopRecording();
                            else if (now - startedAt > 60000) stopRecording();
                        }, 120);
                    } else if (AudioContextClass) {
                        const audioCtx = new AudioContextClass();
                        callRecordAudioCtx = audioCtx;
                        try { await audioCtx.resume?.(); } catch(_) {}
                        voiceMonitorReliable = audioCtx.state === 'running';
                        const source = audioCtx.createMediaStreamSource(stream);
                        analyser = audioCtx.createAnalyser();
                        analyser.fftSize = 1024;
                        source.connect(analyser);
                        const samples = new Uint8Array(analyser.fftSize);
                        callRecordMonitorTimer = setInterval(() => {
                            if (listenToken !== callListenToken || !talkCall.active || talkCall.muted || talkCall.speaking || talk.thinking) {
                                stopRecording();
                                return;
                            }
                            analyser.getByteTimeDomainData(samples);
                            let sum = 0;
                            for (let i=0; i<samples.length; i++) {
                                const v = (samples[i] - 128) / 128;
                                sum += v * v;
                            }
                            const level = Math.sqrt(sum / samples.length);
                            const now = Date.now();
                            if (level > 0.012) {
                                voiceHits += 1;
                                if (voiceHits >= 2) {
                                    heardSpeech = true;
                                    lastVoiceAt = now;
                                    talkCall.status = '听到了，停顿一下就发送';
                                }
                            } else {
                                voiceHits = 0;
                            }
                            if (heardSpeech && now - lastVoiceAt > callSilenceMs() && now - startedAt > 1400) stopRecording();
                            else if (!heardSpeech && now - startedAt > 16000) stopRecording();
                            else if (now - startedAt > 60000) stopRecording();
                        }, 120);
                    } else {
                        callRecordStopTimer = setTimeout(stopRecording, 8200);
                    }
                    recorder.start(300);
                    return true;
                } catch(_) {
                    cleanupCallRecording();
                    return false;
                }
            };
            // 停顿判定窗口：低于 600ms 会把换气当句尾，超过 6s 等太久

            const callSilenceMs = () => Math.min(6000, Math.max(600, Number(talkSettings.callSilenceHoldMs) || 2200));

            const startCallSpeechRecognitionListening = (listenToken) => {
                const recognition = makeSpeechRecognition();
                callRecognition = recognition;
                if (!recognition) {
                    talkCall.status = '当前浏览器不支持语音识别';
                    return;
                }
                recognition.continuous = true;   // 连续监听，别识别完一句就停（减少空窗漏话）
                recognition.maxAlternatives = 1;
                let finalText = ''; let sent = false;
                let interimText = '';
                const currentText = () => joinCallTranscript(finalText, interimText);
                const queueCallTurn = (delay = callSilenceMs()) => {
                    if (!talkCall.handsFree || sent || !currentText()) return;
                    if (callAutoSendTimer) clearTimeout(callAutoSendTimer);
                    callAutoSendTimer = setTimeout(() => {
                        callAutoSendTimer = null;
                        if (listenToken !== callListenToken || sent) return;
                        const text = currentText();
                        if (!text || !talkCall.active || talkCall.muted || talkCall.speaking || talk.thinking) return;
                        sent = true;
                        talkCall.input = text;
                        sendCallTurn();
                    }, delay);
                };
                recognition.onstart = () => {
                    if (listenToken !== callListenToken) return;
                    talkCall.listening = true; talkCall.liveText = ''; talkCall.status = '我在听';
                };
                recognition.onresult = (event) => {
                    if (listenToken !== callListenToken || sent) return;
                    let interim = '';
                    for (let i=event.resultIndex; i<event.results.length; i++) {
                        const part = String(event.results[i][0].transcript || '').trim();
                        if (!part) continue;
                        if (event.results[i].isFinal) finalText = joinCallTranscript(finalText, part);
                        else interim += part;
                    }
                    interimText = String(interim || '').trim();
                    talkCall.liveText = currentText();
                    sendCallSocketEvent(interimText ? 'stt.interim' : 'stt.final', { text:talkCall.liveText });
                    if (finalText) {
                        talkCall.status = '我听到了，停顿一下就发送';
                        queueCallTurn(callSilenceMs());
                    } else if (interimText) {
                        talkCall.status = '我在听';
                    }
                };
                recognition.onerror = (e) => {
                    if (listenToken !== callListenToken) return;
                    talkCall.listening = false;
                    if (e.error === 'not-allowed') talkCall.status = '请允许麦克风权限';
                    else if (e.error !== 'no-speech') talkCall.status = '没有听清，再说一次';
                };
                recognition.onend = () => {
                    if (listenToken !== callListenToken) return;
                    talkCall.listening = false;
                    if (callRecognition === recognition) callRecognition = null;
                    if (currentText() && talkCall.handsFree && !sent) {
                        queueCallTurn(360);
                        return;
                    }
                    if (talkCall.active && talkCall.handsFree && !talkCall.muted && !talk.thinking && !talkCall.speaking && !sent) scheduleCallListening(300);
                };
                try { recognition.start(); } catch(_) {
                    if (callRecognition === recognition) callRecognition = null;
                    talkCall.status = '语音识别没启动，正在重试…';
                    scheduleCallListening(700);
                }
            };

            const startCallListening = async () => {
                if (!talkCall.active || talkCall.muted || talkCall.speaking || talk.thinking) return;
                const listenToken = ++callListenToken;
                clearCallTimers();
                abortCallRecording();
                if (callRecognition) { try { callRecognition.abort(); } catch(_) {} callRecognition = null; }
                if (Date.now() >= callRecorderFallbackUntil) {
                    const startedRecorder = await startCallRecorderListening(listenToken);
                    if (startedRecorder || listenToken !== callListenToken) return;
                }
                if (listenToken !== callListenToken || !talkCall.active || talkCall.muted || talkCall.speaking || talk.thinking) return;
                startCallSpeechRecognitionListening(listenToken);
            };

            const sendCallTurn = async () => {
                clearCallTimers();
                const text = (talkCall.input || talkCall.liveText || '').trim();
                if (!text || talk.thinking) return;
                talkCall.input = ''; talkCall.liveText = ''; talkCall.status = `${talkProfile.claudeName || 'Companion'} 正在想…`;
                stopCallListening();
                // 视频通话：每轮抓一帧真实摄像头画面附给模型，持续"看到"对方
                let callAttachments = [];
                if (talkCall.video && talkCall.cameraActive && talkCall.cameraStream) {
                    try {
                        const frame = await captureStreamFrame(talkCall.cameraStream);
                        if (frame) callAttachments = [{ id:'call-frame-' + Date.now(), dataUrl:frame, name:'视频通话画面', kind:'image' }];
                    } catch(_) {}
                }
                const voiceContext = talkCall.voiceContext;
                talkCall.voiceContext = null;
                const emotionLabels = { happy:'开心', sad:'难过', angry:'生气', fearful:'害怕', disgusted:'厌恶', surprised:'惊讶', neutral:'平静' };
                const eventLabels = { laughter:'笑声', crying:'哭声', cough:'咳嗽', sneeze:'喷嚏', breath:'明显呼吸声', applause:'掌声', background_music:'背景音乐' };
                const voiceHints = [
                    voiceContext?.emotion && voiceContext.emotion !== 'neutral' ? `可能的语气：${emotionLabels[voiceContext.emotion] || voiceContext.emotion}` : '',
                    ...(Array.isArray(voiceContext?.events) ? voiceContext.events.map(x => `声音事件：${eventLabels[x] || x}`) : []),
                ].filter(Boolean);
                const perception = voiceHints.length
                    ? `\n[Rifugio Voice Perception（自动识别，可能误判，请结合上下文自然回应，不要武断下结论）: ${voiceHints.join('；')}]`
                    : '';
                const callPrompt = `[Rifugio System: on calling]\n如需挂断使用[[hangup]]${perception}\n\n${text}`;
                const pipelineStarted = startCallVoicePipeline();
                const reply = await sendTalkMessage(callPrompt, callAttachments, { displayText:text });
                if (reply?.content) {
                    callAiHangupPending = /\[\[\s*(?:hangup|挂断)\s*\]\]/i.test(reply.content);
                    const spoken = String(reply.content).replace(hangupTokenPattern, '').trim();
                    talkCall.latestReply = spoken || reply.content;
                    if (!pipelineStarted || !finishCallVoicePipeline(spoken || reply.content)) speakCallReply(spoken || reply.content);
                } else if (talkCall.active) {
                    if (pipelineStarted) cancelCallVoicePipeline();
                    talkCall.status = talk.error || '没听清，再说一次？';
                    afterCallSpeak();   // 回复空/出错也要重新开始听，别让通话卡死
                }
            };

            const attachCallVideoStream = () => {
                Vue.nextTick(() => {
                    if (callVideoRef.value && talkCall.cameraStream) callVideoRef.value.srcObject = talkCall.cameraStream;
                });
            };

            const startCallCamera = async () => {
                if (!navigator.mediaDevices?.getUserMedia) {
                    talkCall.status = '当前浏览器不能打开摄像头';
                    return false;
                }
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
                    talkCall.cameraStream = stream;
                    talkCall.cameraActive = true;
                    talkCall.status = '真实摄像头已开启';
                    attachCallVideoStream();
                    return true;
                } catch(_) {
                    talkCall.cameraActive = false;
                    talkCall.cameraStream = null;
                    talkCall.status = '没有拿到摄像头权限，已切回虚拟卡牌';
                    return false;
                }
            };

            const stopCallCamera = () => {
                if (talkCall.cameraStream?.getTracks) talkCall.cameraStream.getTracks().forEach(track => track.stop());
                talkCall.cameraStream = null;
                talkCall.cameraActive = false;
                if (callVideoRef.value) callVideoRef.value.srcObject = null;
            };

            const toggleCallCamera = async () => {
                if (!talkCall.video) return;
                if (talkCall.cameraActive) {
                    stopCallCamera();
                    talkCall.status = '已切到虚拟卡牌';
                } else {
                    await startCallCamera();
                }
            };

            const startTalkCall = async (options={}) => {
                if (!activeConvo.value) newTalk();
                talkCall.incoming = false;
                talk.panel = ''; talkCall.active = true; talkCall.startedAt = Date.now(); talkCall.elapsed = 0;
                talkCall.minimized = false; callAiHangupPending = false;
                // 趁这次点击（用户手势）解锁浏览器自动播放：先用同一个 audio 元素放一下静音，
                // 之后我的回复音频复用它就不会被 NotAllowedError 拦掉。必须在任何 await 之前。
                try {
                    if (!callAudio) callAudio = new Audio();
                    callAudio.src = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQgAAAAAAAAAAAAAAA==';
                    callAudio.play().catch(() => {});
                } catch(_) {}
                ensureCallTtsStreamController()?.unlock();
                talkCall.latestReply = ''; talkCall.liveText = ''; talkCall.status = '正在准备麦克风…'; talkCall.muted = false;
                talkCall.video = !!options.video;
                connectCallSocket();
                ensureCallMicStream()
                    .then((stream) => {
                        if (talkCall.active && stream && !talkCall.muted && !talkCall.speaking && !talk.thinking && !talkCall.listening) {
                            talkCall.status = '麦克风已准备好';
                        }
                    })
                    .catch((e) => {
                        if (talkCall.active) talkCall.status = e?.name === 'NotAllowedError' ? '请允许麦克风权限' : '麦克风没打开，改用浏览器识别';
                    });
                appendTalkSystemMessage('[Rifugio System: on calling]\n如需挂断使用[[hangup]]', { kind:'call' });
                postTalkActivity('call', { status:'正在语音通话' });
                if (activeConvo.value) pushConvo(activeConvo.value);
                stopCallCamera();
                if (talkCall.video) {
                    if (talkSettings.videoMode === 'camera') await startCallCamera();
                    else talkCall.status = '正在使用虚拟卡牌视频';
                }
                clearInterval(talkCallTimer);
                talkCallTimer = setInterval(() => { talkCall.elapsed = Math.floor((Date.now() - talkCall.startedAt) / 1000); }, 1000);
                setTimeout(startCallListening, 180);
            };

            const startVideoTalkCall = () => startTalkCall({ video:true });

            const syncCallEndedToClaude = (conversationId) => {
                if (!conversationId || talkSettings.executionMode !== 'terminal') return;
                fetch('/api/terminal-chat/event', {
                    method:'POST',
                    credentials:'include',
                    headers:{ 'Content-Type':'application/json' },
                    body:JSON.stringify({ conversation_id:conversationId, event:'对方已挂断' }),
                    keepalive:true,
                }).catch(() => {});
            };

            const endTalkCall = (endedBy) => {
                const wasActive = talkCall.active;
                const callDuration = talkCallElapsed.value;
                const aiHungUp = endedBy === 'ai';   // UI 按钮点击时 endedBy 是 MouseEvent，不会误判
                callAiHangupPending = false;
                talkCall.minimized = false;
                talkCall.active = false; talkCall.listening = false; talkCall.speaking = false; talkCall.status = '通话已结束';
                talkCall.incoming = false;
                talkCall.video = false;
                stopCallCamera();
                clearInterval(talkCallTimer); talkCallTimer = null;
                stopCallListening();
                cancelCallVoicePipeline();
                closeCallSocket();
                callTtsStreamController?.close();
                callTtsStreamController = null;
                releaseCallMicStream();
                if ('speechSynthesis' in window) window.speechSynthesis.cancel();
                if (callAudio) { try { callAudio.pause(); } catch(_) {} callAudio = null; }   // 挂断时停掉我的声音
                if (wasActive) {
                    const who = aiHungUp ? `${talkProfile.claudeName || 'Companion'} 挂断了电话` : '您已挂断通话';
                    appendTalkSystemMessage(`📞 ${who} · 通话时长 ${callDuration}`, { kind:'call' });
                    postTalkActivity('call', { status:`${who}，时长 ${callDuration}` });
                    if (!aiHungUp && activeConvo.value?.id) syncCallEndedToClaude(activeConvo.value.id);
                    if (activeConvo.value) pushConvo(activeConvo.value);
                }
            };

            const restoreTalkCall = () => {
                talkCall.minimized = false;
                openPhoneApp(findPhoneApp('talk'));
                talk.appView = 'chats';
                talk.chatView = 'chat';
                if (talkCall.video && talkCall.cameraActive) attachCallVideoStream();   // v-if 重挂载后 video 元素要重新绑流
            };

            const toggleCallMute = () => {
                talkCall.muted = !talkCall.muted;
                if (talkCall.muted) {
                    talkCall.status = '麦克风已静音';
                    stopCallListening();
                    releaseCallMicStream();
                } else {
                    talkCall.status = '我在听';
                    ensureCallMicStream().catch(() => null);
                    startCallListening();
                }
            };

            const toggleHandsFree = () => {
                talkCall.handsFree = !talkCall.handsFree;
                talkCall.status = talkCall.handsFree ? '免提连续对话已开启' : '手动说话模式';
                if (talkCall.handsFree && !talkCall.muted) startCallListening();
            };

            onUnmounted(() => {
                clearInterval(talkCallTimer);
                stopCallCamera();
                stopCallListening();
                callTtsStreamController?.close();
                callTtsStreamController = null;
                releaseCallMicStream();
                if ('speechSynthesis' in window) window.speechSynthesis.cancel();
            });

            return { talkCall, callVideoRef, talkCallElapsed, talkCallTimer, callRecognition, callListenToken, callRestartTimer, callAutoSendTimer, callAiHangupPending, callMicStream, callMicPromise, callMicAudioCtx, callMicSource, callMicAnalyser, callRecorder, callRecordStream, callRecordAudioCtx, callRecordMonitorTimer, callRecordStopTimer, callRecordChunks, callRecorderFallbackUntil, callAudio, callSocket, sendCallSocketEvent, connectCallSocket, closeCallSocket, callTokenPattern, hangupTokenPattern, extractCallRefs, stripCallTokens, triggerAiTalkCall, handleAssistantCallRequest, requestAiTalkCall, rejectAiTalkCall, acceptAiTalkCall, clearCallTimers, callMicConstraints, isCallMicLive, warmCallMicStream, ensureCallMicStream, releaseCallMicStream, cleanupCallRecording, abortCallRecording, stopCallListening, scheduleCallListening, joinCallTranscript, afterCallSpeak, speakCallReplyBrowser, playCallAudioUrl, playCallBrowserSentence, pumpCallVoicePipeline, enqueueCallVoiceSentence, drainCallVoiceSentences, startCallVoicePipeline, updateCallVoicePipeline, finishCallVoicePipeline, cancelCallVoicePipeline, speakCallReply, startCallRecorderListening, callSilenceMs, startCallSpeechRecognitionListening, startCallListening, sendCallTurn, attachCallVideoStream, startCallCamera, stopCallCamera, toggleCallCamera, startTalkCall, startVideoTalkCall, syncCallEndedToClaude, endTalkCall, restoreTalkCall, toggleCallMute, toggleHandsFree };
    }
};
