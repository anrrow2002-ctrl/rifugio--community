const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rifugio-transcript-'));
process.env.CLAUDE_TRANSCRIPT_ROOT = root;
const { createTerminalChat } = require('../modules/terminal-chat');
const hooks = createTerminalChat({ get(){}, post(){} }, {}).__test;
const line = (role, text, stop) => JSON.stringify({ type:role, timestamp:new Date().toISOString(), message:{ role, content:[{type:'text',text}], ...(stop ? {stop_reason:stop}: {}) } }) + '\n';

test('reads only the assistant reply after this turn user boundary', () => {
  const file = path.join(root, 'one.jsonl');
  fs.writeFileSync(file, line('user','旧问题') + line('assistant','旧回复','end_turn'));
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, line('user','新问题') + line('assistant','工具前说明') + JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',name:'Read'}],stop_reason:'tool_use'}})+'\n' + line('assistant','工具后结论','end_turn'));
  const got = hooks.extractAssistantFromTranscript(file,{offset,userPrompt:'新问题',fullPrompt:'新问题',turnStartMs:0},'新问题');
  assert.equal(got.userFound,true); assert.equal(got.final,true); assert.match(got.text,/工具前说明/); assert.match(got.text,/工具后结论/); assert.doesNotMatch(got.text,/旧回复/);
});

test('rejects rotated transcript and pane with no new reply', () => {
  const file = path.join(root, 'rotated.jsonl'); fs.writeFileSync(file,line('user','x'));
  const got = hooks.extractAssistantFromTranscript(file,{offset:999,userPrompt:'x'},'x');
  assert.equal(got.rotated,true); assert.equal(got.text,'');
  assert.equal(hooks.extractAssistantFromTerminalPane('上一颗回复','上一颗回复','新问题'),'');
});

test('candidate requires send-time EOF snapshot and matching current user', () => {
  const file = path.join(root, 'candidate.jsonl'); fs.writeFileSync(file,line('assistant','旧回复','end_turn'));
  const snapshot = new Map([[file,{size:fs.statSync(file).size,mtimeMs:Date.now()}]]);
  fs.appendFileSync(file,line('user','本轮')+line('assistant','本轮回复','end_turn'));
  const cand = hooks.transcriptCandidateFromPath(file,snapshot,'本轮','本轮',0,'active-fd');
  assert.equal(cand.offset,snapshot.get(file).size); assert.equal(cand.userFound,true);
  assert.equal(hooks.transcriptCandidateFromPath(file,new Map(),'本轮','本轮',0,'active-fd'),null);
});

test('pane fallback never exposes previous assistant text or the submitted user echo', () => {
  const before = [
    '● 上一轮 Claude 回复',
    '',
    '❯',
    'accept edits on · shift+tab to cycle',
  ].join('\n');
  const submittedOnly = [
    '● 上一轮 Claude 回复',
    '',
    '❯ [time: now]',
    '',
    '  这是本轮用户文字',
    '',
    'accept edits on · shift+tab to cycle',
  ].join('\n');
  assert.equal(hooks.extractAssistantFromTerminalPane(before, submittedOnly, '[time: now]\n这是本轮用户文字'), '');

  const replied = [
    submittedOnly,
    '',
    '● 这是本轮 Claude 回复',
    '',
    '❯',
    'accept edits on · shift+tab to cycle',
  ].join('\n');
  const got = hooks.extractAssistantFromTerminalPane(before, replied, '[time: now]\n这是本轮用户文字');
  assert.match(got, /这是本轮 Claude 回复/);
  assert.doesNotMatch(got, /上一轮 Claude 回复|这是本轮用户文字/);
});
