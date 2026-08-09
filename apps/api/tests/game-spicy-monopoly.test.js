'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionRequest } = require('../modules/game-spicy-monopoly');

test('maps common game actions to encoded upstream paths', () => {
  assert.deepEqual(actionRequest('serve_toll', 'ab 12', { who: 'AI 伴侣' }), {
    method: 'POST',
    path: '/serve_toll/ab%2012/AI%20%E4%BC%B4%E4%BE%A3',
  });
  assert.deepEqual(actionRequest('duel_result', 'game1', { winner: '玩家一' }), {
    method: 'POST',
    path: '/duel_result/game1/%E7%8E%A9%E5%AE%B6%E4%B8%80',
  });
});

test('rejects unsupported or incomplete actions', () => {
  assert.throws(() => actionRequest('delete_everything', 'game1', {}), /unsupported action/);
  assert.throws(() => actionRequest('skip', 'game1', {}), /missing who/);
});
