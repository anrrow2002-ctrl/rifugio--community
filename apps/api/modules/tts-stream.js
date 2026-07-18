const crypto = require('crypto');
const { WebSocket } = require('ws');

const PCM_SAMPLE_RATE = 24000;
const PCM_CHANNELS = 1;

function asText(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeProvider(value) {
  const raw = asText(value).toLowerCase();
  if (raw === 'eleven') return 'elevenlabs';
  if (raw === 'volcengine' || raw === 'bytedance') return 'doubao';
  return raw;
}

function pick(config, keys, fallback = '') {
  for (const key of keys) {
    const value = asText(config?.[key]);
    if (value) return value;
  }
  return asText(fallback);
}

function errorText(error, fallback = 'TTS stream failed') {
  return asText(error?.message || error, fallback).slice(0, 220);
}

class ProviderTtsStream {
  constructor(config, callbacks = {}) {
    this.config = config || {};
    this.callbacks = callbacks;
    this.provider = normalizeProvider(this.config.provider);
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.ended = false;
    this.finishRequested = false;
    this.pendingText = [];
    this.audioSequence = 0;
  }

  emitReady(extra = {}) {
    if (this.closed || this.ready) return;
    this.ready = true;
    this.callbacks.onReady?.({
      provider: this.provider,
      encoding: 'pcm_s16le',
      sample_rate: PCM_SAMPLE_RATE,
      channels: PCM_CHANNELS,
      ...extra,
    });
    this.flush();
  }

  emitAudio(buffer) {
    if (!this.closed && buffer?.length) this.callbacks.onAudio?.(Buffer.from(buffer), ++this.audioSequence);
  }

  append(text) {
    const clean = asText(text);
    if (!clean || this.closed || this.finishRequested) return false;
    this.pendingText.push(clean);
    this.flush();
    return true;
  }

  finish() {
    if (this.closed || this.finishRequested) return;
    this.finishRequested = true;
    this.flush();
  }

  flush() {
    if (!this.ready || this.closed) return;
    while (this.pendingText.length) this.sendText(this.pendingText.shift());
    if (this.finishRequested) this.sendFinish();
  }

  end(extra = {}) {
    if (this.ended) return;
    this.ended = true;
    this.closed = true;
    this.callbacks.onEnd?.({ provider: this.provider, ...extra });
    try { this.socket?.close(1000); } catch (_) {}
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.onError?.(new Error(errorText(error)));
    try { this.socket?.terminate?.(); } catch (_) {}
  }

  cancel() {
    if (this.closed) return;
    try { this.sendCancel?.(); } catch (_) {}
    this.closed = true;
    try { this.socket?.close(1000); } catch (_) {}
  }
}

class MiniMaxTtsStream extends ProviderTtsStream {
  constructor(config, callbacks) {
    super({ ...config, provider: 'minimax' }, callbacks);
    const apiKey = pick(config, ['api_key', 'apiKey']);
    this.voiceId = pick(config, ['voice_id', 'voiceId']);
    if (!apiKey) throw new Error('MiniMax api_key required');
    if (!this.voiceId) throw new Error('MiniMax voice_id required');
    const base = pick(config, ['stream_url', 'streamUrl', 'base_url', 'baseUrl'], 'https://api.minimax.io');
    const host = /minimaxi\.(?:com|chat)/i.test(base) ? 'api.minimaxi.com' : 'api.minimax.io';
    const url = /^wss:\/\//i.test(base) && /\/ws\/v1\/t2a_v2/i.test(base)
      ? base
      : `wss://${host}/ws/v1/t2a_v2`;
    this.socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: 12000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.socket.on('message', data => this.handleMessage(data));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => {
      if (!this.closed && !this.ended) this.fail('MiniMax TTS stream closed early');
    });
  }

  handleMessage(data) {
    if (this.closed) return;
    let message;
    try { message = JSON.parse(String(data)); } catch (_) { return; }
    const code = Number(message?.base_resp?.status_code || 0);
    if (code) return this.fail(message?.base_resp?.status_msg || `MiniMax TTS error ${code}`);
    if (message.event === 'connected_success') {
      this.socket.send(JSON.stringify({
        event: 'task_start',
        model: pick(this.config, ['model'], 'speech-2.8-turbo'),
        language_boost: pick(this.config, ['language_boost', 'languageCode', 'language_code'], 'auto'),
        voice_setting: {
          voice_id: this.voiceId,
          speed: clampNumber(this.config.speed, 0.5, 2, 1),
          vol: clampNumber(this.config.volume ?? this.config.vol, 0.1, 10, 1),
          pitch: clampNumber(this.config.pitch, -12, 12, 0),
        },
        audio_setting: { sample_rate: PCM_SAMPLE_RATE, bitrate: 128000, format: 'pcm', channel: PCM_CHANNELS },
      }));
      return;
    }
    if (message.event === 'task_started') {
      this.emitReady({ model: pick(this.config, ['model'], 'speech-2.8-turbo') });
      return;
    }
    const audio = asText(message?.data?.audio);
    if (audio) this.emitAudio(/^[0-9a-f]+$/i.test(audio) ? Buffer.from(audio, 'hex') : Buffer.from(audio, 'base64'));
    if (message.event === 'task_failed') this.fail(message?.base_resp?.status_msg || 'MiniMax task failed');
    else if (message.event === 'task_finished') this.end();
  }

  sendText(text) {
    this.socket.send(JSON.stringify({ event: 'task_continue', text }));
  }

  sendFinish() {
    this.socket.send(JSON.stringify({ event: 'task_finish' }));
  }

  sendCancel() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ event: 'task_finish' }));
  }
}

