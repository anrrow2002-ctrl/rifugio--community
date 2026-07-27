'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  mountChatroomApiRoutes,
  mountTalkApiRoutes,
  providerFor,
  normalizeApiKey,
  endpointFor,
  modelsEndpointFor,
  cacheUsage,
  isPrivateIp,
  stableCacheKey,
  reasoningText,
  providerAssistantMessage,
} = require('../modules/chatroom-api');

test('detects official providers without confusing compatible endpoints', () => {
  assert.equal(providerFor('auto', 'https://api.openai.com/v1', 'gpt-5.6'), 'openai');
  assert.equal(providerFor('auto', 'https://api.anthropic.com/v1', 'claude-opus-4-8'), 'anthropic');
  assert.equal(providerFor('auto', 'https://api.deepseek.com/v1', 'deepseek-chat'), 'deepseek');
  assert.equal(providerFor('auto', 'https://example.com/v1', 'custom'), 'compatible');
  assert.equal(providerFor('compatible', 'https://relay.example/v1', 'claude-sonnet-4'), 'compatible');
});

test('normalizes provider keys and recognized full endpoints', () => {
  assert.equal(normalizeApiKey('  Bearer sk-relay  '), 'sk-relay');
  assert.equal(endpointFor('https://relay.example/v1/models', 'compatible'), 'https://relay.example/v1/chat/completions');
  assert.equal(endpointFor('https://relay.example/v1/models', 'anthropic'), 'https://relay.example/v1/messages');
  assert.equal(modelsEndpointFor('https://relay.example/v1/chat/completions'), 'https://relay.example/v1/models');
  assert.equal(modelsEndpointFor('https://relay.example/v1/messages'), 'https://relay.example/v1/models');
});

test('normalizes provider cache counters', () => {
  assert.deepEqual(cacheUsage('openai', {
    prompt_tokens: 2000,
    prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 0 },
  }), { hit_tokens: 1500, write_tokens: 0, miss_tokens: 500 });
  assert.deepEqual(cacheUsage('anthropic', {
    input_tokens: 80, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0,
  }), { hit_tokens: 1200, write_tokens: 0, miss_tokens: 80 });
  assert.deepEqual(cacheUsage('deepseek', {
    prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100,
  }), { hit_tokens: 900, write_tokens: 0, miss_tokens: 100 });
});

test('blocks loopback and private network targets', () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '172.16.1.2', '192.168.1.2', '::1', 'fd00::1']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});

test('cache key is stable for stable prompt and tool prefix', () => {
  const messages = [{ role: 'system', content: 'stable' }, { role: 'user', content: 'changes' }];
  const tools = [{ publicName: 'rifugio_memory_breath' }];
  assert.equal(stableCacheKey('gpt-5.6', messages, tools, 'room'), stableCacheKey('gpt-5.6', messages, tools, 'room'));
});

test('preserves upstream reasoning fields for the Talk UI', () => {
  assert.equal(reasoningText({ reasoning_content: '先检查记忆，再回答。' }), '先检查记忆，再回答。');
  assert.equal(reasoningText({ reasoning: 'fallback reasoning' }), 'fallback reasoning');
  assert.equal(reasoningText({ thinking: 'fallback thinking' }), 'fallback thinking');

  assert.deepEqual(providerAssistantMessage({ text: '正文', reasoning: '思维链' }), {
    role: 'assistant',
    content: '正文',
    reasoning_content: '思维链',
  });
  assert.deepEqual(providerAssistantMessage({ text: '正文', reasoning: '' }), {
    role: 'assistant',
    content: '正文',
  });
});

test('mounts Talk and chatroom on distinct API prefixes', () => {
  const routes = [];
  const app = { post(path) { routes.push(path); } };
  mountChatroomApiRoutes(app);
  mountTalkApiRoutes(app);
  assert.deepEqual(routes, [
    '/api/chatroom-api/v1/models', '/api/chatroom-api/v1/chat/completions',
    '/api/talk-api/v1/models', '/api/talk-api/v1/chat/completions',
  ]);
});

test('Talk keeps Claude-named relay models on compatible auth and preserves upstream 401', { concurrency: false }, async t => {
  const app = express();
  app.use(express.json());
  mountTalkApiRoutes(app);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;
  dnsPromises.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  t.after(() => { dnsPromises.lookup = originalLookup; });

  const originalFetch = global.fetch;
  const upstreamCalls = [];
  global.fetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    upstreamCalls.push({
      url: String(url),
      authorization: headers.get('authorization'),
      anthropicKey: headers.get('x-api-key'),
    });
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-relay' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { message: 'Invalid token' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  let response = await originalFetch(base + '/api/talk-api/v1/models', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'compatible',
      base_url: 'https://relay.example/v1/chat/completions',
      api_key: 'Bearer relay-key',
      model: 'claude-sonnet-relay',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].id, 'claude-sonnet-relay');

  response = await originalFetch(base + '/api/talk-api/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'compatible',
      base_url: 'https://relay.example/v1/models',
      api_key: 'Bearer relay-key',
      model: 'claude-sonnet-relay',
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /上游 HTTP 401: Invalid token/);
  assert.deepEqual(upstreamCalls, [
    {
      url: 'https://relay.example/v1/models',
      authorization: 'Bearer relay-key',
      anthropicKey: null,
    },
    {
      url: 'https://relay.example/v1/chat/completions',
      authorization: 'Bearer relay-key',
      anthropicKey: null,
    },
  ]);
});
