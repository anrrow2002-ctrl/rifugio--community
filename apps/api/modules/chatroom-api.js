'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const {
  getAllowedTools,
  toOpenAiTools,
  toAnthropicTools,
  callAllowedTool,
} = require('./mcp-stdio-client');

const REQUEST_TIMEOUT_MS = Number(process.env.CHATROOM_API_TIMEOUT_MS) || 150000;
const MAX_TOOL_ROUNDS = 4;
const RIFUGIO_TOOL_PROMPT = [
  'Rifugio 是用户自己维护的私人系统，不是模型厂商的记忆功能。',
  '当问题涉及用户偏好、共同经历、旧约定或私人上下文时，先调用 Rifugio 的 breath 或 search_memory；一般知识不要滥用记忆。',
  '工具返回的内容只用于回答当前请求，不要泄露无关私人记忆。只有用户当前请求需要时才调用媒体工具。',
].join('\n');

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && (part.type === 'text' || part.type === 'input_text')) return part.text || '';
    if (part && part.type === 'image_url') return '[图片]';
    return '';
  }).filter(Boolean).join('\n');
}

function reasoningText(message) {
  if (!message || typeof message !== 'object') return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    if (typeof message[key] === 'string' && message[key].trim()) return message[key].trim();
  }
  return '';
}

function providerAssistantMessage(result) {
  const message = { role: 'assistant', content: result.text || '（空回复）' };
  const reasoning = String(result.reasoning || '').trim();
  if (reasoning) message.reasoning_content = reasoning;
  return message;
}

function auditProviderEvent(routeName, event) {
  const payload = {
    ts: new Date().toISOString(),
    route: String(routeName || 'provider-api'),
    ...event,
  };
  console.log(`[provider-audit] ${JSON.stringify(payload)}`);
}

function isPrivateIp(address) {
  const ip = String(address || '').replace(/^::ffff:/, '').toLowerCase();
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] >= 224);
  }
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
}

async function validatePublicBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch (_) { throw new Error('Base URL 无效'); }
  if (url.protocol !== 'https:') throw new Error('API 代理只允许 HTTPS Base URL');
  if (url.username || url.password || url.hash) throw new Error('Base URL 不能包含凭证或 fragment');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
    throw new Error('Base URL 指向本地或私网地址，已拒绝');
  }
  return url;
}

function providerFor(value, baseUrl, model) {
  const explicit = String(value || 'auto').toLowerCase();
  if (['openai', 'anthropic', 'deepseek', 'compatible'].includes(explicit)) return explicit;
  const hint = `${baseUrl || ''} ${model || ''}`.toLowerCase();
  if (hint.includes('anthropic.com') || /\bclaude[-_]/.test(hint)) return 'anthropic';
  if (hint.includes('deepseek.com') || /\bdeepseek[-_]/.test(hint)) return 'deepseek';
  if (hint.includes('openai.com') || /\bgpt[-_]/.test(hint)) return 'openai';
  return 'compatible';
}

function endpointFor(baseUrl, provider) {
  const clean = String(baseUrl).replace(/\/+$/, '');
  if (provider === 'anthropic') {
    return /\/messages$/i.test(clean) ? clean : `${clean}/messages`;
  }
  return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
}

function modelsEndpointFor(baseUrl) {
  const clean = String(baseUrl).replace(/\/+$/, '');
  return /\/models$/i.test(clean) ? clean : `${clean}/models`;
}

function stableCacheKey(model, messages, tools, namespace) {
  const system = messages.filter(m => m && m.role === 'system').map(m => contentText(m.content)).join('\n');
  const names = tools.map(tool => tool.publicName).sort().join(',');
  return 'rifugio:' + crypto.createHash('sha256')
    .update([namespace || 'room', model || '', system, names].join('\0'))
    .digest('hex').slice(0, 32);
}

