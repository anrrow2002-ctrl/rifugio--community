'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('../modules/sqlite');
const { createSecretCrypto } = require('../modules/secret-crypto');
const { createSettingsMemoryRoutes } = require('../modules/settings-memory-routes');
const { mountPetAiRoutes } = require('../modules/pet-ai');
const { mountVoiceSttRoutes } = require('../modules/voice-stt');
const { mountChatroomApiRoutes, mountTalkApiRoutes } = require('../modules/chatroom-api');

const originalFetch = global.fetch;

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rifugio-provider-auth-'));
  const dbPath = path.join(dir, 'memory.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.close();
  return { dir, dbPath };
}

async function listen(app) {
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('all OpenAI-compatible community proxies keep Bearer auth server-side', { concurrency: false }, async t => {
  process.env.RIFUGIO_SECRET = 'provider-auth-contract-secret';
  const { maskKey, encrypt, decrypt } = createSecretCrypto();
  const { dir, dbPath } = makeDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  createSettingsMemoryRoutes({ DB_PATH: dbPath, maskKey, encrypt, decrypt }).mountPreMigrationRoutes(app);
  mountPetAiRoutes(app, { DB_PATH: dbPath, maskKey, encrypt, decrypt, clientIp: () => 'test' });
  mountVoiceSttRoutes(app, { DB_PATH: dbPath, maskKey, encrypt, decrypt });
  mountChatroomApiRoutes(app);
  mountTalkApiRoutes(app);
  const local = await listen(app);
  t.after(() => local.close());

  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;
  dnsPromises.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  t.after(() => { dnsPromises.lookup = originalLookup; });

  const expectedKey = 'provider-contract-placeholder';
  const seen = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const headers = new Headers(options.headers || {});
    seen.push({ target, authorization: headers.get('authorization'), method: options.method || 'GET' });
    assert.equal(headers.get('authorization'), 'Bearer ' + expectedKey, target);
    if (target.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-contract' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = originalFetch; });

  let response = await originalFetch(local.url + '/api/settings/llm', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: 'https://api.openai.com/v1/', api_key: expectedKey, model: 'gpt-contract' }),
  });
  assert.equal(response.status, 200);

  response = await originalFetch(local.url + '/api/settings/llm');
  const saved = await response.json();
  assert.match(saved.data.api_key, /\*\*\*/);

  response = await originalFetch(local.url + '/api/settings/llm/test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: 'https://api.openai.com/v1/', api_key: saved.data.api_key }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: [{ id: 'gpt-contract' }] });
  assert.equal(seen.at(-1).target, 'https://api.openai.com/v1/models');

  response = await originalFetch(local.url + '/api/settings/pet-ai', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: expectedKey, model: 'gpt-contract' }),
  });
  const petSaved = await response.json();
  assert.match(petSaved.data.api_key, /\*\*\*/);

  response = await originalFetch(local.url + '/api/settings/pet-ai/test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: petSaved.data.api_key, model: 'gpt-contract' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  response = await originalFetch(local.url + '/api/integrations/models', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'text', provider: 'openai-compatible', base_url: 'https://api.openai.com/v1', api_key: expectedKey }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models[0].id, 'gpt-contract');

  for (const prefix of ['/api/chatroom-api/v1', '/api/talk-api/v1']) {
    response = await originalFetch(local.url + prefix + '/models', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: expectedKey }),
    });
    assert.equal(response.status, 200, prefix + '/models');
    assert.equal((await response.json()).data[0].id, 'gpt-contract');

    response = await originalFetch(local.url + prefix + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: expectedKey,
        model: 'gpt-contract', messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    assert.equal(response.status, 200, prefix + '/chat/completions');
    assert.equal((await response.json()).choices[0].message.content, 'ok');
  }

  assert.equal(seen.length, 7);
  assert.ok(seen.every(item => item.authorization === 'Bearer ' + expectedKey));
});
