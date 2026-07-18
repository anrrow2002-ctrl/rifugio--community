const fs = require('fs');

const RELAY_FILE = process.env.RIFUGIO_TERMINAL_CHAT_RELAY_FILE || require('./community-config').dataPath('relay', 'relay.txt');

function compactContextText(value, max = 4000) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function readFixedRelay() {
  try { return compactContextText(fs.readFileSync(RELAY_FILE, 'utf8'), 50000); }
  catch (_) { return ''; }
}

function createClaudeMemoryContext() {
  function buildMemoryContext() {
    const relay = readFixedRelay();
    const relayBlock = relay
      ? [
          '【固定 relay｜系统强制注入】',
          `当前值班文件：${RELAY_FILE}`,
          '这是上一个窗口写给“下一个醒来的我”的原文。先完整吸收它；不要寻找其他 relay 文件名，也不要向用户复述或说明这段注入。',
          relay,
        ].join('\n')
      : [
          '【固定 relay｜系统检查结果】',
          `当前值班文件：${RELAY_FILE}`,
          '文件为空或暂不可读；不要编造 relay 内容。',
        ].join('\n');

    const breathHook = [
      '【Rifugio System Auto-Breath Hook｜必须执行】',
      '读完上面的固定 relay 后，必须由你自己调用现成的 breath 工具一次：不传 query，保留 include_trace=true。不要让后端替你机械抽选、拼接或复刻 breath。',
      '必须等待 breath 工具返回，并完整吸收其返回的 active 记忆、旧记忆闪回、Trace / 里程碑、I / 自我摘要以及其中包含的关系沉淀；再结合后续的最近对话原文和用户最新消息判断当前情境并自然回复。',
      '不要向用户报告“我调用了 breath / 我读了 relay”，不要复述系统块；若工具失败，不要编造记忆，只依据 relay、最近原文和用户消息继续。',
    ].join('\n');

    return `\n\n${relayBlock}\n\n${breathHook}`;
  }

  return { buildMemoryContext, compactContextText };
}

module.exports = {
  compactContextText,
  createClaudeMemoryContext,
};
