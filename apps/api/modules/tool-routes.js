const { mountRadioRoutes } = require('../radio');
const { mountToyRoutes } = require('../toy');
const { mountImageRoutes } = require('../image');
const { mountMcpStoreRoutes, buildActiveConfig, buildPermissions } = require('../mcp-store');
const path = require('path');
const { dataPath, features } = require('./community-config');

// 工具白名单：允许读记忆、Dream 自省，以及在确有沉淀时写入 feel；不允许聊天里直接 quiet/digest/archive。
const CHAT_ALLOWED_TOOLS = `Read(${dataPath('chat-images')}/**),WebSearch,WebFetch,mcp__rifugio__search_memory,mcp__rifugio__breath,mcp__rifugio__dream,mcp__rifugio__dream_seen,mcp__rifugio__hold,mcp__rifugio__get_health,mcp__rifugio__speak,mcp__rifugio__radio_play,mcp__rifugio__toy_status,mcp__rifugio__toy_set,mcp__rifugio__toy_sequence,mcp__rifugio__toy_flow,mcp__rifugio__toy_wild,mcp__rifugio__toy_stop,mcp__rifugio__generate_image,mcp__rifugio__list_image_presets`;
const MCP_MEMORY_CONFIG = path.join(__dirname, '..', 'mcp-rifugio.json');   // 唯一主 Rifugio MCP（stdio 仅作 loopback transport）

// 给两个 spawn 点用：返回动态的 mcp 配置路径 / allowedTools / disallowedTools / 人格补丁
function buildChatTools() {
  let configPath = MCP_MEMORY_CONFIG, allowed = CHAT_ALLOWED_TOOLS, disallow = [], persona = '';
  try {
    configPath = buildActiveConfig(MCP_MEMORY_CONFIG);
    const p = buildPermissions();
    if (p.allow.length) allowed = CHAT_ALLOWED_TOOLS + ',' + p.allow.join(',');
    disallow = p.disallow; persona = p.persona;
  } catch (_) {}
  return { configPath, allowed, disallow, persona };
}

function mountToolRoutes(app, { hasTerminalAuth } = {}) {
  // ── Radio 电台/音乐/有声 + 播放指令队列（2026-06-21）：必须在 /api/:table 兜底前注册 ──
  if (features.radio) mountRadioRoutes(app, { defaultBitrate: Number(process.env.RADIO_BITRATE) || 320 });
  if (features.toy) mountToyRoutes(app);
  if (features.image) mountImageRoutes(app);
  // 用户自助 MCP 管理（前端粘贴链接 + 选权限）：动态合并进聊天的 --mcp-config
  app.locals._mcpBaseConfig = MCP_MEMORY_CONFIG;
  mountMcpStoreRoutes(app, { hasTerminalAuth });
  try { buildActiveConfig(MCP_MEMORY_CONFIG); } catch (_) {}

  // 前端展示：Claude 现在实际能调用的工具清单（解析真实 allowedTools，按 server 分组）
  const MCP_SERVER_LABEL = { rifugio: 'Rifugio', memory: '记忆库', health: '健康', radio: '电台', toy: '玩具', image: '生图', stickers: 'AI表情包' };
  const MCP_TOOL_LABEL = {
    search_memory: '查记忆', breath: '关系沉淀', dream: 'Dream 自省', dream_seen: '标记已看', hold: '写 feel',
    get_health: '读健康数据',
    speak: 'Companion说话',
    radio_search: '搜歌/电台/故事', radio_play: '播放', sleep_timer: '哄睡定时', radio_stop: '停止播放',
    toy_status: '设备状态', toy_set: '三通道控制', toy_sequence: '动作序列', toy_flow: '连续曲线', toy_wild: '失控模式', toy_stop: '紧急停',
    generate_image: '生成图片', list_image_presets: '看预设组',
    ai_sticker_list: '按情绪查AI表情', ai_sticker_set_resident: '管理常驻高频区',
  };
  const MCP_BUILTIN = new Set(['rifugio', 'memory', 'health', 'radio', 'toy', 'image', 'stickers']);
  app.get('/api/mcp/active', (req, res) => {
    try {
      const { allowed } = buildChatTools();
      const userNames = {};
      try { for (const s of require('../mcp-store').__listForLabel ? require('../mcp-store').__listForLabel() : []) userNames[s.key] = s.name; } catch (_) {}
      const groups = new Map();
      const basics = [];
      for (const raw of allowed.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!raw.startsWith('mcp__')) { basics.push(raw); continue; }
        const parts = raw.split('__');           // mcp__server__tool  或  mcp__server(整服)
        const server = parts[1];
        const tool = parts.slice(2).join('__');
        if (!groups.has(server)) groups.set(server, []);
        if (tool) groups.get(server).push({ name: tool, label: MCP_TOOL_LABEL[tool] || tool });
        else groups.get(server).push({ name: '*', label: '该服务的全部工具' });
      }
      const out = [];
      for (const [server, tools] of groups) {
        out.push({
          server,
          label: MCP_SERVER_LABEL[server] || userNames[server] || server,
          builtin: MCP_BUILTIN.has(server),
          tools,
        });
      }
      if (basics.length) out.push({ server: 'basics', label: '基础工具', builtin: true, tools: basics.map(b => ({ name: b, label: b })) });
      res.json({ ok: true, groups: out });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = {
  MCP_MEMORY_CONFIG,
  buildChatTools,
  mountToolRoutes,
};
