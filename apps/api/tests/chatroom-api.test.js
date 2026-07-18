'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mountChatroomApiRoutes,
  mountTalkApiRoutes,
  providerFor,
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
