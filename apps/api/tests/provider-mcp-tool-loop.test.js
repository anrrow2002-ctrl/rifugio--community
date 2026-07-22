'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const originalFetch = global.fetch;

async function listen(app) {
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('OpenAI-compatible Talk can execute an allowlisted Rifugio MCP tool round', { concurrency: false }, async t => {
  const mcpPath = require.resolve('../modules/mcp-stdio-client');
  const chatroomPath = require.resolve('../modules/chatroom-api');
  let called = 0;
  require.cache[mcpPath] = {
    id: mcpPath,
    filename: mcpPath,
    loaded: true,
    exports: {
      getAllowedTools: async capabilities => {
        assert.deepEqual(capabilities, ['experience']);
        return [{
          name: 'breath',
          publicName: 'rifugio_memory_breath',
          description: 'read memory',
          inputSchema: { type: 'object', properties: {} },
        }];
      },
      toOpenAiTools: tools => tools.map(tool => ({
        type: 'function',
        function: { name: tool.publicName, description: tool.description, parameters: tool.inputSchema },
      })),
      toAnthropicTools: () => [],
      callAllowedTool: async (name, args, tools) => {
        called += 1;
        assert.equal(name, 'rifugio_memory_breath');
        assert.deepEqual(args, {});
        assert.equal(tools[0].name, 'breath');
        return 'memory says hello';
      },
    },
  };
  delete require.cache[chatroomPath];
  t.after(() => {
    delete require.cache[chatroomPath];
    delete require.cache[mcpPath];
    global.fetch = originalFetch;
  });

  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;
  dnsPromises.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  t.after(() => { dnsPromises.lookup = originalLookup; });

  const { mountTalkApiRoutes } = require('../modules/chatroom-api');
  const app = express();
  app.use(express.json());
  mountTalkApiRoutes(app);
  const local = await listen(app);
  t.after(() => local.close());

  let upstreamRound = 0;
  global.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const headers = new Headers(options.headers || {});
    assert.equal(headers.get('authorization'), 'Bearer tool-loop-placeholder');
    const body = JSON.parse(options.body);
    upstreamRound += 1;
    if (upstreamRound === 1) {
      assert.equal(body.tools[0].function.name, 'rifugio_memory_breath');
      return new Response(JSON.stringify({
        choices: [{ message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'rifugio_memory_breath', arguments: '{}' } }],
        } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const toolMessage = body.messages.find(message => message.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'call-1');
    assert.equal(toolMessage.content, 'memory says hello');
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'I used the memory tool.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const response = await originalFetch(local.url + '/api/talk-api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'tool-loop-placeholder',
      model: 'gpt-tool-loop',
      messages: [{ role: 'user', content: 'remember me' }],
      rifugio_experience: true,
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'I used the memory tool.');
  assert.deepEqual(payload.rifugio.tools_used, ['rifugio_memory_breath']);
  assert.equal(called, 1);
  assert.equal(upstreamRound, 2);
});