class ElevenLabsTtsStream extends ProviderTtsStream {
  constructor(config, callbacks) {
    super({ ...config, provider: 'elevenlabs' }, callbacks);
    const apiKey = pick(config, ['api_key', 'apiKey']);
    const voiceId = pick(config, ['voice_id', 'voiceId']);
    const model = pick(config, ['model'], 'eleven_flash_v2_5');
    if (!apiKey) throw new Error('ElevenLabs api_key required');
    if (!voiceId) throw new Error('ElevenLabs voice_id required');
    if (model === 'eleven_v3') throw new Error('ElevenLabs eleven_v3 does not support the TTS WebSocket endpoint');
    const url = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`);
    url.searchParams.set('model_id', model);
    url.searchParams.set('output_format', 'pcm_24000');
    url.searchParams.set('auto_mode', 'true');
    url.searchParams.set('inactivity_timeout', '180');
    this.socket = new WebSocket(url, {
      headers: { 'xi-api-key': apiKey },
      handshakeTimeout: 12000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.socket.on('open', () => {
      this.socket.send(JSON.stringify({
        text: ' ',
        voice_settings: {
          stability: clampNumber(config.stability, 0, 1, 0.5),
          similarity_boost: clampNumber(config.similarity_boost ?? config.similarityBoost, 0, 1, 0.75),
          style: clampNumber(config.style, 0, 1, 0),
          use_speaker_boost: config.use_speaker_boost !== false && config.useSpeakerBoost !== false,
          speed: clampNumber(config.speed, 0.7, 1.2, 1),
        },
      }));
      this.emitReady({ model });
    });
    this.socket.on('message', data => this.handleMessage(data));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => {
      if (!this.closed && !this.ended) this.fail('ElevenLabs TTS stream closed early');
    });
  }

  handleMessage(data) {
    if (this.closed) return;
    let message;
    try { message = JSON.parse(String(data)); } catch (_) { return; }
    if (message.error || message.detail) return this.fail(message.error || message.detail);
    const audio = asText(message.audio);
    if (audio) this.emitAudio(Buffer.from(audio, 'base64'));
    if (message.isFinal === true || message.is_final === true) this.end();
  }

  sendText(text) {
    this.socket.send(JSON.stringify({ text: text + ' ', try_trigger_generation: true }));
  }

  sendFinish() {
    this.socket.send(JSON.stringify({ text: '' }));
  }

  sendCancel() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ text: '' }));
  }
}

const DOUBAO_MSG = { FullClientRequest: 1, FullServerResponse: 9, AudioOnlyServer: 11, FrontEndResultServer: 12, Error: 15 };
const DOUBAO_EVENT = {
  StartConnection: 1, FinishConnection: 2,
  ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52,
  StartSession: 100, CancelSession: 101, FinishSession: 102,
  SessionStarted: 150, SessionCanceled: 151, SessionFinished: 152, SessionFailed: 153,
  TaskRequest: 200, TTSSentenceStart: 350, TTSSentenceEnd: 351, TTSResponse: 352,
};

function doubaoHasSession(event) {
  return ![
    DOUBAO_EVENT.StartConnection, DOUBAO_EVENT.FinishConnection,
    DOUBAO_EVENT.ConnectionStarted, DOUBAO_EVENT.ConnectionFailed, DOUBAO_EVENT.ConnectionFinished,
  ].includes(event);
}

function doubaoFrame(event, sessionId = '', payload = {}) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const sessionBuffer = doubaoHasSession(event) ? Buffer.from(asText(sessionId)) : Buffer.alloc(0);
  const frame = Buffer.allocUnsafe(12 + (doubaoHasSession(event) ? 4 + sessionBuffer.length : 0) + payloadBuffer.length);
  frame[0] = 0x11;
  frame[1] = (DOUBAO_MSG.FullClientRequest << 4) | 0x04;
  frame[2] = 0x10;
  frame[3] = 0x00;
  let offset = 4;
  frame.writeInt32BE(event, offset); offset += 4;
  if (doubaoHasSession(event)) {
    frame.writeUInt32BE(sessionBuffer.length, offset); offset += 4;
    sessionBuffer.copy(frame, offset); offset += sessionBuffer.length;
  }
  frame.writeUInt32BE(payloadBuffer.length, offset); offset += 4;
  payloadBuffer.copy(frame, offset);
  return frame;
}

function readSizedBuffer(buffer, state) {
  if (state.offset + 4 > buffer.length) throw new Error('Doubao frame truncated');
  const size = buffer.readUInt32BE(state.offset); state.offset += 4;
  if (state.offset + size > buffer.length) throw new Error('Doubao frame payload truncated');
  const out = buffer.subarray(state.offset, state.offset + size);
  state.offset += size;
  return out;
}

function parseDoubaoFrame(data) {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) throw new Error('Doubao frame too short');
  const headerBytes = (buffer[0] & 0x0f) * 4;
  const type = buffer[1] >> 4;
  const flag = buffer[1] & 0x0f;
  const state = { offset: headerBytes };
  let sequence = 0;
  let errorCode = 0;
  if ([1, 9, 11, 12].includes(type) && (flag === 1 || flag === 3)) {
    sequence = buffer.readInt32BE(state.offset); state.offset += 4;
  } else if (type === DOUBAO_MSG.Error) {
    errorCode = buffer.readUInt32BE(state.offset); state.offset += 4;
  }
  let event = 0;
  let sessionId = '';
  let connectId = '';
  if (flag === 4) {
    event = buffer.readInt32BE(state.offset); state.offset += 4;
    if (doubaoHasSession(event)) sessionId = readSizedBuffer(buffer, state).toString('utf8');
    if ([50, 51, 52].includes(event)) connectId = readSizedBuffer(buffer, state).toString('utf8');
  }
  const payload = readSizedBuffer(buffer, state);
  return { type, flag, event, sessionId, connectId, sequence, errorCode, payload };
}

function doubaoRate(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.max(-50, Math.min(100, (n - 1) * 100))) : fallback;
}

class DoubaoTtsStream extends ProviderTtsStream {
  constructor(config, callbacks) {
    super({ ...config, provider: 'doubao' }, callbacks);
    const apiKey = pick(config, ['api_key', 'apiKey']);
    this.speaker = pick(config, ['speaker', 'voice_id', 'voiceId', 'voice']);
    this.resourceId = pick(config, ['resource_id', 'resourceId', 'resource', 'model'], 'seed-tts-2.0');
    if (/^S_/i.test(this.speaker) && (!this.resourceId || this.resourceId === 'seed-tts-2.0' || /^volcano_/i.test(this.resourceId))) this.resourceId = 'seed-icl-2.0';
    if (!apiKey) throw new Error('Doubao X-Api-Key required');
    if (!this.speaker) throw new Error('Doubao speaker required');
    this.sessionId = crypto.randomUUID();
    this.connectionFinishedTimer = null;
    const streamUrl = pick(config, ['stream_url', 'streamUrl'], 'wss://openspeech.bytedance.com/api/v3/tts/bidirection');
    this.socket = new WebSocket(streamUrl, {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': this.resourceId,
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
      handshakeTimeout: 12000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.socket.on('open', () => this.socket.send(doubaoFrame(DOUBAO_EVENT.StartConnection)));
    this.socket.on('message', (data, isBinary) => { if (isBinary !== false) this.handleMessage(data); });
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => {
      clearTimeout(this.connectionFinishedTimer);
      if (!this.closed && !this.ended) this.fail('Doubao TTS stream closed early');
    });
  }

  handleMessage(data) {
    if (this.closed) return;
    let message;
    try { message = parseDoubaoFrame(data); } catch (error) { return this.fail(error); }
    if (message.type === DOUBAO_MSG.Error) return this.fail(`Doubao TTS error ${message.errorCode}: ${message.payload.toString('utf8')}`);
    if (message.event === DOUBAO_EVENT.ConnectionFailed || message.event === DOUBAO_EVENT.SessionFailed) {
      return this.fail(message.payload.toString('utf8') || 'Doubao TTS session failed');
    }
    if (message.event === DOUBAO_EVENT.ConnectionStarted) {
      const reqParams = {
        speaker: this.speaker,
        audio_params: {
          format: 'pcm',
          sample_rate: PCM_SAMPLE_RATE,
          speech_rate: this.config.speech_rate != null
            ? Math.round(clampNumber(this.config.speech_rate, -50, 100, 0))
            : doubaoRate(this.config.speed ?? this.config.speed_ratio, 0),
          loudness_rate: this.config.loudness_rate != null
            ? Math.round(clampNumber(this.config.loudness_rate, -50, 100, 0))
            : doubaoRate(this.config.volume ?? this.config.volume_ratio, 0),
        },
      };
      const requestModel = pick(this.config, ['req_model', 'request_model', 'requestModel']);
      if (requestModel) reqParams.model = requestModel;
      const contextTexts = Array.isArray(this.config.context_texts) ? this.config.context_texts.map(value => asText(value)).filter(Boolean) : [];
      const instructions = pick(this.config, ['instructions', 'context_text']);
      if (contextTexts.length) reqParams.context_texts = contextTexts;
      else if (instructions) reqParams.context_texts = [instructions];
      const useTagParser = this.config.use_tag_parser ?? this.config.useTagParser;
      if (useTagParser !== undefined && useTagParser !== '') reqParams.use_tag_parser = useTagParser !== false && String(useTagParser).toLowerCase() !== 'false';
      const emotionScale = Number(this.config.emotion_scale ?? this.config.emotionScale);
      if (Number.isFinite(emotionScale)) reqParams.emotion_scale = emotionScale;
      const pitch = Number(this.config.pitch);
      if (Number.isFinite(pitch)) reqParams.post_process = { pitch: Math.round(clampNumber(pitch, -12, 12, 0)) };
      this.socket.send(doubaoFrame(DOUBAO_EVENT.StartSession, this.sessionId, { req_params: reqParams }));
      return;
    }
    if (message.event === DOUBAO_EVENT.SessionStarted) return this.emitReady({ resource_id: this.resourceId });
    if (message.event === DOUBAO_EVENT.TTSResponse) return this.emitAudio(message.payload);
    if (message.event === DOUBAO_EVENT.SessionFinished || message.event === DOUBAO_EVENT.SessionCanceled) {
      this.socket.send(doubaoFrame(DOUBAO_EVENT.FinishConnection));
      this.connectionFinishedTimer = setTimeout(() => this.end(), 600);
      return;
    }
    if (message.event === DOUBAO_EVENT.ConnectionFinished) {
      clearTimeout(this.connectionFinishedTimer);
      this.end();
    }
  }

  sendText(text) {
    this.socket.send(doubaoFrame(DOUBAO_EVENT.TaskRequest, this.sessionId, { text }));
  }

  sendFinish() {
    this.socket.send(doubaoFrame(DOUBAO_EVENT.FinishSession, this.sessionId));
  }

  sendCancel() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(doubaoFrame(DOUBAO_EVENT.CancelSession, this.sessionId));
  }
}

function createTtsStream(config = {}, callbacks = {}) {
  const provider = normalizeProvider(config.provider);
  if (provider === 'minimax') return new MiniMaxTtsStream(config, callbacks);
  if (provider === 'elevenlabs') return new ElevenLabsTtsStream(config, callbacks);
  if (provider === 'doubao') return new DoubaoTtsStream(config, callbacks);
  throw new Error('streaming TTS unsupported for provider: ' + (provider || '(empty)'));
}

module.exports = {
  PCM_SAMPLE_RATE,
  PCM_CHANNELS,
  createTtsStream,
  normalizeProvider,
  doubaoFrame,
  parseDoubaoFrame,
  DOUBAO_EVENT,
};
