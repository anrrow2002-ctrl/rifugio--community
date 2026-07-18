const crypto = require('crypto');

function createPushRoutes({ readJsonSetting, writeJsonSetting }) {
  const PUSH_VAPID_KEYS_KEY = 'push_vapid_keys';
  const PUSH_SUBSCRIPTIONS_KEY = 'push_subscriptions';
  const WEB_PUSH_SUBJECT = process.env.WEB_PUSH_SUBJECT || 'mailto:admin@example.com';
  let webPushModule = null;
  let webPushLoadTried = false;

  function getWebPushModule() {
    if (webPushModule || webPushLoadTried) return webPushModule;
    webPushLoadTried = true;
    try {
      webPushModule = require('web-push');
    } catch (e) {
      console.warn('[push] web-push dependency unavailable:', e.message);
    }
    return webPushModule;
  }

  function readPushSubscriptions() {
    const rows = readJsonSetting(PUSH_SUBSCRIPTIONS_KEY, []);
    return Array.isArray(rows) ? rows.filter(s => s && s.endpoint) : [];
  }

  function writePushSubscriptions(rows) {
    writeJsonSetting(PUSH_SUBSCRIPTIONS_KEY, (Array.isArray(rows) ? rows : []).filter(s => s && s.endpoint).slice(-80));
  }

  function normalizePushSubscription(input = {}) {
    const subscription = input.subscription || input;
    const endpoint = String(subscription.endpoint || '').trim();
    const keys = subscription.keys || {};
    const p256dh = String(keys.p256dh || '').trim();
    const auth = String(keys.auth || '').trim();
    if (!endpoint || !p256dh || !auth) return null;
    return {
      id: crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24),
      endpoint,
      expirationTime: subscription.expirationTime || null,
      keys: { p256dh, auth },
      userAgent: String(input.userAgent || '').slice(0, 240),
      platform: String(input.platform || '').slice(0, 80),
      updatedAt: new Date().toISOString(),
    };
  }

  function ensureVapidKeys() {
    const webPush = getWebPushModule();
    if (!webPush) return null;
    const envPublic = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
    const envPrivate = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
    if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate, source: 'env' };
    const stored = readJsonSetting(PUSH_VAPID_KEYS_KEY, null);
    if (stored?.publicKey && stored?.privateKey) return { ...stored, source: 'stored' };
    const generated = webPush.generateVAPIDKeys();
    writeJsonSetting(PUSH_VAPID_KEYS_KEY, generated);
    return { ...generated, source: 'generated' };
  }

  function configureWebPush() {
    const webPush = getWebPushModule();
    const keys = ensureVapidKeys();
    if (!webPush || !keys) return null;
    webPush.setVapidDetails(WEB_PUSH_SUBJECT, keys.publicKey, keys.privateKey);
    return webPush;
  }

  function upsertPushSubscription(input = {}) {
    const next = normalizePushSubscription(input);
    if (!next) return null;
    const rows = readPushSubscriptions().filter(s => s.endpoint !== next.endpoint);
    rows.push(next);
    writePushSubscriptions(rows);
    return next;
  }

  function removePushSubscription(endpoint) {
    const clean = String(endpoint || '').trim();
    if (!clean) return 0;
    const rows = readPushSubscriptions();
    const next = rows.filter(s => s.endpoint !== clean);
    writePushSubscriptions(next);
    return rows.length - next.length;
  }

  async function sendWebPushNotification(payload = {}) {
    const webPush = configureWebPush();
    if (!webPush) return { ok: false, unavailable: true, sent: 0, failed: 0 };
    const body = JSON.stringify({
      title: String(payload.title || 'Rifugio').slice(0, 80),
      body: String(payload.body || '有新消息').slice(0, 180),
      icon: payload.icon || '/icon.svg',
      badge: payload.badge || '/icon.svg',
      tag: payload.tag || 'rifugio-talk',
      data: payload.data || {},
    });
    const rows = readPushSubscriptions();
    const alive = [];
    let sent = 0, failed = 0;
    for (const sub of rows) {
      try {
        await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 3600, urgency: 'normal' });
        sent += 1;
        alive.push(sub);
      } catch (e) {
        failed += 1;
        const status = Number(e.statusCode || e.status || 0);
        if (status !== 404 && status !== 410) alive.push(sub);
      }
    }
    if (alive.length !== rows.length) writePushSubscriptions(alive);
    return { ok: sent > 0, sent, failed, total: rows.length };
  }

  function mountPushRoutes(app) {
    app.get('/api/push/vapid-public-key', (_req, res) => {
      const keys = ensureVapidKeys();
      res.json({
        ok: Boolean(keys?.publicKey),
        publicKey: keys?.publicKey || '',
        source: keys?.source || '',
        available: Boolean(getWebPushModule()),
      });
    });

    app.post('/api/push/subscribe', (req, res) => {
      const saved = upsertPushSubscription(req.body || {});
      if (!saved) return res.status(400).json({ ok: false, error: 'invalid push subscription' });
      res.json({ ok: true, id: saved.id, count: readPushSubscriptions().length });
    });

    app.delete('/api/push/subscribe', (req, res) => {
      const endpoint = req.body?.endpoint || req.query.endpoint || '';
      res.json({ ok: true, removed: removePushSubscription(endpoint), count: readPushSubscriptions().length });
    });

    app.post('/api/push/test', async (req, res) => {
      try {
        const result = await sendWebPushNotification({
          title: req.body?.title || 'Rifugio',
          body: req.body?.body || '系统通知测试成功。',
          tag: 'rifugio-test',
          data: { app: 'talk', test: true },
        });
        res.json({ ok: true, result });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message || String(e) });
      }
    });
  }

  return {
    sendWebPushNotification,
    mountPushRoutes,
  };
}

module.exports = { createPushRoutes };
