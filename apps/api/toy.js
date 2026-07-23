// SOSEXY 玩具控制：
// - Android/Chromium PWA uses Web Bluetooth and acts as the local BLE executor.
// - A separately configured BLE bridge remains an optional fallback for remote use.
// MCP commands always pass through this API so consent, history, and emergency stop
// have one policy surface. Bridge tokens are never returned or written to logs.
const crypto = require('crypto');
const BRIDGE_URL = String(process.env.SOSEXY_BRIDGE_URL || '').replace(/\/$/, '');
const CHANNELS = ['suck', 'vibrate', 'current'];
const MAX_HISTORY = 50;
const DIRECT_ONLINE_MS = 12000;
const DIRECT_COMMAND_TIMEOUT_MS = 15000;

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
    bridgeToyConnected: false,
    directSupported: false,
    directConnected: false,
    directClientId: '',
    directLastSeenAt: 0,
    directWildRunning: false,
    directWildEndsAt: 0,
    aiControlEnabled: false,
    lastCheckedAt: null,
    lastError: '',
    history: [],
  };
  const directQueue = [];
  const directPending = new Map();
  const bridgeConfigured = Boolean(BRIDGE_URL && String(process.env.SOSEXY_BRIDGE_TOKEN || '').trim());
  const directOnline = () => Boolean(
    state.directClientId
    && state.directLastSeenAt
    && Date.now() - state.directLastSeenAt < DIRECT_ONLINE_MS
  );

  const snapshot = () => ({
    bridgeAlive: state.bridgeAlive,
    bridgeConfigured,
    bridgeToyConnected: state.bridgeToyConnected,
    directSupported: state.directSupported,
    directOnline: directOnline(),
    directConnected: directOnline() && state.directConnected,
    directWildRunning: directOnline() && state.directWildRunning,
    directWildEndsAt: directOnline() ? state.directWildEndsAt : 0,
    transport: directOnline() && state.directConnected ? 'direct' : (state.bridgeToyConnected ? 'bridge' : 'none'),
    toyConnected: (directOnline() && state.directConnected) || state.bridgeToyConnected,
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
      state.bridgeToyConnected = ping.toy_connected === true;
      state.lastError = '';
      return ping;
    } catch (error) {
      state.bridgeAlive = false;
      state.bridgeToyConnected = false;
      if (bridgeConfigured) state.lastError = String(error.message || error).slice(0, 240);
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

  function ensureExecutor() {
    if (directOnline() && state.directConnected) return 'direct';
    if (bridgeConfigured) return 'bridge';
    const error = new Error(
      state.directSupported
        ? '请先在安卓 Chrome/PWA 打开 Toy 并连接 SOSEXY'
        : '没有可用的安卓蓝牙页面或外部蓝牙桥'
    );
    error.statusCode = 503;
    throw error;
  }

  function enqueueDirect(action, payload, item, timeoutMs = DIRECT_COMMAND_TIMEOUT_MS) {
    if (ensureExecutor() !== 'direct') throw new Error('Android direct executor is unavailable');
    const command = {
      id: item.id,
      action,
      payload,
      createdAt: Date.now(),
      leaseUntil: 0,
      attempts: 0,
    };
    directQueue.push(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        directPending.delete(command.id);
        const index = directQueue.findIndex(entry => entry.id === command.id);
        if (index >= 0) directQueue.splice(index, 1);
        const error = new Error('安卓蓝牙页面没有及时执行指令，请保持 Toy 页面打开');
        error.statusCode = 504;
        reject(error);
      }, Math.max(3000, timeoutMs));
      directPending.set(command.id, { resolve, reject, timer });
    });
  }

  async function dispatchAction(action, payload, item, bridgeTimeoutMs = 30000) {
    const executor = ensureExecutor();
    if (executor === 'direct') {
      return enqueueDirect(action, payload, item);
    }
    const path = action === 'sequence' ? '/sequence'
      : action === 'flow' ? '/flow'
      : action === 'wild' ? '/wild'
      : action === 'stop' ? '/stop'
      : '/set';
    return bridgeRequest(path, 'POST', payload, bridgeTimeoutMs);
  }

  async function runSet(req, res, source, requireConsent) {
    let item;
    try {
      const payload = { channel: channel(req.body && req.body.channel), intensity: intensity(req.body && req.body.intensity) };
      item = begin('set', source, payload);
      if (requireConsent) ensureAiAllowed();
      const result = await dispatchAction('set', payload, item);
      finish(item, 'done', result);
      if (bridgeConfigured && !directOnline()) await refreshBridge();
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
      const result = await dispatchAction('sequence', { steps: clean.steps }, item, Math.max(30000, (clean.totalHold + 20) * 1000));
      finish(item, 'done', result);
      if (bridgeConfigured && !directOnline()) await refreshBridge();
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
      const result = await dispatchAction('flow', { steps: clean.steps }, item, Math.max(30000, (clean.totalSeconds + 20) * 1000));
      finish(item, 'done', result);
      if (bridgeConfigured && !directOnline()) await refreshBridge();
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
      // Both executors acknowledge quickly and run the waveform beside the device.
      const result = await dispatchAction('wild', payload, item, 15000);
      finish(item, 'done', result);
      if (bridgeConfigured && !directOnline()) refreshBridge().catch(() => {});
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      if (item) finish(item, 'error', error);
      res.status(error.statusCode || 400).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  async function runStop(req, res, source) {
    const item = begin('stop', source, { intensity: 0 });
    try {
      const result = await dispatchAction('stop', {}, item);
      finish(item, 'done', result);
      if (bridgeConfigured && !directOnline()) await refreshBridge();
      res.json({ ok: true, result, state: snapshot() });
    } catch (error) {
      finish(item, 'error', error);
      res.status(502).json({ ok: false, error: error.message, state: snapshot() });
    }
  }

  app.locals.toyState = snapshot;

  app.get('/api/toy/state', async (_req, res) => {
    if (!directOnline() && bridgeConfigured) await refreshBridge();
    res.json({ ok: true, state: snapshot() });
  });

  app.post('/api/toy/direct/state', (req, res) => {
    const body = req.body || {};
    const clientId = String(body.clientId || '').trim().slice(0, 96);
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId is required' });
    state.directClientId = clientId;
    state.directSupported = body.supported === true;
    state.directConnected = body.connected === true;
    state.directWildRunning = body.wildRunning === true;
    state.directWildEndsAt = Number.isFinite(Number(body.wildEndsAt)) ? Math.max(0, Number(body.wildEndsAt)) : 0;
    state.directLastSeenAt = Date.now();
    state.lastCheckedAt = new Date().toISOString();
    if (state.directConnected) state.lastError = '';
    res.json({ ok: true, state: snapshot() });
  });

  app.get('/api/toy/direct/commands', (req, res) => {
    const clientId = String(req.query && req.query.client_id || '').trim().slice(0, 96);
    if (!clientId || clientId !== state.directClientId) {
      return res.status(409).json({ ok: false, error: 'direct client changed; refresh Toy state' });
    }
    state.directLastSeenAt = Date.now();
    const now = Date.now();
    const command = directQueue.find(entry => entry.leaseUntil <= now);
    if (!command) return res.json({ ok: true, commands: [] });
    command.leaseUntil = now + 5000;
    command.attempts += 1;
    res.json({
      ok: true,
      commands: [{
        id: command.id,
        action: command.action,
        payload: command.payload,
        createdAt: command.createdAt,
      }],
    });
  });

  app.post('/api/toy/direct/result', (req, res) => {
    const body = req.body || {};
    const clientId = String(body.clientId || '').trim().slice(0, 96);
    const commandId = String(body.commandId || '').trim().slice(0, 96);
    if (!clientId || clientId !== state.directClientId) {
      return res.status(409).json({ ok: false, error: 'direct client changed' });
    }
    state.directLastSeenAt = Date.now();
    const pending = directPending.get(commandId);
    if (!pending) return res.json({ ok: true, ignored: true });
    clearTimeout(pending.timer);
    directPending.delete(commandId);
    const index = directQueue.findIndex(entry => entry.id === commandId);
    if (index >= 0) directQueue.splice(index, 1);
    if (body.ok === true) pending.resolve(body.result || { direct: true });
    else {
      const error = new Error(String(body.error || '安卓蓝牙执行失败').slice(0, 240));
      error.statusCode = 502;
      pending.reject(error);
    }
    res.json({ ok: true });
  });

  app.post('/api/toy/direct/event', (req, res) => {
    const body = req.body || {};
    const action = String(body.action || '').trim();
    if (!['set', 'sequence', 'flow', 'wild', 'stop', 'connect', 'disconnect'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'unknown direct event action' });
    }
    const item = begin(action, 'user', body.details && typeof body.details === 'object' ? body.details : {});
    finish(item, body.ok === false ? 'error' : 'done', body.ok === false ? body.error : { direct: true });
    state.directLastSeenAt = Date.now();
    if (action === 'connect') state.directConnected = body.ok !== false;
    if (action === 'disconnect') {
      state.directConnected = false;
      state.directWildRunning = false;
      state.directWildEndsAt = 0;
    }
    res.json({ ok: true, state: snapshot() });
  });

  app.post('/api/toy/ai-control', async (req, res) => {
    if (typeof (req.body && req.body.enabled) !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be boolean' });
    state.aiControlEnabled = req.body.enabled;
    if (!state.aiControlEnabled) {
      const item = begin('stop', 'permission', { intensity: 0, note: 'AI control disabled' });
      try { finish(item, 'done', await dispatchAction('stop', {}, item)); }
      catch (error) { finish(item, 'error', error); }
    }
    if (!directOnline() && bridgeConfigured) await refreshBridge();
    res.json({ ok: true, state: snapshot() });
  });

  app.post('/api/toy/set', (req, res) => runSet(req, res, 'user', false));
  app.post('/api/toy/sequence', (req, res) => runSequence(req, res, 'user', false));
  app.post('/api/toy/stop', (req, res) => runStop(req, res, (req.body && req.body.source) || 'user'));
  app.post('/api/toy/wild', (req, res) => runWild(req, res, 'user', false));

  // Display-only status polling: a failed poll must never stop a bridge-local run.
  app.get('/api/toy/wild-status', async (_req, res) => {
    if (directOnline() && state.directConnected) {
      const remaining = state.directWildRunning
        ? Math.max(0, Math.round((state.directWildEndsAt - Date.now()) / 1000))
        : null;
      return res.json({
        ok: true,
        running: state.directWildRunning && remaining > 0,
        remaining,
        mode: 'direct',
        toyConnected: true,
      });
    }
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
