const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SOSEXY_BRIDGE_URL = 'https://bridge.example.test';
process.env.SOSEXY_BRIDGE_TOKEN = 'test-bridge-token-1234';
const { mountToyRoutes } = require('../toy');

function mountedRoutes() {
  const routes = { get:new Map(), post:new Map() };
  const app = {
    locals:{},
    get(path, handler) { routes.get.set(path, handler); },
    post(path, handler) { routes.post.set(path, handler); },
  };
  mountToyRoutes(app);
  return routes;
}

function responseCapture() {
  return {
    statusCode:200,
    body:null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

const jsonResponse = value => new Response(JSON.stringify(value), {
  status:200,
  headers:{ 'content-type':'application/json' },
});

test('community API exposes fire-and-forget wild start and status routes', async () => {
  const routes = mountedRoutes();
  assert.ok(routes.post.has('/api/toy/wild'));
  assert.ok(routes.get.has('/api/toy/wild-status'));

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url:String(url), options });
    if (String(url).endsWith('/wild')) return jsonResponse({ started:true });
    return jsonResponse({ ok:true, bridge:'alive', toy_connected:true, running:true, remaining:1799, mode:'wild' });
  };
  try {
    const start = responseCapture();
    await routes.post.get('/api/toy/wild')({ body:{ duration:1800 } }, start);
    assert.equal(start.statusCode, 200);
    assert.equal(start.body.ok, true);
    const startCall = calls.find(call => call.url.endsWith('/wild'));
    assert.equal(JSON.parse(startCall.options.body).duration, 1800);

    const status = responseCapture();
    await routes.get.get('/api/toy/wild-status')({}, status);
    assert.deepEqual(status.body, { ok:true, running:true, remaining:1799, mode:'wild', toyConnected:true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('community API rejects wild durations above 30 minutes before contacting the bridge', async () => {
  const routes = mountedRoutes();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return jsonResponse({ ok:true }); };
  try {
    const response = responseCapture();
    await routes.post.get('/api/toy/wild')({ body:{ duration:1801 } }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /1 to 1800/);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});