function cacheUsage(provider, usage = {}) {
  if (provider === 'anthropic') {
    return {
      hit_tokens: Number(usage.cache_read_input_tokens) || 0,
      write_tokens: Number(usage.cache_creation_input_tokens) || 0,
      miss_tokens: Math.max(0, Number(usage.input_tokens) || 0),
    };
  }
  if (provider === 'deepseek') {
    return {
      hit_tokens: Number(usage.prompt_cache_hit_tokens) || 0,
      write_tokens: 0,
      miss_tokens: Number(usage.prompt_cache_miss_tokens) || 0,
    };
  }
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const hit = Number(details.cached_tokens) || 0;
  return {
    hit_tokens: hit,
    write_tokens: Number(details.cache_write_tokens) || 0,
    miss_tokens: Math.max(0, (Number(usage.prompt_tokens || usage.input_tokens) || 0) - hit),
  };
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, redirect: 'manual', signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
    if (response.status >= 300 && response.status < 400) throw new Error('上游 API 重定向已拒绝');
    if (!response.ok) {
      const message = data.error && (data.error.message || data.error.type) || data.message || text || `HTTP ${response.status}`;
      throw new Error(String(message).slice(0, 500));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMessages(messages, toolsEnabled) {
  const clean = (Array.isArray(messages) ? messages : []).slice(-80).map(message => ({
    role: ['system', 'user', 'assistant', 'tool'].includes(message && message.role) ? message.role : 'user',
    content: message && message.content,
    ...(message && message.name ? { name: String(message.name).slice(0, 64) } : {}),
  }));
  if (toolsEnabled) clean.unshift({ role: 'system', content: RIFUGIO_TOOL_PROMPT });
  return clean;
}

async function runOpenAiCompatible({ provider, endpoint, apiKey, model, messages, temperature, tools, namespace, requestId, routeName }) {
  const working = messages.map(item => ({ ...item }));
  const toolDefs = toOpenAiTools(tools);
  const used = [];
  let last;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const body = { model, messages: working, temperature };
    if (toolDefs.length) { body.tools = toolDefs; body.tool_choice = 'auto'; }
    if (provider === 'openai' && /(^|\.)api\.openai\.com$/i.test(new URL(endpoint).hostname)) {
      body.prompt_cache_key = stableCacheKey(model, messages, tools, namespace);
    }
    last = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const choice = last.choices && last.choices[0];
    const message = choice && choice.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) break;
    if (round === MAX_TOOL_ROUNDS) throw new Error('工具调用轮数超过安全上限');
    working.push(message);
    for (const call of calls) {
      const name = call && call.function && call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      const toolStartedAt = Date.now();
      auditProviderEvent(routeName, {
        event: 'tool_start', request_id: requestId, provider, model,
        round: round + 1, tool: name || 'unknown',
      });
      let output;
      try {
        output = await callAllowedTool(name, args, tools);
        used.push(name);
        auditProviderEvent(routeName, {
          event: 'tool_ok', request_id: requestId, provider, model,
          round: round + 1, tool: name || 'unknown', duration_ms: Date.now() - toolStartedAt,
        });
      } catch (error) {
        auditProviderEvent(routeName, {
          event: 'tool_error', request_id: requestId, provider, model,
          round: round + 1, tool: name || 'unknown', duration_ms: Date.now() - toolStartedAt,
          error_type: error && error.name || 'Error',
        });
        throw error;
      }
      working.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  const message = last && last.choices && last.choices[0] && last.choices[0].message || {};
  return {
    text: contentText(message.content),
    reasoning: reasoningText(message),
    usage: last && last.usage || {}, used, raw: last,
  };
}

function toAnthropicMessages(messages) {
  const system = [];
  const turns = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentText(message.content).trim();
      if (text) system.push({ type: 'text', text });
      continue;
    }
    if (message.role === 'tool') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const text = contentText(message.content).trim();
    if (!text) continue;
    if (turns.length && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += '\n\n' + text;
    } else {
      turns.push({ role, content: text });
    }
  }
  if (!turns.length) turns.push({ role: 'user', content: '请回应。' });
  if (turns[0].role === 'assistant') turns.unshift({ role: 'user', content: '继续。' });
  return { system, turns };
}

async function runAnthropic({ provider, endpoint, apiKey, model, messages, temperature, tools, requestId, routeName }) {
  const converted = toAnthropicMessages(messages);
  const working = converted.turns.map(item => ({ ...item }));
  const toolDefs = toAnthropicTools(tools);
  const used = [];
  let last;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const body = {
      model,
      max_tokens: 2048,
      temperature,
      system: converted.system,
      messages: working,
      cache_control: { type: 'ephemeral' },
    };
    if (toolDefs.length) { body.tools = toolDefs; body.tool_choice = { type: 'auto' }; }
    last = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const blocks = Array.isArray(last.content) ? last.content : [];
    const calls = blocks.filter(block => block && block.type === 'tool_use');
    if (!calls.length) break;
    if (round === MAX_TOOL_ROUNDS) throw new Error('工具调用轮数超过安全上限');
    working.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const call of calls) {
      const toolStartedAt = Date.now();
      auditProviderEvent(routeName, {
        event: 'tool_start', request_id: requestId, provider, model,
        round: round + 1, tool: call.name || 'unknown',
      });
      let output;
      try {
        output = await callAllowedTool(call.name, call.input || {}, tools);
        used.push(call.name);
        auditProviderEvent(routeName, {
          event: 'tool_ok', request_id: requestId, provider, model,
          round: round + 1, tool: call.name || 'unknown', duration_ms: Date.now() - toolStartedAt,
        });
      } catch (error) {
        auditProviderEvent(routeName, {
          event: 'tool_error', request_id: requestId, provider, model,
          round: round + 1, tool: call.name || 'unknown', duration_ms: Date.now() - toolStartedAt,
          error_type: error && error.name || 'Error',
        });
        throw error;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
    }
    working.push({ role: 'user', content: results });
  }
  const text = (Array.isArray(last && last.content) ? last.content : [])
    .filter(block => block && block.type === 'text')
    .map(block => block.text || '')
    .join('\n')
    .trim();
  const reasoning = (Array.isArray(last && last.content) ? last.content : [])
    .filter(block => block && block.type === 'thinking')
    .map(block => block.thinking || block.text || '')
    .join('\n')
    .trim();
  return { text, reasoning, usage: last && last.usage || {}, used, raw: last };
}

