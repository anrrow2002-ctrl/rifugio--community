const crypto = require('crypto');

function asText(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bufferFromMaybeEncodedAudio(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') return null;
  const raw = asText(value);
  if (!raw) return null;
  const data = raw.replace(/^data:audio\/[^;]+;base64,/i, '');
  if (/^[0-9a-f]+$/i.test(data) && data.length % 2 === 0) return Buffer.from(data, 'hex');
  return Buffer.from(data, 'base64');
}

function responseContentType(resp, fallback = 'audio/mpeg') {
  return asText(resp?.headers?.get?.('content-type'), fallback).split(';')[0] || fallback;
}

function audioContentType(format) {
  const f = asText(format, 'mp3').replace(/^audio\//i, '').toLowerCase();
  if (f === 'mp3') return 'audio/mpeg';
  if (f === 'wav') return 'audio/wav';
  if (f === 'ogg' || f === 'ogg_opus' || f === 'opus') return 'audio/ogg';
  if (f === 'pcm') return 'audio/pcm';
  return `audio/${f}`;
}

function pickTtsValue(body, keys = [], envKeys = [], opts = {}, fallback = '') {
  for (const key of keys) {
    const value = asText(body?.[key]);
    if (value) return value;
  }
  if (opts.allowEnv !== false) {
    for (const key of envKeys) {
      const value = asText(process.env[key]);
      if (value) return value;
    }
  }
  return asText(fallback);
}

async function synthesizeOpenAI(body, opts = {}) {
  const apiKey = pickTtsValue(body, ['api_key', 'apiKey'], ['OPENAI_API_KEY', 'TTS_API_KEY'], opts);
  const text = asText(body.text);
  if (!apiKey) throw new Error('OpenAI TTS api_key required');
  if (!text) throw new Error('text required');
  const base = pickTtsValue(body, ['base_url', 'baseUrl'], ['OPENAI_TTS_BASE_URL'], opts, 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = /\/audio\/speech$/i.test(base) ? base : `${base.replace(/\/v1$/i, '/v1')}/audio/speech`;
  const responseFormat = asText(body.response_format || body.format || body.encoding, 'mp3').replace(/^audio\//i, '');
  const payload = {
    model: asText(body.model, 'gpt-4o-mini-tts'),
    input: text,
    voice: pickTtsValue(body, ['voice_id', 'voiceId', 'voice'], ['OPENAI_TTS_VOICE'], opts, 'coral'),
    response_format: responseFormat,
    speed: clampNumber(body.speed, 0.25, 4, 1),
  };
  const instructions = asText(body.instructions || body.style_prompt || body.prompt);
  if (instructions) payload.instructions = instructions;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error('OpenAI TTS HTTP ' + r.status + ': ' + buffer.toString('utf8').slice(0, 220));
  return { provider: 'openai', contentType: responseContentType(r, `audio/${responseFormat === 'mp3' ? 'mpeg' : responseFormat}`), buffer };
}

function parseJsonObjects(raw) {
  const text = asText(raw);
  if (!text) return [];
  try { return [JSON.parse(text)]; } catch (_) {}
  const fromLines = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^data:\s*/i, '');
    if (!trimmed || trimmed === '[DONE]') continue;
    try { fromLines.push(JSON.parse(trimmed)); } catch (_) {}
  }
  if (fromLines.length) return fromLines;

  const out = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (_) {}
        start = -1;
      }
    }
  }
  return out;
}

function doubaoRatioToRate(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(-50, Math.min(100, (n - 1) * 100)));
}

function doubaoIntParam(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(min, Math.min(max, n)));
}

