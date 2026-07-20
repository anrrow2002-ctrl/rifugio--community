const crypto = require('crypto');
const Database = require('./sqlite');

function createAuthPasskey({ IS_PROD = process.env.NODE_ENV === 'production', clientIp }) {
  // ============================================================
  // AUTH GATE — 保护整个 /api（Phase 2）。同源 httponly 签名 cookie。
  // 关键点：前端锁屏校验 PIN 后 POST /api/auth/login 拿 cookie；
  // 之后所有同源 fetch 自动带上 cookie，无需改每个请求。
  // ============================================================
  const AUTH_SECRET = process.env.AUTH_SECRET || (IS_PROD ? '' : 'dev-only-auth-secret');
  if (!process.env.AUTH_SECRET) {
    const msg = '[server] AUTH_SECRET 未配置，登录 cookie 无法被可靠校验。';
    if (IS_PROD) throw new Error(msg);
    console.warn(msg + ' 当前按开发模式继续运行。');
  }
  const AUTH_PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH || '';
  if (!AUTH_PASSWORD_HASH && IS_PROD) {
    throw new Error('[server] AUTH_PASSWORD_HASH 未配置。请先运行 scripts/set-auth-password.sh 设置强密码。');
  }
  const AUTH_COOKIE = 'refuge_auth';
  const TERMINAL_AUTH_COOKIE = 'refuge_terminal_auth';
  const AUTH_TTL_MS = Math.max(1, Number(process.env.AUTH_TTL_HOURS || 168)) * 3600 * 1000;
  const TERMINAL_AUTH_TTL_MS = Math.max(1, Number(process.env.TERMINAL_AUTH_TTL_MINUTES || 20)) * 60 * 1000;
  const LOGIN_WINDOW_MS = Math.max(60, Number(process.env.AUTH_LOGIN_WINDOW_SEC || 900)) * 1000;
  const LOGIN_LOCK_MS = Math.max(60, Number(process.env.AUTH_LOGIN_LOCK_SEC || 900)) * 1000;
  const LOGIN_MAX_FAILS = Math.max(1, Number(process.env.AUTH_LOGIN_MAX_FAILS || 5));
  const loginAttempts = new Map();
  let simpleWebAuthnServerPromise;

  // --- Passkey step-up for the web terminal ---
  const PASSKEY_USER_ID = process.env.PASSKEY_USER_ID || 'owner';
  const PASSKEY_USER_NAME = process.env.PASSKEY_USER_NAME || require('./community-config').USER_NAME;
  const PASSKEY_RP_NAME = process.env.PASSKEY_RP_NAME || require('./community-config').HOME_NAME;
  const PASSKEY_RP_ID = process.env.PASSKEY_RP_ID || process.env.RIFUGIO_DOMAIN || 'localhost';
  const PASSKEY_ORIGINS = (process.env.PASSKEY_ORIGINS || process.env.RIFUGIO_PUBLIC_URL || 'http://localhost:3457')
    .split(',').map(s => s.trim()).filter(Boolean);
  const PASSKEY_CHALLENGE_TTL_MS = Math.max(60, Number(process.env.PASSKEY_CHALLENGE_TTL_SEC || 300)) * 1000;

  function cookieDomainAttr(req) {
    const configured = process.env.AUTH_COOKIE_DOMAIN;
    if (configured === 'host-only') return '';
    if (configured) return `; Domain=${configured}`;
    return '';
  }

  function setCookieHeader(req, name, value, maxAgeSec) {
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax${cookieDomainAttr(req)}`;
  }

  const TERMINAL_COOKIE_PATHS = ['/terminal', '/ttyd', '/ws/terminal', '/api/terminal', '/api/terminal-chat', '/api/terminal-auth', '/api/terminal-passkey', '/api/mcp', '/claude-terminal'];
  function setTerminalCookieHeaders(req, value, maxAgeSec) {
    const domain = cookieDomainAttr(req);
    return TERMINAL_COOKIE_PATHS.map(path =>
      `${TERMINAL_AUTH_COOKIE}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict${domain}`
    );
  }

  function clearCookieHeaders(req, name) {
    const base = `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    const domain = cookieDomainAttr(req);
    return domain ? [base, `${base}${domain}`] : [base];
  }

  function clearTerminalCookieHeaders(req) {
    const domain = cookieDomainAttr(req);
    return [
      `${TERMINAL_AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      ...(domain ? [`${TERMINAL_AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict${domain}`] : []),
      ...TERMINAL_COOKIE_PATHS.flatMap(path => {
        const base = `${TERMINAL_AUTH_COOKIE}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
        return domain ? [base, `${base}${domain}`] : [base];
      }),
    ];
  }

  function verifyScryptPassword(password, encoded) {
    const parts = String(encoded || '').split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]), keylen = Number(parts[4]);
    const salt = Buffer.from(parts[5], 'base64');
    const expected = Buffer.from(parts[6], 'base64');
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keylen)) return false;
    const actual = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async function verifyPassword(password) {
    const hash = AUTH_PASSWORD_HASH;
    if (!hash && !IS_PROD) return password === process.env.DEV_AUTH_PASSWORD;
    if (hash.startsWith('scrypt$')) return verifyScryptPassword(password, hash);
    if (/^\$2[aby]\$/.test(hash)) {
      let bcrypt;
      try { bcrypt = require('bcrypt'); } catch (_) {
        try { bcrypt = require('bcryptjs'); } catch (_) {}
      }
      if (!bcrypt) throw new Error('bcrypt hash configured but bcrypt/bcryptjs is not installed');
      return Boolean(await bcrypt.compare(String(password), hash));
    }
    throw new Error('Unsupported AUTH_PASSWORD_HASH format');
  }

  function loginBucket(ip) {
    const now = Date.now();
    const b = loginAttempts.get(ip);
    if (!b || now - b.firstAt > LOGIN_WINDOW_MS) {
      const fresh = { firstAt: now, fails: 0, blockedUntil: 0 };
      loginAttempts.set(ip, fresh);
      return fresh;
    }
    return b;
  }

  function isLoginBlocked(ip) {
    return (loginAttempts.get(ip)?.blockedUntil || 0) > Date.now();
  }

  function recordLoginFailure(req, reason) {
    const ip = clientIp(req);
    const b = loginBucket(ip);
    b.fails += 1;
    if (b.fails >= LOGIN_MAX_FAILS) b.blockedUntil = Date.now() + LOGIN_LOCK_MS;
    console.warn(`SECURITY_AUTH_FAIL ip=${ip} path=/api/auth/login reason=${reason} fails=${b.fails} blocked=${b.blockedUntil > Date.now()}`);
  }

  function recordLoginSuccess(req) {
    loginAttempts.delete(clientIp(req));
  }

  function signAuth(exp) {
    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(String(exp)).digest('hex');
    return `${exp}.${sig}`;
  }
  function verifyAuth(token) {
    if (!token || !AUTH_SECRET) return false;
    const [expStr, sig] = token.split('.');
    if (!expStr || !sig) return false;
    const expect = crypto.createHmac('sha256', AUTH_SECRET).update(expStr).digest('hex');
    if (sig.length !== expect.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    return Date.now() < Number(expStr);
  }
  function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('='); if (i < 0) return;
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }
  // 同名 cookie 可能有多个（不同 Domain/Path 身份并存，如密钥轮换前的僵尸 cookie
  // 和新登录的活 cookie 同时被浏览器送上来）。parseCookies 后者覆盖前者会恰好读到
  // 僵尸→有效会话被 401（2026-07-02 实锤）。所以逐个收集、任一验签通过即放行。
  function cookieValues(req, name) {
    const out = [];
    (req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('='); if (i < 0) return;
      if (p.slice(0, i).trim() !== name) return;
      try { out.push(decodeURIComponent(p.slice(i + 1).trim())); } catch (_) {}
    });
    return out;
  }
  function hasAuthCookie(req) {
    return cookieValues(req, AUTH_COOKIE).some(verifyAuth);
  }
  function isAuthed(req) {
    if (hasAuthCookie(req)) return true;                                   // 浏览器 cookie
    const t = req.headers['x-chat-token'];                                 // 后台脚本/内部用
    if (t && process.env.CHAT_TOKEN && t === process.env.CHAT_TOKEN) return true;
    return false;
  }
  function signTerminalAuth(exp) {
    const userId = PASSKEY_USER_ID || 'owner';
    const body = `${userId}.${exp}`;
    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(`terminal:${body}`).digest('hex');
    return `${body}.${sig}`;
  }
  function verifyTerminalAuth(token) {
    if (!token || !AUTH_SECRET) return false;
    const [userId, expStr, sig] = token.split('.');
    if (!userId || !expStr || !sig || userId !== (PASSKEY_USER_ID || 'owner')) return false;
    const body = `${userId}.${expStr}`;
    const expect = crypto.createHmac('sha256', AUTH_SECRET).update(`terminal:${body}`).digest('hex');
    if (sig.length !== expect.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    return Date.now() < Number(expStr);
  }
  function hasTerminalAuth(req) {
    return cookieValues(req, AUTH_COOKIE).some(verifyAuth)
      && cookieValues(req, TERMINAL_AUTH_COOKIE).some(verifyTerminalAuth);
  }

  // talk-proactive.js 只允许直连 127.0.0.1 的内部回环调用。Nginx 代理到 Node 时
  // socket 同样是 loopback，因此必须同时拒绝带代理转发头的请求，再校验内部 token。
  const RIFUGIO_INTERNAL_TOKEN = process.env.RIFUGIO_INTERNAL_TOKEN || '';
  function isLoopbackSocket(req) {
    if (req.headers['x-real-ip'] || req.headers['x-forwarded-for']) return false;
    const addr = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    return addr === '127.0.0.1' || addr === '::1';
  }
  function isInternalProactiveRequest(req) {
    if (!RIFUGIO_INTERNAL_TOKEN || !isLoopbackSocket(req)) return false;
    const header = String(req.headers['x-rifugio-internal'] || '');
    if (header.length !== RIFUGIO_INTERNAL_TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(RIFUGIO_INTERNAL_TOKEN));
  }
  async function loadWebAuthnServer() {
    if (!simpleWebAuthnServerPromise) simpleWebAuthnServerPromise = import('@simplewebauthn/server');
    return simpleWebAuthnServerPromise;
  }

  function mountAuthRoutes(app) {
    // 登录：服务端校验强密码 → 下发签名 cookie
    app.post('/api/auth/login', async (req, res) => {
      if (isLoginBlocked(clientIp(req))) {
        recordLoginFailure(req, 'rate_limited');
        return res.status(429).json({ ok: false, error: 'too many attempts' });
      }
      const { password } = req.body || {};
      if (!password) return res.status(400).json({ ok: false, error: 'password required' });
      if (String(password).length < 8 || String(password).length > 128) {
        recordLoginFailure(req, 'bad_length');
        return res.status(401).json({ ok: false, error: '密码不对' });
      }
      let ok = false;
      try { ok = await verifyPassword(password); } catch (e) {
        console.error('[auth] verify failed:', e.message);
        return res.status(500).json({ ok: false, error: 'auth unavailable' });
      }
      if (!ok) {
        recordLoginFailure(req, 'bad_password');
        return res.status(401).json({ ok: false, error: '密码不对' });
      }
      recordLoginSuccess(req);
      const token = signAuth(Date.now() + AUTH_TTL_MS);
      res.setHeader('Set-Cookie', setCookieHeader(req, AUTH_COOKIE, token, Math.floor(AUTH_TTL_MS / 1000)));
      res.json({ ok: true });
    });
    app.post('/api/auth/logout', (req, res) => {
      res.setHeader('Set-Cookie', [
        ...clearCookieHeaders(req, AUTH_COOKIE),
        ...clearTerminalCookieHeaders(req),
      ]);
      res.json({ ok: true });
    });
    // 探测当前是否已登录（前端 mount 时调）
    app.get('/api/auth/check', (req, res) => {
      const ok = isAuthed(req);
      res.status(ok ? 200 : 401).json({ ok });
    });

    // 门：除 login/check 外，所有 /api 都要鉴权
    app.use((req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      const p = req.path;
      if (!/^\/(api|memory-api)\b/.test(p)) return next();
      if (p === '/api/auth/login' || p === '/api/auth/check' || p === '/api/auth/logout' || p === '/api/community/health') return next();
      if (p === '/api/health/ingest') return next();   // iPhone 快捷指令上传：路由内用 x-health-token 自校验，不走登录 cookie
      if (p.startsWith('/api/pet/') && req.headers['x-pet-internal'] === process.env.PET_INTERNAL_KEY) return next();
      if (p === '/api/terminal-chat/send' && isInternalProactiveRequest(req)) return next();
      if (isAuthed(req)) {
        // handoff 从聊天区触发（存对话交接摘要文件），只需登录、不要求终端 passkey；其余 /api/terminal/* 仍需 passkey
        const terminalStatusRead = req.method === 'GET' && p === '/api/terminal-chat/status';
        if (((p.startsWith('/api/terminal/') && p !== '/api/terminal/handoff') || (p.startsWith('/api/terminal-chat/') && !terminalStatusRead)) && !hasTerminalAuth(req)) {
          return res.status(401).json({ ok: false, error: 'terminal verification required' });
        }
        return next();
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    });
  }

  function requireBrowserCookie(req, res) {
    if (hasAuthCookie(req)) return true;
    res.status(401).json({ ok: false, error: 'browser login required' });
    return false;
  }

  function parseJsonArray(value) {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function terminalPasskeyRows(db, { activeOnly = false } = {}) {
    const where = activeOnly
      ? 'WHERE user_id=? AND terminal_enabled=1 AND revoked=0'
      : 'WHERE user_id=?';
    return db.prepare(`
      SELECT credential_id, user_id, public_key, sign_count, device_name, terminal_enabled, revoked, transports, created_at, last_used_at
      FROM terminal_passkeys
      ${where}
      ORDER BY created_at DESC
    `).all(PASSKEY_USER_ID);
  }

  function publicTerminalPasskeyInfo(row) {
    return {
      credential_id: row.credential_id,
      device_name: row.device_name || '',
      terminal_enabled: Boolean(row.terminal_enabled),
      revoked: Boolean(row.revoked),
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    };
  }

  function terminalRegisterWindowOpen(db) {
    const now = Date.now();
    const row = db.prepare('SELECT expires_at FROM terminal_passkey_register_windows WHERE user_id=?').get(PASSKEY_USER_ID);
    if (!row) return false;
    if (Number(row.expires_at) > now) return true;
    try { db.prepare('DELETE FROM terminal_passkey_register_windows WHERE user_id=?').run(PASSKEY_USER_ID); } catch (_) {}
    return false;
  }

  function canRegisterTerminalPasskey(req, db) {
    const totalRows = db.prepare('SELECT COUNT(*) AS n FROM terminal_passkeys WHERE user_id=?').get(PASSKEY_USER_ID).n;
    if (Number(totalRows) === 0) return { ok: true, reason: 'first_init' };
    if (hasTerminalAuth(req)) return { ok: true, reason: 'existing_terminal_passkey' };
    if (terminalRegisterWindowOpen(db)) return { ok: true, reason: 'admin_open_register' };
    return { ok: false, reason: 'terminal_passkey_required' };
  }

  function cleanDeviceName(value) {
    const name = String(value || '').replace(/[^\p{L}\p{N}\s._:-]/gu, '').trim();
    return (name || 'terminal passkey').slice(0, 80);
  }

  function credentialIdToString(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64url');
    return String(value);
  }

  function base64UrlToBuffer(value) {
    return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  function authenticatorDataUserVerified(response) {
    try {
      const data = base64UrlToBuffer(response?.response?.authenticatorData);
      return data.length > 32 && Boolean(data[32] & 0x04);
    } catch (_) {
      return false;
    }
  }

  function savePasskeyChallenge(db, purpose, challenge, metadata = {}) {
    const now = Date.now();
    db.prepare('DELETE FROM passkey_challenges WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM passkey_challenges WHERE user_id=? AND purpose=?').run(PASSKEY_USER_ID, purpose);
    db.prepare(`
      INSERT INTO passkey_challenges (user_id, purpose, challenge, metadata, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(PASSKEY_USER_ID, purpose, challenge, JSON.stringify(metadata || {}), now + PASSKEY_CHALLENGE_TTL_MS, now);
  }

  function consumePasskeyChallenge(db, purpose) {
    const now = Date.now();
    const row = db.prepare(`
      SELECT * FROM passkey_challenges
      WHERE user_id=? AND purpose=? AND expires_at>=?
      ORDER BY id DESC LIMIT 1
    `).get(PASSKEY_USER_ID, purpose, now);
    db.prepare('DELETE FROM passkey_challenges WHERE user_id=? AND purpose=?').run(PASSKEY_USER_ID, purpose);
    if (!row) throw new Error('challenge expired');
    try { row.metadata = JSON.parse(row.metadata || '{}'); } catch (_) { row.metadata = {}; }
    return row;
  }

  async function webAuthnOrFail(res) {
    try {
      return await loadWebAuthnServer();
    } catch (e) {
      console.error('[passkey] @simplewebauthn/server unavailable:', e.message);
      res.status(503).json({ ok: false, error: 'passkey dependency unavailable' });
      return null;
    }
  }

  function mountPasskeyRoutes(app, { DB_PATH }) {
    app.get('/api/passkey/status', (req, res) => {
      res.status(410).json({ ok: false, error: 'use /api/terminal-passkey/status' });
    });

    app.use('/api/passkey', (req, res) => {
      res.status(410).json({ ok: false, error: 'use /api/terminal-passkey' });
    });

    app.get('/api/terminal-passkey/status', (req, res) => {
      if (!requireBrowserCookie(req, res)) return;
      const db = new Database(DB_PATH);
      try {
        const rows = terminalPasskeyRows(db);
        const activeRows = rows.filter(r => r.terminal_enabled && !r.revoked);
        res.json({
          ok: true,
          registered: activeRows.length > 0,
          count: activeRows.length,
          terminal_unlocked: hasTerminalAuth(req),
          registration_open: terminalRegisterWindowOpen(db),
          ttl_minutes: Math.floor(TERMINAL_AUTH_TTL_MS / 60000),
          rp_id: PASSKEY_RP_ID,
          origins: PASSKEY_ORIGINS,
          credentials: rows.map(publicTerminalPasskeyInfo),
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      } finally {
        db.close();
      }
    });

    app.post('/api/terminal-passkey/register/options', async (req, res) => {
      if (!requireBrowserCookie(req, res)) return;
      const webauthn = await webAuthnOrFail(res);
      if (!webauthn) return;
      const db = new Database(DB_PATH);
      try {
        const allowed = canRegisterTerminalPasskey(req, db);
        if (!allowed.ok) return res.status(403).json({ ok: false, error: 'terminal passkey required to register a new device' });
        const passkeys = terminalPasskeyRows(db);
        const options = await webauthn.generateRegistrationOptions({
          rpName: PASSKEY_RP_NAME,
          rpID: PASSKEY_RP_ID,
          userName: PASSKEY_USER_NAME,
          userDisplayName: PASSKEY_USER_NAME,
          attestationType: 'none',
          excludeCredentials: passkeys.map(p => ({ id: p.credential_id, transports: parseJsonArray(p.transports) })),
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required',
            authenticatorAttachment: 'platform',
          },
          preferredAuthenticatorType: 'localDevice',
          supportedAlgorithmIDs: [-7, -257],
        });
        savePasskeyChallenge(db, 'terminal_registration', options.challenge, {
          webauthnUserID: options.user?.id || '',
          reason: allowed.reason,
        });
        res.json({ ok: true, options });
      } catch (e) {
        console.error('[passkey] registration options failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
      } finally {
        db.close();
      }
    });

    app.post('/api/terminal-passkey/register/verify', async (req, res) => {
      if (!requireBrowserCookie(req, res)) return;
      const webauthn = await webAuthnOrFail(res);
      if (!webauthn) return;
      const db = new Database(DB_PATH);
      try {
        const allowed = canRegisterTerminalPasskey(req, db);
        if (!allowed.ok) return res.status(403).json({ ok: false, error: 'terminal passkey required to register a new device' });
        const current = consumePasskeyChallenge(db, 'terminal_registration');
        const verification = await webauthn.verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: current.challenge,
          expectedOrigin: PASSKEY_ORIGINS,
          expectedRPID: PASSKEY_RP_ID,
          requireUserVerification: true,
        });
        if (!verification.verified || !verification.registrationInfo?.credential) {
          return res.status(400).json({ ok: false, error: 'passkey not verified' });
        }
        const info = verification.registrationInfo;
        const credential = info.credential;
        const credentialId = credentialIdToString(credential.id);
        if (!credentialId) return res.status(400).json({ ok: false, error: 'missing credential id' });
        db.prepare(`
          INSERT OR REPLACE INTO terminal_passkeys
            (credential_id, user_id, public_key, sign_count, device_name, terminal_enabled, revoked, transports, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, 1, 0, ?, datetime('now'), NULL)
        `).run(
          credentialId,
          PASSKEY_USER_ID,
          Buffer.from(credential.publicKey),
          Number(credential.counter || 0),
          cleanDeviceName(req.body?.device_name || req.headers['user-agent'] || ''),
          JSON.stringify(credential.transports || []),
        );
        res.json({ ok: true, registered: true, credential_id: credentialId });
      } catch (e) {
        console.warn('[passkey] registration verify failed:', e.message);
        res.status(400).json({ ok: false, error: e.message });
      } finally {
        db.close();
      }
    });

    app.post('/api/terminal-passkey/authenticate/options', async (req, res) => {
      if (!requireBrowserCookie(req, res)) return;
      const webauthn = await webAuthnOrFail(res);
      if (!webauthn) return;
      const db = new Database(DB_PATH);
      try {
        const passkeys = terminalPasskeyRows(db, { activeOnly: true });
        const totalRows = db.prepare('SELECT COUNT(*) AS n FROM terminal_passkeys WHERE user_id=?').get(PASSKEY_USER_ID).n;
        if (passkeys.length === 0 && Number(totalRows) === 0) {
          return res.status(409).json({ ok: false, error: 'no terminal passkey registered', needs_registration: true });
        }
        if (passkeys.length === 0) {
          return res.status(403).json({ ok: false, error: 'no active terminal passkey; use terminal-passkey open-register from SSH' });
        }
        const options = await webauthn.generateAuthenticationOptions({
          rpID: PASSKEY_RP_ID,
          allowCredentials: passkeys.map(p => ({ id: p.credential_id, transports: parseJsonArray(p.transports) })),
          userVerification: 'required',
        });
        savePasskeyChallenge(db, 'terminal_authentication', options.challenge);
        res.json({ ok: true, options });
      } catch (e) {
        console.error('[passkey] authentication options failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
      } finally {
        db.close();
      }
    });

    app.post('/api/terminal-passkey/authenticate/verify', async (req, res) => {
      if (!requireBrowserCookie(req, res)) return;
      const webauthn = await webAuthnOrFail(res);
      if (!webauthn) return;
      const db = new Database(DB_PATH);
      try {
        const current = consumePasskeyChallenge(db, 'terminal_authentication');
        const credentialId = credentialIdToString(req.body?.id);
        const passkey = db.prepare(`
          SELECT * FROM terminal_passkeys
          WHERE user_id=? AND credential_id=? AND terminal_enabled=1 AND revoked=0
        `).get(PASSKEY_USER_ID, credentialId);
        if (!passkey) return res.status(403).json({ ok: false, error: 'terminal passkey is not enabled for this user' });
        const verification = await webauthn.verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: current.challenge,
          expectedOrigin: PASSKEY_ORIGINS,
          expectedRPID: PASSKEY_RP_ID,
          credential: {
            id: passkey.credential_id,
            publicKey: Buffer.from(passkey.public_key),
            counter: Number(passkey.sign_count || 0),
            transports: parseJsonArray(passkey.transports),
          },
          requireUserVerification: true,
        });
        if (!verification.verified) return res.status(400).json({ ok: false, error: 'passkey not verified' });
        const info = verification.authenticationInfo || {};
        const returnedCredentialId = credentialIdToString(info.credentialID || info.credentialIDBytes || credentialId);
        if (returnedCredentialId && returnedCredentialId !== passkey.credential_id) {
          return res.status(400).json({ ok: false, error: 'credential id mismatch' });
        }
        const userVerified = info.userVerified === true || authenticatorDataUserVerified(req.body);
        if (!userVerified) return res.status(403).json({ ok: false, error: 'user verification required' });
        const newCounter = Number(info.newCounter || passkey.sign_count || 0);
        db.prepare("UPDATE terminal_passkeys SET sign_count=?, last_used_at=datetime('now') WHERE credential_id=?").run(newCounter, passkey.credential_id);
        const token = signTerminalAuth(Date.now() + TERMINAL_AUTH_TTL_MS);
        res.setHeader('Set-Cookie', setTerminalCookieHeaders(req, token, Math.floor(TERMINAL_AUTH_TTL_MS / 1000)));
        res.json({ ok: true, terminal_unlocked: true, ttl_minutes: Math.floor(TERMINAL_AUTH_TTL_MS / 60000) });
      } catch (e) {
        console.warn('[passkey] authentication verify failed:', e.message);
        res.status(400).json({ ok: false, error: e.message });
      } finally {
        db.close();
      }
    });

    app.get('/api/terminal-auth/check', (req, res) => {
      const ok = hasTerminalAuth(req);
      res.status(ok ? 200 : 401).json({ ok });
    });

    app.post('/api/terminal-auth/logout', (req, res) => {
      res.setHeader('Set-Cookie', clearTerminalCookieHeaders(req));
      res.json({ ok: true });
    });
  }

  return {
    mountAuthRoutes,
    mountPasskeyRoutes,
    hasAuthCookie,
    isAuthed,
    hasTerminalAuth,
  };
}

module.exports = { createAuthPasskey };
