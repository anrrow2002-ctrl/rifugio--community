#!/usr/bin/env node
// Rifugio 内置 Claude 玩具 MCP：统一经过 VPS Toy API，受 PWA 的 AI 授权开关约束。
const fs = require('fs');
const API = process.env.RIFUGIO_API || 'http://127.0.0.1:3457';

function chatToken() {
  if (process.env.CHAT_TOKEN) return process.env.CHAT_TOKEN;
  try { const m = fs.readFileSync(__dirname + '/.env', 'utf8').match(/^CHAT_TOKEN=(.*)$/m); return m ? m[1].trim() : ''; }
  catch { return ''; }
}

async function api(path, method = 'GET', body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      ...(chatToken() ? { 'x-chat-token': chatToken() } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || `API ${response.status}`);
  return data;
}

const intensity = { type: 'integer', minimum: 0, maximum: 100, description: '强度 0–100' };
const channel = { type: 'string', enum: ['suck', 'vibrate', 'current'], description: 'suck=吮吸，vibrate=震动，current=电流' };
const TOOLS = [
  { name: 'toy_status', description: '查看 Mac 桥、SOSEXY 玩具和用户 AI 授权状态。控制前先调用。', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'toy_set', description: '设置 SOSEXY 的一个通道，强度 0–100。只有用户在 PWA 开启“允许 AI 控制”后才执行。', inputSchema: { type: 'object', properties: { channel, intensity }, required: ['channel', 'intensity'] } },
  { name: 'toy_sequence', description: '执行多步序列。steps_json 是 JSON 数组，每步含 channel、intensity(0–100)、hold(秒)。', inputSchema: { type: 'object', properties: { steps_json: { type: 'string', description: 'JSON 数组字符串，最多64步、总时长最多300秒' } }, required: ['steps_json'] } },
  { name: 'toy_stop', description: '立即停止所有通道；无论 AI 授权是否开启都可用。', inputSchema: { type: 'object', properties: {}, required: [] } },
];

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
async function handle(req) {
  const { id, method, params } = req || {};
  const hasId = id !== undefined && id !== null;
  if (method === 'initialize') return send({ jsonrpc:'2.0', id, result:{ protocolVersion:params?.protocolVersion || '2025-06-18', capabilities:{ tools:{} }, serverInfo:{ name:'rifugio-toy', version:'2.0.0' } } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') return send({ jsonrpc:'2.0', id, result:{ tools:TOOLS } });
  if (method !== 'tools/call') { if (hasId) send({ jsonrpc:'2.0', id, error:{ code:-32601, message:'Method not found: ' + method } }); return; }

  const name = params?.name;
  const args = params?.arguments || {};
  const ok = (text) => send({ jsonrpc:'2.0', id, result:{ content:[{ type:'text', text }] } });
  try {
    if (name === 'toy_status') {
      const state = (await api('/api/toy/state')).state || {};
      return ok(JSON.stringify({ bridge:state.bridgeAlive ? 'alive' : 'offline', toy_connected:state.toyConnected === true, ai_control_enabled:state.aiControlEnabled === true }, null, 2));
    }
    if (name === 'toy_stop') { await api('/api/toy/mcp/stop', 'POST', {}); return ok('已立即停止 SOSEXY 全部通道。'); }
    if (name === 'toy_set') {
      await api('/api/toy/mcp/set', 'POST', { channel:args.channel, intensity:args.intensity });
      return ok(`已设置 ${args.channel} 为 ${args.intensity}/100。`);
    }
    if (name === 'toy_sequence') {
      let steps;
      try { steps = JSON.parse(args.steps_json); } catch (_) { throw new Error('steps_json 必须是 JSON 数组'); }
      await api('/api/toy/mcp/sequence', 'POST', { steps });
      return ok(`已执行 ${Array.isArray(steps) ? steps.length : 0} 步序列。`);
    }
    if (hasId) send({ jsonrpc:'2.0', id, error:{ code:-32602, message:'Unknown tool: ' + name } });
  } catch (error) {
    send({ jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:`${name} 失败：${error.message}` }], isError:true } });
  }
}

let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (_) {}
  }
});
process.stdin.on('error', () => {});
process.stderr.write('[mcp-toy] ready — tools: toy_status, toy_set, toy_sequence, toy_stop\n');