async function synthesizeDoubaoV3(body, opts = {}) {
  const apiKey = pickTtsValue(body, ['api_key', 'apiKey'], ['DOUBAO_TTS_API_KEY'], opts);
  const text = asText(body.text ?? body.input);
  const speaker = pickTtsValue(body, ['speaker', 'voice_id', 'voiceId', 'voice', 'voice_type', 'voiceType'], ['DOUBAO_TTS_VOICE_ID'], opts);
  const isCloneSpeaker = /^S_/i.test(speaker);
  const modelValue = asText(body.model);
  const modelLooksLikeResource = /^(seed-(?:tts|icl)-2\.0|volcano_)/i.test(modelValue);
  const bodyResourceId = pickTtsValue(body, ['resource_id', 'resourceId', 'resource'], [], opts);
  const envResourceId = pickTtsValue({}, [], ['DOUBAO_TTS_RESOURCE_ID', 'DOUBAO_TTS_CLUSTER'], opts);
  const requestedResourceId = bodyResourceId || envResourceId || (modelLooksLikeResource ? modelValue : '') || 'seed-tts-2.0';
  const resourceId = isCloneSpeaker && (!requestedResourceId || requestedResourceId === 'seed-tts-2.0' || /^volcano_/i.test(requestedResourceId))
    ? 'seed-icl-2.0'
    : requestedResourceId;
  if (!apiKey) throw new Error('Doubao X-Api-Key required');
  if (!resourceId) throw new Error('Doubao X-Api-Resource-Id required');
  if (!speaker) throw new Error('Doubao speaker required');
  if (!text) throw new Error('text required');

  const rawBaseUrl = pickTtsValue(body, ['base_url', 'baseUrl'], ['DOUBAO_TTS_BASE_URL'], opts, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  const baseUrl = isCloneSpeaker && /\/api\/v1\/tts\b/i.test(rawBaseUrl)
    ? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
    : rawBaseUrl;
  const requestId = asText(body.request_id || body.requestId || body.reqid, crypto.randomUUID());
  const format = asText(body.format || body.encoding || body.output_format || body.response_format, 'mp3').replace(/^audio\//i, '');
  const audioParams = { format };
  const sampleRate = doubaoIntParam(body.sample_rate || body.sampleRate, 8000, 48000, 24000);
  const bitRate = doubaoIntParam(body.bit_rate || body.bitRate || body.bitrate, 64000, 320000, format === 'mp3' ? 128000 : undefined);
  if (sampleRate) audioParams.sample_rate = sampleRate;
  if (format === 'mp3' && bitRate) audioParams.bit_rate = bitRate;
  audioParams.speech_rate = body.speech_rate != null
    ? doubaoIntParam(body.speech_rate, -50, 100, 0)
    : doubaoRatioToRate(body.speed ?? body.speed_ratio, 0);
  audioParams.loudness_rate = body.loudness_rate != null
    ? doubaoIntParam(body.loudness_rate, -50, 100, 0)
    : doubaoRatioToRate(body.volume ?? body.volume_ratio, 0);
  if (body.enable_subtitle != null) audioParams.enable_subtitle = Boolean(body.enable_subtitle);

  const reqParams = {
    text,
    speaker,
    audio_params: audioParams,
  };
  const requestModel = asText(body.req_model || body.request_model || body.doubao_model || (!modelLooksLikeResource ? body.model : ''));
  if (requestModel) reqParams.model = requestModel;
  const ssml = asText(body.ssml);
  if (ssml) reqParams.ssml = ssml;
  const contextTexts = Array.isArray(body.context_texts)
    ? body.context_texts.map(v => asText(v)).filter(Boolean)
    : [];
  const instructions = asText(body.instructions || body.context_text);
  if (contextTexts.length) reqParams.context_texts = contextTexts;
  else if (instructions) reqParams.context_texts = [instructions];
  const useTagParser = body.use_tag_parser ?? body.useTagParser;
  if (useTagParser !== undefined && useTagParser !== '') reqParams.use_tag_parser = useTagParser !== false && String(useTagParser).toLowerCase() !== 'false';
  const emotionScale = Number(body.emotion_scale ?? body.emotionScale);
  if (Number.isFinite(emotionScale)) reqParams.emotion_scale = emotionScale;
  const pitch = body.post_process_pitch ?? body.pitch;
  if (pitch !== undefined && pitch !== '') {
    reqParams.post_process = { pitch: doubaoIntParam(pitch, -12, 12, 0) };
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
  };
  if (body.require_usage_tokens || body.usage_tokens) headers['X-Control-Require-Usage-Tokens-Return'] = '*';
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ req_params: reqParams }),
  });
  const contentType = responseContentType(r, 'application/json');
  if (/^audio\//i.test(contentType) || /^application\/octet-stream/i.test(contentType)) {
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!r.ok) throw new Error('Doubao TTS HTTP ' + r.status + ': ' + buffer.toString('utf8').slice(0, 220));
    return { provider: 'doubao', contentType: audioContentType(format), buffer };
  }

  const raw = await r.text();
  const jsonChunks = parseJsonObjects(raw);
  const chunks = [];
  let upstreamMessage = raw.slice(0, 220);
  for (const j of jsonChunks) {
    const code = j?.code ?? j?.base_resp?.status_code ?? 0;
    upstreamMessage = asText(j?.message || j?.msg || j?.base_resp?.status_msg || j?.base_resp?.message || upstreamMessage).slice(0, 220);
    if (code && code !== 0 && code !== 20000000) throw new Error('Doubao TTS: ' + (upstreamMessage || code) + ` (code ${code})`);
    const audio = j?.data || j?.result?.data || j?.audio || j?.result?.audio || j?.result?.audio_base64;
    const buffer = bufferFromMaybeEncodedAudio(audio);
    if (buffer?.length) chunks.push(buffer);
  }
  if (!r.ok) throw new Error('Doubao TTS HTTP ' + r.status + ': ' + upstreamMessage);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error('Doubao TTS did not return audio data');
  return { provider: 'doubao', contentType: audioContentType(format), buffer };
}

