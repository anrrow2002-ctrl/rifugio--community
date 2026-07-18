'use strict';

function mountClaudeConversationStateRoute(app, deps = {}) {
  const { loadClaudeConversationState } = deps;

  app.get('/api/conversations/:id/state', (req, res) => {
    try {
      const state = loadClaudeConversationState(req.params.id, {
        autoSessionRelay: req.query.auto_session_relay,
        autoSessionRelayTurns: req.query.auto_session_relay_turns,
      });
      if (!state) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, ...state });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
}

module.exports = { mountClaudeConversationStateRoute };
