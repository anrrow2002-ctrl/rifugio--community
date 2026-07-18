// ── 用户自助 MCP 管理（2026-06-21）────────────────────────────────────
// 用户在前端粘贴一个 MCP 链接（或本地命令）→ 选权限（只读/需要确认/允许写入）→
// 加进来，聊天里的 Claude 下次启动就能用它的工具。现有的也能开关/改权限/删。
//
// 权限语义（headless -p 模式下的现实映射）：
//   · 允许写入 write   → 整个 server 进 allowedTools，自动可用（含写/改/删）
//   · 只读     read    → 已探测到工具时：只放读取类工具进 allowedTools，写类进 disallowedTools(硬限制)；
//                        未探测到时：整个 server 放行 + 人格提示"只读"(软限制)
//   · 需要确认 confirm → 整个 server 放行(可调用) + 人格提示"用前先在聊天里问用户，同意再用"(软确认)
// 注：headless 模式没有交互式弹窗确认，"需要确认"是靠人格约束的软确认；要硬确认需 permission-prompt-tool，
//     以后可加。stdio 会在添加时探测工具清单；远程(sse/http) v1 暂不探测，只读按软限制。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STORE = process.env.MCP_STORE_FILE || require('./modules/community-config').dataPath('mcp-servers.json');
const ACTIVE = process.env.MCP_ACTIVE_FILE || require('./modules/community-config').dataPath('mcp-active.json');
const READ_RE = /^(get|list|search|read|fetch|query|find|view|show|status|describe|count|lookup|retrieve|browse|check|summary|head|stat)/i;

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return []; }
}
function save(list) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2));
}
function sanitizeKey(name, existing) {
  let base = String(name || 'mcp').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'mcp';
  let key = base, i = 1;
  while (existing.has(key)) key = `${base}_${i++}`;
  return key;
}

// 把一台 server 转成 claude --mcp-config 里的条目
function toConfigEntry(s) {
  if (s.transport === 'stdio') return { command: s.command, args: s.args || [] };
  const entry = { type: s.transport === 'http' ? 'http' : 'sse', url: s.url };
  if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers;
  return entry;
}

