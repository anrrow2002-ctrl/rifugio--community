const test = require('node:test');
const assert = require('node:assert/strict');
const { mountNeteaseAuthRoutes } = require('../modules/netease-auth');

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function createHarness(api) {
  const routes = { get: new Map(), post: new Map() };
  const app = {
    get(path, handler) { routes.get.set(path, handler); },
    post(path, handler) { routes.post.set(path, handler); },
  };
  let clock = 1_800_000_000_000;
  let saved = null;
  mountNeteaseAuthRoutes(app, {
    api,
    readJsonSetting: (_key, fallback) => saved ?? fallback,
    writeJsonSetting: (_key, value) => { saved = value; },
    encrypt: value => `encrypted:${value}`,
    decrypt: value => value.replace(/^encrypted:/, ''),
    now: () => clock,
  });
  return {
    routes,
    tick(ms = 2000) { clock += ms; },
    saved: () => saved,
  };
}

const accountResult = {
  status: 200,
  body: {
    code: 200,
    data: {
      profile: {
        userId: 42,
        nickname: '测试用户',
        avatarUrl: 'https://img.example/avatar.jpg',
        signature: 'hello',
      },
    },
  },
};

test('real QR flow stores the NetEase cookie encrypted and never returns it to the browser', async () => {
  let qrChecks = 0;
  const api = {
    login_qr_key: async () => ({ status: 200, body: { code: 200, data: { data: { unikey: 'one-time-key' } } } }),
    login_qr_create: async () => ({ status: 200, body: { code: 200, data: { qrurl: 'orpheus://login', qrimg: 'data:image/png;base64,QR' } } }),
    login_qr_check: async () => {
      qrChecks += 1;
      return qrChecks === 1
        ? { status: 200, body: { code: 801 } }
        : { status: 200, body: { code: 803, cookie: 'MUSIC_U=private-cookie' } };
    },
    login_status: async () => accountResult,
  };
  const harness = createHarness(api);

  const start = responseCapture();
  await harness.routes.post.get('/api/radio/netease/qr/start')({}, start);
  assert.equal(start.body.ok, true);
  assert.equal(start.body.qrDataUrl, 'data:image/png;base64,QR');
  assert.equal(start.headers['cache-control'], 'no-store, max-age=0');
  assert.ok(!JSON.stringify(start.body).includes('one-time-key'));

  const waiting = responseCapture();
  await harness.routes.get.get('/api/radio/netease/qr/status')({}, waiting);
  assert.equal(waiting.body.status, 'waiting');

  harness.tick();
  const authorized = responseCapture();
  await harness.routes.get.get('/api/radio/netease/qr/status')({}, authorized);
  assert.equal(authorized.body.status, 'authorized');
  assert.equal(authorized.body.account.nickname, '测试用户');
  assert.ok(!JSON.stringify(authorized.body).includes('private-cookie'));
  assert.equal(harness.saved().encryptedCookie, 'encrypted:MUSIC_U=private-cookie');
});

test('account, playlists, liked count and playlist tracks are sanitized', async () => {
  const api = {
    login_qr_key: async () => ({ body: { code: 200, unikey: 'key' } }),
    login_qr_create: async () => ({ body: { code: 200, qrimg: 'data:image/png;base64,QR' } }),
    login_qr_check: async () => ({ body: { code: 803, cookie: 'MUSIC_U=private-cookie' } }),
    login_status: async () => accountResult,
    user_playlist: async () => ({
      body: {
        code: 200,
        playlist: [{
          id: 99,
          name: '我喜欢的音乐',
          coverImgUrl: 'https://img.example/list.jpg',
          trackCount: 12,
          specialType: 5,
          creator: { userId: 42, nickname: '测试用户' },
        }],
      },
    }),
    likelist: async () => ({ body: { code: 200, ids: [1, 2, 3] } }),
    playlist_track_all: async () => ({
      body: {
        code: 200,
        songs: [{
          id: 123,
          name: '一首歌',
          dt: 185000,
          ar: [{ name: '歌手' }],
          al: { name: '专辑', picUrl: 'https://img.example/song.jpg' },
        }],
      },
    }),
  };
  const harness = createHarness(api);
  await harness.routes.post.get('/api/radio/netease/qr/start')({}, responseCapture());
  await harness.routes.get.get('/api/radio/netease/qr/status')({}, responseCapture());

  const playlists = responseCapture();
  await harness.routes.get.get('/api/radio/netease/playlists')({ query: {} }, playlists);
  assert.equal(playlists.body.likedCount, 3);
  assert.equal(playlists.body.playlists[0].liked, true);
  assert.equal(playlists.body.playlists[0].owned, true);

  const tracks = responseCapture();
  await harness.routes.get.get('/api/radio/netease/playlists/:id/tracks')({
    params: { id: '99' },
    query: {},
  }, tracks);
  assert.equal(tracks.body.tracks[0].token, 'netease:123::123');
  assert.equal(tracks.body.tracks[0].durationLabel, '3:05');
  assert.equal(tracks.body.tracks[0].url, undefined);
  assert.ok(!JSON.stringify({ playlists: playlists.body, tracks: tracks.body }).includes('private-cookie'));
});

test('logout clears the encrypted server-side credential', async () => {
  const api = {
    login_qr_key: async () => ({ body: { code: 200, unikey: 'key' } }),
    login_qr_create: async () => ({ body: { code: 200, qrimg: 'data:image/png;base64,QR' } }),
    login_qr_check: async () => ({ body: { code: 803, cookie: 'MUSIC_U=private-cookie' } }),
    login_status: async () => accountResult,
    logout: async () => ({ body: { code: 200 } }),
  };
  const harness = createHarness(api);
  await harness.routes.post.get('/api/radio/netease/qr/start')({}, responseCapture());
  await harness.routes.get.get('/api/radio/netease/qr/status')({}, responseCapture());
  assert.ok(harness.saved());

  const logout = responseCapture();
  await harness.routes.post.get('/api/radio/netease/logout')({}, logout);
  assert.equal(logout.body.loggedIn, false);
  assert.equal(harness.saved(), null);
});
