const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rifugio-pane-turn-'));
process.env.CLAUDE_TRANSCRIPT_ROOT = root;
const { createTerminalChat, advanceTerminalTurnLifecycle } = require('../modules/terminal-chat');
const hooks = createTerminalChat({ get(){}, post(){} }, {}).__test;

test('does not expose the previous reply while the new response has not started', () => {
  const oldReadyPane = [
    '● 这是克劳德上一轮的回复',
    '❯',
    'accept edits on · shift+tab to cycle',
  ].join('\n');
  const lifecycle = advanceTerminalTurnLifecycle(undefined, { idle: true });

  assert.deepEqual(lifecycle, { responseStarted: false, settled: false });
  const fallback = lifecycle.settled
    ? hooks.extractAssistantFromTerminalPane(oldReadyPane, oldReadyPane, '本轮新消息')
    : '';
  assert.equal(fallback, '');
});

test('opens pane fallback only after this turn leaves and returns to the ready composer', () => {
  let lifecycle = advanceTerminalTurnLifecycle(undefined, { idle: true });
  lifecycle = advanceTerminalTurnLifecycle(lifecycle, { idle: false });
  assert.deepEqual(lifecycle, { responseStarted: true, settled: false });
  lifecycle = advanceTerminalTurnLifecycle(lifecycle, { idle: true });
  assert.deepEqual(lifecycle, { responseStarted: true, settled: true });
});

test('successful submit lets an instant reply settle even when no busy frame was sampled', () => {
  let lifecycle = advanceTerminalTurnLifecycle(undefined, { submitted: true });
  assert.deepEqual(lifecycle, { responseStarted: true, settled: false });
  lifecycle = advanceTerminalTurnLifecycle(lifecycle, { idle: true });
  assert.deepEqual(lifecycle, { responseStarted: true, settled: true });
});
