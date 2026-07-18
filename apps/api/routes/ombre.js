const express = require('express');
const router = express.Router();

const OMBRE_BASE = process.env.OMBRE_BASE_URL || 'https://example.invalid/ombre';
const OMBRE_API_KEY = process.env.OMBRE_API_KEY || '';

// 缓存 session,失效再重建
let cachedSession = null;
let initInFlight = null;

function parseMcpResponse(text) {
  // 可能是 JSON,也可能是 SSE 流
  try { return JSON.parse(text); } catch {}
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  if (!dataLine) throw new Error(`Ombre non-JSON: ${text.slice(0, 300)}`);
  return JSON.parse(dataLine.slice(5).trim());
}

async function initSession() {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rifugio-memory-api', version: '1.0.0' }
    }
  };
  const r = await fetch(`${OMBRE_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${OMBRE_API_KEY}`,
      'X-API-Key': OMBRE_API_KEY
    },
    body: JSON.stringify(body)
  });
  const sessionId = r.headers.get('mcp-session-id') || r.headers.get('Mcp-Session-Id');
  if (!sessionId) {
    const t = await r.text();
    throw new Error(`initialize did not return Mcp-Session-Id. status=${r.status} body=${t.slice(0,200)}`);
  }
  // 协议要求: 收到 initialize 响应后必须发 notifications/initialized
  await fetch(`${OMBRE_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${OMBRE_API_KEY}`,
      'X-API-Key': OMBRE_API_KEY,
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  return sessionId;
}

async function getSession() {
  if (cachedSession) return cachedSession;
  if (initInFlight) return initInFlight;
  initInFlight = initSession()
    .then(sid => { cachedSession = sid; initInFlight = null; return sid; })
    .catch(err => { initInFlight = null; throw err; });
  return initInFlight;
}

async function callOmbre(toolName, args = {}, _retry = false) {
  const sessionId = await getSession();
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  };
  const r = await fetch(`${OMBRE_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${OMBRE_API_KEY}`,
      'X-API-Key': OMBRE_API_KEY,
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify(body)
  });

  // session 过期 → 清掉重试一次
  if ((r.status === 400 || r.status === 404) && !_retry) {
    const t = await r.text();
    if (/session/i.test(t)) {
      cachedSession = null;
      return callOmbre(toolName, args, true);
    }
    throw new Error(`Ombre ${r.status}: ${t.slice(0,200)}`);
  }

  const text = await r.text();
  const json = parseMcpResponse(text);
  if (json.error) throw new Error(json.error.message || 'Ombre RPC error');
  const content = json.result?.content?.[0]?.text;
  if (content) {
    try { return JSON.parse(content); } catch { return { raw: content }; }
  }
  return json.result;
}

router.get('/health', async (req, res) => {
  try {
    const r = await fetch(`${OMBRE_BASE}/health`, {
      headers: { 'Authorization': `Bearer ${OMBRE_API_KEY}` }
    });
    res.json(await r.json());
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

router.get('/pulse', async (req, res) => {
  try { res.json({ ok: true, data: await callOmbre('pulse', {}) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/breath', async (req, res) => {
  try {
    const args = {};
    if (req.query.keyword) args.keyword = req.query.keyword;
    if (req.query.limit) args.limit = parseInt(req.query.limit);
    res.json({ ok: true, data: await callOmbre('breath', args) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/hold', async (req, res) => {
  try { res.json({ ok: true, data: await callOmbre('hold', req.body) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/trace', async (req, res) => {
  try { res.json({ ok: true, data: await callOmbre('trace', req.body) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
