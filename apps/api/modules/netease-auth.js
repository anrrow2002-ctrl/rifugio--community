const AUTH_SETTING_KEY = 'radio_netease_auth_v1';
const QR_TTL_MS = 4 * 60 * 1000;
const QR_POLL_GAP_MS = 1200;

function createNeteaseApi() {
  return require('@neteasecloudmusicapienhanced/api');
}

function bodyOf(result) {
  return result && typeof result === 'object' && result.body ? result.body : (result || {});
}

function findValue(value, key, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findValue(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function apiCode(result) {
  const body = bodyOf(result);
  return Number(body.code || findValue(body, 'code') || result?.status || 0);
}

function apiMessage(result, fallback = '网易云服务暂时不可用') {
  const body = bodyOf(result);
  return String(body.message || body.msg || findValue(body, 'message') || fallback);
}

function sanitizeAccount(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const userId = String(profile.userId || profile.user_id || '').trim();
  if (!userId) return null;
  return {
    userId,
    nickname: String(profile.nickname || '网易云用户').slice(0, 80),
    avatarUrl: String(profile.avatarUrl || ''),
    backgroundUrl: String(profile.backgroundUrl || ''),
    signature: String(profile.signature || '').slice(0, 180),
    vipType: Number(profile.vipType || 0),
  };
}

function accountFrom(result) {
  const body = bodyOf(result);
  return sanitizeAccount(
    body.profile
    || body.data?.profile
    || body.account?.profile
    || findValue(body, 'profile')
  );
}

function sanitizePlaylist(item, account) {
  if (!item || !item.id) return null;
  const creatorId = String(item.creator?.userId || '');
  return {
    id: String(item.id),
    name: String(item.name || '未命名歌单').slice(0, 120),
    coverUrl: String(item.coverImgUrl || item.picUrl || ''),
    trackCount: Math.max(0, Number(item.trackCount || 0)),
    playCount: Math.max(0, Number(item.playCount || 0)),
    subscribed: Boolean(item.subscribed),
    owned: Boolean(account?.userId && creatorId === String(account.userId)),
    liked: Number(item.specialType || 0) === 5,
    creator: String(item.creator?.nickname || '').slice(0, 80),
  };
}

function sanitizeTrack(track) {
  if (!track || !track.id) return null;
  const artists = Array.isArray(track.ar) ? track.ar : (Array.isArray(track.artists) ? track.artists : []);
  const album = track.al || track.album || {};
  const id = String(track.id);
  const durationMs = Math.max(0, Number(track.dt || track.duration || 0));
  return {
    id: `netease-${id}`,
    mediaId: id,
    title: String(track.name || '未命名歌曲').slice(0, 180),
    artist: artists.map(item => item?.name).filter(Boolean).join(' / ').slice(0, 120),
    album: String(album.name || '').slice(0, 120),
    type: 'song',
    provider: 'netease',
    source: '网易云歌单',
    coverUrl: String(album.picUrl || ''),
    durationLabel: durationMs ? `${Math.floor(durationMs / 60000)}:${String(Math.floor(durationMs / 1000) % 60).padStart(2, '0')}` : '',
    description: String(album.name || ''),
    token: `netease:${id}::${id}`,
  };
}

function mountNeteaseAuthRoutes(app, {
  api = createNeteaseApi(),
  readJsonSetting,
  writeJsonSetting,
  encrypt,
  decrypt,
  now = () => Date.now(),
} = {}) {
  if (!readJsonSetting || !writeJsonSetting || !encrypt || !decrypt) {
    throw new Error('网易云登录缺少安全存储依赖');
  }

  let qrSession = null;

  const noStore = res => {
    res.set('Cache-Control', 'no-store, max-age=0');
    return res;
  };

  const loadCookie = () => {
    const saved = readJsonSetting(AUTH_SETTING_KEY, null);
    if (!saved?.encryptedCookie) return '';
    try {
      return decrypt(String(saved.encryptedCookie));
    } catch (_) {
      writeJsonSetting(AUTH_SETTING_KEY, null);
      return '';
    }
  };

  const saveCookie = cookie => {
    writeJsonSetting(AUTH_SETTING_KEY, cookie ? {
      encryptedCookie: encrypt(String(cookie)),
      updatedAt: new Date(now()).toISOString(),
    } : null);
  };

  const loadAccount = async cookie => {
    if (!cookie) return null;
    const result = await api.login_status({ cookie, timestamp: now() });
    if (apiCode(result) !== 200) return null;
    return accountFrom(result);
  };

  app.post('/api/radio/netease/qr/start', async (_req, res) => {
    noStore(res);
    try {
      const keyResult = await api.login_qr_key({ timestamp: now() });
      const key = String(findValue(bodyOf(keyResult), 'unikey') || '').trim();
      if (!key || apiCode(keyResult) !== 200) {
        return res.status(502).json({ ok: false, error: apiMessage(keyResult, '生成网易云登录凭证失败') });
      }
      const qrResult = await api.login_qr_create({ key, qrimg: true, timestamp: now() });
      const body = bodyOf(qrResult);
      const qrUrl = String(findValue(body, 'qrurl') || '');
      const qrDataUrl = String(findValue(body, 'qrimg') || '');
      if (!qrDataUrl && !qrUrl) {
        return res.status(502).json({ ok: false, error: apiMessage(qrResult, '生成网易云二维码失败') });
      }
      qrSession = {
        key,
        createdAt: now(),
        expiresAt: now() + QR_TTL_MS,
        lastPollAt: 0,
        lastResponse: null,
      };
      return res.json({
        ok: true,
        status: 'waiting',
        qrDataUrl,
        qrUrl,
        expiresAt: qrSession.expiresAt,
      });
    } catch (error) {
      console.warn('[radio/netease] 创建二维码失败:', error?.message || error);
      return res.status(502).json({ ok: false, error: '网易云二维码暂时生成失败，请稍后重试' });
    }
  });

  app.get('/api/radio/netease/qr/status', async (_req, res) => {
    noStore(res);
    if (!qrSession) return res.json({ ok: true, status: 'idle' });
    if (now() >= qrSession.expiresAt) {
      qrSession = null;
      return res.json({ ok: true, status: 'expired', message: '二维码已过期，请重新生成' });
    }
    if (qrSession.lastResponse && now() - qrSession.lastPollAt < QR_POLL_GAP_MS) {
      return res.json(qrSession.lastResponse);
    }
    try {
      qrSession.lastPollAt = now();
      const result = await api.login_qr_check({ key: qrSession.key, timestamp: now() });
      const body = bodyOf(result);
      const code = apiCode(result);
      if (code === 800) {
        qrSession = null;
        return res.json({ ok: true, status: 'expired', message: '二维码已过期，请重新生成' });
      }
      if (code === 801 || code === 802) {
        const response = {
          ok: true,
          status: code === 802 ? 'scanned' : 'waiting',
          message: code === 802 ? '已扫码，请在网易云音乐 App 内确认' : '等待网易云音乐 App 扫码',
        };
        qrSession.lastResponse = response;
        return res.json(response);
      }
      if (code === 803) {
        const cookie = String(body.cookie || findValue(body, 'cookie') || '').trim();
        if (!cookie) return res.status(502).json({ ok: false, status: 'failed', error: '网易云已确认，但没有返回登录凭证' });
        saveCookie(cookie);
        const account = await loadAccount(cookie);
        qrSession = null;
        return res.json({ ok: true, status: 'authorized', account });
      }
      return res.status(502).json({ ok: false, status: 'failed', error: apiMessage(result, '网易云返回了未知登录状态') });
    } catch (error) {
      console.warn('[radio/netease] 查询扫码状态失败:', error?.message || error);
      return res.status(502).json({ ok: false, status: 'failed', error: '暂时无法查询扫码状态，请稍后重试' });
    }
  });

  app.get('/api/radio/netease/account', async (_req, res) => {
    noStore(res);
    try {
      const cookie = loadCookie();
      if (!cookie) return res.json({ ok: true, loggedIn: false, account: null });
      const account = await loadAccount(cookie);
      if (!account) {
        saveCookie('');
        return res.json({ ok: true, loggedIn: false, account: null });
      }
      return res.json({ ok: true, loggedIn: true, account });
    } catch (error) {
      console.warn('[radio/netease] 读取账号失败:', error?.message || error);
      return res.status(502).json({ ok: false, error: '暂时无法读取网易云账号' });
    }
  });

  app.get('/api/radio/netease/playlists', async (req, res) => {
    noStore(res);
    try {
      const cookie = loadCookie();
      const account = await loadAccount(cookie);
      if (!account) return res.status(401).json({ ok: false, error: '请先扫码登录网易云' });
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const [playlistResult, likesResult] = await Promise.all([
        api.user_playlist({ uid: account.userId, limit, offset, cookie, timestamp: now() }),
        api.likelist({ uid: account.userId, cookie, timestamp: now() }).catch(() => null),
      ]);
      if (apiCode(playlistResult) !== 200) {
        return res.status(502).json({ ok: false, error: apiMessage(playlistResult, '读取网易云歌单失败') });
      }
      const body = bodyOf(playlistResult);
      const list = Array.isArray(body.playlist) ? body.playlist : (findValue(body, 'playlist') || []);
      const likeBody = bodyOf(likesResult);
      const ids = Array.isArray(likeBody.ids) ? likeBody.ids : (findValue(likeBody, 'ids') || []);
      return res.json({
        ok: true,
        account,
        likedCount: Array.isArray(ids) ? ids.length : 0,
        playlists: (Array.isArray(list) ? list : []).map(item => sanitizePlaylist(item, account)).filter(Boolean),
      });
    } catch (error) {
      console.warn('[radio/netease] 读取歌单失败:', error?.message || error);
      return res.status(502).json({ ok: false, error: '暂时无法读取网易云歌单' });
    }
  });

  app.get('/api/radio/netease/playlists/:id/tracks', async (req, res) => {
    noStore(res);
    const id = String(req.params.id || '').trim();
    if (!/^\d{1,24}$/.test(id)) return res.status(400).json({ ok: false, error: '歌单 ID 不正确' });
    try {
      const cookie = loadCookie();
      const account = await loadAccount(cookie);
      if (!account) return res.status(401).json({ ok: false, error: '请先扫码登录网易云' });
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const result = await api.playlist_track_all({ id, limit, offset, cookie, timestamp: now() });
      if (apiCode(result) !== 200) return res.status(502).json({ ok: false, error: apiMessage(result, '读取歌单歌曲失败') });
      const body = bodyOf(result);
      const songs = Array.isArray(body.songs) ? body.songs : (findValue(body, 'songs') || []);
      return res.json({
        ok: true,
        tracks: (Array.isArray(songs) ? songs : []).map(sanitizeTrack).filter(Boolean),
      });
    } catch (error) {
      console.warn('[radio/netease] 读取歌单歌曲失败:', error?.message || error);
      return res.status(502).json({ ok: false, error: '暂时无法读取歌单歌曲' });
    }
  });

  app.post('/api/radio/netease/logout', async (_req, res) => {
    noStore(res);
    const cookie = loadCookie();
    qrSession = null;
    saveCookie('');
    if (cookie && typeof api.logout === 'function') {
      try { await api.logout({ cookie, timestamp: now() }); } catch (_) {}
    }
    return res.json({ ok: true, loggedIn: false });
  });
}

module.exports = {
  AUTH_SETTING_KEY,
  mountNeteaseAuthRoutes,
  sanitizeAccount,
  sanitizePlaylist,
  sanitizeTrack,
};