async function synthesizeDoubaoV1(body, opts = {}) {
  const apiKey = pickTtsValue(body, ['api_key', 'apiKey'], ['DOUBAO_TTS_API_KEY'], opts);
  const token = pickTtsValue(body, ['token', 'access_token', 'accessToken'], ['DOUBAO_TTS_TOKEN'], opts);
  const appid = pickTtsValue(body, ['appid', 'app_id', 'appId'], ['DOUBAO_TTS_APPID'], opts);
  const voiceId = pickTtsValue(body, ['voice_id', 'voiceId', 'voice', 'voice_type', 'voiceType'], ['DOUBAO_TTS_VOICE_ID'], opts);
  const text = asText(body.text);
  if (!apiKey && !token) throw new Error('Doubao x-api-key or access_token required');
  if (!voiceId) throw new Error('Doubao voice_type required');
  if (!text) throw new Error('text required');

  const baseUrl = pickTtsValue(body, ['base_url', 'baseUrl'], ['DOUBAO_TTS_BASE_URL'], opts, 'https://openspeech.bytedance.com/api/v1/tts');
  const cluster = pickTtsValue(body, ['cluster', 'model'], ['DOUBAO_TTS_CLUSTER'], opts, 'volcano_icl');
  const uid = pickTtsValue(body, ['uid', 'group_id', 'groupId'], ['DOUBAO_TTS_UID'], opts, 'doubao-voice');
  const reqid = asText(body.reqid || body.request_id, crypto.randomUUID().replace(/-/g, ''));
  const payload = {
    app: { cluster },
    user: { uid },
    audio: {
      voice_type: voiceId,
      encoding: asText(body.encoding || body.format || body.output_format || body.response_format, 'mp3').replace(/^audio\//i, ''),
      speed_ratio: clampNumber(body.speed ?? body.speed_ratio, 0.5, 2, 1),
      volume_ratio: clampNumber(body.volume ?? body.volume_ratio, 0.1, 3, 1),
      pitch_ratio: clampNumber(body.pitch ?? body.pitch_ratio, 0.1, 3, 1),
    },
    request: {
      reqid,
      text,
      text_type: asText(body.text_type || body.textType, 'plain'),
      operation: asText(body.operation, 'query'),
    },
  };
  const withFrontend = body.with_frontend ?? body.withFrontend;
  if (withFrontend !== undefined && withFrontend !== '') payload.request.with_frontend = Number(withFrontend) ? 1 : 0;
  const frontendType = asText(body.frontend_type || body.frontendType);
  if (frontendType) payload.request.frontend_type = frontendType;
  if (appid) payload.app.appid = appid;
  if (token) payload.app.token = token;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && !token) headers['x-api-key'] = apiKey;
  if (token) headers.Authorization = `Bearer;${token}`;
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch (_) {}
  const upstreamMessage = asText(j?.message || j?.msg || j?.base_resp?.status_msg || j?.base_resp?.message || raw).slice(0, 220);
  if (!r.ok) throw new Error('Doubao TTS HTTP ' + r.status + ': ' + upstreamMessage);
  const code = j?.code ?? j?.base_resp?.status_code ?? 0;
  if (code && code !== 0) throw new Error('Doubao TTS: ' + (upstreamMessage || code) + ` (code ${code})`);
  const audio = j?.data?.audio || j?.audio || j?.result?.audio || j?.result?.audio_base64 || (typeof j?.data === 'string' ? j.data : '');
  const buffer = Buffer.isBuffer(audio) ? audio : bufferFromMaybeEncodedAudio(audio);
  if (!buffer || !buffer.length) throw new Error('Doubao TTS did not return audio data');
  return { provider: 'doubao', contentType: 'audio/mpeg', buffer };
}

