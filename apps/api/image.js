// ── 生图 NovelAI（2026-06-23 修正版）─────────────────────────────────────────
// 聊天里 CC 用 generate_image MCP 出图 → 存服务器 → 返回前端聊天框可看可存。
// 这版同时兼容：
//   · 官方 NovelAI /ai/generate-image
//   · 第三方 NovelAI 协议中转（baseUrl 填 https://v2.ninijoker-api.com 这类）
//   · OpenAI Images 兼容接口（provider=openai-image）
//   · 官方 V4/V4.5 参数、画师预设组、测试生图框
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');

const CONFIG = process.env.NAI_CONFIG_FILE || require('./modules/community-config').privatePath('nai-config.json');
const IMG_DIR = process.env.NAI_IMAGE_DIR || require('./modules/community-config').dataPath('images');
const NAI_USER_API = 'https://api.novelai.net/user/subscription';
const DEFAULT_NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality';

const CHAR_CENTERS = [
  [0.5],
  [0.45, 0.55],
  [0.3, 0.5, 0.7],
  [0.25, 0.42, 0.58, 0.75],
  [0.2, 0.35, 0.5, 0.65, 0.8],
  [0.17, 0.3, 0.43, 0.57, 0.7, 0.83],
];

function finiteNum(v, fallback, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function finiteInt(v, fallback, min = -Infinity, max = Infinity) {
  return Math.round(finiteNum(v, fallback, min, max));
}
function boolValue(v, fallback = false) {
  if (v === true || v === false) return v;
  if (v == null || v === '') return fallback;
  if (typeof v === 'string') return !/^(false|0|off|no)$/i.test(v.trim());
  return !!v;
}
function normalizeProvider(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || ['novelai', 'nai', 'novel-ai'].includes(s)) return 'novelai';
  if (['openai-image', 'openai-images', 'openai'].includes(s)) return 'openai-image';
  return s;
}
function normalizeBaseUrl(v, provider = 'novelai') {
  let u = String(v || '').trim();
  if (!u) return '';
  u = u.replace(/\s+/g, '').replace(/\/+$/, '');
  u = u.replace(/\/ai\/generate-image(?:-stream)?$/i, '');
  u = u.replace(/\/generate-image(?:-stream)?$/i, '');
  if (provider === 'openai-image') u = u.replace(/\/v1\/images\/generations$/i, '/v1');
  return u;
}
function isOfficialNovelAiBase(baseUrl) {
  const u = String(baseUrl || '').trim();
  return !u || /(^https?:\/\/)?image\.novelai\.net\/?$/i.test(u);
}
function imageMagic(buf) {
  if (!Buffer.isBuffer(buf)) return { ext: 'png', type: 'image/png' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  return { ext: 'png', type: 'image/png' };
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function upstreamErrorLabel(status, contentType, text, baseUrl) {
  const raw = String(text || '');
  const looksHtml = /<!doctype html|<html[\s>]/i.test(raw) || /text\/html/i.test(String(contentType || ''));
  if (looksHtml) {
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const brief = stripHtml(title || raw).slice(0, 180);
    return `上游返回了 HTML 页面，不是图片 API 响应。HTTP ${status}。请检查 Base URL 是否真的是 NovelAI 协议接口、是否被 Cloudflare/防火墙拦截，当前 Base URL：${baseUrl || '官方 NovelAI'}。${brief ? '页面提示：' + brief : ''}`;
  }
  return `HTTP ${status}：${raw.slice(0, 500)}`;
}

function rawCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function loadCfg() {
  const c = rawCfg();
  const p = c.parameters || c.novelaiParameters || {};
  const provider = normalizeProvider(c.provider);
  const baseUrl = normalizeBaseUrl(c.baseUrl || c.base_url || c.endpointBase || c.apiBaseUrl || '', provider);
  const cfg = {
    apiKey: c.apiKey || '',
    provider,
    baseUrl,
    model: String(c.model || p.model || 'nai-diffusion-4-5-full'),
    width: finiteInt(c.width ?? p.width, 832, 64, 2048),
    height: finiteInt(c.height ?? p.height, 1216, 64, 2048),
    steps: finiteInt(c.steps ?? p.steps, 28, 1, 50),
    scale: finiteNum(c.scale ?? p.scale, 5, 0.1, 20),
    sampler: String(c.sampler || p.sampler || 'k_euler_ancestral'),
    noise_schedule: String(c.noise_schedule ?? p.noise_schedule ?? ''),
    negativeDefault: String(c.negativeDefault ?? c.negative_prompt ?? p.negative_prompt ?? DEFAULT_NEG),
    n_samples: finiteInt(c.n_samples ?? c.n ?? p.n_samples, 1, 1, 4),
    cfg_rescale: finiteNum(c.cfg_rescale ?? c.cfgRescale ?? p.cfg_rescale, 0, 0, 1),
    qualityToggle: boolValue(c.qualityToggle ?? p.qualityToggle, true),
    auto_smea: boolValue(c.auto_smea ?? c.naiAutoSmea, true),
    params_version: finiteInt(c.params_version ?? p.params_version, 3, 1, 4),
    image_format: String(c.image_format || p.image_format || 'png').toLowerCase() === 'webp' ? 'webp' : 'png',
    sm: boolValue(c.sm ?? p.sm, false),
    sm_dyn: boolValue(c.sm_dyn ?? p.sm_dyn, false),
    dynamic_thresholding: boolValue(c.dynamic_thresholding ?? p.dynamic_thresholding, false),
    decrisper: boolValue(c.decrisper ?? (p.deliberate_euler_ancestral_bug === false || p.prefer_brownian === true), false),
    variety_boost: boolValue(c.variety_boost ?? (p.skip_cfg_above_sigma != null), false),
    skip_cfg_above_sigma: c.skip_cfg_above_sigma ?? p.skip_cfg_above_sigma ?? '',
    presets: Array.isArray(c.presets) ? c.presets : [],
    activePresetId: c.activePresetId || '',
    parameters: p && typeof p === 'object' ? { ...p } : {},
  };
  return cfg;
}
function saveCfg(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
}
function publicCfg(c) {
  const { apiKey, ...rest } = c;
  return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? apiKey.slice(0, 4) + '…' + apiKey.slice(-2) : '' };
}
function applyConfigBody(c, b = {}) {
  const provider = b.provider != null ? normalizeProvider(b.provider) : c.provider;
  c.provider = provider;
  if (b.baseUrl != null || b.base_url != null || b.endpointBase != null || b.apiBaseUrl != null) {
    c.baseUrl = normalizeBaseUrl(b.baseUrl ?? b.base_url ?? b.endpointBase ?? b.apiBaseUrl, provider);
  }
  for (const k of ['model', 'sampler', 'noise_schedule', 'activePresetId']) {
    if (typeof b[k] === 'string') c[k] = b[k];
  }
  if (typeof b.negativeDefault === 'string') c.negativeDefault = b.negativeDefault;
  if (typeof b.negative_prompt === 'string') c.negativeDefault = b.negative_prompt;
  for (const k of ['width', 'height', 'steps', 'scale']) {
    if (b[k] != null && Number.isFinite(Number(b[k]))) c[k] = Number(b[k]);
  }
  if (b.n_samples != null || b.n != null) c.n_samples = finiteInt(b.n_samples ?? b.n, c.n_samples, 1, 4);
  if (b.cfg_rescale != null || b.cfgRescale != null) c.cfg_rescale = finiteNum(b.cfg_rescale ?? b.cfgRescale, c.cfg_rescale, 0, 1);
  if (b.qualityToggle != null) c.qualityToggle = boolValue(b.qualityToggle, c.qualityToggle);
  if (b.auto_smea != null || b.naiAutoSmea != null) c.auto_smea = boolValue(b.auto_smea ?? b.naiAutoSmea, c.auto_smea);
  if (b.params_version != null) c.params_version = finiteInt(b.params_version, c.params_version, 1, 4);
  if (b.image_format != null) c.image_format = String(b.image_format).toLowerCase() === 'webp' ? 'webp' : 'png';
  for (const k of ['sm', 'sm_dyn', 'dynamic_thresholding', 'decrisper', 'variety_boost']) {
    if (b[k] != null) c[k] = boolValue(b[k], c[k]);
  }
  if (b.skip_cfg_above_sigma != null) c.skip_cfg_above_sigma = b.skip_cfg_above_sigma;
  if (b.parameters && typeof b.parameters === 'object') {
    c.parameters = { ...(c.parameters || {}), ...b.parameters };
    const p = b.parameters;
    if (p.negative_prompt != null) c.negativeDefault = String(p.negative_prompt);
    if (p.width != null) c.width = finiteInt(p.width, c.width, 64, 2048);
    if (p.height != null) c.height = finiteInt(p.height, c.height, 64, 2048);
    if (p.steps != null) c.steps = finiteInt(p.steps, c.steps, 1, 50);
    if (p.scale != null) c.scale = finiteNum(p.scale, c.scale, 0.1, 20);
    if (p.sampler != null) c.sampler = String(p.sampler);
    if (p.n_samples != null) c.n_samples = finiteInt(p.n_samples, c.n_samples, 1, 4);
    if (p.cfg_rescale != null) c.cfg_rescale = finiteNum(p.cfg_rescale, c.cfg_rescale, 0, 1);
    if (p.qualityToggle != null) c.qualityToggle = boolValue(p.qualityToggle, c.qualityToggle);
    if (p.noise_schedule != null) c.noise_schedule = String(p.noise_schedule || '');
    if (p.sm != null) c.sm = boolValue(p.sm, c.sm);
    if (p.sm_dyn != null) c.sm_dyn = boolValue(p.sm_dyn, c.sm_dyn);
    if (p.dynamic_thresholding != null) c.dynamic_thresholding = boolValue(p.dynamic_thresholding, c.dynamic_thresholding);
    if (p.skip_cfg_above_sigma != null) { c.variety_boost = true; c.skip_cfg_above_sigma = p.skip_cfg_above_sigma; }
  }
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKey = b.apiKey.trim();
  return c;
}

function defaultVarietySigma(model) {
  return /^nai-diffusion-4-5/i.test(String(model || '')) ? 58 : 19;
}
function buildNaiBody(cfg, positive, negative, seed, characters) {
  const isV4 = /nai-diffusion-4/i.test(cfg.model);
  const chars = (Array.isArray(characters) ? characters : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 6);
  const sampler = String(cfg.sampler || 'k_euler_ancestral');
  const canSmea = sampler.toLowerCase() !== 'ddim';
  const autoSmea = cfg.auto_smea !== false && canSmea && (Number(cfg.width) * Number(cfg.height) >= 1024 * 1024);
  const useSmeaDyn = !!cfg.sm_dyn && canSmea;
  const useSmea = !useSmeaDyn && canSmea && (!!cfg.sm || autoSmea);
  const params = {
    params_version: finiteInt(cfg.params_version, 3, 1, 4),
    width: finiteInt(cfg.width, 832, 64, 2048),
    height: finiteInt(cfg.height, 1216, 64, 2048),
    scale: finiteNum(cfg.scale, 5, 0.1, 20),
    sampler,
    steps: finiteInt(cfg.steps, 28, 1, 50),
    n_samples: finiteInt(cfg.n_samples, 1, 1, 4),
    qualityToggle: cfg.qualityToggle !== false,
    dynamic_thresholding: !!cfg.dynamic_thresholding,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: finiteNum(cfg.cfg_rescale, 0, 0, 1),
    legacy_v3_extend: false,
    seed,
    negative_prompt: negative,
    image_format: cfg.image_format === 'webp' ? 'webp' : 'png',
  };
  if (String(cfg.noise_schedule || '').trim()) params.noise_schedule = String(cfg.noise_schedule).trim();
  if (useSmea) params.sm = true;
  if (useSmeaDyn) params.sm_dyn = true;
  if (cfg.decrisper) {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  if (cfg.variety_boost) {
    const sigma = finiteNum(cfg.skip_cfg_above_sigma, defaultVarietySigma(cfg.model), 0, 1000);
    params.skip_cfg_above_sigma = sigma;
  }
  if (isV4) {
    const xs = chars.length ? CHAR_CENTERS[chars.length - 1] : [];
    const posChars = chars.map((c, i) => ({ char_caption: c, centers: [{ x: xs[i], y: 0.5 }] }));
    const negChars = chars.map((_, i) => ({ char_caption: '', centers: [{ x: xs[i], y: 0.5 }] }));
    params.use_coords = false;
    params.characterPrompts = chars.map((c, i) => ({ prompt: c, uc: '', center: { x: xs[i], y: 0.5 }, enabled: true }));
    params.v4_prompt = { caption: { base_caption: positive, char_captions: posChars }, use_coords: false, use_order: true };
    params.v4_negative_prompt = { caption: { base_caption: negative, char_captions: negChars }, legacy_uc: false, use_coords: false, use_order: false };
  } else {
    params.sm = !!params.sm;
    params.sm_dyn = !!params.sm_dyn;
  }
  return { input: positive, model: cfg.model, action: 'generate', parameters: params };
}

function extractFirstImageFromZip(zipBuf) {
  const tmp = path.join(os.tmpdir(), 'nai-' + crypto.randomBytes(5).toString('hex') + '.zip');
  fs.writeFileSync(tmp, zipBuf);
  try { return execFileSync('unzip', ['-p', tmp], { maxBuffer: 64 * 1024 * 1024 }); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function collectJsonImageValues(payload) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const raw = String(v || '').trim();
    if (!raw || seen.has(raw)) return;
    if (/^(?:https?:\/\/|data:image\/)/i.test(raw) || /^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  };
  const walk = (node) => {
    if (node == null || out.length >= 8) return;
    if (typeof node === 'string') { add(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    for (const k of ['url', 'src', 'href', 'image', 'imageUrl', 'image_url', 'data', 'base64', 'b64_json']) {
      if (node[k] != null) add(node[k]);
    }
    for (const k of ['images', 'artifacts', 'outputs', 'output', 'data', 'results', 'result']) {
      if (node[k] != null) walk(node[k]);
    }
  };
  walk(payload);
  return out;
}
async function imageBufferFromJsonValue(value) {
  const raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    const r = await fetch(raw);
    if (!r.ok) throw new Error('图片地址下载失败 ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  if (/^data:image\/[^;]+;base64,/i.test(raw)) {
    return Buffer.from(raw.replace(/^data:image\/[^;]+;base64,/i, ''), 'base64');
  }
  return Buffer.from(raw.replace(/\s+/g, ''), 'base64');
}
async function readGeneratedImageBuffer(r) {
  const contentType = String(r.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (/^image\//.test(contentType)) return buf;
  if (/zip|octet-stream|x-zip/i.test(contentType) || (buf[0] === 0x50 && buf[1] === 0x4b)) return extractFirstImageFromZip(buf);
  if (/json/i.test(contentType) || /^[\s\r\n]*[{[]/.test(buf.toString('utf8', 0, Math.min(buf.length, 20)))) {
    const j = JSON.parse(buf.toString('utf8'));
    const values = collectJsonImageValues(j);
    if (!values.length) throw new Error('接口没有返回可识别的图片字段');
    return imageBufferFromJsonValue(values[0]);
  }
  throw new Error('接口返回格式无法识别：' + (contentType || 'unknown'));
}
function writeImage(buf) {
  const magic = imageMagic(buf);
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const name = id + '.' + magic.ext;
  fs.writeFileSync(path.join(IMG_DIR, name), buf);
  return { id, name, url: `/api/image/file/${name}`, contentType: magic.type };
}

function mountImageRoutes(app) {
  fs.mkdirSync(IMG_DIR, { recursive: true });

  app.get('/api/image/config', (req, res) => res.json({ ok: true, config: publicCfg(loadCfg()) }));

  app.put('/api/image/config', (req, res) => {
    const c = applyConfigBody(loadCfg(), req.body || {});
    saveCfg(c);
    res.json({ ok: true, config: publicCfg(c) });
  });

  app.post('/api/image/presets', (req, res) => {
    const c = loadCfg(); const b = req.body || {};
    const p = {
      id: crypto.randomBytes(5).toString('hex'),
      name: String(b.name || '未命名预设').slice(0, 40),
      prompt: String(b.prompt || ''),
      negative: String(b.negative || ''),
      character: String(b.character || ''),
      lockCharacters: !!b.lockCharacters,
    };
    c.presets.push(p);
    if (!c.activePresetId) c.activePresetId = p.id;
    saveCfg(c);
    res.json({ ok: true, preset: p, config: publicCfg(c) });
  });
  app.put('/api/image/presets/:id', (req, res) => {
    const c = loadCfg(); const p = c.presets.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, error: 'preset not found' });
    const b = req.body || {};
    for (const k of ['name', 'prompt', 'negative', 'character']) if (typeof b[k] === 'string') p[k] = b[k];
    if (typeof b.lockCharacters === 'boolean') p.lockCharacters = b.lockCharacters;
    saveCfg(c);
    res.json({ ok: true, preset: p });
  });
  app.delete('/api/image/presets/:id', (req, res) => {
    const c = loadCfg();
    c.presets = c.presets.filter(x => x.id !== req.params.id);
    if (c.activePresetId === req.params.id) c.activePresetId = c.presets[0] ? c.presets[0].id : '';
    saveCfg(c);
    res.json({ ok: true, config: publicCfg(c) });
  });

  app.post('/api/image/test', async (req, res) => {
    const c = applyConfigBody(loadCfg(), req.body || {});
    const key = (req.body && req.body.apiKey) || c.apiKey;
    if (!key) return res.status(400).json({ ok: false, valid: false, error: c.provider === 'novelai' ? '还没填 NovelAI API Key' : '还没填接口 API Key' });
    if (c.provider === 'novelai' && c.baseUrl && !isOfficialNovelAiBase(c.baseUrl)) {
      return res.json({ ok: true, valid: true, custom: true, model: c.model, message: '第三方 NovelAI Base URL 已保存；连接有效性请用测试生图验证。' });
    }
    if (c.provider !== 'novelai') {
      return res.json({ ok: true, valid: true, custom: true, model: c.model, message: '自定义接口 Key 已收到；请用测试生图验证。' });
    }
    try {
      const r = await fetch(NAI_USER_API, { headers: { Authorization: 'Bearer ' + key } });
      if (r.status === 401) return res.json({ ok: false, valid: false, error: 'Key 无效（401）' });
      if (!r.ok) return res.json({ ok: false, valid: false, error: 'NovelAI 返回 ' + r.status });
      const j = await r.json().catch(() => ({}));
      const tn = j.trainingStepsLeft || {};
      const anlas = (tn.fixedTrainingStepsLeft || 0) + (tn.purchasedTrainingStepsLeft || 0);
      res.json({ ok: true, valid: true, tier: j.tier, active: j.active, anlas });
    } catch (e) { res.status(502).json({ ok: false, valid: false, error: e.message }); }
  });

  // 测试框和 MCP 共用：body 支持 { scene, prompt, presetId, activePresetId, negative, seed, characters }
  app.post('/api/image/generate', async (req, res) => {
    const baseCfg = loadCfg();
    const b = req.body || {};
    const c = applyConfigBody(baseCfg, b);
    const isOpenAiCompat = c.provider === 'openai-image';
    if (!c.apiKey) return res.status(400).json({ ok: false, error: (isOpenAiCompat ? '还没填接口 API Key' : '还没填 NovelAI API Key') + '（生图设置里填一次）' });
    if (c.provider === 'novelai' && c.baseUrl) c.baseUrl = normalizeBaseUrl(c.baseUrl, 'novelai');
    if (c.provider !== 'novelai' && !isOpenAiCompat) return res.status(400).json({ ok: false, error: '这个后端目前只支持 NovelAI 协议和 OpenAI Images；第三方 NovelAI 请把 provider 选 NovelAI，再填 Base URL。' });
    const scene = String(b.scene || b.actionPrompt || b.prompt || '').trim();
    const preset = c.presets.find(p => p.id === (b.presetId || b.activePresetId || c.activePresetId));
    const presetChars = (preset && preset.character) ? String(preset.character).split(/\n+/) : [];
    const charsRaw = (preset && preset.lockCharacters && presetChars.length)
      ? presetChars
      : ((Array.isArray(b.characters) && b.characters.length) ? b.characters : (presetChars.length > 1 ? presetChars : []));
    const characters = charsRaw.map(s => String(s || '').trim()).filter(Boolean);
    const singleChar = (!characters.length && preset && preset.character) ? preset.character : '';
    const parts = [preset && preset.prompt, singleChar, scene].map(s => String(s || '').trim()).filter(Boolean);
    const positive = parts.join(', ');
    if (!positive && !characters.length) return res.status(400).json({ ok: false, error: '没有提示词：请先选一个预设组，或在测试框输入动作/场景。' });
    const negative = String(b.negative || (preset && preset.negative) || c.negativeDefault || '').trim();
    const seed = Number.isFinite(Number(b.seed)) && Number(b.seed) > 0 ? Number(b.seed) : crypto.randomInt(1, 4294967295);
    try {
      let img;
      if (isOpenAiCompat) {
        const base = normalizeBaseUrl(c.baseUrl || 'https://api.openai.com', 'openai-image').replace(/\/+$/, '');
        const r = await fetch(base + '/v1/images/generations', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: c.model, prompt: positive, size: `${c.width}x${c.height}`, n: 1 }),
        });
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          return res.status(502).json({ ok: false, error: upstreamErrorLabel(r.status, r.headers.get('content-type'), detail, base) });
        }
        img = await readGeneratedImageBuffer(r);
      } else {
        const naiBase = normalizeBaseUrl(c.baseUrl || 'https://image.novelai.net', 'novelai').replace(/\/+$/, '');
        const body = buildNaiBody(c, positive, negative, seed, characters);
        const r = await fetch(naiBase + '/ai/generate-image', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + c.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/x-zip-compressed, application/zip, image/png, image/webp, application/json',
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          return res.status(502).json({ ok: false, error: upstreamErrorLabel(r.status, r.headers.get('content-type'), detail, naiBase) });
        }
        img = await readGeneratedImageBuffer(r);
      }
      const saved = writeImage(img);
      res.json({ ok: true, id: saved.id, url: saved.url, prompt: positive, negative, seed, preset: preset ? preset.name : '' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/image/file/:name', (req, res) => {
    const name = path.basename(String(req.params.name));
    const fp = path.join(IMG_DIR, name);
    if (!/^[\w.-]+\.(png|webp|jpg|jpeg)$/i.test(name) || !fs.existsSync(fp)) return res.status(404).end();
    const ext = name.split('.').pop().toLowerCase();
    const type = ext === 'webp' ? 'image/webp' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    fs.createReadStream(fp).pipe(res);
  });
}

module.exports = { mountImageRoutes };
