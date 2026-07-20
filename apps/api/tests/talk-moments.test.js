'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createTalkConvos } = require('../modules/talk-convos');

test('moment API distinguishes the internal token and supports read/comment', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rifugio-moments-'));
  const dbPath = path.join(dir, 'chat.db');
  process.env.CHAT_TOKEN = 'internal-secret';
  process.env.USER_NAME = 'User';
  process.env.COMPANION_NAME = 'Companion';

  const events = [];
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const talk = createTalkConvos({
    DB_PATH: dbPath,
    isClaudeSessionId: () => false,
    syncClaudeTalkConversation: async () => {},
    onMomentEvent: event => events.push(event),
    sendWebPushNotification: async () => ({ ok: true }),
  });
  talk.mountTalkConvoRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  let response = await fetch(base + '/api/talk/moments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-token': 'wrong' },
    body: JSON.stringify({ content: 'from user' }),
  });
  assert.equal(response.status, 201);
  let body = await response.json();
  assert.equal(body.moment.author, 'User');
  const userMomentId = body.moment.id;

  response = await fetch(base + '/api/talk/moments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-token': 'internal-secret' },
    body: JSON.stringify({ content: 'from AI' }),
  });
  assert.equal(response.status, 201);
  body = await response.json();
  assert.equal(body.moment.author, 'Companion');
  assert.equal(events.at(-1).type, 'talk-moment-created');

  response = await fetch(base + '/api/talk/moments/' + encodeURIComponent(userMomentId) + '/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-token': 'internal-secret' },
    body: JSON.stringify({ content: 'I saw it' }),
  });
  assert.equal(response.status, 201);
  body = await response.json();
  assert.equal(body.comment.author, 'Companion');

  response = await fetch(base + '/api/talk/moments/' + encodeURIComponent(userMomentId));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.moment.comments.length, 1);
  assert.equal(body.moment.comments[0].text, 'I saw it');
});