async function synthesizeDoubao(body, opts = {}) {
  const baseUrl = pickTtsValue(body, ['base_url', 'baseUrl'], ['DOUBAO_TTS_BASE_URL'], opts, '');
  const resourceId = pickTtsValue(body, ['resource_id', 'resourceId', 'resource', 'model'], ['DOUBAO_TTS_RESOURCE_ID', 'DOUBAO_TTS_CLUSTER'], opts, '');
  const speaker = pickTtsValue(body, ['speaker', 'voice_id', 'voiceId', 'voice', 'voice_type', 'voiceType'], ['DOUBAO_TTS_VOICE_ID'], opts, '');
  const isCloneSpeaker = /^S_/i.test(speaker);
  const wantsV1 = !isCloneSpeaker && (/\/api\/v1\/tts\b/i.test(baseUrl) || /^volcano_/i.test(resourceId));
  if (wantsV1) return synthesizeDoubaoV1(body, opts);
  return synthesizeDoubaoV3(body, opts);
}

async function synthesizeElevenLabs(body, opts = {}) {
  const apiKey = pickTtsValue(body, ['api_key', 'apiKey'], ['ELEVENLABS_API_KEY'], opts);
  const voiceId = pickTtsValue(body, ['voice_id', 'voiceId'], ['ELEVENLABS_VOICE_ID'], opts);
  const text = asText(body.text);
  if (!apiKey) throw new Error('ElevenLabs api_key required');
  if (!voiceId) throw new Error('ElevenLabs voice_id required');
  if (!text) throw new Error('text required');
  const model = asText(body.model, 'eleven_multilingual_v2');
  const base = pickTtsValue(body, ['base_url', 'baseUrl'], ['ELEVENLABS_BASE_URL'], opts, 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  const outputFormat = asText(body.output_format || body.outputFormat || body.format);
  const target = `${base}/text-to-speech/${encodeURIComponent(voiceId)}${outputFormat ? `?output_format=${encodeURIComponent(outputFormat)}` : ''}`;
  const voiceSettings = {
    stability: clampNumber(body.stability, 0, 1, 0.5),
    similarity_boost: clampNumber(body.similarity_boost, 0, 1, 0.75),
    style: clampNumber(body.style, 0, 1, 0),
    use_speaker_boost: body.use_speaker_boost !== false,
  };
  if (body.speed != null) voiceSettings.speed = clampNumber(body.speed, 0.7, 1.2, 1);
  const payload = {
    text,
    model_id: model,
    voice_settings: voiceSettings,
  };
  const languageCode = asText(body.language_code || body.languageCode);
  if (languageCode) payload.language_code = languageCode;
  const r = await fetch(target, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify(payload),
  });
  const buffer = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error('ElevenLabs TTS HTTP ' + r.status + ': ' + buffer.toString('utf8').slice(0, 220));
  return { provider: 'elevenlabs', contentType: 'audio/mpeg', buffer };
}