// best-effort 探测 stdio MCP 的工具清单（5s 超时）
function probeStdioTools(command, args = []) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return finish([]); }
    let buf = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish([]); }, 5000);
    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2 && m.result && Array.isArray(m.result.tools)) {
          clearTimeout(timer); try { child.kill(); } catch {}
          return finish(m.result.tools.map(t => t.name).filter(Boolean));
        }
      }
    });
    child.on('error', () => { clearTimeout(timer); finish([]); });
    child.on('exit', () => { clearTimeout(timer); finish([]); });
    const w = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    w({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rifugio-probe', version: '1.0' } } });
    w({ jsonrpc: '2.0', method: 'notifications/initialized' });
    w({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

async function probeTools(s) {
  if (s.transport === 'stdio' && s.command) return probeStdioTools(s.command, s.args || []);
  return []; // 远程 v1 暂不探测
}

// ── 给聊天 spawn 用的动态产物 ────────────────────────────────────────
// 把 base 配置(memory/health/radio/toy) + 启用的用户 server 合并成 active 配置文件，返回路径
function buildActiveConfig(baseConfigPath) {
  let base = { mcpServers: {} };
  try { base = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8')); } catch {}
  const cfg = { mcpServers: { ...(base.mcpServers || {}) } };
  for (const s of load()) {
    if (!s.enabled) continue;
    if (cfg.mcpServers[s.key]) continue; // 不覆盖内置
    try { cfg.mcpServers[s.key] = toConfigEntry(s); } catch {}
  }
  fs.mkdirSync(path.dirname(ACTIVE), { recursive: true });
  fs.writeFileSync(ACTIVE, JSON.stringify(cfg, null, 2));
  return ACTIVE;
}

// 返回 { allow:[], disallow:[], persona:'' }，叠加到内置 allowedTools / 人格
function buildPermissions() {
  const allow = [], disallow = [], notes = [];
  for (const s of load()) {
    if (!s.enabled) continue;
    const tools = Array.isArray(s.tools) ? s.tools : [];
    if (s.mode === 'write') {
      allow.push(`mcp__${s.key}`);
    } else if (s.mode === 'read') {
      if (tools.length) {
        for (const t of tools) (READ_RE.test(t) ? allow : disallow).push(`mcp__${s.key}__${t}`);
        notes.push(`「${s.name}」只读：只会用读取类工具`);
      } else {
        // 工具清单未知时不能靠人格提示假装只读；fail closed，避免写工具被隐式放行。
        disallow.push(`mcp__${s.key}`);
        notes.push(`「${s.name}」只读：工具清单尚未验证，已安全停用`);
      }
    } else { // confirm
      allow.push(`mcp__${s.key}`);
      notes.push(`「${s.name}」需要确认：用它的任何工具前，先在聊天里跟用户说一声、得到她同意再调用`);
    }
  }
  const persona = notes.length
    ? `\n\n【外部 MCP 工具权限】用户加了一些外部 MCP，请遵守每台的权限：\n- ${notes.join('\n- ')}`
    : '';
  return { allow, disallow, persona };
}

// ── CRUD 路由 ───────────────────────────────────────────────────────
function mountMcpStoreRoutes(app, { hasTerminalAuth } = {}) {
  const requireMcpAdmin = (req, res) => {
    if (typeof hasTerminalAuth === 'function' && hasTerminalAuth(req)) return true;
    res.status(401).json({ ok: false, error: 'terminal verification required' });
    return false;
  };
  app.get('/api/mcp/servers', (req, res) => {
    res.json({ ok: true, servers: load().map(s => ({ ...s, headers: s.headers ? Object.keys(s.headers) : [] })) });
  });

  app.post('/api/mcp/servers', async (req, res) => {
    if (!requireMcpAdmin(req, res)) return;
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      let transport = ['sse', 'http', 'stdio'].includes(b.transport) ? b.transport : '';
      const url = String(b.url || '').trim();
      const command = String(b.command || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: '名字必填' });
      if (!transport) transport = url ? 'sse' : (command ? 'stdio' : '');
      if (transport === 'stdio' && !command) return res.status(400).json({ ok: false, error: '本地命令(command)必填' });
      if (transport !== 'stdio' && !/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: '远程 MCP 需要 http(s) 链接' });
      const mode = ['read', 'confirm', 'write'].includes(b.mode) ? b.mode : 'confirm';
      const list = load();
      const key = sanitizeKey(name, new Set(list.map(s => s.key)));
      const server = {
        id: require('crypto').randomBytes(6).toString('hex'),
        key, name, transport, mode, enabled: b.enabled !== false,
        url: transport === 'stdio' ? '' : url,
        command: transport === 'stdio' ? command : '',
        args: Array.isArray(b.args) ? b.args.map(String) : (b.args ? String(b.args).split(/\s+/).filter(Boolean) : []),
        headers: (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) ? b.headers : {},
        tools: [],
        createdAt: new Date().toISOString(),
      };
      server.tools = await probeTools(server).catch(() => []);
      list.push(server); save(list);
      buildActiveConfig(app.locals._mcpBaseConfig || path.join(__dirname, 'mcp-memory.json'));
      res.json({ ok: true, server: { ...server, headers: Object.keys(server.headers) } });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.put('/api/mcp/servers/:id', async (req, res) => {
    if (!requireMcpAdmin(req, res)) return;
    try {
      const list = load();
      const s = list.find(x => x.id === req.params.id);
      if (!s) return res.status(404).json({ ok: false, error: 'not found' });
      const b = req.body || {};
      if (typeof b.enabled === 'boolean') s.enabled = b.enabled;
      if (['read', 'confirm', 'write'].includes(b.mode)) s.mode = b.mode;
      if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim();
      if (typeof b.url === 'string' && s.transport !== 'stdio') s.url = b.url.trim();
      if (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) s.headers = b.headers;
      if (b.reprobe) s.tools = await probeTools(s).catch(() => s.tools || []);
      save(list);
      buildActiveConfig(app.locals._mcpBaseConfig || path.join(__dirname, 'mcp-memory.json'));
      res.json({ ok: true, server: { ...s, headers: s.headers ? Object.keys(s.headers) : [] } });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/mcp/servers/:id', (req, res) => {
    if (!requireMcpAdmin(req, res)) return;
    const list = load().filter(x => x.id !== req.params.id);
    save(list);
    buildActiveConfig(app.locals._mcpBaseConfig || path.join(__dirname, 'mcp-memory.json'));
    res.json({ ok: true });
  });
}

// 给 server.js 的 /api/mcp/active 做 key→name 标注用
function __listForLabel() { return load().map(s => ({ key: s.key, name: s.name })); }

module.exports = { mountMcpStoreRoutes, buildActiveConfig, buildPermissions, __listForLabel };
