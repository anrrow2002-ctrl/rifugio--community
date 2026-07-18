#!/usr/bin/env node
// ============================================================
// mcp-health.js — Rifugio 健康数据 stdio MCP server（只读）
// 聊天里 Claude 调 get_health → 读 health_days/health_heart/health_user 三张表，
// 把用户的步数/睡眠/心率/月经/吃药/目标拿过来，便于关心身体、回答健康问题。
// 数据由 iPhone 快捷指令(/api/health/ingest) + 前端记录(/api/health/menstrual-records) 写入。
// ============================================================
const Database = require('better-sqlite3');
const DB_PATH = process.env.RIFUGIO_DB || require('./modules/community-config').dataPath('rifugio-memory.db');

// 前端枚举码 → 中文标签（让报告可读；未知码原样返回）
const FLOW = { spotting: '点滴', light: '少', medium: '中', heavy: '多', flooding: '很多' };
const COLOR = { bright_red: '鲜红', dark_red: '暗红', brown: '褐色', pink: '粉色', black: '黑红', orange: '橙红' };
const MOOD = { happy: '开心', calm: '平静', irritable: '烦躁', anxious: '焦虑', low: '低落', tired: '疲惫', sad: '难过', sensitive: '敏感' };
const SYMPTOM = { breast_tenderness: '乳房胀痛', bloating: '腹胀', headache: '头痛', appetite_change: '食欲变化', acne: '长痘', insomnia: '失眠', fatigue: '乏力', back_pain: '腰酸' };
const LOC = { abdomen: '腹部', lower_back: '腰部', thigh: '大腿', head: '头部' };
const lab = (map, v) => map[v] || v || '';
const labs = (map, arr) => (Array.isArray(arr) ? arr : []).map(x => lab(map, x)).filter(Boolean).join('/');

const TOOL_GET_HEALTH = {
  name: 'get_health',
  description: '读取用户的健康数据：最近 N 天的步数/睡眠/心率，以及月经记录(流量/颜色/痛经/部位/心情/症状/备注)、吃药记录、目标。用户问身体状况、月经、睡眠、运动、吃药时调用。只读，不写。',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '步数/睡眠/心率回看天数，默认 14，最多 90' },
      include_period: { type: 'boolean', description: '是否包含月经记录，默认 true' },
    },
    required: [],
  },
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function jget(db, key, fb) { const r = db.prepare('SELECT value FROM health_user WHERE key=?').get(key); if (!r) return fb; try { return JSON.parse(r.value); } catch (_) { return fb; } }

function buildHealthReport(args = {}) {
  const days = Math.min(Math.max(parseInt(args.days) || 14, 1), 90);
  const includePeriod = args.include_period !== false;
  const since = (() => { const d = new Date(); d.setDate(d.getDate() - (days - 1)); return d.toISOString().slice(0, 10); })();
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const dayRows = db.prepare('SELECT * FROM health_days WHERE date >= ? ORDER BY date DESC').all(since);
    const heartRows = db.prepare('SELECT * FROM health_heart WHERE date >= ? ORDER BY date DESC, time DESC').all(since);
    const out = [`[用户的健康数据 · 最近 ${days} 天]`];

    if (dayRows.length) {
      out.push('\n步数 / 睡眠（每天一行）:');
      for (const r of dayRows) {
        const parts = [];
        if (r.steps != null) parts.push(`步数 ${r.steps}`);
        if (r.walk_heart != null) parts.push(`步行心率 ${r.walk_heart}`);
        if (r.walk_speed != null) parts.push(`速度 ${r.walk_speed}`);
        if (r.sleep_hours != null) parts.push(`睡眠 ${r.sleep_hours}h${r.bedtime ? `(${r.bedtime}→${r.wake || '?'})` : ''}${r.sleep_quality ? ' ' + r.sleep_quality : ''}`);
        out.push(`- ${r.date}: ${parts.join('，') || '（无）'}`);
      }
    } else out.push('\n步数/睡眠：暂无数据（等 iPhone 快捷指令上传）');

    if (heartRows.length) {
      out.push('\n心率读数:');
      for (const r of heartRows) out.push(`- ${r.date}${r.time ? ' ' + r.time : ''}: ${r.rate}${r.resting != null ? `（静息 ${r.resting}）` : ''}${r.note ? ' ' + r.note : ''}`);
    }

    if (includePeriod) {
      const pd = jget(db, 'periodDays', {});
      const keys = Object.keys(pd).sort().reverse();
      if (keys.length) {
        out.push('\n月经记录:');
        for (const k of keys.slice(0, 40)) {
          const p = pd[k] || {};
          const seg = [`流量${lab(FLOW, p.flow)}`, lab(COLOR, p.color)];
          if (p.painLevel) seg.push(`痛经${p.painLevel}级${p.painLocations?.length ? '(' + labs(LOC, p.painLocations) + ')' : ''}`);
          if (p.moods?.length) seg.push('心情' + labs(MOOD, p.moods));
          if (p.symptoms?.length) seg.push('症状' + labs(SYMPTOM, p.symptoms));
          if (p.note) seg.push(`备注"${p.note}"`);
          out.push(`- ${k}: ${seg.filter(Boolean).join('，')}`);
        }
        // 简单推算下次
        const last = keys[0];
        const next = new Date(last + 'T00:00:00'); next.setDate(next.getDate() + 28);
        out.push(`（最近一次记录 ${last}，按 28 天周期约 ${next.toISOString().slice(0, 10)} 前后）`);
      } else out.push('\n月经：暂无记录');
    }

    const meds = jget(db, 'medications', []);
    if (Array.isArray(meds) && meds.length) {
      out.push('\n吃药:');
      // 按吉隆坡时区计算“今天”，避免服务器 UTC 偏差
      const klNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
      const today = klNow.getFullYear() + '-' + String(klNow.getMonth() + 1).padStart(2, '0') + '-' + String(klNow.getDate()).padStart(2, '0');
      const todayDow = klNow.getDay();
      for (const m of meds) {
        // custom 日程：只显示今天启用的药单（跟随前端 customDays 配置）
        if (m.schedule === 'custom' && Array.isArray(m.customDays)) {
          const d = m.customDays.find(x => x && x.dow === todayDow);
          if (!d || !d.enabled) continue;
        }
        const took = Array.isArray(m.takenDates) && m.takenDates.includes(today);
        out.push(`- ${m.name}${m.dose ? ' ' + m.dose : ''}${m.time ? ' ' + m.time : ''}${m.schedule === 'asNeeded' ? ' 按需' : ''}${m.enabled === false ? ' (已停)' : ''}${took ? ' · 今天已服' : ''}`);
      }
    }

    const goals = jget(db, 'goals', null);
    if (goals) out.push(`\n目标: 步数 ${goals.steps ?? '-'} / 睡眠 ${goals.sleep ?? '-'}h`);

    if (out.length === 1) return '（暂时没有任何健康数据。用户还没上传/记录。）';
    return out.join('\n');
  } finally { db.close(); }
}

async function handle(req) {
  const { id, method, params } = req || {};
  const hasId = id !== undefined && id !== null;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'rifugio-health', version: '1.0.0' },
    }});
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [TOOL_GET_HEALTH] } });
  }
  if (method !== 'tools/call') {
    if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    return;
  }
  const name = params?.name;
  const args = params?.arguments || {};
  try {
    if (name === 'get_health') {
      const text = buildHealthReport(args);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    }
    if (hasId) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `get_health 失败：${e.message}` }], isError: true } });
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
process.stderr.write('[mcp-health] ready — tool: get_health\n');
