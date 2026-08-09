'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8069';
const ACTIONS = Object.freeze({
  skip: { method: 'POST', requires:['who'], path: ({ game, who }) => `/skip/${game}/${who}` },
  swap: { method: 'POST', requires:['who'], path: ({ game, who }) => `/swap/${game}/${who}` },
  done: { method: 'POST', requires:['who'], path: ({ game, who }) => `/done/${game}/${who}` },
  pay_toll: { method: 'POST', requires:['who'], path: ({ game, who }) => `/pay_toll/${game}/${who}` },
  serve_toll: { method: 'POST', requires:['who'], path: ({ game, who }) => `/serve_toll/${game}/${who}` },
  buyout_super: { method: 'POST', requires:['who'], path: ({ game, who }) => `/buyout/${game}/${who}` },
  buy_card: { method: 'POST', requires:['who'], path: ({ game, who }) => `/buy_card/${game}/${who}` },
  reroll_identity: { method: 'POST', requires:['who'], path: ({ game, who }) => `/reroll_identity/${game}/${who}` },
  reroll_task: { method: 'POST', requires:['who'], path: ({ game, who }) => `/reroll_task/${game}/${who}` },
  extra_task: { method: 'POST', requires:['who'], path: ({ game, who }) => `/extra_task/${game}/${who}` },
  duel_result: { method: 'POST', requires:['winner'], path: ({ game, winner }) => `/duel_result/${game}/${winner}` },
  use_card: { method: 'POST', requires:['who','index'], path: ({ game, who, index }) => `/use_card/${game}/${who}/${index}` },
  discard_card: { method: 'POST', requires:['who','index'], path: ({ game, who, index }) => `/discard/${game}/${who}/${index}` },
  guess_mark: { method: 'POST', requires:['who','spot'], path: ({ game, who, spot }) => `/guess_mark/${game}/${who}/${spot}` },
});

function segment(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`missing ${name}`);
  return encodeURIComponent(text);
}

function actionRequest(action, gameId, body = {}) {
  const config = ACTIONS[action];
  if (!config) throw new Error(`unsupported action: ${action}`);
  for (const name of config.requires || []) segment(body[name], name);
  const args = {
    game: segment(gameId, 'game_id'),
    who: body.who == null ? '' : segment(body.who, 'who'),
    winner: body.winner == null ? '' : segment(body.winner, 'winner'),
    index: body.index == null ? '' : segment(body.index, 'index'),
    spot: body.spot == null ? '' : segment(body.spot, 'spot'),
  };
  return { method: config.method, path: config.path(args) };
}

function mountSpicyMonopolyRoutes(app, options = {}) {
  const baseUrl = String(options.baseUrl || process.env.SPICY_MONOPOLY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(options.timeoutMs || process.env.SPICY_MONOPOLY_TIMEOUT_MS || 15000);

  async function upstream(req, res, method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch (_) { data = { error: raw || `game service returned ${response.status}` }; }
      res.status(response.status).json(data);
    } catch (error) {
      const unavailable = error?.name === 'AbortError' ? '游戏服务响应超时' : '游戏服务暂时没有回应';
      res.status(502).json({ ok: false, error: unavailable });
    } finally {
      clearTimeout(timer);
    }
  }

  app.get('/api/games/spicy-monopoly/help', (req, res) => upstream(req, res, 'GET', '/help'));
  app.post('/api/games/spicy-monopoly/new_game', (req, res) => upstream(req, res, 'POST', '/new_game', req.body || {}));
  app.post('/api/games/spicy-monopoly/roll/:gameId', (req, res) => upstream(req, res, 'POST', `/roll/${segment(req.params.gameId, 'game_id')}`, req.body || {}));
  app.get('/api/games/spicy-monopoly/state/:gameId', (req, res) => upstream(req, res, 'GET', `/state/${segment(req.params.gameId, 'game_id')}`));
  app.get('/api/games/spicy-monopoly/view/:gameId', (req, res) => upstream(req, res, 'GET', `/view/${segment(req.params.gameId, 'game_id')}`));
  app.get('/api/games/spicy-monopoly/final/:gameId', (req, res) => upstream(req, res, 'GET', `/final_result/${segment(req.params.gameId, 'game_id')}`));
  app.post('/api/games/spicy-monopoly/action/:gameId/:action', (req, res) => {
    try {
      const target = actionRequest(req.params.action, req.params.gameId, req.body || {});
      return upstream(req, res, target.method, target.path);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { mountSpicyMonopolyRoutes, actionRequest, ACTIONS };
