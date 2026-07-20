const Database = require('./sqlite');
const multer = require('multer');
const { synthesizeSpeech, voiceStatus } = require('../voice-gateway');

function mountVoiceSttRoutes(app, ctx = {}) {
  const { DB_PATH, maskKey, encrypt, decrypt } = ctx;

  // ============================================================
  // STT SETTINGS（你说话 → 转文字；可选浏览器内置或 OpenAI 兼容 API）
  // ============================================================
  function normalizeSttSettings(raw = {}) {
    const mode = String(raw.mode || '').trim().toLowerCase() === 'browser' ? 'browser' : 'api';
    const provider = String(raw.provider || 'openai-compatible').trim() || 'openai-compatible';
    return {
      mode,
      provider,
      base_url: String(raw.base_url || raw.baseUrl || '').trim(),
      model: String(raw.model || '').trim(),
      language: String(raw.language || 'zh-CN').trim() || 'zh-CN',
      api_key: String(raw.api_key || raw.apiKey || '').trim(),
    };
  }

  function loadSttSettings({ masked = false } = {}) {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key='stt'").get();
      if (!row) return null;
      const parsed = JSON.parse(row.value);
      if (parsed.api_key_enc) {
        parsed.api_key = masked ? maskKey(decrypt(parsed.api_key_enc)) : decrypt(parsed.api_key_enc);
        delete parsed.api_key_enc;
      }
      return normalizeSttSettings(parsed);
    } catch (_) { return null; }
    finally { db.close(); }
  }

  app.get('/api/settings/stt', (req, res) => {
    try {
      res.json({ ok: true, data: loadSttSettings({ masked: true }) });
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

  app.put('/api/settings/stt', (req, res) => {
    const db = new Database(DB_PATH);
    try {
      const incoming = normalizeSttSettings(req.body || {});
      const existing = db.prepare("SELECT value FROM app_settings WHERE key='stt'").get();
      let stored = {};
      if (existing) { try { stored = JSON.parse(existing.value); } catch(e) {} }
      stored.mode = incoming.mode;
      stored.provider = incoming.provider;
      stored.base_url = incoming.base_url;
      stored.model = incoming.model;
      stored.language = incoming.language;
      if (incoming.api_key && !incoming.api_key.includes('***')) stored.api_key_enc = encrypt(incoming.api_key);
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('stt', ?, datetime('now'))").run(JSON.stringify(stored));
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // ============================================================
  // TTS SETTINGS（OpenAI 兼容；provider/base_url/api_key/model/voice，前端可配，开源用）
  // ============================================================
  // 读持久化 TTS 设置（api_key 已解密）；没配则 {}。给 /api/voice/* 当默认值（请求 body 覆盖它）。
  function loadTtsSettings() {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key='tts'").get();
      if (!row) return {};
      const parsed = JSON.parse(row.value);
      if (parsed.api_key_enc) { parsed.api_key = decrypt(parsed.api_key_enc); delete parsed.api_key_enc; }
      if (parsed.token_enc) { parsed.token = decrypt(parsed.token_enc); delete parsed.token_enc; }
      return parsed || {};
    } catch (_) { return {}; }
    finally { db.close(); }
  }

  app.get('/api/settings/tts', (req, res) => {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key='tts'").get();
      if (!row) return res.json({ ok: true, data: null });
      const parsed = JSON.parse(row.value);
      if (parsed.api_key_enc) { parsed.api_key = maskKey(decrypt(parsed.api_key_enc)); delete parsed.api_key_enc; }
      if (parsed.token_enc) { parsed.token = maskKey(decrypt(parsed.token_enc)); delete parsed.token_enc; }
      res.json({ ok: true, data: parsed });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.put('/api/settings/tts', (req, res) => {
    const db = new Database(DB_PATH);
    try {
      const body = req.body || {};
      const {
        provider, base_url, api_key, model, voice, voice_id, speaker, resource_id, req_model, request_model, group_id,
        appid, app_id, token, access_token, uid, encoding, format,
        sample_rate, sampleRate, bit_rate, bitRate, bitrate,
        speed, speed_ratio, speech_rate, volume, volume_ratio, loudness_rate, pitch, pitch_ratio,
        use_tag_parser, useTagParser, emotion_scale, emotionScale, context_texts,
        operation, text_type, frontend_type, with_frontend,
      } = body;
      const existing = db.prepare("SELECT value FROM app_settings WHERE key='tts'").get();
      let stored = {};
      if (existing) { try { stored = JSON.parse(existing.value); } catch(e){} }
      if (provider !== undefined) stored.provider = provider;
      if (base_url !== undefined) stored.base_url = base_url;
      if (model !== undefined) stored.model = model;
      if (resource_id !== undefined) stored.resource_id = resource_id;
      if (req_model !== undefined) stored.req_model = req_model;
      if (request_model !== undefined) stored.req_model = request_model;
      if (voice !== undefined) stored.voice = voice;
      if (voice_id !== undefined) stored.voice_id = voice_id;
      if (speaker !== undefined) stored.speaker = speaker;
      if (group_id !== undefined) stored.group_id = group_id;
      if (uid !== undefined) stored.uid = uid;
      if (appid !== undefined) stored.appid = appid;
      if (app_id !== undefined) stored.appid = app_id;
      if (encoding !== undefined) stored.encoding = encoding;
      if (format !== undefined) stored.format = format;
      if (sample_rate !== undefined) stored.sample_rate = sample_rate;
      if (sampleRate !== undefined) stored.sample_rate = sampleRate;
      if (bit_rate !== undefined) stored.bit_rate = bit_rate;
      if (bitRate !== undefined) stored.bit_rate = bitRate;
      if (bitrate !== undefined) stored.bit_rate = bitrate;
      if (speed !== undefined) stored.speed = speed;
      if (speed_ratio !== undefined) stored.speed_ratio = speed_ratio;
      if (speech_rate !== undefined) stored.speech_rate = speech_rate;
      if (volume !== undefined) stored.volume = volume;
      if (volume_ratio !== undefined) stored.volume_ratio = volume_ratio;
      if (loudness_rate !== undefined) stored.loudness_rate = loudness_rate;
      if (pitch !== undefined) stored.pitch = pitch;
      if (pitch_ratio !== undefined) stored.pitch_ratio = pitch_ratio;
      if (use_tag_parser !== undefined) stored.use_tag_parser = use_tag_parser;
      if (useTagParser !== undefined) stored.use_tag_parser = useTagParser;
      if (emotion_scale !== undefined) stored.emotion_scale = emotion_scale;
      if (emotionScale !== undefined) stored.emotion_scale = emotionScale;
      if (context_texts !== undefined) stored.context_texts = context_texts;
      if (operation !== undefined) stored.operation = operation;
      if (text_type !== undefined) stored.text_type = text_type;
      if (frontend_type !== undefined) stored.frontend_type = frontend_type;
      if (with_frontend !== undefined) stored.with_frontend = with_frontend;
      // masked key（含 ***）= 不改，保留旧的；否则加密存新 key
      if (api_key && !String(api_key).includes('***')) stored.api_key_enc = encrypt(api_key);
      const nextToken = token !== undefined ? token : access_token;
      if (nextToken && !String(nextToken).includes('***')) stored.token_enc = encrypt(nextToken);
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('tts', ?, datetime('now'))").run(JSON.stringify(stored));
      res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  app.post('/api/settings/tts/test', async (req, res) => {
    try {
      const merged = { ...loadTtsSettings(), ...(req.body || {}), text: (req.body && req.body.text) || '测试。' };
      const result = await synthesizeSpeech(merged, { allowEnv: false });
      res.json({ ok: true, provider: result.provider || '', bytes: result.buffer ? result.buffer.length : 0 });
    } catch (e) {
      res.json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/voice/status', (req, res) => {
    res.json(voiceStatus());
  });

  app.post('/api/voice/tts', async (req, res) => {
    try {
      // 持久化的 TTS 设置当默认；请求 body 覆盖它；再退 env（allowEnv 默认 true）。
      const result = await synthesizeSpeech({ ...loadTtsSettings(), ...(req.body || {}) });
      res.setHeader('Content-Type', result.contentType || 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Voice-Provider', result.provider || '');
      res.send(result.buffer);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // 前端「AI 语音回复」用（synthesizeAssistantVoice）。前端传 {provider,api_key,voice_id,text,speed,stability}，
  // 返回 {audio_url}（data URL，前端直接当 <audio> src，不用存文件）。与 /api/voice/tts 的区别：
  // key 来自请求体(前端语音设置) 而非 env，返回 data URL 而非裸字节。2026-06-21 加。
  app.post('/api/voice/synthesize', async (req, res) => {
    try {
      // 持久化 TTS 设置当默认，请求 body 覆盖；不读 env（allowEnv:false）。
      const result = await synthesizeSpeech({ ...loadTtsSettings(), ...(req.body || {}) }, { allowEnv: false });
      const audioUrl = `data:${result.contentType || 'audio/mpeg'};base64,${result.buffer.toString('base64')}`;
      res.json({ ok: true, provider: result.provider || '', audio_url: audioUrl });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // 前端「拉取模型/音色」用（fetchProviderModels）。body {kind:'text'|'tts'|'image', provider, base_url, api_key, group_id}。
  // kind=tts 调各家「列音色」接口（MiniMax get_voice / ElevenLabs voices）；kind=text 调 OpenAI 兼容 /models。
  // 2026-06-21 加，配合前端语音/模型设置。
  app.post('/api/integrations/models', async (req, res) => {
    const { kind, provider, base_url, api_key, group_id, region } = req.body || {};
    try {
      if (kind === 'tts') {
        const p = String(provider || '').toLowerCase();
        if (p === 'openai' || p === 'openai-tts' || p === 'openai-compatible' || p === 'compatible' || p === 'custom') {
          return res.json({
            ok: true,
            voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(id => ({ id, name: id })),
            models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'].map(id => ({ id, name: id })),
          });
        }
        if (p === 'minimax') {
          if (!api_key) throw new Error('MiniMax api_key required');
          const gid = group_id || process.env.MINIMAX_GROUP_ID;
          const base = (base_url || process.env.MINIMAX_BASE_URL || (region === 'cn' ? 'https://api.minimaxi.chat' : 'https://api.minimax.io')).replace(/\/+$/, '');
          const r = await fetch(`${base}/v1/get_voice${gid ? `?GroupId=${encodeURIComponent(gid)}` : ''}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_type: 'all' }),
          });
          if (!r.ok) throw new Error('MiniMax get_voice 失败: ' + (await r.text().catch(() => '')).slice(0, 200));
          const j = await r.json();
          const code = j.base_resp?.status_code ?? j.base_resp?.code ?? 0;
          if (code && code !== 0) throw new Error('MiniMax: ' + (j.base_resp?.status_msg || j.base_resp?.message || code) + '（检查 key/GroupId/区域）');
          const pick = (arr) => (Array.isArray(arr) ? arr : []).map(v => ({ id: v.voice_id || v.id, name: v.voice_name || v.name || v.voice_id || v.id }));
          const voices = [...pick(j.system_voice), ...pick(j.voice_cloning), ...pick(j.voice_clone)].filter(v => v.id);
          return res.json({ ok: true, voices });
        }
        if (p === 'elevenlabs') {
          if (!api_key) throw new Error('ElevenLabs api_key required');
          const base = (base_url || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
          const r = await fetch(`${base}/voices`, { headers: { 'xi-api-key': api_key } });
          if (!r.ok) throw new Error('ElevenLabs voices 失败: ' + (await r.text().catch(() => '')).slice(0, 200));
          const j = await r.json();
          const voices = (j.voices || []).map(v => ({ id: v.voice_id, name: v.name || v.voice_id }));
          const models = ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_v3'].map(id => ({ id, name: id }));
          return res.json({ ok: true, voices, models });
        }
        if (p === 'doubao' || p === 'volcengine' || p === 'bytedance') {
          return res.json({
            ok: true,
            voices: [],
            models: [{ id: 'seed-tts-2.0', name: 'seed-tts-2.0' }, { id: 'seed-icl-2.0', name: 'seed-icl-2.0' }],
            note: '火山/豆包 v3 单向流式 HTTP：模型填 X-Api-Resource-Id（seed-tts-2.0 / seed-icl-2.0），音色填 speaker。',
          });
        }
        return res.json({ ok: true, voices: [], note: '该 TTS 供应商暂不支持自动列音色，请手填 Voice ID' });
      }
      // kind=text/默认：OpenAI 兼容 /models
      if (!base_url) throw new Error('base_url required');
      if (!api_key) throw new Error('api_key required');
      const r = await fetch(`${String(base_url).replace(/\/+$/, '')}/models`, { headers: { 'Authorization': `Bearer ${api_key}` } });
      if (!r.ok) throw new Error('列模型失败: ' + (await r.text().catch(() => '')).slice(0, 200));
      const j = await r.json();
      const models = (j.data || j.models || []).map(m => ({ id: m.id || m.name, name: m.id || m.name })).filter(m => m.id);
      return res.json({ ok: true, models });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // ── 语音转文字 STT（2026-06-21）：前端录音 multipart(audio+language) → 转发给 OpenAI 兼容的
  // /v1/audio/transcriptions。默认复用 SiliconFlow(SenseVoiceSmall，中文好)，可用 STT_* env 覆盖。
  // 必须注册在 /api/:table 兜底之前，否则被当成"表"403。鉴权走全局门(cookie/x-chat-token)。
  const sttUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  app.post('/api/speech-to-text', sttUpload.single('audio'), async (req, res) => {
    try {
      const saved = loadSttSettings() || {};
      const body = req.body || {};
      const requestedMode = String(body.mode || saved.mode || 'api').trim().toLowerCase();
      if (requestedMode === 'browser') {
        return res.status(501).json({ ok: false, error: '当前选择浏览器内置语音识别，不走后端 STT API' });
      }
      const bodyKey = String(body.api_key || body.apiKey || '').trim();
      const key = (bodyKey && !bodyKey.includes('***') ? bodyKey : '') || saved.api_key || process.env.STT_API_KEY || process.env.SILICONFLOW_API_KEY;
      if (!key) return res.status(501).json({ ok: false, error: 'STT 未配置：到总设置填写语音识别 API，或选择浏览器内置识别' });
      if (!req.file || !req.file.buffer?.length) return res.status(400).json({ ok: false, error: 'no audio' });
      const base = String(body.base_url || body.baseUrl || saved.base_url || process.env.STT_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
      const model = String(body.model || saved.model || process.env.STT_MODEL || 'FunAudioLLM/SenseVoiceSmall').trim();
      const language = String(body.language || saved.language || 'zh-CN').trim();
      const fd = new FormData();
      fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'voice.webm');
      fd.append('model', model);
      if (language) fd.append('language', language);
      const r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { 'Authorization': `Bearer ${key}` }, body: fd });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'STT API：' + (await r.text().catch(() => '')).slice(0, 220) });
      const j = await r.json().catch(() => ({}));
      const rawTranscript = String(j.text || j.transcript || j.result || '');
      const tags = [...rawTranscript.matchAll(/<\|([^|]+)\|>/g)].map(m => String(m[1] || '').trim());
      const emotionMap = {
        HAPPY:'happy', SAD:'sad', ANGRY:'angry', FEARFUL:'fearful',
        DISGUSTED:'disgusted', SURPRISED:'surprised', NEUTRAL:'neutral',
      };
      const eventMap = {
        Laughter:'laughter', Cry:'crying', Sneeze:'sneeze', Breath:'breath',
        Cough:'cough', Applause:'applause', BGM:'background_music',
      };
      const emotionTag = tags.find(tag => emotionMap[tag.toUpperCase()]);
      const events = [...new Set(tags.map(tag => eventMap[tag] || eventMap[Object.keys(eventMap).find(k => k.toLowerCase() === tag.toLowerCase())]).filter(Boolean))];
      const voiceContext = {
        source:'sensevoice',
        emotion:emotionTag ? emotionMap[emotionTag.toUpperCase()] : '',
        events,
        advisory:true,
      };
      // 可见字幕仍保持干净；情绪/笑声等作为独立结构化元数据返回，避免标签被直接念出来。
      const text = rawTranscript
        .replace(/<\|[^|]*\|>/g, '')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      res.json({ ok: true, text, voice_context:voiceContext });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return { loadTtsSettings, loadSttSettings };
}

module.exports = { mountVoiceSttRoutes };
