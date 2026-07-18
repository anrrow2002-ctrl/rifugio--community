'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// A ready Claude composer means the previous turn is over, even when the user
// has already started typing the next message. Only inspect the live footer;
// scrollback may contain arbitrary words such as "Bash", "MCP", or "调用工具".
function terminalPaneHasReadyComposer(text) {
  const clean = String(text || '').replace(/[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n').map(line => line.trim()).filter(Boolean).slice(-14);
  const tail = lines.join('\n');
  const hasReadyFooter = /accept edits on|for shortcuts|shift\+tab to cycle|← for agents|\/effort/i.test(tail);
  if (!hasReadyFooter) return false;
  return lines.some(line =>
    /^❯(?:\s|\u00a0|$)/u.test(line)
    && !/^❯\s*[1-9][.)]\s*(?:Yes|No|Allow|Deny)\b/i.test(line)
  );
}

function advanceTerminalTurnLifecycle(state = {}, observation = {}) {
  // A successful submit is the authoritative start boundary. Requiring a later
  // poll to witness the busy frame races with fast replies: Claude can leave and
  // return to the ready composer between two 650ms polls. Transcript activity or
  // a visibly busy pane remain valid secondary proofs.
  const responseStarted = Boolean(
    state.responseStarted
    || observation.submitted === true
    || observation.assistantActivity
    || observation.idle === false
  );
  return { responseStarted, settled: Boolean(responseStarted && observation.idle === true) };
}

function terminalTranscriptPreviewMaySettle(toolSeen, finalByStopReason) {
  return Boolean(finalByStopReason || !toolSeen);
}

function createTerminalChat(app, deps = {}) {
  const {
    DB_PATH,
    writeJsonStateAtomic,
    resolveCliModel,
    resolveThinkBudget,
    sseHead,
    hasTerminalAuth,
    openLedgerDb,
    appendClaudeConversationMessages,
    recordClaudeHandoffSummary,
    getLLMConfig,
    promptWithImages,
    profileInjectionPlan,
    crossSurfaceBridgePlan,
    profileBlock,
    frontendDynamicContextBlock,
    resolveCharacterPrompt,
    buildMemoryContext,
    compactContextText,
    buildTerminalFrontendProfileHash,
    buildTerminalProfileCoreHash,
    frontendDynamicContextHash,
    buildTerminalProfileUpdateBootstrap,
    buildTerminalDynamicUpdateBootstrap,
    buildTalkConversationSummary,
    RELAY_MSG_COUNT,
    RELAY_TOTAL_MAX_CHARS,
    logTerminalBootstrapDebug,
    markProfileInjected,
    markFrontendDynamicContextInjected,
    markCrossSurfaceBridgeInjected,
  } = deps;

  // ============================================================
  // TERMINAL CHAT v6 — iMessage 外壳 + 真实交互式 Claude Code 终端
  // 不使用 claude -p；普通轮次只把用户原文 paste 到 interactive `claude`。
  // tmux 只做实时状态/预览；最终回复优先从 Claude Code JSONL transcript 收口。
  // 新 terminal session / 手动接力 / 自动接力 / 资料变更时，才注入 profile/memory/最近聊天。
  // 注意：不抓取隐藏 chain-of-thought；只展示公开可见的 thinking/tool 状态摘要。
  // ============================================================
  const TERMINAL_CHAT_TMUX_SESSION = process.env.RIFUGIO_TERMINAL_CHAT_TMUX_SESSION || 'rifugio-terminal-chat';
  // 当设置了固定 session 名时，所有 conversationId 共用同一个 tmux session，
  // 避免 ttyd max-clients 被耗尽。relay 时只 re-bootstrap 不新建 session。
  const TERMINAL_CHAT_FIXED_SESSION = (process.env.RIFUGIO_TERMINAL_CHAT_FIXED_SESSION || '').trim();
  const TERMINAL_CHAT_CWD = process.env.RIFUGIO_TERMINAL_CHAT_CWD || '/root';
  // ttyd-claude.service 里 ttyd 的命令是 `tmux new-session -A -s ttyd-raw claude`——
  // 「原始终端」看到的就是这个固定 session。快捷键面板要往这里发键，不能走按 conversation_id 算的 terminal-chat session。
  const TERMINAL_RAW_SESSION = process.env.RIFUGIO_TERMINAL_RAW_SESSION || 'ttyd-raw';
  const TERMINAL_CHAT_COMMAND = process.env.RIFUGIO_TERMINAL_CHAT_COMMAND || 'claude';
  const TERMINAL_CHAT_MCP_CONFIG = process.env.RIFUGIO_TERMINAL_CHAT_MCP_CONFIG || require('./community-config').dataPath('mcp-active.json');
  const TERMINAL_CHAT_TAIL_LINES = Math.max(120, Math.min(1200, Number(process.env.RIFUGIO_TERMINAL_CHAT_TAIL_LINES || 420) || 420));
  const TERMINAL_CHAT_MAX_MS = Math.max(20000, Math.min(30 * 60 * 1000, Number(process.env.RIFUGIO_TERMINAL_CHAT_MAX_MS || 15 * 60 * 1000) || 15 * 60 * 1000));
  const TERMINAL_CHAT_IDLE_MS = Math.max(1800, Math.min(30000, Number(process.env.RIFUGIO_TERMINAL_CHAT_IDLE_MS || 6500) || 6500));
  const TERMINAL_CHAT_POLL_MS = Math.max(250, Math.min(1500, Number(process.env.RIFUGIO_TERMINAL_CHAT_POLL_MS || 650) || 650));
  const TERMINAL_CHAT_IDLE_MIN_MS = Math.max(8000, Math.min(120000, Number(process.env.RIFUGIO_TERMINAL_IDLE_MIN_MS || 45000) || 45000));
  const TERMINAL_CHAT_STABLE_FINAL_MS = Math.max(3500, Math.min(30000, Number(process.env.RIFUGIO_TERMINAL_STABLE_FINAL_MS || 9000) || 9000));
  const TERMINAL_CHAT_FAST_FINAL_MS = Math.max(1200, Math.min(10000, Number(process.env.RIFUGIO_TERMINAL_FAST_FINAL_MS || 2600) || 2600));
  const terminalPermissionActionsInFlight = new Map();
  const terminalTurnRuns = new Map();
  const terminalLatestTurnByConversation = new Map();
  const TERMINAL_TURN_CACHE_TTL_MS = 20 * 60 * 1000;
  function pruneTerminalTurnRuns() {
    const cutoff = Date.now() - TERMINAL_TURN_CACHE_TTL_MS;
    for (const [key, run] of terminalTurnRuns) {
      if (Number(run.updatedAt || run.createdAt || 0) < cutoff) terminalTurnRuns.delete(key);
    }
    for (const [conversationId, key] of terminalLatestTurnByConversation) {
      if (!terminalTurnRuns.has(key)) terminalLatestTurnByConversation.delete(conversationId);
    }
  }
  function createTerminalTurnRun(conversationId, turnId) {
    pruneTerminalTurnRuns();
    const key = `${conversationId}:${turnId}`;
    const run = { key, conversationId, turnId, createdAt:Date.now(), updatedAt:Date.now(), done:false, events:[] };
    terminalTurnRuns.set(key, run);
    terminalLatestTurnByConversation.set(conversationId, key);
    return run;
  }
  const TERMINAL_CHAT_STATE_PATH = process.env.RIFUGIO_TERMINAL_CHAT_STATE_PATH || require('./community-config').dataPath('terminal-chat-state.json');
  const TERMINAL_CHAT_RELAY_FILE = process.env.RIFUGIO_TERMINAL_RELAY_FILE || require('./community-config').dataPath('relay', 'relay.txt');
  const TERMINAL_CHAT_RELAY_WRITER = process.env.RIFUGIO_TERMINAL_RELAY_WRITER || path.join(__dirname, '..', 'scripts', 'write-terminal-relay.sh');
  const TERMINAL_CHAT_RELAY_TRIGGER_CHARS = Math.max(1000, Math.min(500000, Number(process.env.RIFUGIO_TERMINAL_RELAY_TRIGGER_CHARS || 50000) || 50000));
  const TERMINAL_CHAT_CLAUDE_HIDDEN_CONTEXT_CHARS = Math.max(0, Math.min(500000, Number(process.env.RIFUGIO_TERMINAL_CLAUDE_HIDDEN_CONTEXT_CHARS || 45000) || 0));
  // relay/bootstrap 要带最近 100 轮原文；按 user+assistant 共 200 条消息保存。
  const TERMINAL_CHAT_RELAY_RECENT_MESSAGES = Math.max(20, Math.min(400, Number(process.env.RIFUGIO_TERMINAL_RELAY_RECENT_MESSAGES || 200) || 200));
  const TERMINAL_CHAT_HISTORY_LIMIT = Math.max(40, Math.min(2000, Number(process.env.RIFUGIO_TERMINAL_HISTORY_LIMIT || 1200) || 1200));
  const TERMINAL_CHAT_BOOTSTRAP_RECENT = Math.max(12, Math.min(240, Number(process.env.RIFUGIO_TERMINAL_BOOTSTRAP_RECENT || 64) || 64));

  function terminalLogicalSessionName(conversationId = '', relayIndex = 0) {
    const raw = String(conversationId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 42);
    const base = raw ? `${TERMINAL_CHAT_TMUX_SESSION}-${raw}` : TERMINAL_CHAT_TMUX_SESSION;
    const n = Number(relayIndex || 0);
    return n > 0 ? `${base}-r${n}` : base;
  }
  function terminalSessionName(conversationId = '', relayIndex = 0) {
    // 固定 session 模式：所有对话共用同一个 tmux session，避免 ttyd 坑位耗尽。
    // Claude 上下文段落仍由 terminalLogicalSessionName()/relay_index 表示。
    if (TERMINAL_CHAT_FIXED_SESSION) return TERMINAL_CHAT_FIXED_SESSION;
    return terminalLogicalSessionName(conversationId, 0);
  }
  function terminalTmuxSessionName(conversationId = '', rec = {}) {
    if (TERMINAL_CHAT_FIXED_SESSION) return TERMINAL_CHAT_FIXED_SESSION;
    const base = terminalLogicalSessionName(conversationId, 0);
    const existing = String(rec?.tmux_session || '').trim();
    if (existing && existing === base) return existing;
    return base;
  }
  function terminalReadState() {
    try { return JSON.parse(fs.readFileSync(TERMINAL_CHAT_STATE_PATH, 'utf8')); }
    catch (_) { return { conversations: {} }; }
  }
  function terminalWriteState(st) {
    try { writeJsonStateAtomic(TERMINAL_CHAT_STATE_PATH, st); } catch (_) {}
  }
  function terminalStateFor(conversationId) {
    const st = terminalReadState();
    const key = String(conversationId || 'default');
    st.conversations[key] = st.conversations[key] || { relay_index: 0, turns_since_relay: 0, messages: [] };
    const rec = st.conversations[key];
    const beforeSync = JSON.stringify({
      tmux_session: rec.tmux_session,
      active_session: rec.active_session,
      session: rec.session,
      context_chars_since_relay: rec.context_chars_since_relay,
      context_chars_last_reason: rec.context_chars_last_reason,
      relay_trigger: rec.relay_trigger,
      relay_reason: rec.relay_reason,
      relay_total_chars: rec.relay_total_chars,
      effective_context_chars: rec.effective_context_chars,
    });
    if (!Array.isArray(rec.messages)) rec.messages = [];
    if (!Number.isFinite(Number(rec.relay_index))) rec.relay_index = 0;
    if (!Number.isFinite(Number(rec.turns_since_relay))) rec.turns_since_relay = 0;
    const tmuxSession = terminalTmuxSessionName(key, rec);
    const logicalSession = terminalLogicalSessionName(key, rec.relay_index || 0);
    rec.tmux_session = tmuxSession;
    rec.active_session = logicalSession;
    rec.session = logicalSession;
    if (
      !rec.relay_pending &&
      Number(rec.turns_since_relay || 0) === 0 &&
      Number(rec.context_chars_since_relay || 0) > 0 &&
      /^relay_(bootstrap_completed|clear_after_summary)$/.test(String(rec.context_chars_last_reason || ''))
    ) {
      resetTerminalChatContextCounter(rec, 'state_recalibrated_after_relay_reset');
    }
    ensureTerminalChatContextCounter(rec);
    refreshTerminalRelayTrigger(rec);
    const afterSync = JSON.stringify({
      tmux_session: rec.tmux_session,
      active_session: rec.active_session,
      session: rec.session,
      context_chars_since_relay: rec.context_chars_since_relay,
      context_chars_last_reason: rec.context_chars_last_reason,
      relay_trigger: rec.relay_trigger,
      relay_reason: rec.relay_reason,
      relay_total_chars: rec.relay_total_chars,
      effective_context_chars: rec.effective_context_chars,
    });
    if (afterSync !== beforeSync) terminalWriteState(st);
    return { st, key, rec };
  }
  function terminalActiveSessionName(key, rec) {
    // tmux 操作用承载 session；逻辑 Claude session 见 rec.active_session。
    return terminalTmuxSessionName(key, rec);
  }
  function runCmd(file, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: opts.timeout || 8000, cwd: opts.cwd || TERMINAL_CHAT_CWD, env: process.env });
      let out = '', err = '';
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve({ out, err, code });
        else {
          const e = new Error(`${file} ${args.join(' ')} exited ${code}: ${(err || out).slice(0, 500)}`);
          e.code = code; e.stdout = out; e.stderr = err;
          reject(e);
        }
      });
      if (opts.input != null) { child.stdin.write(String(opts.input)); child.stdin.end(); }
      else child.stdin.end();
    });
  }
  async function tmux(args, opts = {}) { return runCmd('tmux', args, opts); }
  function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
  }
  function terminalChatCommandForModel(model, effort) {
    const base = String(TERMINAL_CHAT_COMMAND || 'claude').trim() || 'claude';
    const rawModel = String(model || '').trim();
    let cmd = base;
    if (rawModel && rawModel !== 'default' && !/\s--model(?:=|\s)/.test(base)) {
      cmd = `${base} --model ${shellQuote(resolveCliModel(rawModel))}`;
    }
    // Terminal 必须与 PWA 普通聊天使用同一份动态 MCP；strict 避免账号级旧 Rifugio 重复注入。
    if (TERMINAL_CHAT_MCP_CONFIG && !/\s--mcp-config(?:=|\s)/.test(base)) {
      cmd = `${cmd} --mcp-config ${shellQuote(TERMINAL_CHAT_MCP_CONFIG)} --strict-mcp-config`;
    }
    // 与 /api/chat、agent stream 保持一致：预算负责开启 thinking，
    // --thinking-display summarized 强制 Claude Code 把可展示摘要写进 JSONL。
    // 只传 MAX_THINKING_TOKENS 时模型会偶发直接产出 text、完全没有 thinking 块，
    // terminal transcript 抓取层因此只能得到空 thinking。
    const effortNow = String(effort || 'high').trim().toLowerCase();
    const effortCli = ({ low:'low', medium:'medium', high:'high', max:'max' })[effortNow] || 'high';
    const budget = resolveThinkBudget(effortCli);
    if (!/\s--effort(?:=|\s)/.test(base)) cmd = `${cmd} --effort ${effortCli}`;
    if (budget) {
      if (!/\s--thinking-display(?:=|\s)/.test(base)) cmd = `${cmd} --thinking-display summarized`;
      cmd = `env MAX_THINKING_TOKENS=${budget} ${cmd}`;
    }
    return cmd;
  }
  async function ensureTerminalChatSession(sessionName, model, effort) {
    try { await tmux(['has-session', '-t', sessionName], { timeout: 3500 }); return { created: false }; }
    catch (_) {
      const command = terminalChatCommandForModel(model, effort);
      await tmux(['new-session', '-d', '-s', sessionName, '-c', TERMINAL_CHAT_CWD, command], { timeout: 8000 });
      await new Promise(r => setTimeout(r, 2200));
      return { created: true, command };
    }
  }
  async function waitTerminalClaudeReady(sessionName, maxMs = 9000) {
    const start = Date.now();
    let last = '';
    while (Date.now() - start < maxMs) {
      await new Promise(r => setTimeout(r, 550));
      try {
        const tail = await captureTerminalTail(sessionName);
        last = tail;
        // 不能看到启动标题就算 ready：Claude Code 首屏还在初始化时，第一条 /model 会被静默吞掉。
        // 输入框和底部快捷键栏同时出现，才说明 Ink TUI 已真正可接收按键。
        const hasPrompt = /(?:^|\n)\s*[❯>]\s*(?:[^\n]{0,160})?(?:\n|$)/m.test(tail);
        const hasInputFooter = /for shortcuts|accept edits on|manual mode on|← for agents|\/effort/i.test(tail);
        if ((hasPrompt && hasInputFooter) || /Human:\s*$/i.test(tail)) return true;
      } catch (_) {}
    }
    console.warn('[terminal-ready-timeout]', JSON.stringify({ sessionName, tail: String(last || '').slice(-300) }));
    return false;
  }
  async function requireTerminalClaudeReady(sessionName, maxMs = 9000, stage = 'input') {
    if (await waitTerminalClaudeReady(sessionName, maxMs)) return true;
    const err = new Error('Terminal not ready for ' + stage + '; input was not sent');
    err.code = 'TERMINAL_NOT_READY';
    err.stage = stage;
    throw err;
  }
  async function captureTerminalTail(sessionName) {
    const r = await tmux(['capture-pane', '-t', sessionName, '-p', '-S', `-${TERMINAL_CHAT_TAIL_LINES}`], { timeout: 6000 });
    return stripAnsi(r.out || '').replace(/\r/g, '');
  }
  function terminalCurrentComposer(text) {
    const t = stripAnsi(text || '').replace(/\r/g, '');
    // 只看最后一个 Claude 输入框；历史消息里的 [Pasted text #…] 不能算“当前未提交”。
    const markers = ['\n❯', '\n>'];
    let start = -1;
    for (const marker of markers) start = Math.max(start, t.lastIndexOf(marker));
    return start >= 0 ? t.slice(start) : t.split('\n').slice(-24).join('\n');
  }
  function terminalPaneHasUnsubmittedPaste(text) {
    const composer = terminalCurrentComposer(text);
    return /\[Pasted text #\d+[^\]]*\]/i.test(composer)
      && /(accept edits|shift\+tab|⏵|⏴)/i.test(composer)
      && !/(?:^|\n)\s*[●✻]\s/m.test(composer);
  }
  async function settleTerminalPaste(sessionName, text = '') {
    const raw = String(text || '');
    const chars = raw.length;
    const lines = raw.split('\n').length;
    // Claude Code 处理多行 bracketed paste 比纯文字慢；图片 prompt 会额外包含多条本机路径。
    const delay = Math.min(2800, Math.max(220, Math.round(chars / 5) + lines * 55));
    await new Promise(r => setTimeout(r, delay));
    for (let attempt = 0; attempt < 6; attempt++) {
      await tmux(['send-keys', '-t', sessionName, 'Enter'], { timeout: 4000 });
      await new Promise(r => setTimeout(r, 420 + attempt * 140));
      const tail = await captureTerminalTail(sessionName).catch(() => '');
      if (!terminalPaneHasUnsubmittedPaste(tail)) return { submitted:true, attempts:attempt + 1 };
    }
    return { submitted:false, attempts:6 };
  }
  async function pasteTerminalRawText(sessionName, text, opts = {}) {
    const buf = `rifugio_${crypto.randomBytes(4).toString('hex')}`;
    await tmux(['load-buffer', '-b', buf, '-'], { input: String(text || ''), timeout: 10000 });
    await tmux(['paste-buffer', '-b', buf, '-t', sessionName, '-p'], { timeout: 8000 });
    await tmux(['delete-buffer', '-b', buf], { timeout: 3000 }).catch(() => {});
    if (opts.enter !== false) return settleTerminalPaste(sessionName, text);
    return { submitted:false, attempts:0 };
  }
  async function pasteTerminalText(sessionName, text) {
    return pasteTerminalRawText(sessionName, text, { enter: true });
  }
  async function sendTerminalShortcutToTmux(sessionName, key) {
    const k = String(key || '').toLowerCase();
    const map = {
      'ctrl-c': ['C-c'], 'ctrl-d': ['C-d'], 'ctrl-l': ['C-l'], 'ctrl-o': ['C-o'], 'ctrl-r': ['C-r'],
      'ctrl-t': ['C-t'], 'ctrl-b': ['C-b'], 'ctrl-a': ['C-a'], 'ctrl-e': ['C-e'], 'ctrl-k': ['C-k'],
      'ctrl-u': ['C-u'], 'ctrl-w': ['C-w'], 'ctrl-y': ['C-y'], 'ctrl-n': ['C-n'], 'ctrl-p': ['C-p'],
      'ctrl-g': ['C-g'], 'ctrl-j': ['C-j'], 'ctrl-x-ctrl-e': ['C-x','C-e'], 'ctrl-x-ctrl-k': ['C-x','C-k'],
      'tab': ['Tab'], 'shift-tab': ['BTab'], 'esc': ['Escape'], 'esc-esc': ['Escape','Escape'],
      'up': ['Up'], 'down': ['Down'], 'left': ['Left'], 'right': ['Right'],
      'home': ['Home'], 'end': ['End'], 'page-up': ['PageUp'], 'page-down': ['PageDown'],
      'backspace': ['BSpace'], 'delete': ['DC'], 'enter': ['Enter'], 'space': ['Space'],
      'slash': ['/'], 'question': ['?'], 'at': ['@'], 'bang': ['!']
    };
    const keys = map[k];
    if (!keys) throw new Error('unsupported shortcut');
    await ensureTerminalChatSession(sessionName);
    await tmux(['send-keys', '-t', sessionName, ...keys], { timeout: 5000 });
  }
  function stripAnsi(s) {
    return String(s || '').replace(/[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  }
  function commonPrefixLen(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; }
  function terminalDelta(before, after) {
    if (!before) return after;
    if (after.startsWith(before)) return after.slice(before.length);
    const anchor = before.slice(Math.max(0, before.length - 1200));
    const pos = after.indexOf(anchor);
    if (pos >= 0) return after.slice(pos + anchor.length);
    const cp = commonPrefixLen(before, after);
    if (cp > 200) return after.slice(cp);
    return after.split('\n').slice(-80).join('\n');
  }
  // Claude Code showing its ready composer means the prior turn is complete.
  // A non-empty composer is the user drafting the next turn, not Claude being busy.
  function terminalPaneIsIdle(text) {
    const t = stripAnsi(text || '').replace(/\r/g, '');
    if (terminalPaneHasUnsubmittedPaste(t)) return false;
    const lines = t.split('\n').map(line => line.trim()).filter(Boolean).slice(-14);
    if (lines.some(line => /^❯\s*$/.test(line))) return true;
    return terminalPaneHasReadyComposer(t);
  }
  function classifyTerminalStatus(text) {
    const t = String(text || '');
    if (terminalPaneIsIdle(t)) return [];
    const out = [];
    if (terminalPaneHasUnsubmittedPaste(t)) out.push({ type: 'input', label: 'Terminal 输入框里有粘贴内容，正在提交' });
    if (/\b(Bash|Read|Write|Edit|MultiEdit|Grep|Glob|LS|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit)\b|mcp__/i.test(t)) out.push({ type: 'tool', label: 'Claude Code 正在调用工具 / MCP' });
    const thought = t.match(/Thought for\s+([^\n(]{1,40})/i) || t.match(/Cogitated for\s+([^\n(]{1,40})/i);
    // thought_done = 已完成状态，不触发 busyVisible；thinking = 进行中
    if (thought) out.push({ type: 'thought_done', label: `Claude 已思考 ${String(thought[1] || '').trim()}` });
    else if (/thinking|思考|Thinking|✻|✽|✳|✶|· · ·|…|Cogitating/i.test(t)) out.push({ type: 'thinking', label: 'Claude 正在思考' });
    if (hasTerminalPermissionPrompt(t)) out.push({ type: 'permission', label: '终端正在等待权限确认' });
    return out.slice(0, 4);
  }
  function terminalCompactText(value, max = 1200) {
    return String(value || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
  }
  function mergeTranscriptText(previous, incoming, max = 12000) {
    const a = String(previous || '').trim();
    const b = String(incoming || '').trim();
    if (!b || a === b || a.endsWith(b)) return terminalCompactText(a, max);
    if (!a || b.startsWith(a)) return terminalCompactText(b, max);
    const cap = Math.min(a.length, b.length, 2000);
    let overlap = 0;
    for (let n = cap; n >= 1; n--) {
      if (a.slice(-n) === b.slice(0, n)) { overlap = n; break; }
    }
    return terminalCompactText(a + (overlap ? '' : '\n') + b.slice(overlap), max);
  }

  function isTerminalPermissionLine(line) {
    const t = stripAnsi(line || '').trim();
    if (!t) return false;
    return /Do you want to proceed\?/i.test(t) ||
      /Yes,\s*and\s*don't\s*ask\s*again|No,\s*and\s*tell\s*Claude/i.test(t) ||
      /^\s*(?:❯\s*)?[123][.)]?\s*(?:Yes|Allow|No|Deny)\b/i.test(t) ||
      /\b(?:Allow|Deny)\b.{0,120}\b(?:Bash|Read|Write|Edit|MultiEdit|WebFetch|WebSearch|NotebookEdit|mcp__|tool|command)\b/i.test(t) ||
      /是否允许.{0,80}(?:执行|运行|读取|写入|修改|调用|工具|命令)/.test(t);
  }

  function hasTerminalPermissionPrompt(text) {
    const raw = stripAnsi(text || '').replace(/\r/g, '');
    if (!raw || terminalPaneIsIdle(raw)) return false;
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.some(isTerminalPermissionLine);
  }

  // 弹窗选项不是固定三个：Bash 命令没法泛化时只有 "1. Yes / 2. No"，此时盲发 '2'（总是允许的旧映射）
  // 会正好按中 No → 工具被拒绝+整轮中断（2026-07-11 bug#16 实锤）。必须从 pane 里解析真实选项。
  function parseTerminalPermissionOptions(lines) {
    const matches = [];
    for (const line of lines.slice(-30)) {
      const m = line.match(/^(?:❯\s*)?(\d)[.)]\s+(.+)$/);
      if (m) matches.push({ digit: m[1], label: m[2].trim().slice(0, 160) });
    }
    // 选项总是从 1 开始连续编号；取最后一组，避免把正文里的编号列表当选项。
    let group = [];
    for (const m of matches) {
      if (m.digit === '1') group = [m];
      else if (group.length && Number(m.digit) === Number(group[group.length - 1].digit) + 1) group.push(m);
    }
    return group;
  }
  function permissionOptionRole(label) {
    const t = String(label || '').toLowerCase();
    if (/don't ask again|always|不再询问|总是/.test(t)) return 'always';
    if (/^(?:no|deny)\b|tell claude|拒绝/.test(t)) return 'deny';
    if (/^(?:yes|allow|proceed)\b|允许/.test(t)) return 'allow';
    return '';
  }
  function detectTerminalPermissionPrompt(text) {
    const raw = stripAnsi(text || '').replace(/\r/g, '');
    if (!hasTerminalPermissionPrompt(raw)) return null;
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isTerminalPermissionLine(lines[i])) { idx = i; break; }
    }
    const start = Math.max(0, idx < 0 ? lines.length - 8 : idx - 3);
    const windowLines = lines.slice(start, start + 14);
    const prompt = windowLines.slice(0, 10).join('\n').slice(-1800);
    const options = parseTerminalPermissionOptions(lines);
    // id 只对稳定内容做 hash：spinner/计时/token 行每秒都变，混进去会导致同一个弹窗每次轮询 id 都不同 → 前端回传必 409。
    const stableLines = windowLines.filter(l => !/^[✢✻✽◐✳✶✱✲·∗~]|\(esc to interrupt|for \d+s\b|↓?\s*[\d.]+k?\s*tokens\b/i.test(l));
    const idSource = options.length
      ? options.map(o => o.digit + o.label).join('|') + '::' + stableLines.slice(0, 4).join('\n')
      : (stableLines.join('\n') || raw.slice(-1800));
    const roleDigits = {};
    for (const o of options) {
      const role = permissionOptionRole(o.label);
      if (role && !roleDigits[role]) roleDigits[role] = o.digit;
    }
    const actions = options.length
      ? options.map(o => ({ id: `opt-${o.digit}`, digit: o.digit, role: permissionOptionRole(o.label), label: `${o.digit}. ${o.label}` }))
      : [
          { id: 'allow', role: 'allow', label: '允许一次' },
          { id: 'deny', role: 'deny', label: '拒绝' },
          { id: 'enter', role: '', label: '按 Enter' },
          { id: 'esc', role: '', label: 'Esc' },
        ];
    return {
      id: crypto.createHash('sha1').update(idSource).digest('hex').slice(0, 16),
      prompt: prompt || raw.slice(-1200),
      options,
      roleDigits,
      actions,
    };
  }

  // action 可以是语义名(allow/always/deny)或 opt-N(前端按真实选项点的)。数字键在对话框里会直接确认，
  // 不再补发 Enter——以前 '2'+Enter 的组合在两选项弹窗上等于按 No 再多敲一下（bug#16）。
  function resolvePermissionKeys(action, prompt) {
    const a = String(action || '').toLowerCase();
    const roleDigits = prompt?.roleDigits || {};
    const digits = new Set((prompt?.options || []).map(o => o.digit));
    const optMatch = a.match(/^opt-(\d)$/);
    if (optMatch) {
      if (digits.size && !digits.has(optMatch[1])) return null; // 弹窗已换，别按错
      return [optMatch[1]];
    }
    if (a === 'allow' || a === 'yes') return [roleDigits.allow || '1'];
    if (a === 'always' || a === 'allow_always') {
      // 没有 "don't ask again" 选项的弹窗（两选项 Bash），退化成允许一次，绝不能盲按 '2'。
      return [roleDigits.always || roleDigits.allow || '1'];
    }
    if (a === 'deny' || a === 'no') return roleDigits.deny ? [roleDigits.deny] : ['Escape'];
    if (a === 'enter') return ['Enter'];
    if (a === 'esc' || a === 'escape') return ['Escape'];
    return null;
  }
  async function sendTerminalPermissionAction(sessionName, action, prompt = null) {
    const keys = resolvePermissionKeys(action, prompt);
    if (!keys) throw new Error('unsupported permission action');
    await ensureTerminalChatSession(sessionName);
    await tmux(['send-keys', '-t', sessionName, ...keys], { timeout: 5000 });
    return keys;
  }


  const CLAUDE_TRANSCRIPT_ROOT = process.env.CLAUDE_TRANSCRIPT_ROOT || path.join(process.env.HOME || '/root', '.claude', 'projects');
  const TERMINAL_TRANSCRIPT_SCAN_LIMIT = Math.max(20, Math.min(300, Number(process.env.RIFUGIO_TERMINAL_TRANSCRIPT_SCAN_LIMIT || 100) || 100));
  const TERMINAL_TRANSCRIPT_WINDOW_BYTES = Math.max(256 * 1024, Math.min(16 * 1024 * 1024, Number(process.env.RIFUGIO_TERMINAL_TRANSCRIPT_WINDOW_BYTES || 4 * 1024 * 1024) || 4 * 1024 * 1024));

  function normalizeTranscriptText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function transcriptNeedle(value) {
    const t = normalizeTranscriptText(value);
    if (!t) return '';
    if (t.length <= 180) return t;
    return t.slice(0, 120);
  }
  function statMaybe(file) {
    try { return fs.statSync(file); } catch (_) { return null; }
  }
  function listClaudeTranscriptFiles(root = CLAUDE_TRANSCRIPT_ROOT, limit = TERMINAL_TRANSCRIPT_SCAN_LIMIT) {
    const out = [];
    const stack = [{ dir: root, depth: 0 }];
    const maxDepth = 5;
    const hardLimit = 5000;
    while (stack.length && out.length < hardLimit) {
      const item = stack.pop();
      let rows = [];
      try { rows = fs.readdirSync(item.dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of rows) {
        const fp = path.join(item.dir, ent.name);
        if (ent.isDirectory()) {
          if (item.depth < maxDepth && ent.name !== 'node_modules' && ent.name !== '.git') stack.push({ dir: fp, depth: item.depth + 1 });
        } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          const st = statMaybe(fp);
          if (st) out.push({ path: fp, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  }
  function snapshotClaudeTranscripts() {
    const map = new Map();
    for (const f of listClaudeTranscriptFiles()) map.set(f.path, { size: f.size, mtimeMs: f.mtimeMs });
    return map;
  }
  function readJsonlWindow(file, startOffset = 0, maxBytes = TERMINAL_TRANSCRIPT_WINDOW_BYTES) {
    const st = statMaybe(file);
    if (!st || !st.isFile()) return { events: [], size: 0, readStart: 0 };
    let readStart = Math.max(0, Math.min(Number(startOffset || 0), st.size));
    if (st.size - readStart > maxBytes) readStart = Math.max(0, st.size - maxBytes);
    // 本地修复（不在 GPT 包内，出新包需重打）：从 readStart 前 1 字节物理读起，
    // 让 split 后第一段必为「边界碎片」（上一行换行符→空串，或被截断的半行），
    // 下面无条件 shift 掉它永远安全。否则当快照 size 恰好落在行边界（Claude Code
    // 每条事件都是整行+\n 写入，几乎总是如此），原来的无条件 shift 会把第一条完整
    // 事件整条吃掉，污染 mtime-scan 兜底路径的 user 匹配。
    const physStart = readStart > 0 ? readStart - 1 : 0;
    const len = Math.max(0, st.size - physStart);
    if (!len) return { events: [], size: st.size, readStart };
    const fd = fs.openSync(file, 'r');
    let text = '';
    try {
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, physStart);
      text = buf.toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
    }
    let lines = text.split(/\r?\n/);
    if (readStart > 0) lines.shift(); // 丢弃边界碎片（空串或半行）；整行事件不受影响。
    const events = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try { events.push(JSON.parse(t)); } catch (_) {}
    }
    return { events, size: st.size, readStart };
  }
  function transcriptEventTimeMs(ev) {
    const raw = ev?.timestamp || ev?.created_at || ev?.createdAt || ev?.message?.timestamp || '';
    const ms = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ms) ? ms : 0;
  }
  function transcriptRole(ev) {
    return ev?.type || ev?.message?.role || ev?.role || '';
  }
  function isTranscriptUserEvent(ev) {
    const role = transcriptRole(ev);
    return role === 'user' || ev?.message?.role === 'user';
  }
  function isTranscriptAssistantEvent(ev) {
    const role = transcriptRole(ev);
    return role === 'assistant' || ev?.message?.role === 'assistant';
  }
  function transcriptContentToText(content, opts = {}) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    const pieces = [];
    const visit = (node) => {
      if (node == null) return;
      if (typeof node === 'string') { if (opts.allowString !== false) pieces.push(node); return; }
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node !== 'object') return;
      const type = String(node.type || '').toLowerCase();
      if (type === 'text') { if (node.text) pieces.push(String(node.text)); return; }
      if (type === 'tool_use' || type === 'tool_result' || type === 'thinking' || type === 'redacted_thinking' || type === 'input_json_delta' || type === 'server_tool_use' || type === 'web_search_tool_result') return;
      if (typeof node.text === 'string' && !type) pieces.push(node.text);
      else if (typeof node.content === 'string' && !/tool|thinking|image|system|meta/.test(type)) pieces.push(node.content);
    };
    visit(content);
    return pieces.join('\n').trim();
  }
  function transcriptThinkingToText(content) {
    const pieces = [];
    const visit = (node) => {
      if (node == null) return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node !== 'object') return;
      const type = String(node.type || '').toLowerCase();
      if (type === 'thinking' || type === 'thinking_delta' || type === 'summary') {
        const text = node.thinking || node.summary || node.text || '';
        if (text) pieces.push(String(text));
      }
      if (Array.isArray(node.content)) visit(node.content);
    };
    visit(content);
    return terminalCompactText(pieces.join('\n'), 12000);
  }
  function transcriptEventThinkingText(ev) {
    const msg = ev?.message || ev;
    return transcriptThinkingToText(msg?.content);
  }
  function transcriptEventToolNames(ev) {
    const msg = ev?.message || ev;
    const content = msg?.content;
    const names = new Set();
    const stack = Array.isArray(content) ? [...content] : [content];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== 'object') continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const type = String(x.type || '').toLowerCase();
      if (type === 'tool_use' || type === 'server_tool_use' || /^mcp/.test(type)) {
        const name = String(x.name || x.tool_name || x.tool || x.id || type || 'tool').trim();
        if (name) names.add(name.slice(0, 80));
      }
      if (Array.isArray(x.content)) stack.push(...x.content);
    }
    return Array.from(names);
  }
  function transcriptEventVisibleText(ev, opts = {}) {
    const msg = ev?.message || ev;
    return transcriptContentToText(msg?.content, opts);
  }
  function transcriptEventHasToolResult(ev) {
    const msg = ev?.message || ev;
    const stack = Array.isArray(msg?.content) ? [...msg.content] : [msg?.content];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== 'object') continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const type = String(x.type || '').toLowerCase();
      if (type === 'tool_result' || type === 'web_search_tool_result' || type === 'server_tool_result') return true;
      if (Array.isArray(x.content)) stack.push(...x.content);
    }
    return false;
  }
  function transcriptEventHasToolUse(ev) {
    const msg = ev?.message || ev;
    const content = msg?.content;
    const stack = Array.isArray(content) ? [...content] : [content];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== 'object') continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const type = String(x.type || '').toLowerCase();
      if (type === 'tool_use' || type === 'server_tool_use' || /^mcp/.test(type)) return true;
      if (Array.isArray(x.content)) stack.push(...x.content);
    }
    return false;
  }
  function transcriptUserMatchesPrompt(ev, userPrompt, fullPrompt = '', turnStartMs = 0) {
    if (!isTranscriptUserEvent(ev)) return false;
    const eventMs = transcriptEventTimeMs(ev);
    if (eventMs && turnStartMs && eventMs < turnStartMs - 2000) return false;
    const text = normalizeTranscriptText(transcriptEventVisibleText(ev, { allowString: true }));
    if (!text) return false;
    const needles = [transcriptNeedle(userPrompt), transcriptNeedle(fullPrompt)].filter(Boolean);
    if (!needles.length) return eventMs ? eventMs >= turnStartMs - 2000 : true;
    return needles.some(n => n.length < 12 ? text.includes(n) : text.includes(n));
  }
  function cleanTranscriptAssistantText(text, rawPrompt = '') {
    let t = stripAnsi(text)
      .replace(/<RIFUGIO_TERMINAL_CONTROL>[\s\S]*?<\/RIFUGIO_TERMINAL_CONTROL>/g, '')
      .replace(/^.*RIFUGIO_TERMINAL_CONTROL.*$/gmi, '')
      .replace(/^.*RIFUGIO_DONE.*$/gmi, '')
      .replace(/\[\?25[hl]/g, '')
      .replace(/\r/g, '')
      .replace(/\x00/g, '');
    const promptLine = String(rawPrompt || '').split(/\n/)[0].trim();
    t = t.split('\n')
      .filter(line => !promptLine || line.trim() !== promptLine)
      .filter(line => !/^\s*(【用户本轮消息】|完成后最后单独输出|不要输出隐藏思维链|Rifugio Terminal Chat 启动\/接力上下文)/.test(line))
      .filter(line => !/^\s*(Bash|Read|Write|Edit|MultiEdit|Grep|Glob|LS|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit)\b/i.test(line))
      .filter(line => !/^\s*(⎿|●|○|✻|✽|✳|✶|✢|✱|✲|\*\s*Cogitated|Cogitated for|Thinking for|Thought for|Esc to interrupt)/i.test(line))
      .filter(line => !/^(\s*\[Using [^\]]+…\]\s*)$/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return t;
  }

  function cleanTerminalPaneAssistantText(text, rawPrompt = '') {
    let t = stripAnsi(text)
      .replace(/\r/g, '')
      .replace(/\x00/g, '')
      .replace(/\[\?25[hl]/g, '');
    const promptLine = String(rawPrompt || '').split(/\n/)[0].trim();
    let lines = t.split('\n');
    // Claude Code interactive UI normally renders the final assistant turn after a visible bullet like "●".
    // For tmux fallback, keep only the last such answer block instead of trying to use the whole pane.
    let bulletIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] || '';
      if (/^\s*[●⏺]\s+/.test(line) && !/^\s*[●⏺]\s*(Bash|Read|Write|Edit|MultiEdit|Grep|Glob|LS|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit)\b/i.test(line)) {
        bulletIdx = i;
        break;
      }
    }
    if (bulletIdx >= 0) {
      lines = lines.slice(bulletIdx);
      // assistant 气泡到下一次 ❯ 用户输入处结束；先截断，不能让续行混进 TTS。
      const nextUserPrompt = lines.findIndex((line, index) =>
        index > 0 && /^\s*[❯>](?:\s|\u00a0|$)/u.test(String(line || ''))
      );
      if (nextUserPrompt > 0) lines = lines.slice(0, nextUserPrompt);
    } else {
      // Last-resort visible-output fallback: take text after the latest "Thought for ..." marker.
      let thoughtIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/\b(Thought for|Thinking|Cogitated for)\b/i.test(lines[i] || '')) { thoughtIdx = i; break; }
      }
      if (thoughtIdx >= 0) lines = lines.slice(thoughtIdx + 1);
    }
    t = lines
      .map(line => String(line || '').replace(/^\s*[●⏺]\s?/, ''))
      .filter(line => !promptLine || line.trim() !== promptLine)
      .filter(line => !/^\s*[❯>].*/.test(line))
      .filter(line => !/^\s*[▎▏│┃].*/.test(line))
      // 纯框线/分隔线（────、━━━、┄┅ 等终端装饰整行），不是正文
      .filter(line => { const s = line.trim(); return !(s && /^[─-╿▁-▟]+$/.test(s)); })
      // 纯思考点行（"· · ·"）
      .filter(line => !/^(?:[·•]\s*){2,}$/.test(line.trim()))
      // Claude Code 启动提示 / 云端广告 / 底部状态条
      .filter(line => !/^\s*Tip:/i.test(line.trim()))
      .filter(line => !/clau\.de|Run tasks in the cloud|control this session from your phone|for shortcuts|for agents/i.test(line))
      .filter(line => !/^\s*(Using\s+.+\s+\(from\s+.+\)|Bypassing Permissions|cwd:|model:)\b/i.test(line.trim()))
      .filter(line => !/^\s*(Thought for|Thinking|Cogitated for|Esc to interrupt|ctrl\+o to expand)\b/i.test(line.trim()))
      .filter(line => !/^\s*(Bash|Read|Write|Edit|MultiEdit|Grep|Glob|LS|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit)\b/i.test(line.trim()))
      // 思考/状态 spinner 行（如 "✢ Skedaddling…"）；旧版用 \b 在 glyph 后匹配不到，改成行首 glyph 直接丢
      .filter(line => !/^[⎿✻✽✳✶✢✱✲◇◆⏳]/.test(line.trim()))
      .join('\n')
      .replace(/^ {1,2}(?=\S)/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // Avoid treating an echoed prompt or empty terminal chrome as a reply.
    if (!t || (promptLine && normalizeTranscriptText(t) === normalizeTranscriptText(promptLine))) return '';
    if (terminalPaneHasUnsubmittedPaste(t) || /\[Pasted text #\d+/i.test(t) || /accept edits|shift\+tab/i.test(t)) return '';
    if (/^(Do you want to proceed|Allow|Proceed|Permissions)/i.test(t)) return '';
    return t;
  }
  function extractAssistantFromTerminalPane(before, after, rawPrompt = '') {
    const cleanBefore = cleanTerminalPaneAssistantText(before, rawPrompt);
    const cleanAfter = cleanTerminalPaneAssistantText(after, rawPrompt);
    // tmux redraw 的 delta 可能同时包含上一轮回复和刚提交的用户文字。
    // pane 兜底只能采纳“最后一颗 Claude 气泡确实变了”的完整快照；
    // 在新 assistant 气泡出现前一律返回空，绝不把历史/用户输入喂给 TTS。
    if (!cleanAfter || normalizeTranscriptText(cleanAfter) === normalizeTranscriptText(cleanBefore)) return '';
    return cleanAfter;
  }

  function extractAssistantFromTranscript(file, marker = {}, rawPrompt = '') {
    if (!file) return { text: '', thinking: '', final: false, interrupted: false, assistantCount: 0, toolCount: 0, toolNames: [], userFound: false, size: 0 };
    const requestedOffset = Math.max(0, Number(marker.offset || 0));
    const fileStat = statMaybe(file);
    if (!fileStat || requestedOffset > fileStat.size) return { text:'', thinking:'', final:false, interrupted:false, assistantCount:0, toolCount:0, toolNames:[], userFound:false, size:fileStat?.size || 0, rotated:true };
    const { events, size } = readJsonlWindow(file, requestedOffset);
    let started = false;
    let userFound = false;
    let lastText = '';
    let lastFinalText = '';
    let thinkingText = '';
    const toolNames = new Set();
    let assistantCount = 0;
    let toolCount = 0;
    let final = false;
    let interrupted = false;
    const textSegments = [];
    let pendingToolSinceText = false;
    for (const ev of events) {
      if (!started && transcriptUserMatchesPrompt(ev, marker.userPrompt || rawPrompt, marker.fullPrompt || '', marker.turnStartMs || 0)) {
        started = true;
        userFound = true;
        continue;
      }
      if (!started) continue;
      // 同一固定 tmux 可能紧接着收到主动消息/另一前端请求。遇到下一条真实用户消息必须收口，
      // 但 tool_result 在 JSONL 里也使用 user role，不能把工具结果误当成下一轮边界。
      if (isTranscriptUserEvent(ev) && !transcriptEventHasToolResult(ev)) {
        // 工具被拒绝/Esc 中断时 CC 写 "[Request interrupted by user...]"，这轮不会再有 final，
        // 必须立刻标记收口，否则 send 循环会干等到 15 分钟硬超时（bug#16 前端卡"调用工具"的直接原因）。
        const boundaryText = normalizeTranscriptText(transcriptEventVisibleText(ev));
        if (/^\[Request interrupted by user/i.test(boundaryText)) { interrupted = true; final = true; }
        break;
      }
      if (isTranscriptAssistantEvent(ev)) {
        assistantCount += 1;
        if (transcriptEventHasToolUse(ev)) { toolCount += 1; pendingToolSinceText = true; }
        for (const name of transcriptEventToolNames(ev)) toolNames.add(name);
        const think = transcriptEventThinkingText(ev);
        if (think) thinkingText = mergeTranscriptText(thinkingText, think, 12000);
        const clean = cleanTranscriptAssistantText(transcriptEventVisibleText(ev), rawPrompt);
        const stopReason = String(ev?.message?.stop_reason || ev?.message?.stopReason || ev?.stop_reason || ev?.stopReason || '').toLowerCase();
        if (clean) {
          if (pendingToolSinceText && lastText && lastText !== clean && !clean.startsWith(lastText)) {
            if (!textSegments.includes(lastText)) textSegments.push(lastText);
          }
          pendingToolSinceText = false;
          lastText = clean;
          if (stopReason && stopReason !== 'tool_use' && stopReason !== 'pause_turn') {
            lastFinalText = clean;
            final = true;
          } else if (!stopReason) {
            lastFinalText = clean;
          }
        }
      }
    }
    const finalTail = lastFinalText || lastText;
    const missingSegments = textSegments.filter(seg => seg && !String(finalTail || '').includes(seg));
    const text = [...missingSegments, finalTail].filter(Boolean).join('\n\n');
    return { text, thinking: thinkingText, final, interrupted, assistantCount, toolCount, toolNames: Array.from(toolNames), userFound, size };
  }

  function procStatInfo(pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const rest = stat.slice(close + 2).trim().split(/\s+/);
      const ppid = Number(rest[1] || 0);
      let cmdline = '';
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch (_) {}
      return { pid: Number(pid), ppid, cmdline };
    } catch (_) { return null; }
  }
  function descendantPidsOf(rootPid) {
    const root = Number(rootPid || 0);
    if (!root) return [];
    let names = [];
    try { names = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch (_) { return [root]; }
    const infos = names.map(procStatInfo).filter(Boolean);
    const children = new Map();
    for (const info of infos) {
      if (!children.has(info.ppid)) children.set(info.ppid, []);
      children.get(info.ppid).push(info.pid);
    }
    const out = [];
    const seen = new Set();
    const q = [root];
    while (q.length) {
      const pid = q.shift();
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      for (const c of (children.get(pid) || [])) q.push(c);
    }
    return out;
  }
  function transcriptFdCandidatesForPid(pid) {
    const out = [];
    const fdDir = `/proc/${pid}/fd`;
    let fds = [];
    try { fds = fs.readdirSync(fdDir); } catch (_) { return out; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(path.join(fdDir, fd)); } catch (_) { continue; }
      link = String(link || '').replace(/ \(deleted\)$/i, '');
      if (!link.endsWith('.jsonl')) continue;
      if (CLAUDE_TRANSCRIPT_ROOT && !link.startsWith(CLAUDE_TRANSCRIPT_ROOT)) continue;
      const st = statMaybe(link);
      if (st && st.isFile()) out.push({ path: link, size: st.size, mtimeMs: st.mtimeMs, pid: Number(pid) });
    }
    return out;
  }
  async function activeClaudeTranscriptFromTmux(sessionName) {
    try {
      const r = await tmux(['display-message', '-p', '-t', sessionName, '#{pane_pid}'], { timeout: 2500 });
      const panePid = Number(String(r.out || '').trim());
      if (!panePid) return null;
      const pids = descendantPidsOf(panePid).slice(0, 256);
      const rows = [];
      for (const pid of pids) rows.push(...transcriptFdCandidatesForPid(pid));
      rows.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.size - a.size));
      return rows[0] || null;
    } catch (_) { return null; }
  }
  function transcriptCandidateFromPath(file, snapshot, userPrompt, fullPrompt, turnStartMs, source = 'active-fd') {
    if (!file) return null;
    const st = statMaybe(file);
    if (!st || !st.isFile()) return null;
    const snap = snapshot?.get?.(file);
    if (!snap || st.size < Number(snap.size || 0)) return null;
    const offset = Number(snap.size || 0);
    const window = readJsonlWindow(file, offset);
    let score = source === 'active-fd' ? 2500 : 500;
    let userFound = false;
    let assistantAfter = 0;
    let userEvents = 0;
    for (const ev of window.events) {
      if (transcriptUserMatchesPrompt(ev, userPrompt, fullPrompt, turnStartMs)) { userFound = true; score += 1000; }
      else if (isTranscriptUserEvent(ev)) { score += 5; userEvents += 1; }
      if (userFound && isTranscriptAssistantEvent(ev)) assistantAfter += 1;
    }
    if (st.size > offset) score += 80;
    if (st.mtimeMs >= turnStartMs - 15000) score += 40;
    if (assistantAfter) score += assistantAfter * 20;
    return { path: file, offset, size: st.size, mtimeMs: st.mtimeMs, userFound, userEvents, active: source === 'active-fd', source, score };
  }
  function chooseTranscriptCandidate(snapshot, userPrompt, fullPrompt, turnStartMs, preferredPath = '') {
    const preferred = preferredPath ? transcriptCandidateFromPath(preferredPath, snapshot, userPrompt, fullPrompt, turnStartMs, 'active-fd') : null;
    // 教程里的关键点：active transcript 不应只靠 mtime。若能从 tmux pane 的 Claude Code 进程 fd 定位到 JSONL，优先信任它。
    // 即使本轮 user echo 还没写出来，也先绑定这个文件，后续只从发送前 offset 之后读取，避免误读旧回复。
    if (preferred?.userFound) return preferred;

    const files = listClaudeTranscriptFiles(CLAUDE_TRANSCRIPT_ROOT, TERMINAL_TRANSCRIPT_SCAN_LIMIT);
    let best = null;
    const weak = [];
    for (const f of files) {
      const snap = snapshot?.get?.(f.path);
      if (!snap || f.size < Number(snap.size || 0)) continue;
      const offset = Number(snap.size || 0);
      const grew = f.size > offset;
      const recent = f.mtimeMs >= turnStartMs - 15000;
      if (!grew && !recent) continue;
      const window = readJsonlWindow(f.path, offset);
      let score = 0;
      let userFound = false;
      let assistantAfter = 0;
      let userEvents = 0;
      for (const ev of window.events) {
        if (transcriptUserMatchesPrompt(ev, userPrompt, fullPrompt, turnStartMs)) { userFound = true; score += 1000; }
        else if (isTranscriptUserEvent(ev)) { score += 5; userEvents += 1; }
        if (userFound && isTranscriptAssistantEvent(ev)) assistantAfter += 1;
      }
      if (grew) score += 80;
      if (recent) score += 40;
      if (assistantAfter) score += assistantAfter * 20;
      const cand = { path: f.path, offset, size: f.size, mtimeMs: f.mtimeMs, userFound, userEvents, score, source: 'mtime-scan' };
      if (userFound) {
        if (!best || cand.score > best.score || (cand.score === best.score && cand.mtimeMs > best.mtimeMs)) best = cand;
      } else if (grew && recent && userEvents) {
        // 弱候选只用于兜底：比如某些 Claude Code 版本 transcript 的 user content 不可见。
        // 多个终端同时增长时，不能靠 mtime 猜，否则会把别的 session 回复收进正式聊天。
        weak.push(cand);
      }
    }
    if (best) return best;
    return null;
  }
  // ─── relay 对话摘要生成 ───────────────────────────────────────────────────
  // 复用前端可配的 LLM（getLLMConfig → app_settings.llm 的 base_url/api_key/model，
  // OpenAI 兼容端点）把整轮对话压缩成摘要 + 保留最后100轮原文。不再写死任何 provider。
  // 返回 { summaryText, lastRaw }；任何失败都返回 null（上层自动退回原文兜底，不影响主流程）。
  async function generateRelaySummaryAsync(allTurns = [], last5Turns = []) {
    if (!allTurns.length) return null;
    let cfg = null;
    try { cfg = await getLLMConfig(); } catch (_) { cfg = null; }
    if (!cfg || !cfg.api_key || !cfg.base_url) return null;
    try {
      const fullText = allTurns.map(m => `${m.role === 'user' ? USER_NAME : COMPANION_NAME}: ${String(m.content || '').slice(0, 800)}`).join('\n');
      const lastRaw = last5Turns.map(m => `${m.role === 'user' ? USER_NAME : COMPANION_NAME}: ${String(m.content || '').slice(0, 1000)}`).join('\n');
      const base = String(cfg.base_url).replace(/\/+$/, '');
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
        body: JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          max_tokens: 600,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content: '你是对话摘要助手。把以下对话压缩成300字以内的中文摘要，保留关键事件、情绪转折、决定/约定，去掉寒暄废话。直接输出摘要正文，不要加标题或前缀。',
            },
            { role: 'user', content: fullText.slice(0, 30000) },
          ],
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const summaryText = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!summaryText) return null;
      return { summaryText, lastRaw };
    } catch (_) { return null; }
  }

  // relay 时异步生成摘要并写入 handoff_summaries（fire-and-forget，不阻塞主流程）
  async function fireRelayHandoffSummary(ledgerDb, { conversationId, surface, fromSessionId, toSessionId, allTurns, last5Turns, last5Snapshot }) {
    const result = await generateRelaySummaryAsync(allTurns, last5Turns).catch(() => null);
    const summaryBody = result
      ? `【对话摘要（DeepSeek-V3 压缩）】\n${result.summaryText}\n\n【最后100轮原文】\n${result.lastRaw}`
      : last5Snapshot || '';
    if (!summaryBody) return;
    try {
      recordClaudeHandoffSummary(ledgerDb, {
        conversationId,
        surface,
        fromSessionId,
        toSessionId,
        summary: summaryBody,
        last5TurnsSnapshot: result?.lastRaw || last5Snapshot || '',
      });
    } catch (_) {}
  }

  function buildTerminalChatConversationSummary(rec, opts = {}) {
    const messages = Array.isArray(rec?.messages) ? rec.messages : [];
    const count = Math.max(8, Math.min(400, Number(opts.count || TERMINAL_CHAT_BOOTSTRAP_RECENT) || TERMINAL_CHAT_BOOTSTRAP_RECENT));
    const rows = messages.slice(-count).map(m => {
      const who = m.role === 'user' ? USER_NAME : COMPANION_NAME;
      const text = terminalCompactText(m.content, 1600);
      return text ? `${who}: ${text}` : '';
    }).filter(Boolean);
    if (!rows.length) return '';
    return [`logical_session: ${rec.active_session || rec.session || '(unknown)'}`, `recent_terminal_messages:`, rows.join('\n')].join('\n');
  }
  function terminalChatTotalChars(rec = {}) {
    const messages = Array.isArray(rec?.messages) ? rec.messages : [];
    return messages.reduce((sum, m) => sum + String(m?.content || '').length, 0);
  }
  function terminalChatLegacyContextChars(rec = {}) {
    const messageChars = terminalChatTotalChars(rec);
    const bootstrapOverhead = Number(rec?.bootstrap_overhead_chars || 0) || 0;
    return messageChars + Math.max(0, bootstrapOverhead);
  }
  function terminalChatVisibleContextChars(rec = {}) {
    if (rec && typeof rec === 'object' && Object.prototype.hasOwnProperty.call(rec, 'context_chars_since_relay')) {
      const n = Number(rec.context_chars_since_relay || 0);
      if (Number.isFinite(n)) return Math.max(0, Math.round(n));
    }
    return terminalChatLegacyContextChars(rec);
  }
  function terminalChatRuntimeOverheadChars(rec = {}) {
    const stored = Number(rec?.claude_hidden_context_chars_override);
    if (Number.isFinite(stored) && stored >= 0) return Math.round(stored);
    return TERMINAL_CHAT_CLAUDE_HIDDEN_CONTEXT_CHARS;
  }
  function terminalChatContextChars(rec = {}) {
    return terminalChatVisibleContextChars(rec) + terminalChatRuntimeOverheadChars(rec);
  }
  function ensureTerminalChatContextCounter(rec = {}) {
    if (!rec || typeof rec !== 'object') return 0;
    const hasCounter = Object.prototype.hasOwnProperty.call(rec, 'context_chars_since_relay');
    const n = Number(rec.context_chars_since_relay || 0);
    if (!hasCounter || !Number.isFinite(n)) rec.context_chars_since_relay = terminalChatLegacyContextChars(rec);
    rec.context_chars_since_relay = Math.max(0, Math.round(Number(rec.context_chars_since_relay || 0) || 0));
    if (!Number.isFinite(Number(rec.context_chars_all_time || 0))) rec.context_chars_all_time = 0;
    rec.context_chars_all_time = Math.max(Number(rec.context_chars_all_time || 0) || 0, rec.context_chars_since_relay);
    return rec.context_chars_since_relay;
  }
  function addTerminalChatContextChars(rec = {}, value = 0, reason = '') {
    if (!rec || typeof rec !== 'object') return 0;
    const add = typeof value === 'number' ? value : String(value || '').length;
    const delta = Math.max(0, Math.round(Number(add || 0) || 0));
    const base = ensureTerminalChatContextCounter(rec);
    rec.context_chars_since_relay = base + delta;
    rec.context_chars_all_time = Math.max(0, Math.round(Number(rec.context_chars_all_time || 0) || 0)) + delta;
    rec.context_chars_last_delta = delta;
    rec.context_chars_last_reason = String(reason || '').slice(0, 80);
    rec.context_chars_updated_at = new Date().toISOString();
    return rec.context_chars_since_relay;
  }
  function resetTerminalChatContextCounter(rec = {}, reason = '') {
    if (!rec || typeof rec !== 'object') return 0;
    rec.context_chars_since_relay = 0;
    rec.context_chars_last_delta = 0;
    rec.context_chars_last_reason = String(reason || 'relay_clear').slice(0, 80);
    rec.context_chars_updated_at = new Date().toISOString();
    rec.context_counter_reset_at = rec.context_chars_updated_at;
    return 0;
  }
  function readTerminalRelayFile() {
    try {
      if (!fs.existsSync(TERMINAL_CHAT_RELAY_FILE) || !fs.statSync(TERMINAL_CHAT_RELAY_FILE).isFile()) return '';
      return fs.readFileSync(TERMINAL_CHAT_RELAY_FILE, 'utf8').trim();
    } catch (_) {
      return '';
    }
  }
  function terminalRelayFileExists() {
    return Boolean(readTerminalRelayFile());
  }
  function terminalRelayFileVersion() {
    const content = readTerminalRelayFile();
    return content ? crypto.createHash('sha256').update(content).digest('hex') : '';
  }
  function terminalRelayWriteInstruction(conversationId = '') {
    const safeId = String(conversationId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'default';
    return `Rifugio Prompt：本窗口已接近上限，下轮将换new-session。

系统固定写入流程：回复完这条消息后，立刻用 Bash 调用固定写入器 ${TERMINAL_CHAT_RELAY_WRITER} ${safeId}，把完整 relay 正文通过 stdin 交给它。写入器只更新固定文件 ${TERMINAL_CHAT_RELAY_FILE}，写入新内容前会把旧版复制到 relay_history；禁止直接覆盖 relay.txt，禁止改名，禁止写成 .used、带时间戳或任何其他文件名。
Bash 写法：${TERMINAL_CHAT_RELAY_WRITER} ${safeId} <<'RIFUGIO_RELAY'，下一行开始写完整 relay 正文，最后单独一行写 RIFUGIO_RELAY。

relay要求：写给下一个会话的中性交接摘要，按时间顺序保留关键事实、用户明确表达、决定、未完成事项和必要上下文。不要猜测姓名、关系类型或情绪；不要加入未配置的昵称。末尾列出下一会话需要继续处理的事项。`;
  }
  function refreshTerminalRelayTrigger(rec = {}) {
    const visibleTotal = terminalChatVisibleContextChars(rec);
    rec.relay_total_chars = visibleTotal;
    rec.effective_context_chars = terminalChatContextChars(rec);
    if (!rec.relay_pending && visibleTotal >= TERMINAL_CHAT_RELAY_TRIGGER_CHARS) {
      rec.relay_trigger = true;
    } else if (!rec.relay_pending && rec.relay_trigger && rec.relay_reason !== 'manual_force_relay') {
      rec.relay_trigger = false;
      rec.relay_reason = '';
    }
    return visibleTotal;
  }
  function buildTerminalChatRelayPendingPrompt(conversationId, systemPrompt, explicit = '', rec = {}, userPrompt = '', opts = {}) {
    const profile = opts.profileBlock != null ? String(opts.profileBlock || '') : profileBlock(systemPrompt || '', { max: 12000 });
    const dynamic = opts.dynamicBlock != null ? String(opts.dynamicBlock || '') : frontendDynamicContextBlock(systemPrompt || '', { max: 12000 });
    const character = opts.characterBlock != null ? String(opts.characterBlock || '') : resolveCharacterPrompt('');
    const memory = buildMemoryContext();
    const frontend = compactContextText(explicit, 12000);
    const terminalRecent = buildTerminalChatConversationSummary(rec, { count: TERMINAL_CHAT_RELAY_RECENT_MESSAGES });
    return [
      '【Rifugio Terminal Chat Relay Bootstrap】',
      'Rifugio提示：当前正在和爱人在Rifugio对话，请自然的回应爱人并牢记一下信息',
      memory,
      profile,
      dynamic,
      character,
      terminalRecent ? `\n【最近100轮 Terminal 原文】\n${terminalRecent}` : '',
      frontend ? `\n【前端补充】\n${frontend}` : '',
      userPrompt ? `\n【用户最新消息】\n${userPrompt}` : '',
    ].filter(Boolean).join('\n\n');
  }
  function recordTerminalChatTurn(st, key, rec, userText, assistantText, meta = {}) {
    const now = new Date().toISOString();
    rec.messages = Array.isArray(rec.messages) ? rec.messages : [];
    rec.messages.push({ role: 'user', content: terminalCompactText(userText, 4000), at: now });
    if (assistantText) {
      rec.messages.push({ role: 'assistant', content: terminalCompactText(assistantText, 8000), at: now, session: meta.session || rec.active_session || '' });
      addTerminalChatContextChars(rec, String(assistantText || '').length, 'assistant_reply');
    }
    if (rec.messages.length > TERMINAL_CHAT_HISTORY_LIMIT) rec.messages = rec.messages.slice(-TERMINAL_CHAT_HISTORY_LIMIT);
    rec.turns_total = Number(rec.turns_total || 0) + 1;
    rec.turns_since_relay = Number(rec.turns_since_relay || 0) + 1;
    rec.last_turn_at = now;
    refreshTerminalRelayTrigger(rec);
    st.conversations[key] = rec;
    terminalWriteState(st);
    try {
      const db = openLedgerDb(false);
      try {
        appendClaudeConversationMessages(db, {
          conversationId: key,
          surface: 'terminal',
          turnId: meta.turnId || crypto.randomUUID(),
          userText,
          assistantText,
          claudeSessionId: meta.session || rec.active_session || '',
          route: 'terminal',
        });
      } finally {
        db.close();
      }
    } catch (_) {}
  }
  function buildTerminalChatBootstrap(conversationId, systemPrompt, explicit = '', rec = {}, opts = {}) {
    const profile = opts.profileBlock != null ? String(opts.profileBlock || '') : profileBlock(systemPrompt || '', { max: 12000 });
    const dynamic = opts.dynamicBlock != null ? String(opts.dynamicBlock || '') : frontendDynamicContextBlock(systemPrompt || '', { max: 12000 });
    const character = opts.characterBlock != null ? String(opts.characterBlock || '') : resolveCharacterPrompt('');
    const memory = buildMemoryContext();
    // 启动/切换时带最近 100 轮（Talk + Terminal）原文，让 terminal 与 -p 互相接住上下文。
    const talkRecent = buildTalkConversationSummary(conversationId, { count: RELAY_MSG_COUNT, totalMax: RELAY_TOTAL_MAX_CHARS });
    const terminalRecent = buildTerminalChatConversationSummary(rec, { count: TERMINAL_CHAT_RELAY_RECENT_MESSAGES });
    // 最新 relay 摘要，补"前情提要"避免失忆
    let handoffSummary = '';
    try {
      const _ledger = openLedgerDb(true);
      try {
        const _row = _ledger.prepare("SELECT summary FROM claude_handoff_summaries WHERE conversation_id=? AND id NOT LIKE 'terminal-preheat:%' ORDER BY created_at DESC LIMIT 1").get(String(conversationId || ''));
        handoffSummary = compactContextText(String(_row?.summary || ''), 4000);
      } finally { _ledger.close(); }
    } catch (_) {}
    const frontend = compactContextText(explicit, 12000);
    const previousTail = terminalCompactText(opts.previousTail || '', 12000);
    return [
      '【Rifugio Terminal Chat 启动/接力上下文】',
      'Rifugio 提示：现在是新窗口接力，您已到达新窗口，回应爱人之前，请接收以下信息并牢记：',
      opts.relayReason ? `relay_reason: ${opts.relayReason}` : '',
      memory,
      profile,
      dynamic,
      character,
      handoffSummary ? `\n【上次 relay 摘要（前情提要）】\n${handoffSummary}` : '',
      !handoffSummary && talkRecent ? `\n【TalkApp 最近 10 轮】\n${talkRecent}` : '',
      !handoffSummary && terminalRecent ? `\n【Terminal Chat 最近 10 轮】\n${terminalRecent}` : '',
      previousTail ? `\n【上一终端尾部公开输出摘要｜仅作状态参考】\n${previousTail}` : '',
      frontend ? `\n【前端补充】\n${frontend}` : '',
    ].filter(Boolean).join('\n\n');
  }
  function shouldRelayTerminalSession(rec, tail, forceRelay = false) {
    if (forceRelay) return 'manual_force_relay';
    const visibleContextChars = refreshTerminalRelayTrigger(rec);
    if (!rec?.relay_pending && visibleContextChars >= TERMINAL_CHAT_RELAY_TRIGGER_CHARS) {
      return `context_chars>=${TERMINAL_CHAT_RELAY_TRIGGER_CHARS}`;
    }
    return '';
  }
  function terminalRelayStatePayload(rec = {}, opts = {}) {
    const messageChars = terminalChatTotalChars(rec);
    const visibleContextChars = terminalChatVisibleContextChars(rec);
    const runtimeOverheadChars = terminalChatRuntimeOverheadChars(rec);
    const contextChars = terminalChatContextChars(rec);
    const relayOverheadChars = Math.max(0, visibleContextChars - messageChars);
    const effectiveOverheadChars = Math.max(0, contextChars - messageChars);
    const visibleAllTimeChars = Math.max(0, Math.round(Number(rec.context_chars_all_time || 0) || 0));
    const contextAllTimeChars = Math.max(contextChars, visibleAllTimeChars + runtimeOverheadChars);
    const triggerPct = Math.min(100, Math.round((visibleContextChars / TERMINAL_CHAT_RELAY_TRIGGER_CHARS) * 100));
    const effectiveTriggerPct = Math.min(100, Math.round((contextChars / TERMINAL_CHAT_RELAY_TRIGGER_CHARS) * 100));
    const willAutoRelay = Boolean(rec.relay_pending || rec.relay_trigger || visibleContextChars >= TERMINAL_CHAT_RELAY_TRIGGER_CHARS);
    return {
      relay_index: Number(rec.relay_index || 0) || 0,
      active_session: rec.active_session || rec.session || '',
      logical_session: rec.active_session || rec.session || '',
      claude_session: rec.active_session || rec.session || '',
      tmux_session: rec.tmux_session || '',
      terminal_session: rec.tmux_session || '',
      previous_session: rec.previous_session || '',
      turns_since_relay: Number(rec.turns_since_relay || 0) || 0,
      turns_total: Number(rec.turns_total || 0) || 0,
      relay_trigger: Boolean(rec.relay_trigger),
      relay_pending: Boolean(rec.relay_pending),
      relay_file: TERMINAL_CHAT_RELAY_FILE,
      relay_file_exists: terminalRelayFileExists(),
      total_chars: visibleContextChars,
      dialog_chars: visibleContextChars,
      message_chars: messageChars,
      overhead_chars: relayOverheadChars,
      visible_context_chars: visibleContextChars,
      runtime_overhead_chars: runtimeOverheadChars,
      claude_hidden_context_chars: runtimeOverheadChars,
      config_chars: runtimeOverheadChars,
      effective_chars: contextChars,
      effective_total_chars: contextChars,
      effective_overhead_chars: effectiveOverheadChars,
      relay_total_chars: Number(rec.relay_total_chars || visibleContextChars) || 0,
      context_chars_since_relay: visibleContextChars,
      visible_context_chars_since_relay: visibleContextChars,
      context_chars_all_time: contextAllTimeChars,
      visible_context_chars_all_time: visibleAllTimeChars,
      trigger_chars: TERMINAL_CHAT_RELAY_TRIGGER_CHARS,
      trigger_progress_pct: triggerPct,
      effective_trigger_progress_pct: effectiveTriggerPct,
      will_auto_relay_next_turn: willAutoRelay,
      last_relay_reason: rec.relay_reason || '',
      bootstrapped_at: rec.bootstrapped_at || '',
      history_messages: Array.isArray(rec.messages) ? rec.messages.length : 0,
      estimated_context_chars: visibleContextChars,
      effective_context_chars: contextChars,
      recent_summary_chars: buildTerminalChatConversationSummary(rec, { count: TERMINAL_CHAT_BOOTSTRAP_RECENT }).length,
    };
  }
  function sseJson(res, obj) {
    if (!res || res.destroyed || res.writableEnded) return false;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; }
    catch (_) { return false; }
  }

  app.get('/api/terminal-chat/status', async (req, res) => {
    try {
      const conversationId = String(req.query.conversation_id || '').trim() || 'default';
      const { rec } = terminalStateFor(conversationId);
      const sessionName = terminalActiveSessionName(conversationId, rec);
      const logicalSession = rec.active_session || terminalLogicalSessionName(conversationId, rec.relay_index || 0);
      const canSeeTerminalTail = hasTerminalAuth(req);
      let exists = false, tail = '', tailPreview = '';
      try {
        await tmux(['has-session', '-t', sessionName], { timeout: 2500 });
        exists = true;
        tail = await captureTerminalTail(sessionName);
        tailPreview = canSeeTerminalTail ? tail.slice(-3000) : '';
      } catch (_) {}
      let latestHandoff = null;
      try {
        const db = openLedgerDb(true);
        try {
          latestHandoff = db.prepare(`
            SELECT id, from_claude_session_id, to_claude_session_id, summary, created_at
            FROM claude_handoff_summaries
            WHERE conversation_id=? AND surface='terminal'
            ORDER BY created_at DESC
            LIMIT 1
          `).get(conversationId) || null;
        } finally {
          db.close();
        }
      } catch (_) {}
      const relayState = terminalRelayStatePayload(rec, { tail });
      const permission = canSeeTerminalTail ? detectTerminalPermissionPrompt(tail) : null;
      // Live terminal state must never be frozen by a browser/proxy 304.
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
      res.json({
        ok: true,
        mode: 'terminal_chat',
        session: logicalSession,
        logical_session: logicalSession,
        claude_session: logicalSession,
        tmux_session: sessionName,
        terminal_session: sessionName,
        exists,
        relay_index: rec.relay_index || 0,
        turns_since_relay: rec.turns_since_relay || 0,
        turns_total: rec.turns_total || 0,
        bootstrapped_at: rec.bootstrapped_at || '',
        tail_preview: tailPreview,
        permission,
        relay_state: relayState,
        handoff: latestHandoff ? {
          id: latestHandoff.id,
          from_session: latestHandoff.from_claude_session_id,
          to_session: latestHandoff.to_claude_session_id,
          created_at: latestHandoff.created_at,
          summary_chars: String(latestHandoff.summary || '').length,
        } : null,
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
  });

  // 只登记给 Claude 的会话事件，不立即触发回复；在下一条真实用户消息前注入。
  app.post('/api/terminal-chat/event', (req, res) => {
    try {
      const conversationId = String(req.body?.conversation_id || '').trim() || 'default';
      const event = String(req.body?.event || '').trim().slice(0, 200);
      if (!event) return res.status(400).json({ ok:false, error:'event required' });
      const { st, key, rec } = terminalStateFor(conversationId);
      rec.pending_events = Array.isArray(rec.pending_events) ? rec.pending_events.slice(-8) : [];
      rec.pending_events.push({ text:event, at:new Date().toISOString() });
      st.conversations[key] = rec;
      terminalWriteState(st);
      res.json({ ok:true, queued:true });
    } catch (e) { res.status(500).json({ ok:false, error:e.message || String(e) }); }
  });

  app.post('/api/terminal-chat/shortcut', async (req, res) => {
    try {
      const isRaw = String(req.body?.target || '').trim() === 'raw';
      let sessionName, logicalSession;
      if (isRaw) {
        sessionName = logicalSession = TERMINAL_RAW_SESSION;
        // raw session 只能由 ttyd 打开终端时创建（new-session -A）；这里绝不代建，
        // 否则会凭空多出一个 detached tmux + 无人看的 claude 实例
        try { await tmux(['has-session', '-t', sessionName], { timeout: 3500 }); }
        catch (_) { return res.status(409).json({ ok: false, error: '原始终端没在运行——先打开终端页面再按快捷键' }); }
      } else {
        const conversationId = String(req.body?.conversation_id || '').trim() || 'default';
        const { rec } = terminalStateFor(conversationId);
        sessionName = terminalActiveSessionName(conversationId, rec);
        logicalSession = rec.active_session || terminalLogicalSessionName(conversationId, rec.relay_index || 0);
        await ensureTerminalChatSession(sessionName);
      }
      if (req.body?.text != null) await pasteTerminalRawText(sessionName, String(req.body.text || ''), { enter: req.body.enter !== false });
      else await sendTerminalShortcutToTmux(sessionName, req.body?.key);
      res.json({ ok: true, session: logicalSession, logical_session: logicalSession, claude_session: logicalSession, tmux_session: sessionName, terminal_session: sessionName });
    } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
  });

  app.post('/api/terminal-chat/permission', async (req, res) => {
    try {
      const conversationId = String(req.body?.conversation_id || '').trim() || 'default';
      const action = String(req.body?.action || '').trim();
      const permissionId = String(req.body?.permission_id || '').trim();
      const { rec } = terminalStateFor(conversationId);
      const sessionName = terminalActiveSessionName(conversationId, rec);
      const logicalSession = rec.active_session || terminalLogicalSessionName(conversationId, rec.relay_index || 0);
      let current = detectTerminalPermissionPrompt(await captureTerminalTail(sessionName).catch(() => ''));
      if (permissionId && current?.id && permissionId !== current.id) {
        return res.status(409).json({ ok: false, error: 'permission prompt is stale', current_permission_id: current.id });
      }
      let pending = terminalPermissionActionsInFlight.get(sessionName);
      if (!pending) {
        pending = (async () => {
          const promptAtSend = current;
          const keys = await sendTerminalPermissionAction(sessionName, action, promptAtSend);
          let cleared = false;
          let nudged = false;
          for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 180));
            current = detectTerminalPermissionPrompt(await captureTerminalTail(sessionName).catch(() => ''));
            if (!current) { cleared = true; break; }
            // 数字键在新版对话框会直接确认；老版本只移动光标，需要补一下 Enter。
            // 同一个弹窗 ~0.5s 还没消失才补，且只补一次，别把 Enter 打进别的界面。
            if (!nudged && i >= 2 && /^\d$/.test(keys[0] || '') && promptAtSend?.id && current.id === promptAtSend.id) {
              nudged = true;
              await tmux(['send-keys', '-t', sessionName, 'Enter'], { timeout: 4000 }).catch(() => {});
            }
          }
          return { cleared, keys, permission_id: permissionId || current?.id || '' };
        })().finally(() => terminalPermissionActionsInFlight.delete(sessionName));
        terminalPermissionActionsInFlight.set(sessionName, pending);
      }
      const result = await pending;
      res.json({
        ok: true,
        action,
        cleared: Boolean(result?.cleared),
        permission_id: result?.permission_id || permissionId,
        session: logicalSession,
        logical_session: logicalSession,
        claude_session: logicalSession,
        tmux_session: sessionName,
        terminal_session: sessionName,
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
  });

  // App 切到后台导致 SSE 断开时，从内存回放本轮 Terminal 事件；后端仍会继续等 transcript 收口。
  app.get('/api/terminal-chat/resume', (req, res) => {
    pruneTerminalTurnRuns();
    const conversationId = String(req.query?.conversation_id || '').trim() || 'default';
    const requestedTurnId = String(req.query?.turn_id || '').trim();
    const key = requestedTurnId ? `${conversationId}:${requestedTurnId}` : terminalLatestTurnByConversation.get(conversationId);
    const run = key ? terminalTurnRuns.get(key) : null;
    if (!run) return res.status(404).json({ ok:false, error:'terminal turn not found' });
    res.json({ ok:true, conversation_id:conversationId, turn_id:run.turnId, done:run.done, events:run.events, updated_at:run.updatedAt });
  });

  app.post('/api/terminal-chat/send', async (req, res) => {
    const { prompt, conversation_id, model, effort, system_prompt, character_prompt, bootstrap_context, force_bootstrap, force_relay, images } = req.body || {};
    const rawPrompt0 = String(prompt || '').trim();
    let rawPrompt = promptWithImages(rawPrompt0, images);
    const terminalImageCount = Array.isArray(images)
      ? images.filter(x => /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(String(x || ''))).slice(0, 6).length
      : 0;
    if (!rawPrompt) return res.status(400).json({ ok: false, error: 'prompt required' });
    sseHead(res);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const conversationId = String(conversation_id || '').trim() || 'default';
    const requestedTerminalModel = String(model || '').trim();
    const terminalCliModel = resolveCliModel(requestedTerminalModel);
    const turnId = crypto.randomUUID().slice(0, 8);
    const turnStartMs = Date.now();
    const terminalTurnRun = createTerminalTurnRun(conversationId, turnId);
    let clientClosed = false;
    req.on('aborted', () => { clientClosed = true; });
    res.on('close', () => { if (!res.writableEnded) clientClosed = true; });
    const emitTerminal = (payload) => {
      const event = { ...payload, turn_id:payload?.turn_id || turnId };
      terminalTurnRun.events.push(event);
      if (terminalTurnRun.events.length > 240) terminalTurnRun.events.splice(0, terminalTurnRun.events.length - 240);
      terminalTurnRun.updatedAt = Date.now();
      if (!clientClosed && !res.destroyed && !res.writableEnded) sseJson(res, event);
      return event;
    };
    try {
      const { st, key, rec } = terminalStateFor(conversationId);
      const pendingEvents = Array.isArray(rec.pending_events) ? rec.pending_events.splice(0) : [];
      if (pendingEvents.length) {
        const eventText = pendingEvents.map(x => String(x?.text || '')).filter(Boolean).join('；');
        rawPrompt = `[Rifugio System Event: ${eventText}]\n这只是会话状态同步，请自然理解，不要声称用户刚刚又发送了一条消息。\n\n${rawPrompt}`;
        st.conversations[key] = rec;
        terminalWriteState(st);
      }
      let sessionName = terminalActiveSessionName(key, rec);
      let logicalSession = rec.active_session || terminalLogicalSessionName(key, rec.relay_index || 0);
      let previousTail = '';
      let relayReason = '';
      try {
        await tmux(['has-session', '-t', sessionName], { timeout: 1800 });
        previousTail = await captureTerminalTail(sessionName).catch(() => '');
      } catch (_) {}
      const forceRelayRequested = force_relay === true || force_relay === 'true';
      if (forceRelayRequested) {
        rec.relay_trigger = true;
        rec.relay_reason = 'manual_force_relay';
        refreshTerminalRelayTrigger(rec);
        st.conversations[key] = rec;
        terminalWriteState(st);
      }
      const relayReasonAtStart = shouldRelayTerminalSession(rec, previousTail, forceRelayRequested);
      if (relayReasonAtStart && !rec.relay_pending) {
        rec.relay_trigger = true;
        rec.relay_reason = relayReasonAtStart;
        st.conversations[key] = rec;
        terminalWriteState(st);
      }
      const relayPendingAtStart = Boolean(rec.relay_pending);
      const relayTriggerAtStart = !relayPendingAtStart && Boolean(rec.relay_trigger);
      const relayFileVersionAtStart = relayTriggerAtStart ? terminalRelayFileVersion() : '';
      if (relayTriggerAtStart) {
        relayReason = rec.relay_reason || `context_chars>${TERMINAL_CHAT_RELAY_TRIGGER_CHARS}`;
        emitTerminal({
          type: 'terminal_relay',
          phase: 'summary_instruction',
          reason: relayReason,
          session: logicalSession,
          logical_session: logicalSession,
          claude_session: logicalSession,
          tmux_session: sessionName,
          terminal_session: sessionName,
          relay_index: rec.relay_index || 0,
          relay_state: terminalRelayStatePayload(rec, { tail: previousTail }),
        });
      } else if (relayPendingAtStart) {
        relayReason = rec.relay_reason || 'relay_pending_bootstrap';
        emitTerminal({
          type: 'terminal_relay',
          phase: 'pending_bootstrap',
          reason: relayReason,
          session: logicalSession,
          logical_session: logicalSession,
          claude_session: logicalSession,
          tmux_session: sessionName,
          terminal_session: sessionName,
          relay_index: rec.relay_index || 0,
          relay_state: terminalRelayStatePayload(rec, { tail: previousTail }),
        });
      }

      const ensured = await ensureTerminalChatSession(sessionName, requestedTerminalModel, effort);
      // effort 中途切换（2026-07-02）：CLI 有 /effort 命令，同 /model 一样贴进去即生效（实测 2.1.198）。
      // tmux 是全局共享暖会话 → 当前 effort 记在 st.tmux_effort（全局），不按会话记。
      const effortNow = String(effort || 'medium');
      const effortCli = ({ low: 'low', medium: 'medium', high: 'high', off: 'low' })[effortNow.toLowerCase()] || 'medium';
      let effortSwitched = false;
      if (!ensured.created && !relayPendingAtStart && !relayTriggerAtStart && st.tmux_effort !== effortNow) {
        await requireTerminalClaudeReady(sessionName, 6500, 'effort switch');
        await pasteTerminalRawText(sessionName, `/effort ${effortCli}`, { enter: true });
        await new Promise(r => setTimeout(r, 900));
        // 2.1.198 时代贴进去即生效；新版 CLI 对带历史的会话弹确认菜单("Change effort level?")。
        // 不按掉的话 pane 卡在菜单里，下一次贴的 /model 或正文会被菜单吞掉、回车误选菜单项
        // （sonnet-5 那次"切换未确认"的真凶）。发现菜单就回车确认默认的 Yes。
        for (let i = 0; i < 2; i++) {
          const tailAfterEffort = await captureTerminalTail(sessionName).catch(() => '');
          const lastLines = tailAfterEffort.split('\n').filter(l => l.trim()).slice(-12).join('\n');
          if (!/Change effort level\?|Yes, switch to/i.test(lastLines)) break;
          await tmux(['send-keys', '-t', sessionName, 'Enter'], { timeout: 4000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 700));
        }
        effortSwitched = true;
        emitTerminal({
          type: 'terminal_effort',
          effort: effortNow,
          applied: true,
          session: logicalSession,
          logical_session: logicalSession,
          tmux_session: sessionName,
          terminal_session: sessionName,
        });
      }
      if (ensured.created || effortSwitched) {
        st.tmux_effort = effortNow;
        terminalWriteState(st);
      }
      const currentTmuxModel = String(st.tmux_model || '').trim();
      const shouldSwitchExistingModel = Boolean(
        !ensured.created &&
        requestedTerminalModel &&
        currentTmuxModel !== terminalCliModel
      );
      let modelSwitchApplied = false;
      if (shouldSwitchExistingModel) {
        await requireTerminalClaudeReady(sessionName, 6500, 'model switch');
        await pasteTerminalRawText(sessionName, `/model ${terminalCliModel}`, { enter: true });
        let tailAfterSwitch = '';
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, i === 0 ? 900 : 450));
          tailAfterSwitch = await captureTerminalTail(sessionName).catch(() => tailAfterSwitch);
          const lastLines = tailAfterSwitch.split('\n').filter(l => l.trim()).slice(-24).join('\n');
          if (terminalPaneHasUnsubmittedPaste(lastLines)) {
            await tmux(['send-keys', '-t', sessionName, 'Enter'], { timeout: 4000 }).catch(() => {});
            continue;
          }
          if (/Change model\?|Yes, switch to|switch model/i.test(lastLines)) {
            await tmux(['send-keys', '-t', sessionName, 'Enter'], { timeout: 4000 }).catch(() => {});
            continue;
          }
          if (/Set model to|Model:\s*(?:opus|sonnet|haiku|fable)/i.test(lastLines)) {
            modelSwitchApplied = true;
            break;
          }
          if (/unknown model|invalid model|model not found|not available/i.test(lastLines)) break;
        }
        if (!modelSwitchApplied) console.warn('[terminal-chat] /model 切换未确认，保留全局旧值下轮重试', { sessionName, model: terminalCliModel });
        emitTerminal({
          type: 'terminal_model',
          model: terminalCliModel,
          effort: String(effort || 'medium'),
          applied: modelSwitchApplied,
          session: logicalSession,
          logical_session: logicalSession,
          claude_session: logicalSession,
          tmux_session: sessionName,
          terminal_session: sessionName,
        });
      }
      if (ensured.created) {
        st.tmux_model = terminalCliModel;
        rec.cli_model = terminalCliModel;
        terminalWriteState(st);
      } else if (modelSwitchApplied) {
        // 固定 tmux 被所有逻辑对话共享，真实模型必须记在全局；按 conversation 记会在切对话后失真。
        st.tmux_model = terminalCliModel;
        rec.cli_model = terminalCliModel;
        terminalWriteState(st);
      } else if (st.tmux_model) {
        rec.cli_model = st.tmux_model;
      }
      // 判定拆两层（2026-07-02，"内容没变就跳过"）：
      // - 核心资料(profile字段+character)变了 → 重贴完整 profile 更新块；
      // - 只有动态行(表情包库存/戳一戳/主动电话)变了 → 只贴几百字的 dynamic 小块；
      // - 都没变 → 什么都不贴。rec 里没存过对应 hash（老状态/升级后第一条）→ 直接采纳当前值，不重贴。
      const terminalBootstrapHash = buildTerminalFrontendProfileHash(system_prompt || '', character_prompt);
      const terminalCoreHash = buildTerminalProfileCoreHash(system_prompt || '', character_prompt);
      const terminalDynamicHash = frontendDynamicContextHash(system_prompt || '');
      const canDiffTerminalUpdates = Boolean(
        !relayPendingAtStart &&
        !relayTriggerAtStart &&
        !force_bootstrap &&
        !ensured.created &&
        rec.bootstrapped_at
      );
      const profileUpdateOnlyAtStart = Boolean(
        canDiffTerminalUpdates &&
        terminalCoreHash &&
        rec.profile_core_hash &&
        rec.profile_core_hash !== terminalCoreHash
      );
      const dynamicUpdateOnlyAtStart = Boolean(
        canDiffTerminalUpdates &&
        !profileUpdateOnlyAtStart &&
        terminalDynamicHash &&
        rec.dynamic_hash &&
        rec.dynamic_hash !== terminalDynamicHash
      );
      const needBootstrap = Boolean(!relayPendingAtStart && (force_bootstrap || ensured.created || !rec.bootstrapped_at || profileUpdateOnlyAtStart));
      if (ensured.created || relayPendingAtStart || needBootstrap) {
        await requireTerminalClaudeReady(sessionName, 9000, 'bootstrap');
      }
      emitTerminal({
        type: 'terminal_route',
        session: logicalSession,
        logical_session: logicalSession,
        claude_session: logicalSession,
        tmux_session: sessionName,
        terminal_session: sessionName,
        turn_id: turnId,
        bootstrapping: needBootstrap || relayPendingAtStart,
        profile_update_only: profileUpdateOnlyAtStart,
        dynamic_update_only: dynamicUpdateOnlyAtStart,
        created: ensured.created,
        model: st.tmux_model || rec.cli_model || terminalCliModel,
        effort: String(effort || 'medium'),
        relay_index: rec.relay_index || 0,
        turns_since_relay: rec.turns_since_relay || 0,
        relay_state: terminalRelayStatePayload(rec, { tail: previousTail }),
      });

      const rememberedTranscriptPath = String(rec.transcript_path || '').trim();
      const activeTranscriptBefore = await activeClaudeTranscriptFromTmux(sessionName).catch(() => null);
      const transcriptSnapshot = snapshotClaudeTranscripts();
      // Claude Code 2.1.207 原生进程不再长期持有 JSONL fd；把上轮已绑定文件显式放进快照，
      // 保证偏移永远从发送前 EOF 开始，而不是候选未进最近100个文件时退回 offset=0。
      for (const transcriptPath of [activeTranscriptBefore?.path, rememberedTranscriptPath].filter(Boolean)) {
        if (transcriptSnapshot.has(transcriptPath)) continue;
        const stTranscript = statMaybe(transcriptPath);
        if (stTranscript?.isFile()) transcriptSnapshot.set(transcriptPath, { size:stTranscript.size, mtimeMs:stTranscript.mtimeMs });
      }
      const before = await captureTerminalTail(sessionName).catch(() => '');
      const terminalProfilePlan = profileInjectionPlan(system_prompt || '', { conversation_id: conversationId, session_id: logicalSession });
      const terminalBridgePlan = (needBootstrap && !profileUpdateOnlyAtStart)
        ? crossSurfaceBridgePlan(conversationId, 'terminal', logicalSession, { currentPrompt: rawPrompt0 || rawPrompt })
        : { text: '', hash: '', key: '', source: 'talk', target: 'terminal', alreadyInjected: true };
      const bootstrapProfile = (needBootstrap || relayPendingAtStart) ? profileBlock(system_prompt || '', { max: 12000 }) : '';
      const bootstrap = relayPendingAtStart
        ? buildTerminalChatRelayPendingPrompt(conversationId, system_prompt, bootstrap_context, rec, rawPrompt, { profileBlock: bootstrapProfile, characterBlock: resolveCharacterPrompt(character_prompt) })
        : (needBootstrap
          ? (profileUpdateOnlyAtStart
            ? buildTerminalProfileUpdateBootstrap(system_prompt || '', resolveCharacterPrompt(character_prompt))
            : buildTerminalChatBootstrap(conversationId, system_prompt, bootstrap_context, rec, { previousTail, relayReason, profileBlock: bootstrapProfile, characterBlock: resolveCharacterPrompt(character_prompt) }))
          : (dynamicUpdateOnlyAtStart ? buildTerminalDynamicUpdateBootstrap(system_prompt || '') : ''));
      const bridgeText = (!relayPendingAtStart && !profileUpdateOnlyAtStart && terminalBridgePlan?.text) ? compactContextText(terminalBridgePlan.text, 22000) : '';
      const promptForClaude = relayPendingAtStart
        ? ''
        : (relayTriggerAtStart ? `${terminalRelayWriteInstruction(conversationId)}\n\n${rawPrompt}` : rawPrompt);
      logTerminalBootstrapDebug('terminal-chat/send', {
        conversationId,
        sessionName,
        logicalSession,
        needBootstrap: needBootstrap || relayPendingAtStart,
        relayReason,
        relayPendingAtStart,
        relayTriggerAtStart,
        dynamicUpdateOnly: dynamicUpdateOnlyAtStart,
        system_prompt,
        character_prompt,
        bootstrap,
        terminalProfilePlan,
      });
      const pasteText = [bootstrap, bridgeText, promptForClaude].filter(Boolean).join('\n\n---\n\n');
      rec.last_paste_chars = pasteText.length;
      rec.last_bootstrap_chars = bootstrap.length;
      rec.last_bridge_chars = bridgeText.length;
      rec.last_prompt_chars = promptForClaude.length;
      // 50k 触发口径：累计“真正 paste 给 Claude 的全部内容”。
      // 包括普通用户消息、profile 更新、bootstrap、bridge、relay 指令和前端补充；不再只记最近一次 bootstrap overhead。
      addTerminalChatContextChars(rec, pasteText.length, bootstrap ? 'paste_with_bootstrap' : 'paste_user_prompt');
      rec.relay_total_chars = terminalChatVisibleContextChars(rec);
      rec.effective_context_chars = terminalChatContextChars(rec);
      refreshTerminalRelayTrigger(rec);
      st.conversations[key] = rec;
      terminalWriteState(st);
      const pasteSubmit = await pasteTerminalText(sessionName, pasteText);
      await new Promise(r => setTimeout(r, 550));
      const afterPasteTail = await captureTerminalTail(sessionName).catch(() => '');
      if (terminalPaneHasUnsubmittedPaste(afterPasteTail)) {
        emitTerminal({ type: 'terminal_status', statuses: [{ type:'input', label:'Terminal 多行内容仍在输入框，继续确认提交…' }] });
        const retrySubmit = await settleTerminalPaste(sessionName, pasteText);
        if (!retrySubmit?.submitted) {
          emitTerminal({ type:'terminal_status', statuses:[{ type:'error', label:'Terminal 多行内容提交失败，请重试本条消息' }] });
          throw new Error('Terminal pasted input was not submitted after retries');
        }
      } else if (pasteSubmit?.attempts > 1) {
        emitTerminal({ type:'terminal_status', statuses:[{ type:'input', label:`Terminal 多行内容已在第 ${pasteSubmit.attempts} 次确认后提交` }] });
      }
      if (terminalImageCount) emitTerminal({ type: 'terminal_status', statuses: [{ type:'tool', label:`已附带 ${terminalImageCount} 张图片，等待 Claude Code 用 Read 查看` }] });
      emitTerminal({ type: 'terminal_status', statuses: [{ type:'thinking', label:'已发送到 Claude Code，等待开始思考…' }] });
      if (needBootstrap) {
        rec.bootstrapped_at = new Date().toISOString();
        rec.tmux_session = sessionName;
        rec.session = logicalSession;
        rec.active_session = logicalSession;
      }
      // 无论是否重贴，都把当前三个 hash 采纳进状态（缺失=老状态升级，静默采纳不重贴）
      if (rec.profile_hash !== terminalBootstrapHash || rec.profile_core_hash !== terminalCoreHash || rec.dynamic_hash !== terminalDynamicHash || needBootstrap) {
        rec.profile_hash = terminalBootstrapHash;
        rec.profile_core_hash = terminalCoreHash;
        rec.dynamic_hash = terminalDynamicHash;
        st.conversations[key] = rec;
        terminalWriteState(st);
      }
      if ((needBootstrap || relayPendingAtStart) && system_prompt) markProfileInjected(system_prompt || '', { conversation_id: conversationId, session_id: logicalSession }, relayPendingAtStart ? 'terminal_relay_bootstrap' : (profileUpdateOnlyAtStart ? 'terminal_profile_update' : 'terminal_bootstrap_full'));
      if (dynamicUpdateOnlyAtStart && system_prompt) markFrontendDynamicContextInjected(system_prompt || '', { conversation_id: conversationId, session_id: logicalSession }, 'terminal_dynamic_update');
      if (terminalBridgePlan.hash && needBootstrap) markCrossSurfaceBridgeInjected(terminalBridgePlan, 'terminal_bootstrap');

      const start = Date.now();
      let lastPane = before;
      let lastPaneChange = Date.now();
      let lastPreview = '';
      let lastPreviewAt = 0;
      let transcript = null;
      let activeTranscriptPath = activeTranscriptBefore?.path || rememberedTranscriptPath || '';
      let lastActiveTranscriptProbe = 0;
      let lastTranscriptSize = 0;
      let lastTranscriptChange = Date.now();
      let transcriptFinalReadyAt = 0;
      let finalFromTranscript = '';
      let finalByStopReason = false;
      let transcriptToolSeen = false;
      let finalFromPane = '';
      let turnInterrupted = false;
      let lastPaneFallbackPreview = '';
      let lastPaneFallbackAt = 0;
      let lastStatusKey = '';
      let lastPermissionKey = '';
      let lastThinking = '';
      let lastToolNamesKey = '';
      // The paste helper has already verified that the composer no longer
      // contains unsubmitted input. Start this turn at that submit boundary so a
      // fast reply cannot be missed between pane polls.
      let terminalTurnLifecycle = advanceTerminalTurnLifecycle(undefined, {
        submitted: Boolean(pasteSubmit?.submitted),
      });

      while (Date.now() - start < TERMINAL_CHAT_MAX_MS) {
        await new Promise(r => setTimeout(r, TERMINAL_CHAT_POLL_MS));
        const nowPane = await captureTerminalTail(sessionName).catch(() => lastPane);
        if (nowPane !== lastPane) { lastPane = nowPane; lastPaneChange = Date.now(); }
        const delta = terminalDelta(before, nowPane);
        const recentForStatus = nowPane.split('\n').slice(-50).join('\n');
        const terminalIdleVisible = terminalPaneIsIdle(recentForStatus);
        const statuses = classifyTerminalStatus(recentForStatus);
        terminalTurnLifecycle = advanceTerminalTurnLifecycle(terminalTurnLifecycle, { idle: terminalIdleVisible });
        const statusKey = JSON.stringify(statuses || []);
        if (statusKey !== lastStatusKey) {
          lastStatusKey = statusKey;
          emitTerminal({ type: 'terminal_status', statuses });
        }
        const permissionPrompt = detectTerminalPermissionPrompt(recentForStatus);
        if (permissionPrompt && permissionPrompt.id !== lastPermissionKey) {
          lastPermissionKey = permissionPrompt.id;
          emitTerminal({
            type: 'terminal_permission_request',
            ...permissionPrompt,
            session: logicalSession,
            logical_session: logicalSession,
            claude_session: logicalSession,
            tmux_session: sessionName,
            terminal_session: sessionName,
            turn_id: turnId,
          });
        } else if (!permissionPrompt) {
          lastPermissionKey = '';
        }
        if (!transcript) {
          if (!activeTranscriptPath || Date.now() - lastActiveTranscriptProbe > 1800) {
            lastActiveTranscriptProbe = Date.now();
            const activeNow = await activeClaudeTranscriptFromTmux(sessionName).catch(() => null);
            if (activeNow?.path) activeTranscriptPath = activeNow.path;
          }
          transcript = chooseTranscriptCandidate(transcriptSnapshot, rawPrompt0 || rawPrompt, rawPrompt, turnStartMs, activeTranscriptPath);
          if (transcript) {
            lastTranscriptSize = transcript.size || 0;
            lastTranscriptChange = Date.now();
            if (rec.transcript_path !== transcript.path) {
              rec.transcript_path = transcript.path;
              rec.transcript_bound_at = new Date().toISOString();
              st.conversations[key] = rec;
              terminalWriteState(st);
            }
            emitTerminal({ type: 'terminal_status', statuses: [{ type:'transcript', label: transcript.active ? '已绑定当前 Claude Code transcript' : '已接到 Claude Code transcript' }] });
          }
        }
        if (transcript) {
          const extracted = extractAssistantFromTranscript(transcript.path, {
            offset: transcript.offset || 0,
            userPrompt: rawPrompt0 || rawPrompt,
            fullPrompt: rawPrompt,
            turnStartMs,
          }, rawPrompt0 || rawPrompt);
          terminalTurnLifecycle = advanceTerminalTurnLifecycle(terminalTurnLifecycle, {
            idle: terminalIdleVisible,
            assistantActivity: Boolean(extracted.assistantCount || extracted.toolCount || extracted.thinking || extracted.text),
          });
          if (extracted.toolCount) transcriptToolSeen = true;
          if (extracted.size && extracted.size !== lastTranscriptSize) {
            lastTranscriptSize = extracted.size;
            lastTranscriptChange = Date.now();
          }
          if (extracted.thinking && extracted.thinking !== lastThinking) {
            lastThinking = extracted.thinking;
            emitTerminal({ type: 'terminal_thinking', text: extracted.thinking.slice(-12000), source: 'transcript' });
          }
          const toolNames = Array.isArray(extracted.toolNames) ? extracted.toolNames.slice(0, 5) : [];
          const toolNamesKey = toolNames.join('|');
          if (!extracted.final && toolNames.length && toolNamesKey !== lastToolNamesKey) {
            lastToolNamesKey = toolNamesKey;
            emitTerminal({
              type: 'terminal_status',
              statuses: toolNames.map(name => ({ type:'tool', label:`Claude Code 调用 ${name}` })),
            });
          } else if (!extracted.final && !terminalIdleVisible && extracted.toolCount && !statuses.some(s => s.type === 'tool')) {
            emitTerminal({ type: 'terminal_status', statuses: [{ type:'tool', label:'Claude Code 正在调用工具 / MCP' }] });
          }
          if (extracted.text) {
            finalFromTranscript = extracted.text;
            finalByStopReason = Boolean(extracted.final);
            if (finalFromTranscript !== lastPreview) {
              lastPreview = finalFromTranscript;
              lastPreviewAt = Date.now();
              if (extracted.final) transcriptFinalReadyAt = Date.now();
              emitTerminal({ type: 'terminal_preview', text: finalFromTranscript.slice(-16000), source: 'transcript' });
            } else if (extracted.final && !transcriptFinalReadyAt) {
              transcriptFinalReadyAt = Date.now();
            }
          }
          if (extracted.interrupted) {
            // 权限被拒/Esc 中断：这轮不会再有回复，立即收口，别等 15 分钟硬超时（bug#16）。
            turnInterrupted = true;
            if (extracted.text) finalFromTranscript = extracted.text;
            emitTerminal({ type: 'terminal_status', statuses: [{ type:'info', label:'工具调用被拒绝/中断，本轮已结束' }] });
            break;
          }
        }
        const permissionVisible = !terminalIdleVisible && (Boolean(permissionPrompt) || statuses.some(s => s.type === 'permission'));
        // Only current live controls may keep the turn busy. Scrollback text is inert.
        const busyVisible = !terminalIdleVisible && (/\bThinking\b|Cogitating|Esc to interrupt|thinking|思考|工具|Do you want to proceed/i.test(recentForStatus) || statuses.some(s => s.type === 'thinking' || s.type === 'tool' || s.type === 'permission' || s.type === 'input'));
        if (!finalFromTranscript && terminalTurnLifecycle.settled && !busyVisible && !permissionVisible) {
          const paneReply = extractAssistantFromTerminalPane(before, nowPane, rawPrompt0 || rawPrompt);
          if (paneReply) {
            finalFromPane = paneReply;
            if (paneReply !== lastPaneFallbackPreview) {
              lastPaneFallbackPreview = paneReply;
              lastPaneFallbackAt = Date.now();
              emitTerminal({ type: 'terminal_preview', text: paneReply.slice(-16000), source: 'tmux-pane-fallback' });
            }
          }
        }
        const age = Date.now() - start;
        const paneIdle = Date.now() - lastPaneChange;
        const transcriptIdle = Date.now() - lastTranscriptChange;
        const previewStable = lastPreview && lastPreviewAt && (Date.now() - lastPreviewAt > TERMINAL_CHAT_STABLE_FINAL_MS);
        const previewFastStable = lastPreview && lastPreviewAt && (Date.now() - lastPreviewAt > TERMINAL_CHAT_FAST_FINAL_MS);
        const stopReasonStable = finalByStopReason && transcriptFinalReadyAt && (Date.now() - transcriptFinalReadyAt > Math.min(1800, TERMINAL_CHAT_STABLE_FINAL_MS));
        const previewMaySettle = terminalTranscriptPreviewMaySettle(transcriptToolSeen, finalByStopReason);
        if (finalFromTranscript && !permissionVisible) {
          if (stopReasonStable) break;
          if (age > 3500 && previewFastStable && !busyVisible && previewMaySettle) break;
          // transcript 是最终收口的主信源。pane 里可能残留旧的 Thinking/Thought for 状态行，
          // 不能让 stale tmux 文本把一个已经稳定写完的 JSONL 回复卡到超时。
          // 工具调用期间(busyVisible)预览文本本就不会变，不能把"还在等工具返回"误判成"稳定收尾"。
          if (age > 12000 && transcriptIdle > TERMINAL_CHAT_IDLE_MS && previewStable && !busyVisible && previewMaySettle) break;
          if (age > Math.min(TERMINAL_CHAT_IDLE_MIN_MS, 12000) && transcriptIdle > TERMINAL_CHAT_IDLE_MS && paneIdle > Math.min(TERMINAL_CHAT_IDLE_MS, 4500) && !busyVisible && previewStable && previewMaySettle) break;
        }
        if (!finalFromTranscript && finalFromPane && !permissionVisible) {
          const paneFallbackStable = lastPaneFallbackAt && (Date.now() - lastPaneFallbackAt > Math.min(TERMINAL_CHAT_STABLE_FINAL_MS, 4500));
          if (age > 9000 && paneIdle > Math.min(TERMINAL_CHAT_IDLE_MS, 4500) && paneFallbackStable) break;
        }
      }

      if (transcript) {
        const extracted = extractAssistantFromTranscript(transcript.path, {
          offset: transcript.offset || 0,
          userPrompt: rawPrompt0 || rawPrompt,
          fullPrompt: rawPrompt,
          turnStartMs,
        }, rawPrompt0 || rawPrompt);
        if (extracted.text) finalFromTranscript = extracted.text;
      }

      if (!finalFromTranscript && !turnInterrupted) {
        const afterFinalPane = await captureTerminalTail(sessionName).catch(() => lastPane);
        const afterFinalIdle = terminalPaneIsIdle(afterFinalPane.split('\n').slice(-50).join('\n'));
        terminalTurnLifecycle = advanceTerminalTurnLifecycle(terminalTurnLifecycle, { idle: afterFinalIdle });
        if (terminalTurnLifecycle.settled) {
          const paneReply = extractAssistantFromTerminalPane(before, afterFinalPane, rawPrompt0 || rawPrompt);
          if (paneReply) finalFromPane = paneReply;
        }
      }

      const chosenFinal = finalFromTranscript || finalFromPane
        || (turnInterrupted ? '（本轮工具调用被拒绝/中断，Claude 已停下等待你的下一条消息。）' : '');
      recordTerminalChatTurn(st, key, rec, rawPrompt0 || rawPrompt, chosenFinal, { session: logicalSession, turnId });

      if (relayPendingAtStart) {
        rec.relay_pending = false;
        rec.relay_trigger = false;
        rec.turns_since_relay = 0;
        rec.bootstrapped_at = new Date().toISOString();
        rec.profile_hash = terminalBootstrapHash;
        rec.tmux_session = sessionName;
        rec.session = logicalSession;
        rec.active_session = logicalSession;
        rec.messages = Array.isArray(rec.messages) ? rec.messages.slice(-TERMINAL_CHAT_RELAY_RECENT_MESSAGES) : [];
        resetTerminalChatContextCounter(rec, 'relay_bootstrap_completed'); // fix: reset after bootstrap
        rec.relay_total_chars = terminalChatVisibleContextChars(rec);
        rec.effective_context_chars = terminalChatContextChars(rec);
        rec.relay_reason = 'relay_bootstrap_completed';
        rec.relay_file = TERMINAL_CHAT_RELAY_FILE;
        rec.relay_file_version = terminalRelayFileVersion();
        st.conversations[key] = rec;
        terminalWriteState(st);
        emitTerminal({
          type: 'terminal_relay',
          phase: 'bootstrap_completed',
          session: logicalSession,
          logical_session: logicalSession,
          claude_session: logicalSession,
          tmux_session: sessionName,
          terminal_session: sessionName,
          relay_index: rec.relay_index || 0,
          relay_file: TERMINAL_CHAT_RELAY_FILE,
          relay_file_version: rec.relay_file_version || '',
          relay_state: terminalRelayStatePayload(rec, { tail: await captureTerminalTail(sessionName).catch(() => '') }),
        });
      } else if (relayTriggerAtStart) {
        const relayFileVersionAfter = terminalRelayFileVersion();
        const relayFileUpdated = Boolean(relayFileVersionAfter && relayFileVersionAfter !== relayFileVersionAtStart);
        if (relayFileUpdated) {
          try {
            await pasteTerminalRawText(sessionName, '/clear', { enter: true });
            await new Promise(r => setTimeout(r, 2500));
          } catch (_) {}
          rec.relay_index = Number(rec.relay_index || 0) + 1;
          const nextLogicalSession = terminalLogicalSessionName(key, rec.relay_index || 0);
          rec.turns_since_relay = 0;
          resetTerminalChatContextCounter(rec, 'relay_clear_after_summary');
          rec.previous_session = logicalSession;
          rec.tmux_session = sessionName;
          rec.active_session = nextLogicalSession;
          rec.session = nextLogicalSession;
          rec.bootstrapped_at = '';
          rec.profile_hash = '';
          rec.relay_pending = true;
          rec.relay_trigger = false;
          rec.relay_reason = 'relay_file_ready_after_reply';
          rec.relay_file = TERMINAL_CHAT_RELAY_FILE;
          rec.relay_file_version = relayFileVersionAfter;
          rec.relay_file_detected_at = new Date().toISOString();
          rec.relay_total_chars = terminalChatVisibleContextChars(rec);
          rec.effective_context_chars = terminalChatContextChars(rec);
          st.conversations[key] = rec;
          terminalWriteState(st);
          emitTerminal({
            type: 'terminal_relay',
            phase: 'cleared_pending_bootstrap',
            session: nextLogicalSession,
            logical_session: nextLogicalSession,
            claude_session: nextLogicalSession,
            tmux_session: sessionName,
            terminal_session: sessionName,
            relay_index: rec.relay_index || 0,
            relay_file: TERMINAL_CHAT_RELAY_FILE,
            relay_state: terminalRelayStatePayload(rec, { tail: '' }),
          });
        } else {
          // 固定 relay.txt 没有产生新版本：保持 relay_trigger=true，下一轮继续在用户消息前注入写摘要指令。
          rec.relay_trigger = true;
          rec.relay_reason = terminalRelayFileExists() ? 'relay_file_unchanged_after_reply' : 'relay_file_missing_after_reply';
          rec.relay_total_chars = terminalChatVisibleContextChars(rec);
          rec.effective_context_chars = terminalChatContextChars(rec);
          st.conversations[key] = rec;
          terminalWriteState(st);
        }
      }

      // Clear the last thinking/tool/permission badge before publishing final.
      emitTerminal({ type: 'terminal_status', statuses: [] });
      emitTerminal({
        type: 'terminal_final',
        text: chosenFinal,
        interrupted: turnInterrupted,
        transcript: Boolean(finalFromTranscript),
        pane_fallback: Boolean(!finalFromTranscript && finalFromPane),
        transcript_path: transcript?.path || '',
        session: rec.active_session || logicalSession,
        logical_session: rec.active_session || logicalSession,
        claude_session: rec.active_session || logicalSession,
        tmux_session: sessionName,
        terminal_session: sessionName,
        turn_id: turnId,
        relay_index: rec.relay_index || 0,
        turns_since_relay: rec.turns_since_relay || 0,
        relay_state: terminalRelayStatePayload(rec, { tail: await captureTerminalTail(sessionName).catch(() => '') }),
        fallback_needed: !chosenFinal,
      });
      terminalTurnRun.done = true;
      terminalTurnRun.updatedAt = Date.now();
      if (!res.destroyed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (e) {
      emitTerminal({ type: 'error', error: e.message || String(e), turn_id: turnId });
      terminalTurnRun.done = true;
      terminalTurnRun.updatedAt = Date.now();
      if (!res.destroyed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });

  return {
    terminalReadState,
    terminalCompactText,
    fireRelayHandoffSummary,
    __test: { extractAssistantFromTranscript, extractAssistantFromTerminalPane, chooseTranscriptCandidate, transcriptCandidateFromPath },
  };
}

module.exports = { createTerminalChat, terminalPaneHasReadyComposer, advanceTerminalTurnLifecycle, terminalTranscriptPreviewMaySettle };
