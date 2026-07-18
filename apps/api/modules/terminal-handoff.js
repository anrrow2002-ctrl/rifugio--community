'use strict';

const fs = require('fs');
const path = require('path');

const HANDOFF_DIR = process.env.RIFUGIO_HANDOFF_DIR || require('./community-config').dataPath('handoffs');

function mountTerminalHandoffRoute(app, deps = {}) {
  const {
    resolveClaudeSessionForConversation,
    compactContextText,
    buildTalkConversationSummary,
    profileBlock,
    resolveCharacterPrompt,
    buildMemoryContext,
    markProfileInjected,
    openLedgerDb,
    recordClaudeHandoffSummary,
  } = deps;

  app.post('/api/terminal/handoff', (req, res) => {
    const { session_id, workspace, summary, conversation_id, system_prompt, profile_context, character_prompt } = req.body || {};
    const conversationId = String(conversation_id || '').trim() || 'default';
    const activeSessionId = resolveClaudeSessionForConversation(conversationId, session_id);
    const frontendSummary = compactContextText(summary, 8000);
    const dbSummary = buildTalkConversationSummary(conversationId);
    const profileText = system_prompt || profile_context || '';
    const profile = profileText ? profileBlock(profileText) : '';
    const character = resolveCharacterPrompt(character_prompt);
    const memory = buildMemoryContext();
    const terminalBootstrap = [
      memory,
      profile,
      character,
      dbSummary ? `\n\n【最近聊天记录｜后端从 chat_convos 生成】\n${dbSummary}` : '',
      frontendSummary ? `\n\n【前端补充交接摘要】\n${frontendSummary}` : '',
    ].filter(Boolean).join('\n');
    if (!terminalBootstrap.trim()) return res.status(400).json({ ok: false, error: 'nothing to handoff' });
    try {
      fs.mkdirSync(HANDOFF_DIR, { recursive: true });
      const sid = String(activeSessionId || '').replace(/[^0-9a-fA-F-]/g, '').slice(0, 40);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const fname = `handoff-${ts}${sid ? '-' + sid.slice(0, 8) : ''}.md`;
      const fpath = path.join(HANDOFF_DIR, fname);
      const resumeCmd = sid ? `claude --resume ${sid}` : 'claude --continue';
      // v6 不再生成 claude -p 注入命令；聊天模式会在新 interactive session / 接力 / 资料变更时自动注入上下文。
      const injectCmd = '';
      const md = [
        `# Rifugio 对话交接 handoff`,
        ``,
        `- 生成时间: ${new Date().toISOString()}`,
        `- session_id: ${activeSessionId || '(unknown)'}`,
        `- conversation_id: ${conversationId}`,
        `- workspace: ${workspace || '/root'}`,
        `- 恢复命令: \`${resumeCmd}\``,
        `- 交互式注入方式: 打开 \`${resumeCmd}\` 后，把本文件正文粘贴进 Claude Code；Terminal Chat 聊天模式会自动注入，无需手动。`,
        ``,
        `请先吸收下面的资料和最近对话，把它当作当前终端 Claude session 的最新上下文。不要复述这份文件，不要说“收到”；后续直接继续陪用户聊天/做事。若这里的资料与旧 session 记忆冲突，以这里为准。`,
        ``,
        `---`,
        ``,
        terminalBootstrap,
        ``,
      ].join('\n');
      fs.writeFileSync(fpath, md, 'utf8');
      if (profileText) markProfileInjected(profileText, { conversation_id: conversationId, session_id: activeSessionId || '' }, 'handoff_full');
      try {
        const ledgerDb = openLedgerDb(false);
        try {
          recordClaudeHandoffSummary(ledgerDb, {
            conversationId,
            surface: 'talk',
            fromSessionId: activeSessionId || '',
            toSessionId: '',
            summary: terminalBootstrap,
            last5TurnsSnapshot: dbSummary,
          });
        } finally {
          ledgerDb.close();
        }
      } catch (_) {}
      res.json({ ok: true, path: fpath, file: fname, session_id: activeSessionId || '', resume_command: resumeCmd, inject_command: injectCmd });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
}

module.exports = { mountTerminalHandoffRoute };
