const fs = require('fs');
const { spawn } = require('child_process');

function createClaudeStatusQuota() {
  // ── -p 月度额度追踪（2026-06-21）──────────────────────────────────────────
  // 累加每次 /api/claude-agent/stream 的 result.total_cost_usd，按月统计。到 $18 预警 →
  // 前端横幅 + 存 handoff + 提示切终端 `claude --resume`（上下文在；实际额度/缓存以 Claude Code 服务端为准）。用户拍板 A 方案+阈值$18。
  const PQ_USAGE_FILE = process.env.PQ_USAGE_FILE || require('./community-config').dataPath('provider-usage.json');
  const PQ_BUDGET_USD = Number(process.env.PQ_BUDGET_USD || 20);
  const PQ_WARN_USD   = Number(process.env.PQ_WARN_USD || 18);
  const pqMonth = () => new Date().toISOString().slice(0, 7);   // YYYY-MM
  function readPqUsage() {
    try {
      const j = JSON.parse(fs.readFileSync(PQ_USAGE_FILE, 'utf8'));
      if (j && j.month === pqMonth()) return { month: j.month, cost_usd: Number(j.cost_usd) || 0 };
    } catch (_) {}
    return { month: pqMonth(), cost_usd: 0 };   // 跨月自动归零
  }
  function addPqUsage(deltaUsd) {
    const u = readPqUsage();
    u.cost_usd = Math.round((u.cost_usd + (Number(deltaUsd) || 0)) * 1e6) / 1e6;
    try { fs.writeFileSync(PQ_USAGE_FILE, JSON.stringify(u), 'utf8'); } catch (_) {}
    return u;
  }

  function mountClaudeAgentStatusRoute(app) {
    app.get('/api/claude-agent/status', (req, res) => {
      const env = { ...process.env, HOME: '/root' };
      for (const k of Object.keys(env)) {
        if (/^CLAUDE/i.test(k) || /^AI_AGENT/i.test(k)) delete env[k];
      }

      const child = spawn('claude', ['--version'], {
        cwd: '/root',
        env,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('error', e => {
        if (!res.headersSent) {
          res.status(503).json({ ok: false, logged_in: false, error: 'claude CLI unavailable: ' + e.message });
        }
      });
      child.on('close', code => {
        if (res.headersSent) return;
        if (code !== 0) {
          return res.status(503).json({ ok: false, logged_in: false, error: (err || out || `claude exited ${code}`).slice(0, 300) });
        }
        res.json({ ok: true, logged_in: true, mode: 'claude-cli', version: (out || '').trim() || null });
      });
    });
  }

  function mountQuotaRoute(app) {
    // -p 月度额度状态（前端轮询/进聊天时查，决定是否提示切终端）
    app.get('/api/quota/status', (req, res) => {
      const u = readPqUsage();
      res.json({
        ok: true, scope: 'p', month: u.month,
        used_usd: u.cost_usd, warn_usd: PQ_WARN_USD, budget_usd: PQ_BUDGET_USD,
        near_limit: u.cost_usd >= PQ_WARN_USD,
        remaining_usd: Math.max(0, Math.round((PQ_BUDGET_USD - u.cost_usd) * 100) / 100),
      });
    });
  }

  return {
    PQ_BUDGET_USD,
    PQ_WARN_USD,
    readPqUsage,
    addPqUsage,
    mountClaudeAgentStatusRoute,
    mountQuotaRoute,
  };
}

module.exports = { createClaudeStatusQuota };
