(() => {
  'use strict';
  const API = '/api/games/spicy-monopoly';
  const $ = id => document.getElementById(id);
  const setupView = $('setupView');
  const gameView = $('gameView');
  const storageKey = 'rifugio-spicy-monopoly-session-v1';
  const state = { gameId:'', token:'', rulesAck:'', view:null, last:null, busy:false, poll:0 };
  const tileEmoji = { start:'🏁', task:'✦', truth:'💬', shop:'🛍', jail:'🔒', chance:'🎴', mystery:'?' };
  const coords = [[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[2,6],[3,6],[4,6],[5,6],[6,6],[6,5],[6,4],[6,3],[6,2],[6,1],[5,1],[4,1],[3,1],[2,1]];

  async function request(path, options = {}) {
    const response = await fetch(API + path, { credentials:'include', cache:'no-store', ...options,
      headers: options.body ? { 'content-type':'application/json', ...(options.headers || {}) } : options.headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.detail || data.error || `请求失败 (${response.status})`);
    return data;
  }

  function setBusy(on, text = '') {
    state.busy = on; $('rollBtn').disabled = on; $('refreshBtn').disabled = on;
    $('gameStatus').textContent = text;
  }

  function saveSession() {
    localStorage.setItem(storageKey, JSON.stringify({ gameId:state.gameId, token:state.token, last:state.last }));
  }

  function parseList(value) { return String(value || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean); }
  function lineup(a, b) { return a === '男' && b === '男' ? '男男' : a === '女' && b === '女' ? '女女' : '男女'; }
  function dieGlyph(n) { return ['•','⚀','⚁','⚂','⚃','⚄','⚅'][Number(n) || 0]; }

  function boardData() {
    if (state.view?.tiles) return state.view.tiles;
    const total = Number(state.view?.total_rounds || 18);
    const special = total <= 12
      ? { 0:'start',5:'chance',8:'mystery',11:'jail',14:'truth',17:'shop' }
      : { 0:'start',4:'truth',5:'chance',8:'mystery',10:'jail',12:'shop',14:'truth',15:'chance',17:'mystery',19:'shop' };
    return Array.from({length:20}, (_,index) => ({ index, type:special[index] || 'task' }));
  }

  function renderBoard() {
    const board = $('board');
    board.querySelectorAll('.tile').forEach(el => el.remove());
    const players = state.view?.players || [];
    boardData().forEach(tile => {
      const el = document.createElement('div');
      const [row,col] = coords[tile.index];
      el.className = `tile ${tile.type !== 'task' ? 'special' : ''} ${tile.owner ? 'owner' : ''}`;
      el.style.gridArea = `${row}/${col}`;
      if (tile.owner) el.style.setProperty('--owner', players.find(p => p.name === tile.owner)?.color || '#fa8cad');
      el.innerHTML = `<span class="n">${tile.index}</span><span class="e">${tileEmoji[tile.type] || '✦'}</span><span class="markers"></span>`;
      const markers = el.querySelector('.markers');
      players.filter(p => Number(p.position) === tile.index).forEach(p => {
        const m = document.createElement('i'); m.className = 'marker'; m.style.setProperty('--marker', p.color || '#fff'); m.title = p.name; markers.appendChild(m);
      });
      board.appendChild(el);
    });
    $('gameIdLabel').textContent = `NO. ${state.gameId || '—'}`;
  }

  function renderPlayers() {
    const wrap = $('players'); wrap.textContent = '';
    (state.view?.players || []).forEach(p => {
      const card = document.createElement('article');
      card.className = 'player' + (state.view.turn === p.name ? ' active' : '');
      card.style.setProperty('--player', p.color || '#fa8cad');
      card.innerHTML = `<i class="player-color"></i><div class="player-top"><h3>${escapeHtml(p.name)}</h3><span class="coin">◉ ${p.coins}</span></div><p>${escapeHtml(p.identity?.name || '无身份')} · 第 ${Number(p.lap || 0)+1} 圈 · ${p.position} 格</p>`;
      wrap.appendChild(card);
    });
  }

  function escapeHtml(value) { const e=document.createElement('div'); e.textContent=String(value ?? ''); return e.innerHTML; }

  function taskFromView() {
    const pending = state.view?.pending_tasks || [];
    return pending[0] || null;
  }

  function actionButton(label, action, payload = {}, className = '') {
    const b = document.createElement('button'); b.textContent = label; b.className = className;
    b.onclick = () => runAction(action, payload); return b;
  }

  function renderMoment() {
    const task = taskFromView();
    const last = state.last || {};
    const toll = state.view?.pending_toll;
    const duel = state.view?.pending_duel;
    const actions = $('contextActions'); actions.textContent = '';
    let type = '等待掷骰', meta = state.view?.turn ? `轮到 ${state.view.turn}` : '轮到你们';
    let title = '棋盘已经铺好', text = '掷出骰子，让引擎决定你们会落在哪里。', tags = [];

    if (task) {
      type = task.truth ? '真心话' : task.super ? '超级任务' : '当前任务';
      meta = `${task.who} · 强度 ${task.strength}`; title = task.truth ? '说出你的答案' : '这一格，慢慢来'; text = task.content;
      tags = [task.type, ...(task.kink || [])].filter(Boolean);
      actions.append(actionButton('换一道', 'swap', { who:task.who }));
      actions.append(actionButton('跳过', 'skip', { who:task.who }, 'danger'));
      if (task.super) actions.append(actionButton('花币买断', 'buyout_super', { who:task.who }, 'danger'));
    } else if (toll) {
      type = '地盘事件'; meta = `${toll.who} → ${toll.landlord}`; title = '交钱，还是接受差遣？'; text = `${toll.who} 踩进了 ${toll.landlord} 的地盘，过路费 ${toll.fee} 币。`;
      actions.append(actionButton(`交 ${toll.fee} 币`, 'pay_toll', { who:toll.who }));
      actions.append(actionButton('差遣已经完成', 'serve_toll', { who:toll.who }));
    } else if (duel) {
      type = '同格对决'; title = '谁先破功，谁就输了'; text = '选出这一轮的赢家，才能继续推进。';
      (state.view?.players || []).forEach(p => actions.append(actionButton(`${p.name} 获胜`, 'duel_result', { winner:p.name })));
    } else if (last.task?.内容) {
      type = last.tile === 'truth' ? '真心话' : '刚刚抽到'; meta = last.who ? `${last.who} · 骰子 ${last.dice || '—'}` : meta; title = last.say || '这一轮'; text = last.task.内容;
      tags = [last.task.强度, last.task.玩法类型, last.task.kink].filter(Boolean);
    } else if (last.truth?.内容) {
      type = '真心话'; meta = last.who || meta; title = last.say || '回答它'; text = last.truth.内容;
    } else if (last.say) {
      type = '刚刚发生'; meta = last.who ? `${last.who} · 骰子 ${last.dice || '—'}` : meta; title = last.say; text = last.hint || '这一轮已经记进棋盘。';
    }
    $('momentType').textContent = type; $('momentMeta').textContent = meta; $('momentTitle').textContent = title; $('momentText').textContent = text;
    $('momentTags').innerHTML = tags.map(t => `<span>${escapeHtml(t)}</span>`).join('');
  }

  function render() {
    const v = state.view || {};
    const count = Number(v.turn_count || 0), total = Number(v.total_rounds || 18);
    $('roundLabel').textContent = `回合 ${count} / ${total}`; $('roundProgress').style.width = `${Math.min(100, count / total * 100)}%`;
    $('turnLabel').textContent = v.game_over ? '游戏结束' : v.turn ? `轮到 ${v.turn}` : '等待开局';
    $('dieFace').textContent = dieGlyph(state.last?.dice);
    $('rollBtn').querySelector('b').textContent = taskFromView() ? '完成并进入下一轮' : '掷骰';
    $('finalBtn').classList.toggle('hidden', !v.game_over);
    $('identityText').textContent = v.status || '';
    renderPlayers(); renderBoard(); renderMoment();
  }

  async function loadView(silent = false) {
    if (!state.gameId || state.busy) return;
    try {
      if (!silent) setBusy(true, '正在同步棋盘…');
      const previousTurn = state.view?.turn_count;
      state.view = await request(`/view/${encodeURIComponent(state.gameId)}`);
      if (silent && previousTurn != null && previousTurn !== state.view.turn_count) state.last = null;
      render();
      if (!silent) setBusy(false, '棋盘已同步');
    } catch (error) {
      if (!silent) setBusy(false, error.message);
    }
  }

  async function runAction(action, payload) {
    if (state.busy) return;
    try {
      setBusy(true, '正在结算…');
      const result = await request(`/action/${encodeURIComponent(state.gameId)}/${encodeURIComponent(action)}`, { method:'POST', body:JSON.stringify(payload) });
      state.last = { say:result.result || result.say || '操作已完成' }; saveSession(); await loadView(true); render(); setBusy(false, result.result || '已完成');
    } catch (error) { setBusy(false, error.message); }
  }

  async function roll() {
    if (state.busy) return;
    if (state.view?.pending_duel) { $('gameStatus').textContent = '请先选出对决赢家'; return; }
    try {
      setBusy(true, '骰子正在滚动…');
      const payload = await request(`/roll/${encodeURIComponent(state.gameId)}`, { method:'POST', body:'{}' });
      state.last = payload; saveSession(); await loadView(true); render(); setBusy(false, payload.settled || '这一轮已经落定');
    } catch (error) { setBusy(false, error.message); }
  }

  async function startGame(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget); $('setupStatus').textContent = '正在铺开棋盘…';
    try {
      if (!state.rulesAck) state.rulesAck = (await request('/help')).rules_ack;
      const p1Sex = form.get('p1_sex'), p2Sex = form.get('p2_sex');
      const body = {
        p1_name:form.get('p1_name'), p1_sex:p1Sex, p1_role:form.get('p1_role'),
        p2_name:form.get('p2_name'), p2_sex:p2Sex, p2_role:form.get('p2_role'), lineup:lineup(p1Sex,p2Sex),
        flavor:form.get('flavor'), game_length:Number(form.get('game_length')), reverse_chance:Number(form.get('reverse_chance')),
        redline:parseList(form.get('redline')), pair_code:form.get('pair_code') || '', identity_mode:'mixed',
        setup_confirmed:true, rules_ack:state.rulesAck,
      };
      const result = await request('/new_game', { method:'POST', body:JSON.stringify(body) });
      state.gameId=result.game_id; state.token=result.player_token; state.last={ say:result.intensity_note || '游戏已开局' }; saveSession();
      setupView.classList.add('hidden'); gameView.classList.remove('hidden'); await loadView(); startPolling();
    } catch (error) { $('setupStatus').textContent = error.message; }
  }

  async function showFinal() {
    try { setBusy(true,'正在结算终局…'); const r=await request(`/final/${encodeURIComponent(state.gameId)}`); state.last={say:r.result}; await loadView(true); render(); setBusy(false,r.result); }
    catch(error){ setBusy(false,error.message); }
  }

  function startPolling() { clearInterval(state.poll); state.poll=setInterval(() => loadView(true), 3000); }
  function reset() { clearInterval(state.poll); localStorage.removeItem(storageKey); state.gameId=''; state.view=null; state.last=null; gameView.classList.add('hidden'); setupView.classList.remove('hidden'); }

  $('setupForm').addEventListener('submit', startGame); $('rollBtn').addEventListener('click', roll); $('refreshBtn').addEventListener('click', () => loadView()); $('newBtn').addEventListener('click', reset); $('finalBtn').addEventListener('click', showFinal);
  $('identityToggle').addEventListener('click', () => $('identityToggle').parentElement.classList.toggle('open'));
  window.addEventListener('visibilitychange', () => { if (!document.hidden && state.gameId) loadView(true); });

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (saved.gameId) { state.gameId=saved.gameId; state.token=saved.token || ''; state.last=saved.last || null; setupView.classList.add('hidden'); gameView.classList.remove('hidden'); loadView(); startPolling(); }
  } catch (_) {}
  request('/help').then(r => { state.rulesAck = r.rules_ack || ''; }).catch(() => {});
})();
