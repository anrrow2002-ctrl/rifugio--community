const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../js/apps/18-talk-stream.js');
const applySnapshot = window.Rifugio.applyTerminalTurnSnapshot;

test('terminal_final closes the assistant bubble with the recovered reply', () => {
  const msg = { content:'', preview:true, done:false, pendingReconnect:true };
  const snapshot = {
    done:true,
    events:[
      { type:'terminal_status', statuses:[] },
      { type:'terminal_final', text:'已经回复', transcript:true },
    ],
  };
  const result = applySnapshot(snapshot, msg, evt => {
    if (evt.type === 'terminal_final') {
      msg.content = evt.text;
      msg.preview = false;
      msg.done = true;
      msg.pendingReconnect = false;
    }
  });
  assert.deepEqual(result, { done:true, hasFinal:true });
  assert.equal(msg.content, '已经回复');
  assert.equal(msg.done, true);
  assert.equal(msg.preview, false);
  assert.equal(msg.pendingReconnect, false);
});

test('done snapshot without terminal_final stops loading with an explicit fallback', () => {
  const msg = { content:'', preview:true, done:false, pendingReconnect:true };
  const result = applySnapshot({ done:true, events:[{ type:'terminal_status', statuses:[] }] }, msg, () => {});
  assert.deepEqual(result, { done:true, hasFinal:false });
  assert.equal(msg.done, true);
  assert.equal(msg.preview, false);
  assert.equal(msg.pendingReconnect, false);
  assert.equal(msg.error, true);
  assert.match(msg.content, /本轮已经结束/);
});

test('unfinished snapshot keeps the assistant bubble pending', () => {
  const msg = { content:'', preview:true, done:false, pendingReconnect:true };
  const result = applySnapshot({ done:false, events:[] }, msg, () => {});
  assert.deepEqual(result, { done:false, hasFinal:false });
  assert.equal(msg.done, false);
  assert.equal(msg.preview, true);
  assert.equal(msg.pendingReconnect, true);
});
