const express = require('express');
const cors = require('cors');

const DEFAULT_CORS_ORIGINS = [process.env.RIFUGIO_PUBLIC_URL || 'http://localhost:3457'];

function clientIp(req) {
  // Nginx overwrites X-Real-IP after validating the trusted proxy; do not trust a client-supplied CF header here.
  const raw = req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || '';
  return String(raw).trim().replace(/^::ffff:/, '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) || 'unknown';
}

function sanitizeForLog(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(v => sanitizeForLog(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/password|passwd|token|secret|api[_-]?key|authorization|cookie/i.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string' && v.length > 220) out[k] = v.slice(0, 220) + '...';
    else out[k] = sanitizeForLog(v, depth + 1);
  }
  return out;
}

function createAppCore() {
  const app = express();
  app.set('trust proxy', 'loopback');

  const corsOrigins = (process.env.RIFUGIO_CORS_ORIGINS || process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  app.use(cors({
    credentials: true,
    origin(origin, cb) {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      // 不发 CORS 头让浏览器拦；服务端真正的防线是 auth gate，这里抛 Error 只会往日志灌堆栈
      console.warn(`[cors] denied origin: ${origin}`);
      return cb(null, false);
    },
  }));
  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
    next();
  });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} status=${res.statusCode} ip=${clientIp(req)} ms=${Date.now() - startedAt}`);
    });
    next();
  });

  return { app, clientIp, corsOrigins };
}

module.exports = {
  DEFAULT_CORS_ORIGINS,
  clientIp,
  sanitizeForLog,
  createAppCore,
};
