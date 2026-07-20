'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { features } = require('./community-config');

const DEFAULT_CONFIG = process.env.RIFUGIO_MCP_CONFIG || path.join(__dirname, '..', 'mcp-rifugio.json');
const TOOL_CACHE_MS = 5 * 60 * 1000;
const SAFE_CAPABILITIES = Object.freeze({
  memory: {
    memory: new Set(['breath', 'search_memory']),
    rifugio: new Set(['breath', 'search_memory']),
  },
  media: {
    radio: new Set(['radio_search', 'radio_play', 'sleep_timer', 'radio_stop']),
    image: new Set(['generate_image', 'list_image_presets']),
    rifugio: new Set(['radio_play', 'generate_image', 'list_image_presets']),
  },
  // Mirrors the existing Claude chat's relationship-experience allowlist.
  // Maintenance/VPS, terminal, filesystem and arbitrary shell tools are intentionally absent.
  experience: {
    memory: new Set(['breath', 'search_memory', 'hold', 'plan', 'dream', 'dream_seen']),
    health: new Set(['get_health']),
    radio: new Set(['radio_search', 'radio_play', 'sleep_timer', 'radio_stop']),
    toy: new Set(['toy_status', 'toy_vibrate', 'toy_pulse', 'toy_wave', 'toy_escalate', 'toy_stop']),
    image: new Set(['generate_image', 'list_image_presets']),
    stickers: new Set(['ai_sticker_list', 'ai_sticker_set_resident']),
    rifugio: new Set([
      'breath', 'search_memory', 'hold', 'plan', 'dream', 'dream_seen',
      'get_health', 'radio_play', 'speak',
      'toy_status', 'toy_set', 'toy_sequence', 'toy_flow', 'toy_wild', 'toy_stop',
      'generate_image', 'list_image_presets',
      'read', 'write', 'view_pyq', 'post_pyq',
    ]),
  },
});

let cachedAt = 0;
let cachedConfigPath = '';
let cachedTools = [];

function readConfig(configPath = DEFAULT_CONFIG) {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const rawServers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : {};
  const configDir = path.dirname(path.resolve(configPath));
  const servers = Object.fromEntries(Object.entries(rawServers).map(([name, entry]) => [
    name,
    entry && typeof entry === 'object' ? { ...entry, cwd: entry.cwd || configDir } : entry,
  ]));
  // Stickers are a built-in relationship tool even if an older base config has not listed it yet.
  const stickerServer = path.join(__dirname, '..', 'sticker-mcp.js');
  if (!servers.stickers && fs.existsSync(stickerServer)) {
    servers.stickers = { command: 'node', args: [stickerServer] };
  }
  return servers;
}

function rpcStdio(entry, request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!entry || !entry.command) return reject(new Error('MCP stdio command missing'));
    const child = spawn(entry.command, Array.isArray(entry.args) ? entry.args : [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(entry.env || {}) },
      cwd: entry.cwd || process.cwd(),
    });
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch (_) {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('MCP stdio timeout')), timeoutMs);
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (!settled) finish(new Error(`MCP stdio exited before response (${code})`));
    });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        if (message.id !== 2) continue;
        if (message.error) return finish(new Error(message.error.message || 'MCP error'));
        return finish(null, message.result || {});
      }
    });
    const write = value => child.stdin.write(JSON.stringify(value) + '\n');
    write({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'rifugio-api-bridge', version: '1.0.0' },
      },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    write({ ...request, jsonrpc: '2.0', id: 2 });
  });
}

function publicToolName(server, name) {
  return `rifugio_${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

async function discoverTools(configPath = DEFAULT_CONFIG) {
  const now = Date.now();
  if (cachedConfigPath === configPath && cachedTools.length && now - cachedAt < TOOL_CACHE_MS) {
    return cachedTools;
  }
  const servers = readConfig(configPath);
  const discovered = [];
  for (const [server, entry] of Object.entries(servers)) {
    if (!entry || !entry.command) continue; // API bridge never opens remote/user MCP implicitly.
    let result;
    try {
      result = await rpcStdio(entry, { method: 'tools/list', params: {} }, 10000);
    } catch (_) {
      continue;
    }
    for (const tool of (Array.isArray(result.tools) ? result.tools : [])) {
      if (!tool || !tool.name) continue;
      discovered.push({
        server,
        entry,
        name: tool.name,
        publicName: publicToolName(server, tool.name),
        description: String(tool.description || '').slice(0, 1200),
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      });
    }
  }
  cachedAt = now;
  cachedConfigPath = configPath;
  cachedTools = discovered;
  return discovered;
}

function toolFeatureEnabled(tool) {
  if (tool.name === 'get_health') return features.health;
  if (tool.name === 'radio_play' || tool.name.startsWith('radio_')) return features.radio;
  if (tool.name === 'generate_image' || tool.name === 'list_image_presets') return features.image;
  if (tool.name === 'speak') return features.voice;
  if (tool.name.startsWith('toy_')) return features.toy;
  return true;
}

function isAllowed(tool, capabilities = []) {
  if (!toolFeatureEnabled(tool)) return false;
  for (const capability of capabilities) {
    const serverRules = SAFE_CAPABILITIES[capability];
    const names = serverRules && serverRules[tool.server];
    if (names && names.has(tool.name)) return true;
  }
  return false;
}

async function getAllowedTools(capabilities = [], configPath = DEFAULT_CONFIG) {
  const requested = [...new Set((Array.isArray(capabilities) ? capabilities : []).map(String))];
  const tools = await discoverTools(configPath);
  return tools.filter(tool => isAllowed(tool, requested));
}

function toOpenAiTools(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.publicName,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function toAnthropicTools(tools) {
  return tools.map(tool => ({
    name: tool.publicName,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function resultText(result) {
  const blocks = Array.isArray(result && result.content) ? result.content : [];
  const text = blocks
    .filter(block => block && block.type === 'text')
    .map(block => String(block.text || ''))
    .join('\n')
    .trim();
  if (text) return text.slice(0, 30000);
  return JSON.stringify(result || {}).slice(0, 30000);
}

async function callAllowedTool(publicName, args, tools) {
  const tool = (Array.isArray(tools) ? tools : []).find(item => item.publicName === publicName);
  if (!tool) throw new Error('tool is not allowed for this API seat');
  const result = await rpcStdio(tool.entry, {
    method: 'tools/call',
    params: { name: tool.name, arguments: args && typeof args === 'object' ? args : {} },
  });
  return resultText(result);
}

module.exports = {
  SAFE_CAPABILITIES,
  discoverTools,
  getAllowedTools,
  toOpenAiTools,
  toAnthropicTools,
  callAllowedTool,
};
