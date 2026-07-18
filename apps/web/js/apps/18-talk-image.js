// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTalkImageStudio = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const NAI_IMAGE_MODELS = [
                { id:'nai-diffusion-4-5-full', label:'NAI Diffusion 4.5 Full' },
                { id:'nai-diffusion-4-5-curated', label:'NAI Diffusion 4.5 Curated' },
                { id:'nai-diffusion-4-full', label:'NAI Diffusion 4 Full' },
                { id:'nai-diffusion-4-curated-preview', label:'NAI Diffusion 4 Curated Preview' },
                { id:'nai-diffusion-3', label:'NAI Diffusion 3' },
                { id:'nai-diffusion-furry-3', label:'NAI Diffusion Furry 3' },
            ];

            // ── 生图 NovelAI：key + 出图参数 + 预设组 存后端（这样 CC 的 generate_image MCP 也能用）──
            const imageStudio = reactive({
                presets:[], activePresetId:'', hasKey:false, keyHint:'',
                testStatus:'', saveStatus:'',
                testPrompt:'', testGenerateStatus:'', testGenerating:false, testImages:[], testLastObjectUrls:[],
                runTestGenerate:null, composeTestPrompt:null, composeTestNegative:null, activePresetName:null,
                draft:{ name:'', prompt:'', negative:'', character:'' },
            });
            const NAI_SAMPLER_ALIASES = {
                'Euler Ancestral':'k_euler_ancestral', 'Euler a':'k_euler_ancestral', euler_ancestral:'k_euler_ancestral', k_euler_ancestral:'k_euler_ancestral',
                Euler:'k_euler', euler:'k_euler', k_euler:'k_euler',
                DDIM:'ddim', ddim:'ddim', ddim_v3:'ddim_v3',
                DPM2:'k_dpm_2', dpm2:'k_dpm_2', dpm_2:'k_dpm_2', k_dpm_2:'k_dpm_2',
                'DPM++ 2M':'k_dpmpp_2m', dpmpp_2m:'k_dpmpp_2m', k_dpmpp_2m:'k_dpmpp_2m',
                'DPM++ 2S Ancestral':'k_dpmpp_2s_ancestral', dpmpp_2s_ancestral:'k_dpmpp_2s_ancestral', k_dpmpp_2s_ancestral:'k_dpmpp_2s_ancestral',
                'DPM++ SDE':'k_dpmpp_sde', dpmpp_sde:'k_dpmpp_sde', k_dpmpp_sde:'k_dpmpp_sde',
                'DPM Fast':'k_dpm_fast', dpm_fast:'k_dpm_fast', k_dpm_fast:'k_dpm_fast',
            };

            const normalizeImageProvider = (value=talkSettings.imageProvider) => {
                const v = String(value || '').trim().toLowerCase();
                if (['novelai', 'nai', 'novel-ai'].includes(v)) return 'novelai';
                if (['openai-image', 'openai-images', 'openai'].includes(v)) return 'openai-image';
                return v || 'custom-image';
            };
            const normalizeImageBaseUrl = (value=talkSettings.imageBaseUrl, provider=normalizeImageProvider()) => {
                let u = String(value || '').trim();
                if (!u) return '';
                u = u.replace(/\s+/g, '').replace(/\/+$/, '');
                // 允许用户直接粘完整 endpoint，前端统一裁成 base，避免后端再拼 /ai/generate-image 时双重路径。
                u = u.replace(/\/ai\/generate-image(?:-stream)?$/i, '');
                u = u.replace(/\/generate-image(?:-stream)?$/i, '');
                if (provider === 'openai-image') u = u.replace(/\/v1\/images\/generations$/i, '/v1');
                return u;
            };
            const parseNaiResolution = (value=talkSettings.naiResolution) => {
                const [rawW, rawH] = String(value || '832x1216').toLowerCase().split('x');
                let width = clampInt(rawW, 832, 64, 2048);
                let height = clampInt(rawH, 1216, 64, 2048);
                // NovelAI 尺寸通常按 64 对齐；第三方代理也更容易接受这种尺寸。
                width = Math.max(64, Math.round(width / 64) * 64);
                height = Math.max(64, Math.round(height / 64) * 64);
                return [width, height];
            };
            const normalizeNaiSampler = (value=talkSettings.naiSampler) => {
                const raw = String(value || '').trim();
                return NAI_SAMPLER_ALIASES[raw] || NAI_SAMPLER_ALIASES[raw.toLowerCase()] || raw || 'k_euler_ancestral';
            };
            const normalizeNaiSeed = (value=talkSettings.naiSeed) => {
                const raw = String(value || '').trim();
                if (!raw) return undefined;
                const n = Number(raw);
                if (!Number.isFinite(n)) return undefined;
                return Math.max(0, Math.min(4294967295, Math.floor(n)));
            };
            const isNovelAIModelV4 = (model=talkSettings.naiModel) => /^nai-diffusion-4/i.test(String(model || ''));
            const naiSupportsSmea = (sampler) => String(sampler || '').toLowerCase() !== 'ddim';
            const defaultVarietySigma = (model) => /^nai-diffusion-4-5/i.test(String(model || '')) ? 58 : 19;
            const buildImageConfigPayload = (opts={}) => {
                const provider = normalizeImageProvider();
                const baseUrl = normalizeImageBaseUrl(talkSettings.imageBaseUrl, provider);
                const [width, height] = parseNaiResolution();
                const model = String(talkSettings.naiModel || 'nai-diffusion-4-5-full').trim() || 'nai-diffusion-4-5-full';
                const sampler = normalizeNaiSampler();
                const negative = String(talkSettings.naiNegativePrompt || '').trim();
                const seed = normalizeNaiSeed();
                const nSamples = clampInt(talkSettings.naiNSamples, 1, 1, 4);
                const steps = clampInt(talkSettings.naiSteps, 28, 1, 50);
                const scale = clampNumber(talkSettings.naiScale, 5, 0.1, 20);
                const cfgRescale = clampNumber(talkSettings.naiCfgRescale, 0, 0, 1);
                const paramsVersion = clampInt(talkSettings.naiParamsVersion, 3, 1, 4);
                const canSmea = naiSupportsSmea(sampler);
                const autoSmea = talkSettings.naiAutoSmea !== false && canSmea && (width * height >= 1024 * 1024);
                const useSmeaDyn = !!talkSettings.naiSMDyn && canSmea;
                const useSmea = !useSmeaDyn && (!!talkSettings.naiSM || autoSmea);
                const sigmaRaw = String(talkSettings.naiSkipCfgAboveSigma || '').trim();
                const varietySigma = clampNumber(sigmaRaw || defaultVarietySigma(model), defaultVarietySigma(model), 0, 1000);
                const parameters = {
                    width, height, steps, scale, sampler, n_samples:nSamples,
                    negative_prompt:negative,
                    qualityToggle:talkSettings.naiQualityToggle !== false,
                    params_version:paramsVersion,
                    legacy:false, legacy_v3_extend:false,
                    image_format:String(talkSettings.naiImageFormat || 'png').toLowerCase() === 'webp' ? 'webp' : 'png',
                };
                if (seed !== undefined) parameters.seed = seed;
                if (cfgRescale > 0) parameters.cfg_rescale = cfgRescale;
                if (String(talkSettings.naiNoiseSchedule || '').trim()) parameters.noise_schedule = String(talkSettings.naiNoiseSchedule).trim();
                if (useSmea) parameters.sm = true;
                if (useSmeaDyn) parameters.sm_dyn = true;
                if (talkSettings.naiDynamicThresholding) parameters.dynamic_thresholding = true;
                if (talkSettings.naiDecrisper) {
                    parameters.deliberate_euler_ancestral_bug = false;
                    parameters.prefer_brownian = true;
                }
                if (talkSettings.naiVarietyBoost) parameters.skip_cfg_above_sigma = varietySigma;
                if (isNovelAIModelV4(model)) {
                    // 官方 V4/V4.5 仍兼容 input/negative_prompt；同时把 v4_prompt 结构传给后端，便于支持多角色 prompt。
                    parameters.v4_prompt = { caption:{ base_caption:'', char_captions:[] }, use_coords:false, use_order:true };
                    parameters.v4_negative_prompt = { caption:{ base_caption:negative, char_captions:[] }, legacy_uc:false, use_coords:false, use_order:false };
                }
                const body = {
                    provider,
                    baseUrl, base_url:baseUrl,
                    endpointBase:baseUrl,
                    apiBaseUrl:baseUrl,
                    compat:'novelai',
                    endpointHints: provider === 'openai-image'
                        ? ['/v1/images/generations']
                        : ['/ai/generate-image', '/ai/generate-image-stream'],
                    model, width, height, steps, scale, sampler, seed,
                    n:nSamples, n_samples:nSamples,
                    negativeDefault:negative, negative_prompt:negative,
                    cfgRescale, cfg_rescale:cfgRescale,
                    qualityToggle:parameters.qualityToggle,
                    params_version:paramsVersion,
                    noise_schedule:parameters.noise_schedule || '',
                    auto_smea:!!talkSettings.naiAutoSmea, sm:!!parameters.sm, sm_dyn:!!parameters.sm_dyn, dynamic_thresholding:!!parameters.dynamic_thresholding,
                    decrisper:!!talkSettings.naiDecrisper, variety_boost:!!talkSettings.naiVarietyBoost, skip_cfg_above_sigma:parameters.skip_cfg_above_sigma ?? '',
                    image_format:parameters.image_format,
                    activePresetId:imageStudio.activePresetId,
                    parameters,
                    novelaiRequestDefaults:{ action:'generate', input:'', model, parameters },
                };
                const key = String(talkSettings.naiApiKey || '').trim();
                if (opts.includeKey && key) body.apiKey = key;
                return body;
            };
            const getActiveImagePreset = () => imageStudio.presets.find(p => p && p.id === imageStudio.activePresetId) || null;
            const activePresetName = () => {
                const p = getActiveImagePreset();
                return p && p.name ? p.name : '';
            };
            const joinPromptParts = (parts) => parts.map(v => String(v || '').trim()).filter(Boolean).join(', ');
            const composePresetTestPrompt = (extraPrompt=imageStudio.testPrompt) => {
                const p = getActiveImagePreset();
                const artistPrompt = String(p && p.prompt || '').trim();
                const characterPrompt = String(p && p.character || '').trim().replace(/\n+/g, ', ');
                const actionPrompt = String(extraPrompt || '').trim();
                return joinPromptParts([artistPrompt, characterPrompt, actionPrompt]);
            };
            const composePresetTestNegative = () => {
                const p = getActiveImagePreset();
                return String((p && p.negative) || talkSettings.naiNegativePrompt || '').trim();
            };
            const revokeImageStudioObjectUrls = () => {
                if (!Array.isArray(imageStudio.testLastObjectUrls)) return;
                imageStudio.testLastObjectUrls.forEach((u) => {
                    try { if (u && /^blob:/i.test(String(u))) URL.revokeObjectURL(u); } catch(_) {}
                });
                imageStudio.testLastObjectUrls = [];
            };
            const collectImageResultUrls = (payload) => {
                const out = [];
                const seen = new Set();
                const add = (value) => {
                    const raw = String(value || '').trim();
                    if (!raw) return;
                    let normalized = raw;
                    if (/^https?:\/\//i.test(raw) || /^data:image\//i.test(raw) || /^blob:/i.test(raw) || /^\/(?!\/)/.test(raw)) {
                        normalized = raw;
                    } else if (/^[A-Za-z0-9+/=\n\r]+$/.test(raw) && raw.replace(/\s+/g, '').length > 96) {
                        normalized = 'data:image/png;base64,' + raw.replace(/\s+/g, '');
                    } else {
                        return;
                    }
                    if (!seen.has(normalized)) {
                        seen.add(normalized);
                        out.push(normalized);
                    }
                };
                const walk = (node) => {
                    if (node == null || out.length >= 8) return;
                    if (typeof node === 'string') { add(node); return; }
                    if (Array.isArray(node)) { node.forEach(walk); return; }
                    if (typeof node !== 'object') return;
                    ['url', 'src', 'href', 'image', 'imageUrl', 'image_url', 'data', 'base64', 'b64_json'].forEach((k) => {
                        if (node[k] != null) add(node[k]);
                    });
                    ['images', 'artifacts', 'outputs', 'output', 'data', 'results', 'result'].forEach((k) => {
                        if (node[k] != null) walk(node[k]);
                    });
                };
                walk(payload);
                return out;
            };
            const runImageStudioTestGenerate = async () => {
                if (imageStudio.testGenerating) return;
                const actionPrompt = String(imageStudio.testPrompt || '').trim();
                if (!imageStudio.activePresetId && !actionPrompt) {
                    imageStudio.testGenerateStatus = '请先点上面某个画师组的 ★，或至少输入一段动作/场景。';
                    return;
                }
                imageStudio.testGenerating = true;
                imageStudio.testGenerateStatus = '已点击生成，正在请求 /api/image/generate…';
                revokeImageStudioObjectUrls();
                imageStudio.testImages = [];
                try {
                    const body = buildImageConfigPayload({ includeKey:true });
                    body.scene = actionPrompt;
                    body.actionPrompt = actionPrompt;
                    body.presetId = imageStudio.activePresetId || '';
                    body.activePresetId = imageStudio.activePresetId || '';
                    body.negative = composePresetTestNegative();
                    body.test = true;
                    const r = await fetch('/api/image/generate', {
                        method:'POST',
                        headers:{ 'Content-Type':'application/json' },
                        credentials:'include',
                        body:JSON.stringify(body),
                    });
                    const contentType = String(r.headers.get('content-type') || '').toLowerCase();
                    if (r.ok && /^image\//.test(contentType)) {
                        const blob = await r.blob();
                        const url = URL.createObjectURL(blob);
                        imageStudio.testLastObjectUrls = [url];
                        imageStudio.testImages = [url];
                        imageStudio.testGenerateStatus = '测试生图成功 ✓';
                        return;
                    }
                    const j = await parseImageJson(r);
                    const urls = collectImageResultUrls(j);
                    if (r.ok && urls.length) {
                        imageStudio.testImages = urls;
                        imageStudio.testGenerateStatus = '测试生图成功 ✓ 共 ' + urls.length + ' 张';
                        return;
                    }
                    imageStudio.testGenerateStatus = '测试生图失败：' + (j.error || j.message || ('HTTP ' + r.status));
                } catch(e) {
                    imageStudio.testGenerateStatus = '测试生图失败：' + (e && e.message || e);
                } finally {
                    imageStudio.testGenerating = false;
                }
            };
            imageStudio.composeTestPrompt = composePresetTestPrompt;
            imageStudio.composeTestNegative = composePresetTestNegative;
            imageStudio.activePresetName = activePresetName;
            imageStudio.runTestGenerate = runImageStudioTestGenerate;
            const applyImageConfigFromServer = (config) => {
                const c = config || {};
                const p = c.parameters || c.novelaiParameters || {};
                imageStudio.presets = Array.isArray(c.presets) ? c.presets : [];
                imageStudio.activePresetId = c.activePresetId || '';
                imageStudio.hasKey = !!c.hasKey;
                imageStudio.keyHint = c.keyHint || '';
                if (c.provider) talkSettings.imageProvider = normalizeImageProvider(c.provider);
                if (c.baseUrl || c.base_url || c.endpointBase || c.apiBaseUrl) talkSettings.imageBaseUrl = normalizeImageBaseUrl(c.baseUrl || c.base_url || c.endpointBase || c.apiBaseUrl, talkSettings.imageProvider);
                if (c.model || p.model) talkSettings.naiModel = c.model || p.model;
                if ((c.width || p.width) && (c.height || p.height)) talkSettings.naiResolution = `${c.width || p.width}x${c.height || p.height}`;
                if (c.sampler || p.sampler) talkSettings.naiSampler = normalizeNaiSampler(c.sampler || p.sampler);
                if (c.steps != null || p.steps != null) talkSettings.naiSteps = c.steps ?? p.steps;
                if (c.scale != null || p.scale != null) talkSettings.naiScale = c.scale ?? p.scale;
                if (c.seed != null || p.seed != null) talkSettings.naiSeed = String(c.seed ?? p.seed ?? '');
                if (c.negativeDefault != null || c.negative_prompt != null || p.negative_prompt != null) talkSettings.naiNegativePrompt = c.negativeDefault ?? c.negative_prompt ?? p.negative_prompt ?? '';
                if (c.n_samples != null || c.n != null || p.n_samples != null) talkSettings.naiNSamples = c.n_samples ?? c.n ?? p.n_samples;
                if (c.cfg_rescale != null || c.cfgRescale != null || p.cfg_rescale != null) talkSettings.naiCfgRescale = c.cfg_rescale ?? c.cfgRescale ?? p.cfg_rescale;
                if (c.qualityToggle != null || p.qualityToggle != null) talkSettings.naiQualityToggle = c.qualityToggle ?? p.qualityToggle;
                if (c.auto_smea != null || c.naiAutoSmea != null) talkSettings.naiAutoSmea = c.auto_smea ?? c.naiAutoSmea;
                if (c.noise_schedule != null || p.noise_schedule != null) talkSettings.naiNoiseSchedule = c.noise_schedule ?? p.noise_schedule ?? '';
                if (c.params_version != null || p.params_version != null) talkSettings.naiParamsVersion = c.params_version ?? p.params_version;
                if (c.image_format != null || p.image_format != null) talkSettings.naiImageFormat = c.image_format ?? p.image_format;
                if (c.sm != null || p.sm != null) talkSettings.naiSM = !!(c.sm ?? p.sm);
                if (c.sm_dyn != null || p.sm_dyn != null) talkSettings.naiSMDyn = !!(c.sm_dyn ?? p.sm_dyn);
                if (c.dynamic_thresholding != null || p.dynamic_thresholding != null) talkSettings.naiDynamicThresholding = !!(c.dynamic_thresholding ?? p.dynamic_thresholding);
                if (c.decrisper != null || p.deliberate_euler_ancestral_bug != null || p.prefer_brownian != null) talkSettings.naiDecrisper = !!(c.decrisper ?? (p.deliberate_euler_ancestral_bug === false || p.prefer_brownian === true));
                if (c.variety_boost != null || p.skip_cfg_above_sigma != null) talkSettings.naiVarietyBoost = !!(c.variety_boost ?? (p.skip_cfg_above_sigma != null));
                if (c.skip_cfg_above_sigma != null || p.skip_cfg_above_sigma != null) talkSettings.naiSkipCfgAboveSigma = String(c.skip_cfg_above_sigma ?? p.skip_cfg_above_sigma ?? '');
            };
            const parseImageJson = async (r) => {
                const text = await r.text();
                try { return text ? JSON.parse(text) : {}; }
                catch(_) {
                    const raw = String(text || '');
                    const html = /<!doctype html|<html[\s>]/i.test(raw) || /text\/html/i.test(String(r.headers.get('content-type') || ''));
                    if (html) {
                        const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
                        const clean = String(title || raw)
                            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/&nbsp;/gi, ' ')
                            .replace(/&amp;/gi, '&')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .slice(0, 180);
                        return { ok:false, error:'收到 HTML 页面，不是图片接口响应。通常是后端没替换成功、Base URL 填错、或第三方接口被 Cloudflare/防火墙拦截。' + (clean ? ' 页面提示：' + clean : '') };
                    }
                    return { ok:false, error:raw.slice(0, 240) || ('HTTP ' + r.status) };
                }
            };
            const loadImageConfig = async () => {
                try {
                    const r = await fetch('/api/image/config', { credentials:'include', cache:'no-store' });
                    if (!r.ok) return;
                    const c = (await r.json()).config || {};
                    applyImageConfigFromServer(c);
                } catch(_) {}
            };
            const saveImageServer = async () => {
                imageStudio.saveStatus = '保存中…';
                const body = buildImageConfigPayload({ includeKey:true });
                try {
                    const r = await fetch('/api/image/config', { method:'PUT', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify(body) });
                    const j = await parseImageJson(r);
                    if (r.ok && j.ok !== false) {
                        if (j.config) applyImageConfigFromServer(j.config);
                        else if (body.apiKey) { imageStudio.hasKey = true; imageStudio.keyHint = body.apiKey.slice(0, 4) + '…' + body.apiKey.slice(-4); }
                        imageStudio.saveStatus = '已保存到服务器 ✓';
                    } else imageStudio.saveStatus = '保存失败：' + (j.error || ('HTTP ' + r.status));
                } catch(e) { imageStudio.saveStatus = '保存失败：' + e.message; }
            };
            // 生图参数改了就自动同步后端（防止前后端不一致：之前只有手动点"保存"才传）
            let imageCfgSaveTimer = null;
            const autoSaveImageConfig = () => {
                clearTimeout(imageCfgSaveTimer);
                imageCfgSaveTimer = setTimeout(() => { saveImageServer(); }, 700);
            };
            Vue.watch(() => [
                talkSettings.naiModel, talkSettings.naiResolution, talkSettings.naiSampler,
                talkSettings.naiSteps, talkSettings.naiScale, talkSettings.naiSeed, talkSettings.naiNegativePrompt,
                talkSettings.naiNSamples, talkSettings.naiCfgRescale, talkSettings.naiQualityToggle,
                talkSettings.naiAutoSmea, talkSettings.naiSM, talkSettings.naiSMDyn, talkSettings.naiDynamicThresholding,
                talkSettings.naiDecrisper, talkSettings.naiVarietyBoost, talkSettings.naiSkipCfgAboveSigma, talkSettings.naiNoiseSchedule,
                talkSettings.naiParamsVersion, talkSettings.naiImageFormat,
                talkSettings.imageProvider, talkSettings.imageBaseUrl, talkSettings.naiApiKey,
                imageStudio.activePresetId,
            ], autoSaveImageConfig);
            const testImageConnection = async () => {
                imageStudio.testStatus = '测试中…';
                try {
                    const body = buildImageConfigPayload({ includeKey:true });
                    const r = await fetch('/api/image/test', { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify(body) });
                    const j = await parseImageJson(r);
                    const ok = r.ok && (j.ok === true || j.valid === true || (j.ok !== false && j.valid !== false && !j.error));
                    if (ok) {
                        const bits = [];
                        if (j.tier != null) bits.push('套餐 ' + j.tier);
                        if (j.anlas != null) bits.push('剩余 Anlas ' + j.anlas);
                        if (j.model) bits.push('模型 ' + j.model);
                        imageStudio.testStatus = '连接成功 ✓' + (bits.length ? ' ' + bits.join('，') : '');
                    } else {
                        imageStudio.testStatus = '连接失败：' + (j.error || j.message || ('HTTP ' + r.status));
                    }
                } catch(e) { imageStudio.testStatus = '连接失败：' + e.message; }
            };
            const addImagePreset = async () => {
                const d = imageStudio.draft;
                if (!String(d.name || '').trim() && !String(d.prompt || '').trim()) { imageStudio.saveStatus = '预设至少要有名字或画师串'; return; }
                try {
                    const r = await fetch('/api/image/presets', { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify(d) });
                    const j = await r.json();
                    if (j.ok) { imageStudio.draft = { name:'', prompt:'', negative:'', character:'' }; await loadImageConfig(); imageStudio.saveStatus = '预设已保存 ✓'; }
                } catch(e) { imageStudio.saveStatus = '保存失败：' + e.message; }
            };
            const updateImagePreset = async (p) => {
                try { await fetch('/api/image/presets/' + p.id, { method:'PUT', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify({ name:p.name, prompt:p.prompt, negative:p.negative, character:p.character, lockCharacters:!!p.lockCharacters }) }); imageStudio.saveStatus = '已更新「' + p.name + '」'; } catch(_) {}
            };
            // 边打字边存（防止还没失焦就去出图、后端拿到旧内容）
            const presetSaveTimers = {};
            const updateImagePresetDebounced = (p) => {
                clearTimeout(presetSaveTimers[p.id]);
                presetSaveTimers[p.id] = setTimeout(() => updateImagePreset(p), 600);
            };
            const deleteImagePreset = async (p) => {
                try { await fetch('/api/image/presets/' + p.id, { method:'DELETE', credentials:'include' }); await loadImageConfig(); } catch(_) {}
            };
            const setActivePreset = async (id) => {
                imageStudio.activePresetId = id;
                try { await fetch('/api/image/config', { method:'PUT', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify({ activePresetId:id }) }); } catch(_) {}
            };

            return { NAI_IMAGE_MODELS, imageStudio, NAI_SAMPLER_ALIASES, normalizeImageProvider, normalizeImageBaseUrl, parseNaiResolution, normalizeNaiSampler, normalizeNaiSeed, isNovelAIModelV4, naiSupportsSmea, defaultVarietySigma, buildImageConfigPayload, getActiveImagePreset, activePresetName, joinPromptParts, composePresetTestPrompt, composePresetTestNegative, revokeImageStudioObjectUrls, collectImageResultUrls, runImageStudioTestGenerate, applyImageConfigFromServer, parseImageJson, loadImageConfig, saveImageServer, imageCfgSaveTimer, autoSaveImageConfig, testImageConnection, addImagePreset, updateImagePreset, presetSaveTimers, updateImagePresetDebounced, deleteImagePreset, setActivePreset };
    }
};
