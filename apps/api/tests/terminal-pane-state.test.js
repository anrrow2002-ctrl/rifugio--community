'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalPaneHasReadyComposer } = require('../modules/terminal-chat');

test('ready composer closes the previous turn even when the next message is being typed', () => {
  const pane = [
    '❯ 前端卡住了，一直显示你在回复中，在调用工具！',
    '● 没有在调工具，已经回复完了。',
    '✻ Brewed for 4s',
    '────────────────────────────────────────',
    '❯\u00a0你先去',
    '────────────────────────────────────────',
    '⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(terminalPaneHasReadyComposer(pane), true);
});

test('empty ready composer is settled', () => {
  const pane = [
    '● 回复完成',
    '❯',
    '⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
  assert.equal(terminalPaneHasReadyComposer(pane), true);
});

test('active tool output is not a ready composer', () => {
  const pane = [
    '● Bash(curl http://localhost/example)',
    '✻ Thinking…',
    'Esc to interrupt',
  ].join('\n');
  assert.equal(terminalPaneHasReadyComposer(pane), false);
});

test('permission selection is not mistaken for the chat composer', () => {
  const pane = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '2. No',
    'Esc to cancel',
  ].join('\n');
  assert.equal(terminalPaneHasReadyComposer(pane), false);
});
