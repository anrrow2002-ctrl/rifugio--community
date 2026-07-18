const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { synthesizeSpeech } = require('../voice-gateway');
const { createTtsStream, normalizeProvider } = require('./tts-stream');

const TALK_CALL_WS_PATH = '/ws/talk-call';
const MAX_MESSAGE_BYTES = 256 * 1024;
const AUDIO_CHUNK_BYTES = 24 * 1024;
const STREAM_PROVIDERS = new Set(['minimax', 'elevenlabs', 'doubao']);

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

function safeRequestId(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120) || crypto.randomUUID();
}

function mountTalkCallWebSocket(server, deps = {}) {
  const { isAuthed, loadTtsSettings = () => ({}) } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    if (pathname !== TALK_CALL_WS_PATH) return;
    if (typeof isAuthed === 'function' && !isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const connectionId = crypto.randomUUID();
    const streams = new Map();
    const completedLegacy = new Set();
    let alive = true;

    const cancelStream = (requestId) => {
      const entry = streams.get(requestId);
      if (!entry) return;
      streams.delete(requestId);
      try { entry.adapter?.cancel(); } catch (_) {}
    };

    const cancelAllStreams = () => {
      for (const requestId of [...streams.keys()]) cancelStream(requestId);
    };

    const startStream = (msg, requestId) => {
      cancelStream(requestId);
      const config = { ...loadTtsSettings(), ...(msg.options || {}) };
      const provider = normalizeProvider(config.provider);
      if (!STREAM_PROVIDERS.has(provider)) {
        sendJson(ws, { type:'tts.stream.error', request_id:requestId, code:'stream_provider_unsupported', message:'当前供应商不支持通话流式 TTS' });
        return;
      }
      const entry = { adapter:null, lastInputSeq:0, outputSeq:0, provider };
      streams.set(requestId, entry);
      try {
        entry.adapter = createTtsStream(config, {
          onReady: meta => {
            if (streams.get(requestId) !== entry) return;
            sendJson(ws, { type:'tts.stream.ready', request_id:requestId, ...meta });
          },
          onAudio: buffer => {
            if (streams.get(requestId) !== entry) return;
            for (let offset = 0; offset < buffer.length; offset += AUDIO_CHUNK_BYTES) {
              const chunk = buffer.subarray(offset, offset + AUDIO_CHUNK_BYTES);
              sendJson(ws, {
                type:'tts.stream.audio',
                request_id:requestId,
                seq:++entry.outputSeq,
                encoding:'pcm_s16le',
                sample_rate:24000,
                channels:1,
                audio:chunk.toString('base64'),
              });
            }
          },
          onEnd: meta => {
            if (streams.get(requestId) !== entry) return;
            streams.delete(requestId);
            sendJson(ws, { type:'tts.stream.end', request_id:requestId, chunks:entry.outputSeq, ...meta });
          },
          onError: error => {
            if (streams.get(requestId) !== entry) return;
            streams.delete(requestId);
            sendJson(ws, {
              type:'tts.stream.error',
              request_id:requestId,
              code:'upstream_stream_failed',
              provider,
              message:String(error?.message || error).slice(0, 220),
            });
          },
        });
        sendJson(ws, { type:'tts.stream.connecting', request_id:requestId, provider });
      } catch (error) {
        streams.delete(requestId);
        sendJson(ws, {
          type:'tts.stream.error',
          request_id:requestId,
          code:'stream_start_failed',
          provider,
          message:String(error?.message || error).slice(0, 220),
        });
      }
    };

    ws.on('pong', () => { alive = true; });
    sendJson(ws, {
      type:'ready',
      protocol:'rifugio-talkcall-v2',
      connection_id:connectionId,
      tts_stream_providers:[...STREAM_PROVIDERS],
      tts_stream_encoding:'pcm_s16le',
      tts_stream_sample_rate:24000,
    });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        sendJson(ws, { type:'error', code:'binary_input_not_enabled', message:'binary microphone streaming is reserved for the STT adapter' });
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); }
      catch (_) { sendJson(ws, { type:'error', code:'bad_json' }); return; }
      const requestId = safeRequestId(msg.request_id);

      if (msg.type === 'ping') {
        sendJson(ws, { type:'pong', request_id:requestId, at:Date.now() });
        return;
      }
      if (msg.type === 'call.start') {
        sendJson(ws, { type:'ack', event:msg.type, request_id:requestId, at:Date.now() });
        return;
      }
      if (msg.type === 'call.stop') {
        cancelAllStreams();
        sendJson(ws, { type:'ack', event:msg.type, request_id:requestId, at:Date.now() });
        return;
      }
      if (msg.type === 'stt.interim' || msg.type === 'stt.final' || msg.type === 'voice.context') {
        sendJson(ws, { type:'ack', event:msg.type, request_id:requestId, at:Date.now() });
        return;
      }

      if (msg.type === 'tts.stream.start') {
        startStream(msg, requestId);
        return;
      }
      if (msg.type === 'tts.stream.text') {
        const entry = streams.get(requestId);
        if (!entry) {
          sendJson(ws, { type:'tts.stream.error', request_id:requestId, code:'stream_not_found' });
          return;
        }
        const seq = Math.max(0, Number(msg.seq || 0));
        if (seq && seq <= entry.lastInputSeq) {
          sendJson(ws, { type:'tts.stream.ack', request_id:requestId, seq, duplicate:true });
          return;
        }
        const text = String(msg.text || '').trim();
        if (!text || text.length > 1000) {
          sendJson(ws, { type:'tts.stream.error', request_id:requestId, code:'invalid_tts_text' });
          return;
        }
        if (seq) entry.lastInputSeq = seq;
        entry.adapter.append(text);
        sendJson(ws, { type:'tts.stream.ack', request_id:requestId, seq });
        return;
      }
      if (msg.type === 'tts.stream.finish') {
        const entry = streams.get(requestId);
        if (entry) entry.adapter.finish();
        return;
      }
      if (msg.type === 'tts.stream.cancel') {
        cancelStream(requestId);
        sendJson(ws, { type:'tts.stream.canceled', request_id:requestId });
        return;
      }

      if (msg.type !== 'tts.synthesize') {
        sendJson(ws, { type:'error', code:'unsupported_event', request_id:requestId });
        return;
      }
      if (completedLegacy.has(requestId)) {
        sendJson(ws, { type:'tts.duplicate', request_id:requestId });
        return;
      }
      const text = String(msg.text || '').trim();
      if (!text || text.length > 1000) {
        sendJson(ws, { type:'error', code:'invalid_tts_text', request_id:requestId });
        return;
      }
      completedLegacy.add(requestId);
      if (completedLegacy.size > 100) completedLegacy.delete(completedLegacy.values().next().value);
      try {
        sendJson(ws, { type:'tts.start', request_id:requestId });
        const result = await synthesizeSpeech({ ...loadTtsSettings(), ...(msg.options || {}), text });
        const total = Math.ceil(result.buffer.length / AUDIO_CHUNK_BYTES);
        for (let index = 0; index < total; index += 1) {
          if (ws.readyState !== WebSocket.OPEN) return;
          const chunk = result.buffer.subarray(index * AUDIO_CHUNK_BYTES, (index + 1) * AUDIO_CHUNK_BYTES);
          sendJson(ws, {
            type:'tts.chunk', request_id:requestId, index, total,
            content_type:result.contentType || 'audio/mpeg',
            audio:chunk.toString('base64'),
          });
        }
        sendJson(ws, { type:'tts.end', request_id:requestId, chunks:total, provider:result.provider || '' });
      } catch (error) {
        sendJson(ws, { type:'error', code:'tts_failed', request_id:requestId, message:String(error?.message || error).slice(0, 220) });
      }
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat);
        cancelAllStreams();
        ws.terminate();
        return;
      }
      alive = false;
      try { ws.ping(); } catch (_) {}
    }, 30000);
    ws.on('close', () => { clearInterval(heartbeat); cancelAllStreams(); });
    ws.on('error', () => { clearInterval(heartbeat); cancelAllStreams(); });
  });

  return wss;
}

module.exports = { mountTalkCallWebSocket, TALK_CALL_WS_PATH };
