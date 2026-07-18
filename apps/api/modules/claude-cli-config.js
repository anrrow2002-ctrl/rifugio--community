const MODEL_MAP = {
  opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
  'opus-4-6': 'claude-opus-4-6',
};

const THINK_BUDGET = '3000';
const CLAUDE_SPAWN_TIMEOUT_MS = Math.max(180000, Math.min(30 * 60 * 1000, Number(process.env.RIFUGIO_CLAUDE_SPAWN_TIMEOUT_MS || 15 * 60 * 1000) || 15 * 60 * 1000));

function resolveCliModel(model) {
  if (!model || model === 'default') return 'opus';
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  if (/^claude-/.test(model)) return model;
  return 'opus';
}

function resolveThinkBudget(effort) {
  const v = String(effort == null ? 'medium' : effort).trim().toLowerCase();
  if (!v || ['off', 'none', 'false', '0', 'disabled'].includes(v)) return '';
  if (v === 'low') return '1024';
  if (v === 'high') return '6000';
  return THINK_BUDGET;
}

module.exports = {
  MODEL_MAP,
  THINK_BUDGET,
  CLAUDE_SPAWN_TIMEOUT_MS,
  resolveCliModel,
  resolveThinkBudget,
};
