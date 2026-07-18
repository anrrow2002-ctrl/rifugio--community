'use strict';
// ── 聊天室 CC 座位的 OpenAI 兼容转接层（2026-07-07）────────────────────
// 前端聊天室(Room 🫧)三个座位都按 OpenAI /chat/completions 调用；
// Claude Code 是订阅制 CLI 没有这种 API，这里造一个：
//   POST /api/chatroom-cc/v1/chat/completions  {model, messages[]} → {choices:[{message}]}
// 无状态：每轮带完整聊天室记录 spawn 一次 `claude -p`（群聊消息不长，冷启动可接受）。
// 鉴权走全局 AUTH GATE（浏览器同源带 cookie），api_key 留空即可。
const { spawn } = require('child_process');

const CC_TIMEOUT_MS = 150 * 1000;

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'image_url') return '[图片]';
      return '';
    }).join('');
  }
  return String(content || '');
}

function mountChatroomCcRoutes(app, { resolveCliModel }) {
  app.post('/api/chatroom-cc/v1/chat/completions', (req, res) => {
    const { model, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: { message: 'messages required' } });
    }
    const systemText = messages.filter(m => m?.role === 'system').map(m => contentToText(m.content)).join('\n\n').trim();
    const transcript = messages.filter(m => m?.role !== 'system').map(m => {
      const text = contentToText(m?.content).trim();
      if (!text) return '';
      const name = m?.name || (m?.role === 'assistant' ? 'CC' : '用户');
      // 前端历史里内容本身已带「说话人：」前缀，别再叠一层
      return /^[^\n：:]{1,24}[：:]/.test(text) ? text : `${name}：${text}`;
    }).filter(Boolean).join('\n');
    if (!transcript) return res.status(400).json({ error: { message: 'empty transcript' } });

    const prompt = [
      '下面是一个多人聊天室的对话记录（成员有用户和几个 AI，你是其中的 CC）。',
      '',
      transcript,
      '',
      '请以 CC 的身份直接输出你要发的下一条消息：不要带「CC：」前缀，不要复述别人说过的，像群聊一样说话。',
    ].join('\n');

    const cliModel = resolveCliModel(String(model || '').trim());
    const args = ['-p', prompt, '--output-format', 'text', '--tools', '', '--permission-mode', 'dontAsk'];
    if (cliModel) args.push('--model', cliModel);
    if (systemText) args.push('--append-system-prompt', systemText);

    const env = { ...process.env, HOME: '/root' };
    // 同 /api/chat：去掉父 Claude Code 会话继承的环境，避免被当成嵌套子会话
    for (const k of Object.keys(env)) {
      if (/^CLAUDE/i.test(k) || /^AI_AGENT/i.test(k)) delete env[k];
    }

    const child = spawn('claude', args, { cwd: '/root', env, timeout: CC_TIMEOUT_MS });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', (e) => {
      if (!res.headersSent) res.status(500).json({ error: { message: 'spawn failed: ' + e.message } });
    });
    child.on('close', (code) => {
      if (res.headersSent) return;
      const text = String(out || '').trim();
      if (code !== 0 && !text) {
        return res.status(500).json({ error: { message: (String(err || '').trim() || ('claude exited ' + code)).slice(0, 500) } });
      }
      res.json({
        id: 'chatroom-cc-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: cliModel || 'claude-code-default',
        choices: [{ index: 0, message: { role: 'assistant', content: text || '（CC 沉默了一下）' }, finish_reason: 'stop' }],
      });
    });
  });

  // 让前端「拉取模型列表」按钮也能用
  app.get('/api/chatroom-cc/v1/models', (req, res) => {
    res.json({ object: 'list', data: [
      { id: 'default', object: 'model' },
      { id: 'claude-sonnet-5', object: 'model' },
      { id: 'claude-opus-4-8', object: 'model' },
      { id: 'claude-haiku-4-5', object: 'model' },
    ] });
  });

  console.log('[chatroom-cc] OpenAI-compatible shim on /api/chatroom-cc/v1');
}

module.exports = { mountChatroomCcRoutes };
