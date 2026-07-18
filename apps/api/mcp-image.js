#!/usr/bin/env node
// ============================================================
// mcp-image.js — Rifugio 生图 stdio MCP server（仅 CC，Claude.ai 不加）
// 聊天里用户说"画一张 XX"，我调 generate_image → NovelAI 出图 → 返回图片 URL，
// 我把 URL 放进回复，前端聊天框渲染成图片，她可以看、可以保存。
// 画师串/质量串/负向走后端"预设库"，可指定 preset 名或用当前激活预设。
// ============================================================
const fs = require('fs');
const API = process.env.RIFUGIO_API || 'http://127.0.0.1:3457';
function chatToken() {
  if (process.env.CHAT_TOKEN) return process.env.CHAT_TOKEN;
  try { const m = fs.readFileSync(__dirname + '/.env', 'utf8').match(/^CHAT_TOKEN=(.*)$/m); return m ? m[1].trim() : ''; }
  catch { return ''; }
}
const HEADERS = { 'Content-Type': 'application/json', ...(chatToken() ? { 'x-chat-token': chatToken() } : {}) };
async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: HEADERS, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('API ' + r.status));
  return j;
}

const TOOLS = [
  {
    name: 'generate_image',
    description: '用 NovelAI 生成一张图片（用户想看图、说"画一张…"时用）。画师串/质量串/负向由后端"预设库"管理；scene 写整体场景/动作/构图。要画多个人（比如"我和你"）时，必须用 characters 数组把每个人单独描述，否则只会画出一个人/糊在一起。出图后返回图片 URL，请把 URL 原样写进回复，前端会渲染给用户看和保存。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '整体场景/动作/构图/背景（不用写画师串，预设里有）；多角色时这里只写共同的场景，不写各自长相' },
        characters: { type: 'array', items: { type: 'string' }, description: '多角色时每人一条描述（如 ["1girl, 长发, 红裙", "1boy, 西装, 短发"]）。画"我和你"两个人就给两条。单人可不填。' },
        preset: { type: 'string', description: '可选：指定预设组名字（不填用当前激活的预设）' },
        negative: { type: 'string', description: '可选：额外负向（不填用预设/默认负向）' },
      },
      required: ['scene'],
    },
  },
  {
    name: 'list_image_presets',
    description: '列出生图的预设组（每组是一套画师 prompt/质量串/负向），以及当前激活的是哪组。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(req) {
  const { id, method, params } = req || {};
  const hasId = id !== undefined && id !== null;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rifugio-image', version: '1.0.0' } } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method !== 'tools/call') { if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } }); return; }

  const name = params?.name;
  const a = params?.arguments || {};
  const ok = (text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  try {
    if (name === 'list_image_presets') {
      const { config } = await api('/api/image/config');
      if (!config.presets.length) return ok('还没有预设组。用户可以在生图设置里保存几套画师 prompt。');
      const lines = config.presets.map(p => `${p.id === config.activePresetId ? '★' : '·'} ${p.name}${p.prompt ? '：' + p.prompt.slice(0, 60) : ''}`);
      return ok('生图预设组：\n' + lines.join('\n'));
    }
    if (name === 'generate_image') {
      let presetId;
      if (a.preset) {
        const { config } = await api('/api/image/config');
        const hit = config.presets.find(p => p.name === a.preset || p.id === a.preset);
        if (hit) presetId = hit.id;
      }
      const j = await api('/api/image/generate', { method: 'POST', body: JSON.stringify({ scene: a.scene, characters: Array.isArray(a.characters) ? a.characters : undefined, presetId, negative: a.negative }) });
      return ok(`图片已生成（预设：${j.preset || '无'}，seed ${j.seed}）。\n请把这个相对链接原样写进你给用户的回复里：${j.url}\n前端会把它渲染成图片，她能看也能保存。不要改成别的地址、不要加域名。`);
    }
    if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${name} 失败：${e.message}` }], isError: true } });
  }
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk; let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
process.stdin.on('error', () => {});
process.stderr.write('[mcp-image] ready — tools: generate_image, list_image_presets\n');
