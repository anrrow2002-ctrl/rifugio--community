// Unified TalkCall streaming TTS controller: MiniMax / ElevenLabs / Doubao.
window.Rifugio = window.Rifugio || {};
window.Rifugio.createTalkTtsStreamController = function(options = {}) {
    const STREAM_PROVIDERS = new Set(['minimax', 'elevenlabs', 'doubao']);
    let pipeline = null;
    let audioContext = null;

    const setStatus = (text) => options.onStatus?.(text);
    const setSpeaking = (value) => options.onSpeaking?.(Boolean(value));

    const ensureAudioContext = async () => {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('当前浏览器不支持连续音频播放');
        if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextClass({ sampleRate:24000 });
        if (audioContext.state === 'suspended') await audioContext.resume();
        return audioContext;
    };

    const unlock = () => {
        ensureAudioContext().catch(() => null);
    };

    const stopSources = (target) => {
        if (!target?.sources) return;
        target.sources.forEach(source => {
            try { source.onended = null; source.stop(); } catch (_) {}
        });
        target.sources.clear();
        target.activeSources = 0;
    };

    const send = (type, payload = {}) => options.send?.(type, payload) === true;

    const cancel = () => {
        const target = pipeline;
        if (!target) return;
        if (target.requestId) send('tts.stream.cancel', { request_id:target.requestId });
        stopSources(target);
        target.completed = true;
        pipeline = null;
    };

    const close = () => {
        cancel();
        try { audioContext?.close?.(); } catch (_) {}
        audioContext = null;
    };

    const complete = (target) => {
        if (!target || target.completed || pipeline !== target) return;
        target.completed = true;
        pipeline = null;
        setSpeaking(false);
        options.onComplete?.();
    };

    const maybeComplete = (target) => {
        if (!target || target.completed || pipeline !== target) return;
        if (target.providerEnded && target.activeSources === 0) {
            if (!target.audioStarted && target.finalText && !target.fallbackStarted) {
                target.fallbackStarted = true;
                pipeline = null;
                options.onFallback?.(target.finalText);
                return;
            }
            complete(target);
        }
    };

    const base64Bytes = (value) => {
        const raw = atob(String(value || ''));
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
        return out;
    };

    const schedulePcm = async (target, message) => {
        if (!target || target.completed || pipeline !== target || !message.audio) return;
        const ctx = await ensureAudioContext();
        if (pipeline !== target || target.completed) return;
        let bytes = base64Bytes(message.audio);
        if (target.pcmRemainder?.length) {
            const joined = new Uint8Array(target.pcmRemainder.length + bytes.length);
            joined.set(target.pcmRemainder, 0);
            joined.set(bytes, target.pcmRemainder.length);
            bytes = joined;
            target.pcmRemainder = null;
        }
        if (bytes.length % 2) {
            target.pcmRemainder = bytes.slice(bytes.length - 1);
            bytes = bytes.slice(0, bytes.length - 1);
        }
        const samples = Math.floor(bytes.length / 2);
        if (!samples) return;
        const sampleRate = Math.max(8000, Number(message.sample_rate || target.sampleRate || 24000));
        const audioBuffer = ctx.createBuffer(1, samples, sampleRate);
        const channel = audioBuffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < samples; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        const lead = target.audioStarted ? 0.025 : 0.16;
        const startAt = Math.max(ctx.currentTime + lead, target.nextPlayTime || 0);
        target.nextPlayTime = startAt + audioBuffer.duration;
        target.audioStarted = true;
        target.activeSources += 1;
        target.sources.add(source);
        setSpeaking(true);
        setStatus(`${options.getName?.() || 'Companion'} 回答中…`);
        source.onended = () => {
            target.sources.delete(source);
            target.activeSources = Math.max(0, target.activeSources - 1);
            maybeComplete(target);
        };
        source.start(startAt);
    };

    const fail = (target, message) => {
        if (!target || target.completed || pipeline !== target) return;
        target.failed = true;
        target.error = String(message || '流式 TTS 失败');
        if (target.audioStarted) {
            target.providerEnded = true;
            setStatus('实时语音连接中断，正在收尾…');
            maybeComplete(target);
            return;
        }
        if (target.finalText && !target.fallbackStarted) {
            target.fallbackStarted = true;
            stopSources(target);
            pipeline = null;
            setStatus('实时语音不可用，已切回顺滑模式');
            options.onFallback?.(target.finalText);
        }
    };

    const handleSocketClose = () => {
        if (pipeline) fail(pipeline, '通话 WebSocket 已断开');
    };

    const handleSocketMessage = (raw) => {
        let message;
        try { message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw)); }
        catch (_) { return false; }
        const target = pipeline;
        if (!target || String(message.request_id || '') !== target.requestId) return false;
        if (message.type === 'tts.stream.connecting') {
            setStatus('正在连接实时音色…');
            return true;
        }
        if (message.type === 'tts.stream.ready') {
            target.ready = true;
            target.sampleRate = Number(message.sample_rate || 24000);
            setStatus(`${options.getName?.() || 'Companion'} 正在组织第一句…`);
            return true;
        }
        if (message.type === 'tts.stream.audio') {
            schedulePcm(target, message).catch(error => fail(target, error?.message || error));
            return true;
        }
        if (message.type === 'tts.stream.end') {
            target.providerEnded = true;
            maybeComplete(target);
            return true;
        }
        if (message.type === 'tts.stream.error' || (message.type === 'error' && /tts/i.test(message.code || ''))) {
            fail(target, message.message || message.code || '流式 TTS 失败');
            return true;
        }
        return message.type === 'tts.stream.ack';
    };

    const enqueueText = (target, text) => {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!clean || !target || target.completed || pipeline !== target) return false;
        const seq = ++target.inputSeq;
        if (!send('tts.stream.text', { request_id:target.requestId, seq, text:clean })) {
            fail(target, '通话 WebSocket 未连接');
            return false;
        }
        target.committed += text;
        return true;
    };

    const drain = (target, flush = false) => {
        if (!target || target.completed || pipeline !== target) return;
        const strongBoundary = /[。！？!?；;\n]/;
        while (target.buffer) {
            const match = strongBoundary.exec(target.buffer);
            let cut = match ? match.index + match[0].length : 0;
            if (!cut && target.buffer.length >= 96) {
                const windowText = target.buffer.slice(0, 96);
                const comma = Math.max(windowText.lastIndexOf('，'), windowText.lastIndexOf(','));
                cut = comma >= 36 ? comma + 1 : 72;
            }
            if (!cut) break;
            const phrase = target.buffer.slice(0, cut);
            target.buffer = target.buffer.slice(cut);
            enqueueText(target, phrase);
        }
        if (flush && target.buffer.trim()) {
            enqueueText(target, target.buffer);
            target.buffer = '';
        }
    };

    const start = () => {
        const provider = String(options.getProvider?.() || '').toLowerCase();
        if (!STREAM_PROVIDERS.has(provider)) return false;
        if (!options.isSocketOpen?.()) return false;
        cancel();
        let streamOptions;
        try {
            streamOptions = { ...(options.getStreamOptions?.() || {}), provider };
            delete streamOptions.text;
        } catch (_) {
            return false;
        }
        const requestId = `call-tts-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const target = {
            requestId,
            provider,
            seen:'',
            committed:'',
            buffer:'',
            inputSeq:0,
            sampleRate:24000,
            nextPlayTime:0,
            activeSources:0,
            sources:new Set(),
            pcmRemainder:null,
            ready:false,
            finished:false,
            providerEnded:false,
            audioStarted:false,
            failed:false,
            fallbackStarted:false,
            completed:false,
            finalText:'',
        };
        pipeline = target;
        if (!send('tts.stream.start', { request_id:requestId, options:streamOptions })) {
            pipeline = null;
            return false;
        }
        setSpeaking(true);
        setStatus('正在连接实时音色…');
        return true;
    };

    const update = (content) => {
        const target = pipeline;
        if (!target || target.completed || target.finished) return false;
        const clean = String(options.cleanText?.(content) ?? content ?? '');
        if (clean.startsWith(target.seen)) {
            target.buffer += clean.slice(target.seen.length);
            target.seen = clean;
        } else if (clean.startsWith(target.committed)) {
            target.seen = clean;
            target.buffer = clean.slice(target.committed.length);
        } else {
            // 已经送出的前缀绝不回滚；等待后续单调增长快照，避免旧内容再次进入 TTS。
            target.seen = clean;
            return true;
        }
        drain(target, false);
        return true;
    };

    const finish = (content = '') => {
        const target = pipeline;
        if (!target || target.completed) return false;
        update(content);
        target.finalText = String(options.cleanText?.(content) ?? content ?? '').trim();
        drain(target, true);
        target.finished = true;
        if (target.failed && !target.audioStarted) {
            stopSources(target);
            pipeline = null;
            return false;
        }
        if (!send('tts.stream.finish', { request_id:target.requestId })) {
            stopSources(target);
            pipeline = null;
            return false;
        }
        return true;
    };

    return {
        unlock,
        start,
        update,
        finish,
        cancel,
        close,
        handleSocketMessage,
        handleSocketClose,
        isActive:() => Boolean(pipeline),
    };
};