function mountProviderApiRoutes(app, options = {}) {
  const prefix = String(options.prefix || '/api/chatroom-api/v1').replace(/\/+$/, '');
  const routeName = String(options.routeName || 'chatroom-api').replace(/[^a-z0-9_-]/gi, '') || 'provider-api';
  const defaultNamespace = String(options.defaultNamespace || routeName).slice(0, 80);

  app.post(`${prefix}/models`, async (req, res) => {
    try {
      const body = req.body || {};
      const apiKey = String(body.api_key || '').trim();
      const baseUrl = String(body.base_url || '').trim();
      if (!apiKey || !baseUrl) throw new Error('base_url / api_key 必填');
      const provider = providerFor(body.provider, baseUrl, body.model);
      const checked = await validatePublicBaseUrl(baseUrl);
      const endpoint = modelsEndpointFor(checked.toString().replace(/\/$/, ''));
      const headers = provider === 'anthropic'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${apiKey}` };
      const upstream = await fetchJson(endpoint, { headers });
      const data = (upstream.data || upstream.models || []).map(item => ({
        id: item && (item.id || item.name || item.model), object: 'model',
      })).filter(item => item.id);
      res.json({ object: 'list', data, rifugio: { provider } });
    } catch (error) {
      const status = /必填|无效|只允许|不能包含|私网/.test(error.message) ? 400 : 502;
      res.status(status).json({ error: { message: String(error.message || error).slice(0, 500) } });
    }
  });

  app.post(`${prefix}/chat/completions`, async (req, res) => {
    const requestId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    let auditProvider = 'unknown';
    let auditModel = '';
    try {
      const body = req.body || {};
      const apiKey = String(body.api_key || '').trim();
      const model = String(body.model || '').trim();
      const baseUrl = String(body.base_url || '').trim();
      if (!apiKey || !model || !baseUrl) throw new Error('base_url / api_key / model 必填');
      if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('messages required');
      const provider = providerFor(body.provider, baseUrl, model);
      auditProvider = provider;
      auditModel = model;
      const checked = await validatePublicBaseUrl(baseUrl);
      const endpoint = endpointFor(checked.toString().replace(/\/$/, ''), provider);
      const capabilities = [];
      if (body.rifugio_memory === true) capabilities.push('memory');
      if (body.rifugio_tools === true) capabilities.push('media');
      if (body.rifugio_experience === true) capabilities.push('experience');
      const tools = capabilities.length ? await getAllowedTools(capabilities) : [];
      const messages = normalizeMessages(body.messages, tools.length > 0);
      const input = {
        provider, endpoint, apiKey, model, messages, tools,
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.85,
        namespace: String(body.cache_namespace || defaultNamespace).slice(0, 80),
        requestId, routeName,
      };
      const result = provider === 'anthropic'
        ? await runAnthropic(input)
        : await runOpenAiCompatible(input);
      const cache = cacheUsage(provider, result.usage);
      auditProviderEvent(routeName, {
        event: 'request_done', request_id: requestId, provider, model,
        tools_used: result.used, reasoning_chars: String(result.reasoning || '').length,
        duration_ms: Date.now() - requestStartedAt, cache,
      });
      res.json({
        id: `${routeName}-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: providerAssistantMessage(result), finish_reason: 'stop' }],
        usage: result.usage,
        rifugio: { provider, cache, tools_used: result.used },
      });
    } catch (error) {
      auditProviderEvent(routeName, {
        event: 'request_error', request_id: requestId, provider: auditProvider, model: auditModel,
        duration_ms: Date.now() - requestStartedAt, error_type: error && error.name || 'Error',
      });
      const status = /必填|required|无效|只允许|不能包含|私网|工具调用轮数/.test(error.message) ? 400 : 502;
      res.status(status).json({ error: { message: String(error.message || error).slice(0, 500) } });
    }
  });
  console.log(`[${routeName}] provider cache + Rifugio MCP bridge on ${prefix}`);
}

function mountChatroomApiRoutes(app) {
  mountProviderApiRoutes(app, { prefix: '/api/chatroom-api/v1', routeName: 'chatroom-api', defaultNamespace: 'chatroom' });
}

function mountTalkApiRoutes(app) {
  mountProviderApiRoutes(app, { prefix: '/api/talk-api/v1', routeName: 'talk-api', defaultNamespace: 'talk' });
}

module.exports = {
  mountChatroomApiRoutes,
  mountTalkApiRoutes,
  mountProviderApiRoutes,
  providerFor,
  cacheUsage,
  isPrivateIp,
  stableCacheKey,
  reasoningText,
  providerAssistantMessage,
};
