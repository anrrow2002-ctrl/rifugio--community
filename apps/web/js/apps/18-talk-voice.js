// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTalkVoice = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const TTS_PROVIDER_ALIASES = {
                'openai-tts':'openai',
                compatible:'openai-compatible',
                custom:'openai-compatible',
                eleven:'elevenlabs',
                volcengine:'doubao',
                bytedance:'doubao',
                volcano:'doubao',
            };

            const TTS_MODEL_OPTIONS = {
                openai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
                'openai-compatible': ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
                elevenlabs: ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_v3'],
                minimax: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'],
                doubao: ['seed-tts-2.0', 'seed-icl-2.0'],
            };

            const DOUBAO_V1_DEFAULT_BASE_URL = 'https://openspeech.bytedance.com/api/v1/tts';

            const DOUBAO_V3_DEFAULT_BASE_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

            const TTS_PROVIDER_DEFAULTS = {
                '': { apiKey:'', voiceId:'', model:'', appId:'', token:'', instructions:'', requestModel:'', useTagParser:false, emotionScale:'', format:'mp3', volume:1, pitch:0, groupId:'', region:'global', baseUrl:'', speed:1, stability:0.5, style:0, similarityBoost:0.75, useSpeakerBoost:true, languageCode:'', languageBoost:'auto', sampleRate:32000, bitrate:128000, channel:1 },
                openai: { apiKey:'', voiceId:'coral', model:'gpt-4o-mini-tts', appId:'', token:'', instructions:'', requestModel:'', useTagParser:false, emotionScale:'', format:'mp3', volume:1, pitch:0, groupId:'', region:'global', baseUrl:'', speed:1, stability:0.5, style:0, similarityBoost:0.75, useSpeakerBoost:true, languageCode:'', languageBoost:'auto', sampleRate:32000, bitrate:128000, channel:1 },
                'openai-compatible': { apiKey:'', voiceId:'coral', model:'gpt-4o-mini-tts', appId:'', token:'', instructions:'', requestModel:'', useTagParser:false, emotionScale:'', format:'mp3', volume:1, pitch:0, groupId:'', region:'global', baseUrl:'', speed:1, stability:0.5, style:0, similarityBoost:0.75, useSpeakerBoost:true, languageCode:'', languageBoost:'auto', sampleRate:32000, bitrate:128000, channel:1 },
                elevenlabs: { apiKey:'', voiceId:'', model:'eleven_multilingual_v2', appId:'', token:'', instructions:'', requestModel:'', useTagParser:false, emotionScale:'', format:'mp3_44100_128', volume:1, pitch:0, groupId:'', region:'global', baseUrl:'', speed:1, stability:0.5, style:0, similarityBoost:0.75, useSpeakerBoost:true, languageCode:'', languageBoost:'auto', sampleRate:32000, bitrate:128000, channel:1 },
                minimax: { apiKey:'', voiceId:'', model:'speech-2.8-hd', appId:'', token:'', instructions:'', requestModel:'', useTagParser:false, emotionScale:'', format:'mp3', volume:1, pitch:0, groupId:'', region:'global', baseUrl:'', speed:1, stability:0.5, style:0, similarityBoost:0.75, useSpeakerBoost:true, languageCode:'', languageBoost:'auto', sampleRate:32000, bitrate:128000, channel:1 },
                doubao: { apiKey:'', voiceId:'', model:'seed-tts-2.0', appId:'', token:'', instructions:'青年男性，低沉磁性的声线，慵懒松弛的语气，带一点刚睡醒的沙哑感，语速偏慢，温柔宠溺', requestModel:'seed-tts-2.0-expressive', useTagParser:true, emotionScale:2, format:'mp3', volume:1, pitch:-1, groupId:'', region:'global', baseUrl:DOUBAO_V3_DEFAULT_BASE_URL, speed:0.9, stability:0.5, style:0, similarityBoost:0.75, useSpeakerBoost:true, languageCode:'', languageBoost:'auto', sampleRate:24000, bitrate:128000, channel:1 },
            };

            const TTS_PROVIDER_META = {
                '': { label:'不使用', apiKeyPlaceholder:'TTS API Key', voicePlaceholder:'Voice ID / 音色 ID', modelPlaceholder:'模型 ID', formatPlaceholder:'格式', note:'' },
                openai: { label:'OpenAI TTS', apiKeyPlaceholder:'OpenAI API Key', voicePlaceholder:'voice，例如 coral / alloy', modelPlaceholder:'model，例如 gpt-4o-mini-tts', formatPlaceholder:'response_format：mp3 / wav / opus / flac / aac / pcm', note:'OpenAI：发送 model、input、voice、response_format、speed，语气写入 instructions。' },
                'openai-compatible': { label:'OpenAI Compatible TTS', apiKeyPlaceholder:'兼容接口 API Key', voicePlaceholder:'兼容接口 voice', modelPlaceholder:'兼容接口 model', formatPlaceholder:'response_format', note:'OpenAI Compatible：只按 /v1/audio/speech 形状发送，不夹带 ElevenLabs / 豆包 / MiniMax 字段。' },
                elevenlabs: { label:'ElevenLabs', apiKeyPlaceholder:'ElevenLabs xi-api-key', voicePlaceholder:'voice_id，例如 21m00Tcm4TlvDq8ikWAM', modelPlaceholder:'model_id，例如 eleven_multilingual_v2', formatPlaceholder:'output_format，例如 mp3_44100_128', note:'ElevenLabs：发送 text、model_id、voice_settings；language_code 留空时由模型自动判断。' },
                minimax: { label:'MiniMax', apiKeyPlaceholder:'MiniMax API Key', voicePlaceholder:'voice_id', modelPlaceholder:'model，例如 speech-2.8-hd', formatPlaceholder:'audio_setting.format，例如 mp3', note:'MiniMax：发送 model、voice_setting、audio_setting；GroupId/区域只给 MiniMax 使用。' },
                doubao: { label:'火山/豆包', apiKeyPlaceholder:'X-Api-Key', voicePlaceholder:'speaker / 音色 ID', modelPlaceholder:'X-Api-Resource-Id，例如 seed-icl-2.0', formatPlaceholder:'audio_params.format：mp3 / pcm / ogg_opus / wav', note:'火山/豆包：复刻音色用 Resource ID=seed-icl-2.0；情绪增强写在请求体 model=seed-tts-2.0-expressive，可配 context_texts 和标签解析。' },
            };

            const TTS_PROFILE_FIELDS = {
                apiKey:'ttsApiKey',
                voiceId:'ttsVoiceId',
                model:'ttsModel',
                appId:'ttsAppId',
                token:'ttsToken',
                instructions:'ttsInstructions',
                requestModel:'ttsRequestModel',
                useTagParser:'ttsUseTagParser',
                emotionScale:'ttsEmotionScale',
                format:'ttsFormat',
                volume:'ttsVolume',
                pitch:'ttsPitch',
                groupId:'ttsGroupId',
                region:'ttsRegion',
                baseUrl:'ttsBaseUrl',
                speed:'ttsSpeed',
                stability:'ttsStability',
                style:'ttsStyle',
                similarityBoost:'ttsSimilarityBoost',
                useSpeakerBoost:'ttsUseSpeakerBoost',
                languageCode:'ttsLanguageCode',
                languageBoost:'ttsLanguageBoost',
                sampleRate:'ttsSampleRate',
                bitrate:'ttsBitrate',
                channel:'ttsChannel',
            };

            const TTS_PROFILE_FIELD_NAMES = Object.values(TTS_PROFILE_FIELDS);

            const normalizeTtsProvider = (value) => {
                const raw = String(value || '').trim().toLowerCase();
                return TTS_PROVIDER_DEFAULTS[TTS_PROVIDER_ALIASES[raw] || raw] ? (TTS_PROVIDER_ALIASES[raw] || raw) : raw;
            };

            const defaultTtsProfile = (provider) => ({ ...(TTS_PROVIDER_DEFAULTS[normalizeTtsProvider(provider)] || TTS_PROVIDER_DEFAULTS['']) });

            const normalizeTtsFormat = (provider, value) => {
                const p = normalizeTtsProvider(provider);
                const raw = String(value || '').trim();
                if (p === 'elevenlabs') {
                    if (!raw || raw === 'mp3' || raw === 'audio/mpeg') return 'mp3_44100_128';
                    return raw;
                }
                if (p === 'openai' || p === 'openai-compatible') {
                    if (!raw) return 'mp3';
                    if (/^mp3_/i.test(raw)) return 'mp3';
                    return raw.replace(/^audio\//i, '');
                }
                return raw || 'mp3';
            };

            const normalizeTtsModel = (provider, model) => {
                const p = normalizeTtsProvider(provider);
                const raw = String(model || '').trim();
                if (!raw) return defaultTtsProfile(p).model;
                if ((p === 'openai' || p === 'openai-compatible') && /^(eleven_|speech-|volcano_)/i.test(raw)) return defaultTtsProfile(p).model;
                if (p === 'elevenlabs' && /^(gpt-|tts-|speech-|volcano_)/i.test(raw)) return defaultTtsProfile(p).model;
                if (p === 'minimax' && /^(gpt-|tts-|eleven_|volcano_)/i.test(raw)) return defaultTtsProfile(p).model;
                if (p === 'doubao' && /^(gpt-|tts-|eleven_|speech-|volcano_)/i.test(raw)) return defaultTtsProfile(p).model;
                return raw;
            };

            const collectTtsFields = (opts={}) => {
                const includeEmpty = opts.includeEmpty !== false;
                const out = {};
                Object.entries(TTS_PROFILE_FIELDS).forEach(([key, field]) => {
                    const value = talkSettings[field];
                    if (!includeEmpty && (value == null || value === '')) return;
                    out[key] = value;
                });
                return out;
            };

            const normalizeTtsProfile = (provider, raw={}) => {
                const p = normalizeTtsProvider(provider);
                const base = defaultTtsProfile(p);
                const profile = { ...base, ...(raw || {}) };
                ['apiKey','voiceId','model','appId','token','instructions','requestModel','format','groupId','region','baseUrl','languageCode','languageBoost'].forEach(k => {
                    profile[k] = String(profile[k] == null ? '' : profile[k]).trim();
                });
                profile.model = normalizeTtsModel(p, profile.model);
                profile.format = normalizeTtsFormat(p, profile.format);
                if (p === 'doubao') {
                    const baseUrl = String(profile.baseUrl || '').replace(/\/+$/, '');
                    const wasBundledV1Default = baseUrl === DOUBAO_V1_DEFAULT_BASE_URL && (!raw?.baseUrl || String(raw.baseUrl || '').replace(/\/+$/, '') === DOUBAO_V1_DEFAULT_BASE_URL) && (!raw?.model || raw.model === 'volcano_icl');
                    if (wasBundledV1Default) {
                        profile.baseUrl = DOUBAO_V3_DEFAULT_BASE_URL;
                        profile.model = 'seed-tts-2.0';
                        if (profile.groupId === 'doubao-voice') profile.groupId = '';
                        if (Number(profile.pitch) === 1) profile.pitch = 0;
                    }
                }
                profile.region = profile.region === 'cn' ? 'cn' : 'global';
                profile.speed = clampNumber(profile.speed, base.speed, p === 'openai' || p === 'openai-compatible' ? 0.25 : (p === 'elevenlabs' ? 0.7 : 0.5), p === 'openai' || p === 'openai-compatible' ? 4 : (p === 'elevenlabs' ? 1.2 : 2));
                profile.volume = clampNumber(profile.volume, base.volume, 0.1, p === 'minimax' ? 10 : 3);
                profile.pitch = clampNumber(profile.pitch, base.pitch, -12, 12);
                profile.stability = clampNumber(profile.stability, base.stability, 0, 1);
                profile.style = clampNumber(profile.style, base.style, 0, 1);
                profile.similarityBoost = clampNumber(profile.similarityBoost, base.similarityBoost, 0, 1);
                profile.useSpeakerBoost = profile.useSpeakerBoost !== false;
                profile.useTagParser = profile.useTagParser === true || String(profile.useTagParser).toLowerCase() === 'true';
                profile.emotionScale = profile.emotionScale === '' ? base.emotionScale : clampNumber(profile.emotionScale, base.emotionScale || 2, 0, 5);
                profile.sampleRate = clampInt(profile.sampleRate, base.sampleRate, 8000, 48000);
                profile.bitrate = clampInt(profile.bitrate, base.bitrate, 32000, 320000);
                profile.channel = clampInt(profile.channel, base.channel, 1, 2);
                return profile;
            };

            const ensureTtsProfiles = () => {
                if (!talkSettings.ttsProfiles || typeof talkSettings.ttsProfiles !== 'object' || Array.isArray(talkSettings.ttsProfiles)) talkSettings.ttsProfiles = {};
                Object.keys(talkSettings.ttsProfiles).forEach(key => {
                    const provider = normalizeTtsProvider(key);
                    if (!TTS_PROVIDER_DEFAULTS[provider]) {
                        delete talkSettings.ttsProfiles[key];
                        return;
                    }
                    if (provider !== key) {
                        talkSettings.ttsProfiles[provider] = { ...(talkSettings.ttsProfiles[provider] || {}), ...(talkSettings.ttsProfiles[key] || {}) };
                        delete talkSettings.ttsProfiles[key];
                    }
                    talkSettings.ttsProfiles[provider] = normalizeTtsProfile(provider, talkSettings.ttsProfiles[provider]);
                });
            };

            const getTtsProfile = (provider=talkSettings.ttsProvider) => {
                const p = normalizeTtsProvider(provider);
                ensureTtsProfiles();
                return normalizeTtsProfile(p, talkSettings.ttsProfiles[p] || {});
            };

            const persistTtsProfile = (provider=talkSettings.ttsProvider) => {
                const p = normalizeTtsProvider(provider);
                if (!TTS_PROVIDER_DEFAULTS[p] || !p) return null;
                ensureTtsProfiles();
                const profile = normalizeTtsProfile(p, collectTtsFields({ includeEmpty:true }));
                talkSettings.ttsProfiles[p] = profile;
                return profile;
            };

            const applyTtsProfileToFields = (provider=talkSettings.ttsProvider, rawProfile=null) => {
                const p = normalizeTtsProvider(provider);
                const profile = normalizeTtsProfile(p, rawProfile || talkSettings.ttsProfiles?.[p] || {});
                Object.entries(TTS_PROFILE_FIELDS).forEach(([key, field]) => { talkSettings[field] = profile[key]; });
                return profile;
            };
            talkSettings.ttsProvider = normalizeTtsProvider(talkSettings.ttsProvider);
            ensureTtsProfiles();
            if (talkSettings.ttsProvider) {
                const legacyProfile = collectTtsFields({ includeEmpty:false });
                const hadProfile = Boolean(talkSettings.ttsProfiles[talkSettings.ttsProvider]);
                if (!hadProfile && talkSettings.ttsProvider === 'elevenlabs') {
                    if (Number(legacyProfile.speed) === 1.2) legacyProfile.speed = 1;
                    if (Number(legacyProfile.stability) === 0.36) legacyProfile.stability = 0.5;
                    if (Number(legacyProfile.style) === 0.84) legacyProfile.style = 0;
                }
                talkSettings.ttsProfiles[talkSettings.ttsProvider] = normalizeTtsProfile(talkSettings.ttsProvider, {
                    ...(talkSettings.ttsProfiles[talkSettings.ttsProvider] || {}),
                    ...legacyProfile,
                });
            }
            applyTtsProfileToFields(talkSettings.ttsProvider);

            let activeTtsProviderKey = talkSettings.ttsProvider;

            const ttsProviderMeta = computed(() => TTS_PROVIDER_META[normalizeTtsProvider(talkSettings.ttsProvider)] || TTS_PROVIDER_META['']);

            const ttsProviderNote = computed(() => ttsProviderMeta.value.note || '');

            const ttsProviderModelOptions = computed(() => (TTS_MODEL_OPTIONS[normalizeTtsProvider(talkSettings.ttsProvider)] || []).map(id => ({ id, name:id })));

            const ttsVoicePlaceholder = computed(() => ttsProviderMeta.value.voicePlaceholder || 'Voice ID / 音色 ID');

            const ttsModelPlaceholder = computed(() => ttsProviderMeta.value.modelPlaceholder || '模型 ID');

            const ttsFormatPlaceholder = computed(() => ttsProviderMeta.value.formatPlaceholder || '格式');

            const ttsSpeedBounds = computed(() => {
                const p = normalizeTtsProvider(talkSettings.ttsProvider);
                if (p === 'openai' || p === 'openai-compatible') return { min:0.25, max:4, step:0.05 };
                if (p === 'elevenlabs') return { min:0.7, max:1.2, step:0.02 };
                return { min:0.5, max:2, step:0.02 };
            });

            const ttsPitchBounds = computed(() => ({ min:-12, max:12, step:0.5, label:'音高' }));

            const ttsHasCredentials = (provider=normalizeTtsProvider(talkSettings.ttsProvider), profile=getTtsProfile(provider)) => {
                const p = normalizeTtsProvider(provider);
                if (!p) return false;
                if (p === 'doubao') {
                    const wantsV1 = /\/api\/v1\/tts\b/i.test(String(profile.baseUrl || '')) || /^volcano_/i.test(String(profile.model || ''));
                    return wantsV1 ? Boolean(profile.apiKey || profile.token) : Boolean(profile.apiKey);
                }
                return Boolean(profile.apiKey);
            };

            const isTtsReady = computed(() => {
                const provider = normalizeTtsProvider(talkSettings.ttsProvider);
                const profile = normalizeTtsProfile(provider, collectTtsFields({ includeEmpty:true }));
                return Boolean(provider && ttsHasCredentials(provider, profile) && profile.voiceId);
            });

            const buildTtsPayload = (text, meta = {}) => {
                const provider = normalizeTtsProvider(talkSettings.ttsProvider);
                if (!provider) throw new Error('先选择 TTS 供应商');
                const cfg = normalizeTtsProfile(provider, collectTtsFields({ includeEmpty:true }));
                if (!ttsHasCredentials(provider, cfg)) throw new Error(provider === 'doubao' ? '请填写 X-Api-Key' : '请填写 API Key');
                if (!cfg.voiceId) throw new Error('请填写当前供应商的 Voice ID / 音色 ID');
                const body = { provider, text:String(text || '') };
                const set = (key, value) => {
                    if (value === undefined || value === null || value === '') return;
                    body[key] = value;
                };
                if (provider === 'doubao') {
                    const doubaoResourceId = /^S_/i.test(cfg.voiceId) && (!cfg.model || cfg.model === 'seed-tts-2.0')
                        ? 'seed-icl-2.0'
                        : (cfg.model || 'seed-tts-2.0');
                    set('api_key', cfg.apiKey);
                    set('token', cfg.token);
                    set('appid', cfg.appId);
                    set('speaker', cfg.voiceId);
                    set('voice_id', cfg.voiceId);
                    set('resource_id', doubaoResourceId);
                    set('model', doubaoResourceId);
                    set('req_model', cfg.requestModel);
                    set('use_tag_parser', cfg.useTagParser);
                    set('emotion_scale', cfg.emotionScale);
                    set('group_id', cfg.groupId);
                    set('base_url', cfg.baseUrl || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
                    set('format', cfg.format || 'mp3');
                    set('sample_rate', cfg.sampleRate);
                    set('bitrate', cfg.bitrate);
                    set('speed', cfg.speed);
                    set('volume', cfg.volume);
                    set('pitch', cfg.pitch);
                    const voiceTags = Array.isArray(meta.voiceTags) ? meta.voiceTags.filter(Boolean) : [];
                    const doubaoInstructions = [
                        cfg.instructions,
                        voiceTags.length ? `本段语气标签：${voiceTags.join('，')}` : '',
                    ].filter(Boolean).join('；');
                    set('instructions', doubaoInstructions);
                    return body;
                }
                set('api_key', cfg.apiKey);
                set('voice_id', cfg.voiceId);
                set('model', cfg.model);
                if (provider === 'openai' || provider === 'openai-compatible') {
                    set('base_url', cfg.baseUrl || 'https://api.openai.com/v1');
                    set('instructions', cfg.instructions);
                    set('response_format', cfg.format || 'mp3');
                    set('speed', cfg.speed);
                } else if (provider === 'elevenlabs') {
                    set('base_url', cfg.baseUrl);
                    set('output_format', cfg.format || 'mp3_44100_128');
                    set('stability', cfg.stability);
                    set('similarity_boost', cfg.similarityBoost);
                    set('style', cfg.style);
                    set('use_speaker_boost', cfg.useSpeakerBoost);
                    set('speed', cfg.speed);
                    set('language_code', cfg.languageCode);
                } else if (provider === 'minimax') {
                    set('group_id', cfg.groupId);
                    set('base_url', cfg.baseUrl || (cfg.region === 'cn' ? 'https://api.minimaxi.chat' : 'https://api.minimax.io'));
                    set('speed', cfg.speed);
                    set('volume', cfg.volume);
                    set('pitch', cfg.pitch);
                    set('language_boost', cfg.languageBoost || 'auto');
                    set('format', cfg.format || 'mp3');
                    set('sample_rate', cfg.sampleRate);
                    set('bitrate', cfg.bitrate);
                    set('channel', cfg.channel);
                }
                return body;
            };

            const buildTtsModelRequest = () => {
                const provider = normalizeTtsProvider(talkSettings.ttsProvider);
                const cfg = normalizeTtsProfile(provider, collectTtsFields({ includeEmpty:true }));
                return {
                    kind:'tts',
                    provider,
                    base_url: provider === 'doubao'
                        ? (cfg.baseUrl || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
                        : (provider === 'minimax' ? (cfg.baseUrl || (cfg.region === 'cn' ? 'https://api.minimaxi.chat' : 'https://api.minimax.io')) : cfg.baseUrl),
                    api_key: cfg.apiKey,
                    token: provider === 'doubao' ? cfg.token : undefined,
                    appid: provider === 'doubao' ? cfg.appId : undefined,
                    group_id: (provider === 'minimax' || provider === 'doubao') ? cfg.groupId : undefined,
                    region: cfg.region,
                };
            };

            const maskTtsDebugValue = (key, value) => {
                if (/api[_-]?key|token|authorization|secret/i.test(key)) return value ? '***' : '';
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskTtsDebugValue(k, v)]));
                }
                return value;
            };

            const ttsDebugPayload = computed(() => {
                if (!normalizeTtsProvider(talkSettings.ttsProvider)) return '';
                try {
                    const body = buildTtsPayload('宝宝，这是我的声音，你听听看喜不喜欢。');
                    return JSON.stringify(maskTtsDebugValue('body', body), null, 2);
                } catch(e) {
                    return JSON.stringify({ provider:normalizeTtsProvider(talkSettings.ttsProvider), error:e.message || String(e) }, null, 2);
                }
            });

            let ttsProviderSwitchHandled = false;
            Vue.watch(() => talkSettings.ttsProvider, (next, prev) => {
                const previous = normalizeTtsProvider(prev || activeTtsProviderKey);
                const current = normalizeTtsProvider(next);
                if (previous && previous !== current && !ttsProviderSwitchHandled) persistTtsProfile(previous);
                ttsProviderSwitchHandled = false;
                if (talkSettings.ttsProvider !== current) {
                    talkSettings.ttsProvider = current;
                    return;
                }
                applyTtsProfileToFields(current);
                talkSettings.availableTtsVoices = [];
                talkSettings.ttsFetchStatus = '';
                talkSettings.ttsPreviewStatus = current ? `已切换到 ${ttsProviderMeta.value.label}，参数已隔离` : '';
                activeTtsProviderKey = current;
            });
            Vue.watch(() => TTS_PROFILE_FIELD_NAMES.map(k => talkSettings[k]), () => {
                if (normalizeTtsProvider(talkSettings.ttsProvider) === 'doubao' && /^S_/i.test(String(talkSettings.ttsVoiceId || '')) && (!talkSettings.ttsModel || talkSettings.ttsModel === 'seed-tts-2.0')) {
                    talkSettings.ttsModel = 'seed-icl-2.0';
                    return;
                }
                persistTtsProfile(talkSettings.ttsProvider);
            });
            Vue.watch(talkSettings, () => { saveTalkSettings(); scheduleTalkProactive(); }, { deep:true });
            Vue.watch(() => talkSettings.systemNotifications, (enabled) => {
                if (enabled) requestTalkNotificationPermission();
                else disableTalkWebPushSubscription();
            });

            const voiceInputStatusText = computed(() => ({
                requesting_permission:'正在请求麦克风权限…',
                recording:'正在录音，再点麦克风停止',
                processing:'正在转文字…',
                success:'已转成文字，先放进输入框',
                error:'语音转文字失败',
                idle:'',
            })[talk.voiceInput.status] || '');

            let talkRecognition = null;

            let talkVoiceRecorder = null;

            let talkVoiceRecognition = null;

            let talkVoiceChunks = [];

            const voiceState = reactive({ playingId: null, currentTime: 0, duration: {} });

            let voiceAudioEl = null;

            const voiceBarPattern = [38,68,52,88,58,32,78,48,64,42,74,54,36,82,58,46,70,40];

            const voiceBarHeight = (n) => voiceBarPattern[n % voiceBarPattern.length];

            const formatVoiceDuration = (sec) => {
                const s = Math.max(0, Math.round(Number(sec) || 0));
                return s > 0 ? `${s}″` : '';
            };

            const voiceDurationLabel = (id) => formatVoiceDuration(voiceState.duration[id]);

            const voiceProgressPct = (id) => {
                const dur = voiceState.duration[id] || 0;
                if (voiceState.playingId !== id || !dur) return 0;
                return Math.min(100, (voiceState.currentTime / dur) * 100);
            };

            const toggleVoicePlay = (id, url) => {
                if (!url) return;
                if (voiceState.playingId === id) {
                    voiceAudioEl?.pause();
                    voiceState.playingId = null;
                    return;
                }
                if (voiceAudioEl) { voiceAudioEl.pause(); voiceAudioEl = null; }
                const el = new Audio(url);
                voiceAudioEl = el;
                voiceState.playingId = id;
                voiceState.currentTime = 0;
                el.addEventListener('loadedmetadata', () => {
                    if (Number.isFinite(el.duration)) voiceState.duration[id] = el.duration;
                });
                el.addEventListener('timeupdate', () => {
                    if (voiceState.playingId === id) voiceState.currentTime = el.currentTime;
                });
                el.addEventListener('ended', () => {
                    if (voiceState.playingId === id) { voiceState.playingId = null; voiceState.currentTime = 0; }
                });
                el.play().catch(() => { if (voiceState.playingId === id) voiceState.playingId = null; });
            };

            const makeSpeechRecognition = () => {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) return null;
                const recognition = new SpeechRecognition();
                recognition.lang = sttCfg?.language || 'zh-CN';
                recognition.interimResults = true;
                recognition.continuous = false;
                return recognition;
            };

            const toggleTalkDictation = () => {
                if (talk.dictating && talkRecognition) { talkRecognition.stop(); return; }
                talkRecognition = makeSpeechRecognition();
                if (!talkRecognition) {
                    talk.error = '当前浏览器不支持语音识别，请使用 Safari 或 Chrome。';
                    return;
                }
                const baseText = talk.input.trim();
                let finalText = '';
                talkRecognition.onstart = () => { talk.dictating = true; talk.error = ''; };
                talkRecognition.onresult = (event) => {
                    finalText = '';
                    let interimText = '';
                    for (let i = 0; i < event.results.length; i++) {
                        const text = event.results[i][0].transcript;
                        if (event.results[i].isFinal) finalText += text;
                        else interimText += text;
                    }
                    talk.input = [baseText, finalText, interimText].filter(Boolean).join(' ').trim();
                    talk.error = interimText ? '正在听：' + interimText : '';
                };
                talkRecognition.onerror = (e) => { talk.error = e.error === 'not-allowed' ? '请允许麦克风权限后再试。' : '语音输入没有听清。'; };
                talkRecognition.onend = () => {
                    talk.dictating = false;
                    talk.input = [baseText, finalText].filter(Boolean).join(' ').trim();
                    if (talk.error.startsWith('正在听：')) talk.error = '';
                };
                talkRecognition.start();
            };

            const voiceInputErrorText = (code) => ({
                permission_denied:'麦克风权限未开启',
                unsupported_browser:'当前浏览器不支持录音',
                empty_audio:'没有检测到声音，请重新录制',
                network_error:'语音转文字失败，请稍后重试',
                stt_api_error:'语音转文字接口还没有接好',
                timeout:'语音转文字超时，请重试',
                unknown:'语音转文字失败，请稍后重试',
            }[code] || '语音转文字失败，请稍后重试');
            // opus 优先（2026-07-02）：同样一句话 webm-opus 比 mp4/AAC 小 3-6 倍，
            // STT 上传时间大头在音频体积——之前 mp4 排第一，iOS/新 Chrome 都选中它，通话转文字特别慢。
            // 旧 iOS 不支持 webm 会自动落回 mp4，不影响可用性。

            const bestAudioMime = () => {
                if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
                const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
                return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
            };
            // 语音说话用 32kbps 足够清晰；不设的话浏览器默认 128k+，白白拖慢上传/转写

            const speechRecorderOptions = (mime) => {
                const opts = { audioBitsPerSecond: 32000 };
                if (mime) opts.mimeType = mime;
                return opts;
            };

            const setVoiceInputError = (code) => {
                talk.voiceInput.status = 'error';
                talk.voiceInput.error = code;
                talk.voiceInput.errorMessage = voiceInputErrorText(code);
                talk.error = talk.voiceInput.errorMessage;
            };

            const clearVoiceInput = () => {
                if (talk.voiceInput.timeoutId) clearTimeout(talk.voiceInput.timeoutId);
                talk.voiceInput.timeoutId = null;
                talk.voiceInput.stream = null;
                talk.voiceInput.startedAt = 0;
            };

            const releaseVoiceInputStream = () => {
                const stream = talk.voiceInput.stream;
                if (stream?.getTracks) stream.getTracks().forEach(track => track.stop());
            };

            const transcribeVoiceBlob = async (blob, mime, requestId = 0, withDetails = false) => {
                if (!blob || blob.size < 600) {
                    const err = new Error('empty_audio');
                    err.code = 'empty_audio';
                    throw err;
                }
                const form = new FormData();
                const ext = /mp4|aac/i.test(mime || '') ? 'mp4' : 'webm';
                form.append('audio', blob, `voice-${Date.now()}.${ext}`);
                form.append('language', sttCfg?.language || 'zh-CN');
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                try {
                    const res = await fetch('/api/speech-to-text', {
                        method:'POST',
                        credentials:'include',
                        body:form,
                        signal:controller.signal,
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || data.ok === false) {
                        const err = new Error(data.error || `HTTP ${res.status}`);
                        err.code = res.status === 501 ? 'stt_api_error' : 'network_error';
                        throw err;
                    }
                    const text = String(data.text || data.transcript || data.data?.text || data.data?.transcript || '').trim();
                    const voiceContext = data.voice_context || data.voiceContext || data.data?.voice_context || null;
                    const hasVoiceEvent = !!(voiceContext && (voiceContext.emotion || voiceContext.events?.length));
                    if (!text && !(withDetails && hasVoiceEvent)) {
                        const err = new Error('empty_audio');
                        err.code = 'empty_audio';
                        throw err;
                    }
                    if (requestId && requestId !== talk.voiceInput.requestId) {
                        const err = new Error('stale_request');
                        err.code = 'unknown';
                        throw err;
                    }
                    return withDetails ? { text, voiceContext } : text;
                } catch(e) {
                    if (e.name === 'AbortError') e.code = 'timeout';
                    throw e;
                } finally {
                    clearTimeout(timeout);
                }
            };

            const appendLocalVoiceMessage = (attachment) => {
                let c = activeConvo.value;
                if (!c) { newTalk(); c = activeConvo.value; }
                if (!c) return;
                c.messages.push({
                    id:Date.now(),
                    role:'user',
                    content:'（语音消息，暂未识别出文字）',
                    attachments:[attachment],
                    time:nowHM(),
                    localOnly:true,
                });
                if (c.name === '新对话') c.name = '语音消息';
                talk.error = '这条语音已保存；目前没有识别出文字，所以没有发送给 AI。';
                saveTalk();
                pushConvo(c);
                scrollTalkBottom();
            };

            const resetVoiceRecording = () => {
                talk.voiceRecording.active = false;
                talk.voiceRecording.stream = null;
                talkVoiceRecorder = null;
                talkVoiceRecognition = null;
                talkVoiceChunks = [];
            };

            const stopVoiceTracks = () => {
                const stream = talk.voiceRecording.stream;
                if (stream?.getTracks) stream.getTracks().forEach(track => track.stop());
            };

            const stopVoiceMessage = () => {
                if (!talk.voiceRecording.active) return;
                talk.voiceRecording.status = '正在整理语音条…';
                if (talkVoiceRecognition) {
                    try { talkVoiceRecognition.stop(); } catch(_) {}
                }
                if (talkVoiceRecorder && talkVoiceRecorder.state !== 'inactive') {
                    try { talkVoiceRecorder.stop(); } catch(_) {}
                } else {
                    stopVoiceTracks();
                    resetVoiceRecording();
                }
            };

            const startVoiceMessage = async () => {
                if (talk.voiceRecording.active) { stopVoiceMessage(); return; }
                if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
                    talk.error = '当前浏览器不支持录制语音条。';
                    return;
                }
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
                    talkVoiceChunks = [];
                    talk.voiceRecording.active = true;
                    talk.voiceRecording.status = '正在录音，说完点“停止并发送”。';
                    talk.voiceRecording.transcript = '';
                    talk.voiceRecording.stream = stream;
                    talk.panel = 'voice';
                    talkVoiceRecorder = new MediaRecorder(stream, speechRecorderOptions(bestAudioMime()));
                    talkVoiceRecorder.ondataavailable = (event) => {
                        if (event.data && event.data.size) talkVoiceChunks.push(event.data);
                    };
                    talkVoiceRecorder.onstop = async () => {
                        const mime = talkVoiceRecorder?.mimeType || 'audio/webm';
                        const blob = new Blob(talkVoiceChunks, { type:mime });
                        const audioUrl = URL.createObjectURL(blob);
                        const backendTranscript = await transcribeVoiceBlob(blob, mime).catch(() => '');   // 后端 STT 优先（更可靠）
                        const browserTranscript = String(talk.voiceRecording.transcript || '').replace(/\[[^\]]*]$/, '').trim();
                        const transcript = (backendTranscript || browserTranscript || '').trim();
                        stopVoiceTracks();
                        resetVoiceRecording();
                        talk.panel = '';
                        const attachment = {
                            id:'voice-' + Date.now(),
                            kind:'voice',
                            name:transcript ? transcript.slice(0, 24) : '语音消息',
                            dataUrl:audioUrl,
                            audioUrl,
                            transcript,
                        };
                        if (transcript) await sendTalkMessage(transcript, [attachment]);
                        else appendLocalVoiceMessage(attachment);
                    };
                    talkVoiceRecorder.start();
                    talkVoiceRecognition = makeSpeechRecognition();
                    if (talkVoiceRecognition) {
                        talkVoiceRecognition.continuous = true;
                        talkVoiceRecognition.onresult = (event) => {
                            let finalText = '';
                            let interimText = '';
                            for (let i=event.resultIndex; i<event.results.length; i++) {
                                const part = event.results[i][0].transcript;
                                if (event.results[i].isFinal) finalText += part;
                                else interimText += part;
                            }
                            const previous = String(talk.voiceRecording.transcript || '').replace(/\s*\[.*$/, '').trim();
                            talk.voiceRecording.transcript = [previous, finalText, interimText ? `[${interimText}]` : ''].filter(Boolean).join(' ').trim();
                        };
                        talkVoiceRecognition.onerror = () => { talk.voiceRecording.status = '语音还在录，转文字没有听清。'; };
                        try { talkVoiceRecognition.start(); } catch(_) {}
                    }
                } catch(e) {
                    talk.error = '请允许麦克风权限后再录语音。';
                    stopVoiceTracks();
                    resetVoiceRecording();
                }
            };

            const toggleVoiceMessage = () => {
                if (talk.voiceRecording.active) stopVoiceMessage();
                else startVoiceMessage();
            };

            const processVoiceInputBlob = async (blob, mime, requestId) => {
                talk.voiceInput.status = 'processing';
                talk.voiceInput.error = '';
                talk.voiceInput.errorMessage = '';
                try {
                    const text = await transcribeVoiceBlob(blob, mime, requestId);
                    const current = String(talk.input || '').trim();
                    talk.input = current ? `${current}\n${text}` : text;
                    talk.voiceInput.status = 'success';
                    talk.voiceInput.error = '';
                    talk.voiceInput.errorMessage = '';
                    talk.error = '';
                    Vue.nextTick(() => {
                        const el = document.querySelector('.talk-composer textarea');
                        if (el) { el.focus(); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }
                    });
                    setTimeout(() => {
                        if (talk.voiceInput.status === 'success') talk.voiceInput.status = 'idle';
                    }, 1800);
                } catch(e) {
                    setVoiceInputError(e.code || 'network_error');
                } finally {
                    releaseVoiceInputStream();
                    clearVoiceInput();
                    talkVoiceRecorder = null;
                    talkVoiceChunks = [];
                }
            };

            const stopVoiceInput = () => {
                if (talk.voiceInput.status !== 'recording') return;
                talk.voiceInput.status = 'processing';
                if (talkVoiceRecorder && talkVoiceRecorder.state !== 'inactive') {
                    try { talkVoiceRecorder.stop(); } catch(e) { setVoiceInputError('unknown'); }
                } else {
                    releaseVoiceInputStream();
                    clearVoiceInput();
                }
            };

            const startVoiceInput = async () => {
                if (['requesting_permission','recording','processing'].includes(talk.voiceInput.status)) return;
                if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
                    setVoiceInputError('unsupported_browser');
                    return;
                }
                talk.panel = '';
                talk.error = '';
                talk.voiceInput.error = '';
                talk.voiceInput.errorMessage = '';
                talk.voiceInput.status = 'requesting_permission';
                const requestId = Date.now();
                talk.voiceInput.requestId = requestId;
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } });
                    const mime = bestAudioMime();
                    talkVoiceChunks = [];
                    talk.voiceInput.stream = stream;
                    talk.voiceInput.startedAt = Date.now();
                    talkVoiceRecorder = new MediaRecorder(stream, speechRecorderOptions(mime));
                    talkVoiceRecorder.ondataavailable = event => {
                        if (event.data && event.data.size) talkVoiceChunks.push(event.data);
                    };
                    talkVoiceRecorder.onerror = () => setVoiceInputError('unknown');
                    talkVoiceRecorder.onstop = () => {
                        const recorderMime = talkVoiceRecorder?.mimeType || mime || 'audio/webm';
                        const blob = new Blob(talkVoiceChunks, { type:recorderMime });
                        processVoiceInputBlob(blob, recorderMime, requestId);
                    };
                    talkVoiceRecorder.start(250);
                    talk.voiceInput.status = 'recording';
                    talk.voiceInput.timeoutId = setTimeout(() => {
                        if (talk.voiceInput.status === 'recording') stopVoiceInput();
                    }, 60000);
                } catch(e) {
                    releaseVoiceInputStream();
                    clearVoiceInput();
                    setVoiceInputError(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'permission_denied' : 'unknown');
                }
            };

            const toggleVoiceInput = () => {
                if (talk.voiceInput.status === 'recording') stopVoiceInput();
                else startVoiceInput();
            };

            const TTS_REQUEST_GAP_MS = 350;

            const ttsProviderQueues = {};

            const ttsProviderLastAt = {};

            const waitMs = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));

            const enqueueTtsRequest = (provider, task) => {
                const key = normalizeTtsProvider(provider) || 'default';
                const previous = ttsProviderQueues[key] || Promise.resolve();
                const next = previous.catch(() => {}).then(async () => {
                    const wait = TTS_REQUEST_GAP_MS - (Date.now() - (ttsProviderLastAt[key] || 0));
                    if (wait > 0) await waitMs(wait);
                    try {
                        return await task();
                    } finally {
                        ttsProviderLastAt[key] = Date.now();
                    }
                });
                ttsProviderQueues[key] = next.catch(() => {});
                return next;
            };
            // 统一的 TTS 调用：按供应商生成隔离 body，调后端，并把真实错误带回来。

            const callTts = async (text) => {
                const prepared = prepareTtsInput(text);
                const body = buildTtsPayload(prepared.text, { voiceTags: prepared.voiceTags });
                return enqueueTtsRequest(body.provider, async () => {
                    const res = await fetch('/api/voice/synthesize', {
                        method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include',
                        body:JSON.stringify(body),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
                    const url = data.audio_url || data.audioUrl || data.url || '';
                    if (!url) throw new Error('TTS 接口没有返回音频');
                    return url;
                });
            };

            const synthesizeAssistantVoice = async (assistantMsg, convo) => {
                if (talkCall.active) return;   // 通话中由 speakCallReply 负责发声，别重复合成（省额度）
                if (!talkSettings.aiVoiceReplyEnabled || !isTtsReady.value || !assistantMsg?.content) return;
                assistantMsg.voiceStatus = '正在生成 AI 语音条…';
                saveTalk(); if (convo) pushConvo(convo);
                try {
                    assistantMsg.voiceUrl = await callTts(assistantMsg.content);
                    assistantMsg.voiceStatus = 'AI 语音回复';
                } catch(e) {
                    const raw = String(e?.message || e || '');
                    // 额度/配额类错误给短提示，避免把上游一长串 JSON 原样塞进聊天把布局撑爆；其余错误截断到 80 字
                    assistantMsg.voiceStatus = /quota|credit|insufficient|配额|额度|余额|balance/i.test(raw)
                        ? '语音额度不足，已暂停 AI 语音合成'
                        : ('TTS 失败：' + (raw.length > 80 ? raw.slice(0, 80) + '…' : raw));
                }
                saveTalk(); if (convo) pushConvo(convo); scrollTalkBottom();
            };
            // ── 音色预设库：把当前这套 TTS 配置存成一个预设，存好几套随时切 ──

            const VOICE_FIELDS = ['ttsProvider','ttsApiKey','ttsVoiceId','ttsModel','ttsAppId','ttsToken','ttsInstructions','ttsRequestModel','ttsUseTagParser','ttsEmotionScale','ttsFormat','ttsVolume','ttsPitch','ttsSimilarityBoost','ttsUseSpeakerBoost','ttsLanguageCode','ttsLanguageBoost','ttsSampleRate','ttsBitrate','ttsChannel','ttsGroupId','ttsRegion','ttsBaseUrl','ttsSpeed','ttsStability','ttsStyle'];

            const saveVoicePreset = () => {
                if (!talkSettings.ttsProvider || !talkSettings.ttsVoiceId) { talkSettings.ttsPreviewStatus = '先选 provider 并填音色 ID 再保存'; return; }
                const provider = normalizeTtsProvider(talkSettings.ttsProvider);
                const profile = persistTtsProfile(provider) || normalizeTtsProfile(provider, collectTtsFields({ includeEmpty:true }));
                const snap = {}; VOICE_FIELDS.forEach(k => snap[k] = talkSettings[k]);
                const name = String(talkSettings.voiceDraftName || '').trim() || `${ttsProviderMeta.value.label}·${String(talkSettings.ttsVoiceId).slice(-6)}`;
                const preset = { id:'voice-' + Date.now(), name, provider, ttsProfile:profile, ...snap };
                talkSettings.voicePresets.push(preset);
                talkSettings.activeVoicePresetId = preset.id;
                talkSettings.voiceDraftName = '';
                talkSettings.ttsPreviewStatus = `已保存音色「${name}」`;
            };

            const applyVoicePreset = (p) => {
                const provider = normalizeTtsProvider(p.provider || p.ttsProvider);
                const previousProvider = normalizeTtsProvider(talkSettings.ttsProvider);
                if (previousProvider && previousProvider !== provider) persistTtsProfile(previousProvider);
                if (provider && talkSettings.ttsProvider !== provider) {
                    ttsProviderSwitchHandled = true;
                    talkSettings.ttsProvider = provider;
                }
                if (provider && p.ttsProfile) {
                    ensureTtsProfiles();
                    talkSettings.ttsProfiles[provider] = normalizeTtsProfile(provider, p.ttsProfile);
                    applyTtsProfileToFields(provider, talkSettings.ttsProfiles[provider]);
                } else {
                    VOICE_FIELDS.forEach(k => { if (p[k] !== undefined) talkSettings[k] = p[k]; });
                    persistTtsProfile(provider || talkSettings.ttsProvider);
                }
                talkSettings.activeVoicePresetId = p.id;
                talkSettings.ttsPreviewStatus = `已切换到「${p.name}」`;
            };

            const deleteVoicePreset = (p) => {
                talkSettings.voicePresets = talkSettings.voicePresets.filter(x => x.id !== p.id);
                if (talkSettings.activeVoicePresetId === p.id) talkSettings.activeVoicePresetId = '';
            };
            // 设置里"试听"：用一句话测一下 key/音色/模型对不对，直接播

            const previewTtsVoice = async () => {
                if (!isTtsReady.value) { talkSettings.ttsPreviewStatus = normalizeTtsProvider(talkSettings.ttsProvider) === 'doubao' ? '先填 X-Api-Key、speaker 和 Resource ID' : '先选供应商，并填当前供应商的 Key 与音色 ID'; return; }
                talkSettings.ttsPreviewStatus = '合成中…';
                try {
                    const url = await callTts('宝宝，这是我的声音，你听听看喜不喜欢。');
                    talkSettings.ttsPreviewStatus = '播放中 ♪';
                    const audio = new Audio(url);
                    audio.onended = () => { talkSettings.ttsPreviewStatus = '试听成功 ✓ 这个声音可以用了'; };
                    audio.onerror = () => { talkSettings.ttsPreviewStatus = '音频播放失败'; };
                    await audio.play();
                } catch(e) {
                    talkSettings.ttsPreviewStatus = '失败：' + e.message;
                }
            };

            onUnmounted(() => {
                stopVoiceTracks();
                if (talkRecognition) { try { talkRecognition.abort(); } catch(_) {} }
                if (talkVoiceRecognition) { try { talkVoiceRecognition.abort(); } catch(_) {} }
            });

            return { TTS_PROVIDER_ALIASES, TTS_MODEL_OPTIONS, DOUBAO_V1_DEFAULT_BASE_URL, DOUBAO_V3_DEFAULT_BASE_URL, TTS_PROVIDER_DEFAULTS, TTS_PROVIDER_META, TTS_PROFILE_FIELDS, TTS_PROFILE_FIELD_NAMES, normalizeTtsProvider, defaultTtsProfile, normalizeTtsFormat, normalizeTtsModel, collectTtsFields, normalizeTtsProfile, ensureTtsProfiles, getTtsProfile, persistTtsProfile, applyTtsProfileToFields, activeTtsProviderKey, ttsProviderMeta, ttsProviderNote, ttsProviderModelOptions, ttsVoicePlaceholder, ttsModelPlaceholder, ttsFormatPlaceholder, ttsSpeedBounds, ttsPitchBounds, ttsHasCredentials, isTtsReady, buildTtsPayload, buildTtsModelRequest, maskTtsDebugValue, ttsDebugPayload, ttsProviderSwitchHandled, voiceInputStatusText, talkRecognition, talkVoiceRecorder, talkVoiceRecognition, talkVoiceChunks, voiceState, voiceAudioEl, voiceBarPattern, voiceBarHeight, formatVoiceDuration, voiceDurationLabel, voiceProgressPct, toggleVoicePlay, makeSpeechRecognition, toggleTalkDictation, voiceInputErrorText, bestAudioMime, speechRecorderOptions, setVoiceInputError, clearVoiceInput, releaseVoiceInputStream, transcribeVoiceBlob, appendLocalVoiceMessage, resetVoiceRecording, stopVoiceTracks, stopVoiceMessage, startVoiceMessage, toggleVoiceMessage, processVoiceInputBlob, stopVoiceInput, startVoiceInput, toggleVoiceInput, TTS_REQUEST_GAP_MS, ttsProviderQueues, ttsProviderLastAt, waitMs, enqueueTtsRequest, callTts, synthesizeAssistantVoice, VOICE_FIELDS, saveVoicePreset, applyVoicePreset, deleteVoicePreset, previewTtsVoice };
    }
};
