#!/usr/bin/env node
// ============================================================
// mcp-radio.js — Rifugio 电台/音乐/有声 stdio MCP server
// 聊天里 Claude 调：
//   radio_play    一步到位：自动搜歌/电台/有声故事并推到前端播放；可带 sleep_minutes 哄睡定时
//                 （网易云付费曲 + Audius + 全球电台 + Archive；单曲放完前端自动停）
// 走本机 HTTP localhost:3457（指令队列在 server 进程里），带 x-chat-token 过鉴权门。
// ============================================================
const fs = require('fs');
const API = process.env.RIFUGIO_API || 'http://127.0.0.1:3457';

// CHAT_TOKEN：优先环境变量，否则从 api/.env 读一行
function chatToken() {
  if (process.env.CHAT_TOKEN) return process.env.CHAT_TOKEN;
  try {
    const env = fs.readFileSync(__dirname + '/.env', 'utf8');
    const m = env.match(/^CHAT_TOKEN=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const TOKEN = chatToken();
const HEADERS = { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-chat-token': TOKEN } : {}) };

async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: HEADERS, ...opts });
  if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
  return r.json();
}

const TOOLS = [
  {
    name: 'radio_play',
    description: '放歌/电台/有声故事，一步到位：给 query 自动搜并播最佳一条；想哄睡连续放就同时给 sleep_minutes（N 分钟后自动停）。单曲放完前端会自动停。歌曲覆盖国内主流曲库 + Audius；type=radio 全球电台直播、audiobook/story 走 Internet Archive。也可给已知直链 url+title 播指定音频。指令推到前端约 6 秒内开始播。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要播放的关键词，如"晴天 周杰伦"、"白噪音 雨声"、"睡前故事"（自动搜索取最佳一条）' },
        type: { type: 'string', description: 'song 歌曲(默认)/radio 电台/audiobook 有声/story 故事' },
        url: { type: 'string', description: '已知直链时直接给（与 query 二选一）' },
        title: { type: 'string', description: '配合 url 给的标题' },
        sleep_minutes: { type: 'integer', description: '可选：播放同时设定 N 分钟后自动停止（哄睡）' },
      },
      required: [],
    },
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const SID = 'default';

async function doSearch(args) {
  const limit = Math.min(Number(args.limit) || 8, 20);
  const params = new URLSearchParams({ q: String(args.query || ''), type: String(args.type || ''), providers: 'all', limit: String(limit) });
  const j = await api('/api/radio/search?' + params.toString());
  const list = (j.results || []).slice(0, Math.min(Number(args.limit) || 8, 20));
  if (!list.length) return { list, text: '没搜到结果。换个关键词试试？' };
  const lines = list.map((it, i) =>
    `${i + 1}. ${it.title}${it.artist ? ' — ' + it.artist : ''}（${it.source || it.provider}${it.durationLabel ? ' · ' + it.durationLabel : ''}）`);
  return { list, text: lines.join('\n') };
}

async function handle(req) {
  const { id, method, params } = req || {};
  const hasId = id !== undefined && id !== null;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rifugio-radio', version: '1.0.0' } } });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method !== 'tools/call') { if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } }); return; }

  const name = params?.name;
  const args = params?.arguments || {};
  const ok = (text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  try {
    if (name === 'radio_play') {
      let item = null;
      if (args.url) {
        item = { title: args.title || '指定音频', url: args.url, type: args.type || 'song', provider: 'mcp', source: 'Claude' };
      } else if (args.query) {
        const { list } = await doSearch({ query: args.query, type: args.type, limit: 5 });
        item = list.find(x => x.url) || null;
      }
      if (!item || !item.url) return ok('没有可播放的音频（没给 url，也没搜到带直链的结果）。');
      await api('/api/playback/commands', { method: 'POST', body: JSON.stringify({ sessionId: SID, title: item.title, url: item.url, type: item.type, provider: item.provider, source: item.source, durationLabel: item.durationLabel }) });
      let extra = '';
      if (args.sleep_minutes) { const s = await api('/api/playback/sleep', { method: 'POST', body: JSON.stringify({ sessionId: SID, minutes: Number(args.sleep_minutes) }) }); extra = `，并设定 ${s.minutes} 分钟后停止哄睡`; }
      return ok(`▶ 已推送到前端电台：《${item.title}》${item.artist ? ' — ' + item.artist : ''}（${item.source}）${extra}。前端约 6 秒内开始播放。`);
    }

    if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${name} 失败：${e.message}` }], isError: true } });
  }
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
process.stdin.on('error', () => {});
process.stderr.write('[mcp-radio] ready — tools: radio_play\n');
