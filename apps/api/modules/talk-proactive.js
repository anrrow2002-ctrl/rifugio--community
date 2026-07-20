const crypto = require('crypto');
const Database = require('./sqlite');
const { spawn } = require('child_process');

function createTalkProactive(ctx = {}) {
  const {
    DB_PATH,
    readJsonSetting,
    writeJsonSetting,
    sanitizeTalkMessages,
    sendWebPushNotification,
  } = ctx;
  const RIFUGIO_INTERNAL_TOKEN = process.env.RIFUGIO_INTERNAL_TOKEN || '';
  const TERMINAL_CHAT_INTERNAL_BASE = process.env.RIFUGIO_INTERNAL_BASE_URL || 'http://127.0.0.1:3457';

  const TALK_PROACTIVE_SETTINGS_KEY = 'talk_proactive_settings';
  const TALK_PROACTIVE_ACTIVITY_KEY = 'talk_proactive_activity';
  const TALK_PROACTIVE_EVENTS_KEY = 'talk_proactive_events';
  const TALK_PROACTIVE_POLL_MS = Math.max(15000, Math.min(5 * 60 * 1000, Number(process.env.RIFUGIO_TALK_PROACTIVE_POLL_MS || 30000) || 30000));
  const TALK_PROACTIVE_RECENT_CHAT_SECONDS = Math.max(10, Math.min(600, Number(process.env.RIFUGIO_TALK_PROACTIVE_RECENT_CHAT_SECONDS || 90) || 90));
  let talkProactiveRunning = false;

  function normalizeTalkProactiveSettings(input = {}) {
    const minMinutes = Math.max(1, Math.min(1440, Number(input.minMinutes ?? input.proactiveMinMinutes ?? 120) || 120));
    const randomMinutes = Math.max(0, Math.min(1440, Number(input.randomMinutes ?? input.proactiveRandomMinutes ?? 0) || 0));
    const normalizeHHMM = (value, fallback = '') => {
      const raw = String(value || '').trim();
      const m = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return fallback;
      const hh = Math.max(0, Math.min(23, Number(m[1]) || 0));
      const mm = Math.max(0, Math.min(59, Number(m[2]) || 0));
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
    return {
      enabled: Boolean(input.enabled),
      scriptEnabled: input.scriptEnabled !== false && input.proactiveScriptEnabled !== false,
      minMinutes,
      randomMinutes,
      quietSeconds: Math.max(10, Math.min(1800, Number(input.quietSeconds || TALK_PROACTIVE_RECENT_CHAT_SECONDS) || TALK_PROACTIVE_RECENT_CHAT_SECONDS)),
      activeStart: normalizeHHMM(input.activeStart || input.proactiveStartTime, '08:00'),
      activeEnd: normalizeHHMM(input.activeEnd || input.proactiveEndTime, '23:30'),
      timezone: String(input.timezone || input.proactiveTimezone || process.env.TZ || 'Asia/Kuala_Lumpur').trim().slice(0, 80),
      prompt: String(input.prompt || input.proactivePrompt || '').trim().slice(0, 600),
      barkUrl: String(input.barkUrl || '').trim().slice(0, 1000),
      conversationId: String(input.conversationId || input.conversation_id || '').trim().slice(0, 120),
      model: String(input.model || 'default').trim().slice(0, 80),
      effort: String(input.effort || 'medium').trim().slice(0, 20),
      systemPrompt: String(input.systemPrompt || input.system_prompt || '').trim().slice(0, 20000),
      characterPrompt: String(input.characterPrompt || input.character_prompt || '').trim().slice(0, 12000),
      updatedAt: new Date().toISOString(),
    };
  }

  function readTalkProactiveSettings() {
    return normalizeTalkProactiveSettings(readJsonSetting(TALK_PROACTIVE_SETTINGS_KEY, {}));
  }

  function writeTalkProactiveSettings(settings) {
    writeJsonSetting(TALK_PROACTIVE_SETTINGS_KEY, normalizeTalkProactiveSettings(settings));
  }

  function readTalkActivity() {
    const now = Date.now();
    const raw = readJsonSetting(TALK_PROACTIVE_ACTIVITY_KEY, {});
    return {
      lastUserAt: Number(raw.lastUserAt || 0) || 0,
      lastAnyAt: Number(raw.lastAnyAt || 0) || 0,
      lastAssistantAt: Number(raw.lastAssistantAt || 0) || 0,
      lastCallStatus: String(raw.lastCallStatus || ''),
      lastCallStatusAt: Number(raw.lastCallStatusAt || 0) || 0,
      lastPokeAt: Number(raw.lastPokeAt || 0) || 0,
      nextDueAt: Number(raw.nextDueAt || 0) || 0,
      lastTriggerAt: Number(raw.lastTriggerAt || 0) || 0,
      conversationId: String(raw.conversationId || ''),
      updatedAt: raw.updatedAt || new Date(now).toISOString(),
    };
  }

  function writeTalkActivity(patch = {}) {
    const prev = readTalkActivity();
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    writeJsonSetting(TALK_PROACTIVE_ACTIVITY_KEY, next);
    return next;
  }

  function computeTalkProactiveDelayMs(settings) {
    const base = Math.max(1, Number(settings.minMinutes || 120) || 120);
    const random = Math.max(0, Number(settings.randomMinutes || 0) || 0);
    return Math.floor((base + (random ? Math.random() * random : 0)) * 60 * 1000);
  }

  function ensureTalkProactiveDue(settings, activity) {
    if (!settings.enabled) return activity;
    const lastUserAt = Number(activity.lastUserAt || 0) || Date.now();
    const minDue = lastUserAt + Math.max(1, Number(settings.minMinutes || 120) || 120) * 60 * 1000;
    if (activity.nextDueAt && activity.nextDueAt >= minDue) return activity;
    return writeTalkActivity({ nextDueAt: lastUserAt + computeTalkProactiveDelayMs(settings) });
  }

  function hhmmToMinutes(value) {
    const m = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    return (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0);
  }

  function talkProactiveWindowState(settings, now = Date.now()) {
    if (settings.scriptEnabled === false) return { active: false, reason: 'script_disabled', nextAt: now + 60 * 60 * 1000 };
    const start = hhmmToMinutes(settings.activeStart);
    const end = hhmmToMinutes(settings.activeEnd);
    if (start == null || end == null || start === end) return { active: true, reason: 'all_day', nextAt: now };
    let parts;
    try {
      parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: settings.timezone || process.env.TZ || 'Asia/Kuala_Lumpur',
        hour:'2-digit',
        minute:'2-digit',
        hour12:false,
      }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    } catch (_) {
      parts = { hour: new Date(now).getHours(), minute: new Date(now).getMinutes() };
    }
    const currentHour = (Number(parts.hour) || 0) % 24;
    const current = currentHour * 60 + (Number(parts.minute) || 0);
    const active = start < end
      ? current >= start && current < end
      : current >= start || current < end;
    if (active) return { active: true, reason: 'inside_window', nextAt: now };
    const deltaMinutes = current < start
      ? start - current
      : (24 * 60 - current) + start;
    return { active: false, reason: 'outside_window', nextAt: now + Math.max(1, deltaMinutes) * 60 * 1000 };
  }

  function readTalkProactiveEvents() {
    const rows = readJsonSetting(TALK_PROACTIVE_EVENTS_KEY, []);
    return Array.isArray(rows) ? rows : [];
  }

  function pushTalkProactiveEvent(event) {
    const rows = readTalkProactiveEvents();
    rows.push({
      id: String(event.id || crypto.randomUUID()),
      createdAt: new Date().toISOString(),
      ...event,
    });
    writeJsonSetting(TALK_PROACTIVE_EVENTS_KEY, rows.slice(-80));
  }

  function markTalkActivityFromMessages(convo) {
    const messages = Array.isArray(convo?.messages) ? convo.messages : [];
    const recent = [...messages].reverse();
    const last = recent.find(m => m && (m.role === 'user' || m.role === 'assistant'));
    const lastUser = recent.find(m => m && m.role === 'user');
    const now = Date.now();
    const patch = { conversationId: String(convo?.id || '') };
    if (lastUser) patch.lastUserAt = Number(lastUser.created_at || lastUser.createdAt || lastUser.ts || lastUser.id || 0) || now;
    if (last?.role === 'assistant') patch.lastAssistantAt = now;
    if (last) patch.lastAnyAt = now;
    if (last) writeTalkActivity(patch);
  }

  function loadTalkConvoForProactive(settings) {
    const db = new Database(DB_PATH);
    try {
      const cid = String(settings.conversationId || readTalkActivity().conversationId || '').trim();
      const row = cid
        ? db.prepare('SELECT * FROM chat_convos WHERE id=?').get(cid)
        : db.prepare('SELECT * FROM chat_convos ORDER BY updated_at DESC LIMIT 1').get();
      if (!row) return null;
      let messages = [];
      try { messages = JSON.parse(row.messages || '[]'); } catch (_) {}
      return { ...row, messages: sanitizeTalkMessages(messages) };
    } finally {
      db.close();
    }
  }

  function saveTalkConvoMessages(convo, messages) {
    const db = new Database(DB_PATH);
    try {
      db.prepare(`UPDATE chat_convos SET messages=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(sanitizeTalkMessages(messages)), convo.id);
    } finally {
      db.close();
    }
  }

  function encodeBarkPathPart(value) {
    return encodeURIComponent(String(value || '').trim()).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  function buildTalkBarkTarget(url, title, body) {
    const bark = String(url || '').trim();
    if (!bark) return { skipped: true, reason: 'empty_bark_url' };
    const safeTitle = String(title || '').trim().slice(0, 120);
    const safeBody = String(body || '').trim().slice(0, 800);
    if (!safeTitle || !safeBody) return { skipped: true, reason: 'empty_bark_payload' };
    if (/^(title|标题)$/i.test(safeTitle) && /^(content|body|正文)$/i.test(safeBody)) {
      return { skipped: true, reason: 'placeholder_bark_payload' };
    }
    try {
      const u = new URL(bark);
      if (u.searchParams.has('title') || u.searchParams.has('body')) {
        u.searchParams.set('title', safeTitle);
        u.searchParams.set('body', safeBody);
        return { target: u.href };
      }
    } catch (_) {}
    const hashIndex = bark.indexOf('#');
    const withoutHash = hashIndex >= 0 ? bark.slice(0, hashIndex) : bark;
    const hash = hashIndex >= 0 ? bark.slice(hashIndex) : '';
    const queryIndex = withoutHash.indexOf('?');
    const rawBase = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
    const suffix = (queryIndex >= 0 ? withoutHash.slice(queryIndex) : '') + hash;
    const base = rawBase.replace(/\/+$/, '');
    if (!base) return { skipped: true, reason: 'invalid_bark_url' };
    const encodedTitle = encodeBarkPathPart(safeTitle);
    const encodedBody = encodeBarkPathPart(safeBody);
    let targetBase = base;
    const replaceSegment = (pattern, replacement) => {
      const next = targetBase.replace(pattern, `$1${replacement}`);
      const changed = next !== targetBase;
      targetBase = next;
      return changed;
    };
    const titleChanged = replaceSegment(/(^|\/)(?:Title|\{title\}|:title|标题)(?=\/|$)/i, encodedTitle);
    const bodyChanged = replaceSegment(/(^|\/)(?:Content|Body|\{content\}|\{body\}|:content|:body|正文)(?=\/|$)/i, encodedBody);
    if (titleChanged || bodyChanged) {
      if (!titleChanged) targetBase += `/${encodedTitle}`;
      if (!bodyChanged) targetBase += `/${encodedBody}`;
      return { target: `${targetBase}${suffix}` };
    }
    return { target: `${base}/${encodedTitle}/${encodedBody}${suffix}` };
  }

  async function sendTalkBark(url, title, body) {
    const built = buildTalkBarkTarget(url, title, body);
    if (!built.target) return { ok: false, skipped: true, reason: built.reason || 'invalid_bark_url' };
    const sendWithCurl = (fetchError = '', fetchStatus = 0) => new Promise(resolve => {
      let out = '', err = '';
      const child = spawn('curl', ['-sS', '-L', '--max-time', '12', '-o', '/dev/null', '-w', '%{http_code}', built.target], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('error', e => resolve({ ok: false, method: 'curl', fetchStatus, fetchError, error: e.message || String(e) }));
      child.on('close', code => {
        const status = Number(String(out || '').match(/(\d{3})\s*$/)?.[1] || 0) || 0;
        resolve({
          ok: code === 0 && status >= 200 && status < 300,
          method: 'curl',
          status,
          exitCode: code,
          fetchStatus,
          fetchError,
          error: code === 0 ? '' : (err || `curl exited ${code}`).slice(0, 180),
        });
      });
    });
    try {
      const r = await fetch(built.target, { method: 'GET' });
      if (r.ok) return { ok: true, status: r.status, method: 'fetch' };
      return await sendWithCurl('', r.status);
    } catch (e) {
      return await sendWithCurl(e.message || String(e), 0);
    }
  }

  function extractTalkBarkDirective(raw) {
    let text = String(raw || '');
    let directive = null;
    text = text.replace(/\[\[bark(?:[:：]([\s\S]*?))?\]\]/gi, (_all, payload = '') => {
      if (!directive) {
        const body = String(payload || '').trim();
        const sep = body.includes('|') ? '|' : (body.includes('｜') ? '｜' : '');
        if (sep) {
          const i = body.indexOf(sep);
          directive = {
            title: body.slice(0, i).trim().slice(0, 120),
            body: body.slice(i + sep.length).trim().slice(0, 800),
          };
        } else if (body) {
          directive = { title: 'Claude', body: body.slice(0, 800) };
        }
      }
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { text, bark: directive };
  }

  // 主动消息必须是"正在跟她聊天的那个 session"，不能另开一个 claude 进程自己攒上下文——
  // 真实聊天在 terminal-chat.js 的 tmux 交互式 claude 里，那边不认 --session-id/--resume。
  // 唯一办法是内部回环调用 /api/terminal-chat/send，把提示文字当成一条"用户消息" paste
  // 进同一个 tmux pane，走它原有的整套收口逻辑。回环鉴权见 auth-passkey.js 的
  // isInternalProactiveRequest（socket 必须是 127.0.0.1/::1 + x-rifugio-internal token）。
  async function sendProactiveIntoTerminalChat(prompt, opts = {}) {
    if (!RIFUGIO_INTERNAL_TOKEN) throw new Error('RIFUGIO_INTERNAL_TOKEN 未配置，无法回环调用 terminal-chat');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`${TERMINAL_CHAT_INTERNAL_BASE}/api/terminal-chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-rifugio-internal': RIFUGIO_INTERNAL_TOKEN },
        body: JSON.stringify({
          prompt,
          conversation_id: opts.conversationId || 'talk-proactive',
          model: opts.model || 'default',
          effort: opts.effort || 'medium',
          system_prompt: opts.systemPrompt || '',
          character_prompt: opts.characterPrompt || '',
          bootstrap_context: '',
          force_relay: false,
          images: [],
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`terminal-chat/send ${res.status}: ${text.slice(0, 300)}`);
      let finalText = '';
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (_) { continue; }
        if (ev.type === 'terminal_final') finalText = String(ev.text || '');
        if (ev.type === 'error') throw new Error(ev.error || 'terminal-chat error');
      }
      return finalText;
    } finally {
      clearTimeout(timer);
    }
  }

  async function maybeRunTalkProactive() {
    if (talkProactiveRunning) return;
    const settings = readTalkProactiveSettings();
    if (!settings.enabled) return;
    const windowState = talkProactiveWindowState(settings);
    if (!windowState.active) {
      writeTalkActivity({ nextDueAt: windowState.nextAt });
      return;
    }
    let activity = ensureTalkProactiveDue(settings, readTalkActivity());
    const now = Date.now();
    if (!activity.lastUserAt || now < activity.nextDueAt) return;
    const quietSeconds = Number(settings.quietSeconds || TALK_PROACTIVE_RECENT_CHAT_SECONDS) || TALK_PROACTIVE_RECENT_CHAT_SECONDS;
    if (activity.lastAnyAt && now - activity.lastAnyAt < quietSeconds * 1000) {
      writeTalkActivity({ nextDueAt: now + Math.max(60 * 1000, quietSeconds * 1000) });
      return;
    }
    const minutes = Math.max(1, Math.floor((now - activity.lastUserAt) / 60000));
    const convo = loadTalkConvoForProactive(settings);
    if (!convo) return;
    talkProactiveRunning = true;
    try {
      const prompt = [
        `Rifugio System Auto-Prompt：\n对方已经${minutes}分钟没有联系你。请结合当前对话上下文，判断对方最后做了什么、你们聊到了哪里，再自然地主动发一条符合当前情境的消息吧～。如果上下文不足，不要编造，也不要只复述“多久没联系”。`,
        `主动脚本当前允许时间窗：${settings.activeStart || '全天'}-${settings.activeEnd || '全天'}（${settings.timezone || process.env.TZ || 'local'}）。时间窗外系统不会注入你。`,
        settings.barkUrl ? [
          'Bark：用户提供了 Bark URL/模板，后端会在本次主动消息生成后自动发送 push notification。',
          `Bark URL/模板：${settings.barkUrl}`,
          'Bark URL 格式等价于：curl "https://api.day.app/key/Title/Content?icon=https://example.com/icon.png"。',
          '不要自己调用工具或 curl 发送 Bark，避免重复推送。你可以单独输出一行 [[bark:标题|正文]] 来自定义推送标题和正文；如果不输出，后端会用对话名和你的主动消息正文发送。不要把 Title/Content/title/content 当成真实内容。',
        ].join('\n') : 'Bark：用户没有提供 Bark URL，不要输出 bark 指令。',
        '动态/朋友圈：你可以自行判断是否调用 post_pyq 发一条动态，不强制。想配图时先调用 generate_image，再把返回的相对图片链接传给 post_pyq；不要把动态全文重复发进聊天。',
        settings.prompt ? `用户给你的主动消息风格补充：${settings.prompt}` : '',
      ].filter(Boolean).join('\n');
      const rawContent = (await sendProactiveIntoTerminalChat(prompt, {
        conversationId: convo.id,
        model: settings.model,
        effort: settings.effort,
        systemPrompt: settings.systemPrompt,
        characterPrompt: settings.characterPrompt,
      })).trim() || '我刚刚想起你，来看看你在不在。';
      const barkDirective = extractTalkBarkDirective(rawContent);
      const content = barkDirective.text || '我刚刚想起你，来看看你在不在。';
      const msg = {
        id: Date.now(),
        role: 'assistant',
        content,
        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
        model: 'proactive',
        engine: 'agent',
        done: true,
        proactive: true,
      };
      const messages = Array.isArray(convo.messages) ? convo.messages : [];
      messages.push(msg);
      saveTalkConvoMessages(convo, messages);
      writeTalkActivity({
        lastAnyAt: now,
        lastAssistantAt: now,
        lastTriggerAt: now,
        conversationId: convo.id,
        nextDueAt: now + computeTalkProactiveDelayMs(settings),
      });
      const title = convo.name || 'Claude';
      const barkTitle = barkDirective.bark?.title || title;
      const barkBody = barkDirective.bark?.body || content.slice(0, 180) || '发来一条新消息';
      let barkResult = settings.barkUrl
        ? await sendTalkBark(settings.barkUrl, barkTitle, barkBody)
        : { ok: false, skipped: true, reason: 'empty_bark_url' };
      if (settings.barkUrl && barkResult?.skipped && barkResult.reason === 'placeholder_bark_payload') {
        barkResult = await sendTalkBark(settings.barkUrl, title, content.slice(0, 180) || '发来一条新消息');
        barkResult.placeholderFallback = true;
      }
      const pushResult = await sendWebPushNotification({
        title,
        body: content.slice(0, 180),
        tag: `rifugio-talk-${convo.id}`,
        data: { app: 'talk', convoId: convo.id, messageId: msg.id },
      });
      pushTalkProactiveEvent({ type: 'talk-proactive-message', conversationId: convo.id, message: msg, bark: barkResult, push: pushResult });
    } catch (e) {
      writeTalkActivity({ nextDueAt: Date.now() + 5 * 60 * 1000 });
      pushTalkProactiveEvent({ type: 'talk-proactive-error', error: e.message || String(e) });
    } finally {
      talkProactiveRunning = false;
    }
  }

  function mountTalkProactiveRoutes(app) {
    app.get('/api/talk/proactive/settings', (_req, res) => {
      res.json({ ok: true, settings: readTalkProactiveSettings(), activity: readTalkActivity() });
    });

    app.put('/api/talk/proactive/settings', (req, res) => {
      const settings = normalizeTalkProactiveSettings(req.body || {});
      writeTalkProactiveSettings(settings);
      const activity = settings.enabled ? ensureTalkProactiveDue(settings, readTalkActivity()) : readTalkActivity();
      res.json({ ok: true, settings, activity });
    });

    app.post('/api/talk/activity', (req, res) => {
      const now = Date.now();
      const kind = String(req.body?.kind || 'any');
      const patch = { lastAnyAt: now };
      if (kind === 'user') patch.lastUserAt = now;
      if (kind === 'assistant') patch.lastAssistantAt = now;
      if (kind === 'poke') patch.lastPokeAt = now;
      if (kind === 'call') {
        patch.lastCallStatus = String(req.body?.status || '').slice(0, 120);
        patch.lastCallStatusAt = now;
      }
      if (req.body?.conversationId || req.body?.conversation_id) patch.conversationId = String(req.body.conversationId || req.body.conversation_id);
      if (kind === 'poke') {
        pushTalkProactiveEvent({
          type: 'talk-activity',
          kind,
          conversationId: patch.conversationId || '',
          label: String(req.body?.label || '').slice(0, 120),
        });
      }
      if (kind === 'call') {
        pushTalkProactiveEvent({
          type: 'talk-call-status',
          kind,
          conversationId: patch.conversationId || '',
          status: patch.lastCallStatus,
        });
      }
      const settings = readTalkProactiveSettings();
      const activity = writeTalkActivity(patch);
      res.json({ ok: true, activity: settings.enabled && kind === 'user' ? ensureTalkProactiveDue(settings, activity) : activity });
    });

    app.get('/api/talk/proactive/events', (req, res) => {
      const since = String(req.query.since || '');
      const rows = readTalkProactiveEvents();
      const index = since ? rows.findIndex(e => e.id === since) : -1;
      res.json({ ok: true, events: index >= 0 ? rows.slice(index + 1) : rows.slice(-20), latest: rows[rows.length - 1]?.id || '' });
    });
  }

  return {
    TALK_PROACTIVE_POLL_MS,
    markTalkActivityFromMessages,
    maybeRunTalkProactive,
    mountTalkProactiveRoutes,
    pushTalkProactiveEvent,
  };
}

module.exports = { createTalkProactive };
