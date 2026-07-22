// SOSEXY 玩具控制：VPS 安全层 → Cloudflare Tunnel → Mac BLE Bridge。
// 前端只负责状态、人工控制、AI 授权和记录；桥 token 永不返回或写入日志。
const crypto = require('crypto');
const BRIDGE_URL = String(process.env.SOSEXY_BRIDGE_URL || '').replace(/\/$/, '');
const CHANNELS = ['suck', 'vibrate', 'current'];
const MAX_HISTORY = 50;

function bridgeToken() {
  const token = String(process.env.SOSEXY_BRIDGE_TOKEN || '').trim();
  if (!BRIDGE_URL || !token) throw new Error('SOSEXY bridge is disabled or not configured');
  return token;
}

function redactForLog(value) {
  let clean = String(value == null ? '' : value);
  try {
    const token = bridgeToken();
    if (token) clean = clean.split(token).join('[token]');
  } catch (_) {}
  return clean.split(BRIDGE_URL).join('[bridge]').replace(/https?:\/\/[^\s"'`]+/g, '[url]');
}

async function bridgeRequest(path, method = 'GET', body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(BRIDGE_URL + path, {
      method,
      signal: controller.signal,
      headers: {
        'X-Bridge-Token': bridgeToken(),
        'User-Agent': 'Rifugio-API/1.0',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text.slice(0, 200) }; }
    if (!response.ok) {
      console.error(`[toy] bridge ${path} HTTP ${response.status} body=${redactForLog(text).slice(0, 300)}`);
      const failure = new Error(data.error || data.message || `bridge HTTP ${response.status}`);
      failure.bridgeLogged = true;
      throw failure;
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      console.error(`[toy] bridge ${path} timed out after ${timeoutMs}ms`);
      throw new Error('bridge request timed out');
    }
    if (!error || error.bridgeLogged !== true) console.error(`[toy] bridge ${path} failed: ${redactForLog(error && error.message)}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function channel(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!CHANNELS.includes(clean)) throw new Error('channel must be suck, vibrate, or current');
  return clean;
}

function intensity(value) {
  if (typeof value === 'boolean' || !Number.isInteger(Number(value))) throw new Error('intensity must be an integer from 0 to 100');
  const clean = Number(value);
  if (clean < 0 || clean > 100) throw new Error('intensity must be from 0 to 100');
  return clean;
}

function sequence(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('steps must contain 1 to 64 items');
  let totalHold = 0;
  const steps = value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`step ${index + 1} must be an object`);
    const hold = Number(step.hold == null ? 1 : step.hold);
    if (!Number.isFinite(hold) || hold < 0 || hold > 120) throw new Error(`step ${index + 1} hold must be from 0 to 120 seconds`);
    totalHold += hold;
    return { channel: channel(step.channel), intensity: intensity(step.intensity), hold };
  });
  if (totalHold > 300) throw new Error('sequence total hold must not exceed 300 seconds');
  return { steps, totalHold };
}

function flow(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('steps must contain 1 to 64 items');
  let totalSeconds = 0;
  const steps = value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`step ${index + 1} must be an object`);
    const hasFrom = Object.prototype.hasOwnProperty.call(step, 'from');
    const hasTo = Object.prototype.hasOwnProperty.call(step, 'to');
    if (hasFrom || hasTo) {
      if (!hasFrom || !hasTo) throw new Error(`step ${index + 1} ramp requires both from and to`);
      const seconds = Number(step.seconds == null ? 2 : step.seconds);
      if (typeof step.seconds === 'boolean' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120) {
        throw new Error(`step ${index + 1} seconds must be greater than 0 and at most 120`);
      }
      totalSeconds += seconds;
      return { channel: channel(step.channel), from: intensity(step.from), to: intensity(step.to), seconds };
    }
    const hold = Number(step.hold == null ? 1 : step.hold);
    if (typeof step.hold === 'boolean' || !Number.isFinite(hold) || hold < 0 || hold > 120) {
      throw new Error(`step ${index + 1} hold must be from 0 to 120 seconds`);
    }
    totalSeconds += hold;
    return { channel: channel(step.channel), intensity: intensity(step.intensity), hold };
  });
  if (totalSeconds > 300) throw new Error('flow total duration must not exceed 300 seconds');
  return { steps, totalSeconds };
}

function wild(value) {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const duration = Number(body.duration == null ? 600 : body.duration);
  if (typeof body.duration === 'boolean' || !Number.isInteger(duration) || duration < 1 || duration > 1800) {
    throw new Error('duration must be an integer from 1 to 1800 seconds');
  }
  const rawChannels = body.channels == null ? ['suck', 'vibrate'] : body.channels;
  if (!Array.isArray(rawChannels) || !rawChannels.length || rawChannels.length > CHANNELS.length) {
    throw new Error('channels must contain 1 to 3 valid channels');
  }
  const channels = rawChannels.map(channel);
  if (new Set(channels).size !== channels.length) throw new Error('channels must not contain duplicates');
  const ceiling = Number(body.ceiling == null ? 80 : body.ceiling);
  if (typeof body.ceiling === 'boolean' || !Number.isInteger(ceiling) || ceiling < 60 || ceiling > 90) {
    throw new Error('ceiling must be an integer from 60 to 90');
  }
  return { duration, channels, ceiling };
}

function mountToyRoutes(app) {
  const state = {
    bridgeAlive: false,
    toyConnected: false,
    aiControlEnabled: false,
    lastCheckedAt: null,
    lastError: '',
    history: [],
  };

  const snapshot = () => ({
    bridgeAlive: state.bridgeAlive,
    toyConnected: state.toyConnected,
    aiControlEnabled: state.aiControlEnabled,
    lastCheckedAt: state.lastCheckedAt,
    lastError: state.lastError,
    deviceName: 'SOSEXY',
    channels: CHANNELS,
    history: state.history.slice(),
  });

  function begin(action, source, details = {}) {
    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      createdAt: new Date().toISOString(),
      source,
      action,
      status: 'pending',
      ...details,
    };
    state.history.unshift(item);
    state.history = state.history.slice(0, MAX_HISTORY);
    return item;
  }

  function finish(item, status, resultOrError) {
    item.status = status;
    item.finishedAt = new Date().toISOString();
    if (status === 'done') item.result = resultOrError;
    else item.error = String(resultOrError && resultOrError.message || resultOrError || 'unknown error').slice(0, 240);
  }

  async function refreshBridge() {
    try {
      const ping = await bridgeRequest('/ping');
      state.bridgeAlive = ping.bridge === 'alive' || ping.ok === true;
      state.toyConnected = ping.toy_connected === true;
      state.lastError = '';
      return ping;
    } catch (error) {
      state.bridgeAlive = false;
      state.toyConnected = false;
      state.lastError = String(error.message || error).slice(0, 240);
      return null;
    } finally {
      state.lastCheckedAt = new Date().toISOString();
    }
  }

  function ensureAiAllowed() {
    if (!state.aiControlEnabled) {
      const error = new Error('前端尚未开启“允许 AI 控制”');
      error.statusCode = 403;
      throw error;
    }
  }

  async function runSet(req, res, source, requireConsent) {
    let item;
    try {
      const payload = { channel: channel(req.body && req.body.channel), intensity: intensity(req.body && req.body.intensity) };
      item = begin('set', source, payload);
      if (requireConsent) ensureAiAllowed();
      const result = await bridgeRequest('/set', 'POST', payload);
      finish(item, 'done', result);
      await refreshBridge();
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      if (item) finish(item, 'error', error);
      res.status(error.statusCode || 400).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  async function runSequence(req, res, source, requireConsent) {
    let item;
    try {
      const clean = sequence(req.body && req.body.steps);
      item = begin('sequence', source, { steps: clean.steps });
      if (requireConsent) ensureAiAllowed();
      const result = await bridgeRequest('/sequence', 'POST', { steps: clean.steps }, Math.max(30000, (clean.totalHold + 20) * 1000));
      finish(item, 'done', result);
      await refreshBridge();
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      if (item) finish(item, 'error', error);
      res.status(error.statusCode || 400).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  async function runFlow(req, res, source, requireConsent) {
    let item;
    try {
      const clean = flow(req.body && req.body.steps);
      item = begin('flow', source, { steps: clean.steps, duration: clean.totalSeconds });
      if (requireConsent) ensureAiAllowed();
      const result = await bridgeRequest('/flow', 'POST', { steps: clean.steps }, Math.max(30000, (clean.totalSeconds + 20) * 1000));
      finish(item, 'done', result);
      await refreshBridge();
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      if (item) finish(item, 'error', error);
      res.status(error.statusCode || 400).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  async function runWild(req, res, source, requireConsent) {
    let item;
    try {
      const payload = wild(req.body);
      item = begin('wild', source, payload);
      if (requireConsent) ensureAiAllowed();
      // The Mac bridge acknowledges immediately and runs the waveform locally.
      const result = await bridgeRequest('/wild', 'POST', payload, 15000);
      finish(item, 'done', result);
      refreshBridge().catch(() => {});
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      if (item) finish(item, 'error', error);
      res.status(error.statusCode || 400).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  async function runStop(req, res, source) {
    const item = begin('stop', source, { intensity: 0 });
    try {
      const result = await bridgeRequest('/stop', 'POST', {});
      finish(item, 'done', result);
      await refreshBridge();
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      finish(item, 'error', error);
      res.status(502).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  app.locals.toyState = snapshot;

  app.get('/api/toy/state', async (_req, res) => {
    await refreshBridge();
    res.json({ ok: true, state: snapshot() });
  });

  app.post('/api/toy/ai-control', async (req, res) => {
    if (typeof (req.body && req.body.enabled) !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be boolean' });
    state.aiControlEnabled = req.body.enabled;
    if (!state.aiControlEnabled) {
      const item = begin('stop', 'permission', { intensity: 0, note: 'AI control disabled' });
      try { finish(item, 'done', await bridgeRequest('/stop', 'POST', {})); }
      catch (error) { finish(item, 'error', error); }
    }
    await refreshBridge();
    res.json({ ok: true, state: snapshot() });
  });

  app.post('/api/toy/set', (req, res) => runSet(req, res, 'user', false));
  app.post('/api/toy/sequence', (req, res) => runSequence(req, res, 'user', false));
  app.post('/api/toy/stop', (req, res) => runStop(req, res, (req.body && req.body.source) || 'user'));
  app.post('/api/toy/wild', (req, res) => runWild(req, res, 'user', false));

  // Display-only status polling: a failed poll must never stop a bridge-local run.
  app.get('/api/toy/wild-status', async (_req, res) => {
    try {
      const ping = await bridgeRequest('/ping', 'GET', undefined, 6000);
      res.json({
        ok: true,
        running: ping.running === true,
        remaining: Number.isFinite(Number(ping.remaining)) ? Math.max(0, Math.round(Number(ping.remaining))) : null,
        mode: typeof ping.mode === 'string' ? ping.mode : null,
        toyConnected: ping.toy_connected === true,
      });
    } catch (_) {
      res.json({ ok: false, unavailable: true });
    }
  });

  app.post('/api/toy/mcp/set', (req, res) => runSet(req, res, 'mcp', true));
  app.post('/api/toy/mcp/sequence', (req, res) => runSequence(req, res, 'mcp', true));
  app.post('/api/toy/mcp/flow', (req, res) => runFlow(req, res, 'mcp', true));
  app.post('/api/toy/mcp/wild', (req, res) => runWild(req, res, 'mcp', true));
  app.post('/api/toy/mcp/stop', (req, res) => runStop(req, res, 'mcp'));

  // 兼容旧前端的紧停地址；旧队列不再执行真实设备动作。
  app.post('/api/toy/commands/stop', (req, res) => runStop(req, res, (req.body && req.body.source) || 'user'));
}

module.exports = { mountToyRoutes };