async function synthesizeMiniMax(body, opts = {}) {
  const apiKey = pickTtsValue(body, ['api_key', 'apiKey'], ['MINIMAX_API_KEY'], opts);
  const groupId = pickTtsValue(body, ['group_id', 'groupId'], ['MINIMAX_GROUP_ID'], opts);
  const voiceId = pickTtsValue(body, ['voice_id', 'voiceId'], ['MINIMAX_VOICE_ID'], opts);
  const text = asText(body.text);
  if (!apiKey) throw new Error('MiniMax api_key required');
  if (!voiceId) throw new Error('MiniMax voice_id required');
  if (!text) throw new Error('text required');
  const base = pickTtsValue(body, ['base_url', 'baseUrl'], ['MINIMAX_BASE_URL'], opts, 'https://api.minimax.io').replace(/\/+$/, '');
  const target = `${base}/v1/t2a_v2${groupId ? `?GroupId=${encodeURIComponent(groupId)}` : ''}`;
  const r = await fetch(target, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: asText(body.model, 'speech-2.8-hd'),
      text,
      stream: false,
      language_boost: asText(body.language_boost || body.languageCode || body.language_code, 'auto'),
      output_format: asText(body.output_format, 'hex'),
      voice_setting: {
        voice_id: voiceId,
        speed: clampNumber(body.speed, 0.5, 2, 1),
        vol: clampNumber(body.volume ?? body.vol, 0.1, 10, 1),
        pitch: clampNumber(body.pitch, -12, 12, 0),
      },
      audio_setting: {
        sample_rate: Math.floor(clampNumber(body.sample_rate || body.sampleRate, 8000, 48000, 32000)),
        bitrate: Math.floor(clampNumber(body.bitrate, 32000, 320000, 128000)),
        format: asText(body.format || body.encoding, 'mp3'),
        channel: Math.floor(clampNumber(body.channel, 1, 2, 1)),
      },
    }),
  });
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch (_) {}
  if (!r.ok) throw new Error('MiniMax TTS HTTP ' + r.status + ': ' + raw.slice(0, 220));
  const code = j?.base_resp?.status_code ?? j?.base_resp?.code ?? 0;
  if (code && code !== 0) throw new Error('MiniMax TTS: ' + (j?.base_resp?.status_msg || j?.base_resp?.message || code));
  const audio = j?.data?.audio || j?.audio || j?.result?.audio;
  const buffer = bufferFromMaybeEncodedAudio(audio);
  if (!buffer || !buffer.length) throw new Error('MiniMax TTS did not return audio data');
  return { provider: 'minimax', contentType: 'audio/mpeg', buffer };
}

async function synthesizeSpeech(body = {}, opts = {}) {
  const provider = pickTtsValue(body, ['provider'], ['TTS_PROVIDER'], opts).toLowerCase();
  if (provider === 'openai' || provider === 'openai-tts') return synthesizeOpenAI(body, opts);
  if (provider === 'openai-compatible' || provider === 'compatible' || provider === 'custom') return synthesizeOpenAI({ ...body, provider: 'openai' }, opts);
  if (provider === 'doubao' || provider === 'volcengine' || provider === 'bytedance') return synthesizeDoubao(body, opts);
  if (provider === 'elevenlabs' || provider === 'eleven') return synthesizeElevenLabs(body, opts);
  if (provider === 'minimax') return synthesizeMiniMax(body, opts);
  throw new Error('unsupported TTS provider: ' + (provider || '(empty)'));
}

function voiceStatus() {
  return {
    ok: true,
    providers: ['openai', 'openai-compatible', 'elevenlabs', 'minimax', 'doubao'],
    openai: { endpoint: 'https://api.openai.com/v1/audio/speech', auth: 'Bearer API key' },
    elevenlabs: { endpoint: 'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}', auth: 'xi-api-key' },
    minimax: { endpoint: 'https://api.minimax.io/v1/t2a_v2', auth: 'Bearer API key', groupId: 'optional for newer global endpoint' },
    doubao: { endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', auth: 'X-Api-Key + X-Api-Resource-Id', legacyEndpoint: 'https://openspeech.bytedance.com/api/v1/tts' },
  };
}

module.exports = { synthesizeSpeech, voiceStatus };
