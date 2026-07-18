// ── Radio 电台 / 音乐 / 有声（2026-06-21）─────────────────────────────────
//   · GET  /api/radio/search?q=&type=&providers=  聚合多源搜索 → 统一卡片
//   · 播放指令队列：MCP 推 → 前端每 6s 轮询 /api/playback/commands/latest 播放
//   · 定时哄睡：N 分钟后队列里塞一条 {action:'stop'}，前端停播
const crypto = require('crypto');

const TIMEOUT = 12000;
async function jget(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Rifugio/1.0', ...(opts.headers || {}) }, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return opts.text ? await r.text() : await r.json();
  } finally { clearTimeout(t); }
}

// ── GD Studio 解析站 ──────────────────────────────────────────────────
const GD = 'https://music-api.gdstudio.xyz/api.php';
// token 编码：netease:歌曲id:封面id:歌词id —— 给 MCP 用，避免一次搜全部解析直链
function gdToken(src, it) { return `${src}:${it.id}:${it.pic_id || ''}:${it.lyric_id || it.id}`; }
function parseToken(token) {
  const [source, id, pic, lyric] = String(token || '').split(':');
  return { source: source || 'netease', id, pic, lyric: lyric || id };
}
async function gdSearch(source, q, count = 12) {
  // GD 站限流的表现很阴：搜索返回空数组 []（长得像"没搜到"）、解析返回无 url，都不报错。
  // 所以空数组也当可疑重试（真没结果的查询多打一发无害）；连挂才记日志。
  const url = `${GD}?types=search&source=${source}&name=${encodeURIComponent(q)}&count=${count}&pages=1`;
  let list = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 700));
    try {
      const j = await jget(url);
      if (Array.isArray(j)) { list = j; if (j.length) break; }
      else if (attempt === 2) console.warn(`[radio] gdSearch ${source} 响应不是数组:`, JSON.stringify(j).slice(0, 160));
    } catch (e) {
      if (attempt === 2) console.warn(`[radio] gdSearch ${source} 三次都失败:`, e.message);
    }
  }
  if (Array.isArray(list) && !list.length) console.warn(`[radio] gdSearch ${source} 三次都是空数组(疑似限流): ${q}`);
  return (Array.isArray(list) ? list : []).map(it => ({
    raw: it, source,
    title: it.name,
    artist: Array.isArray(it.artist) ? it.artist.join('/') : (it.artist || ''),
    album: it.album || '',
    token: gdToken(source, it),
  }));
}
async function gdResolveUrl(source, id, br = 320) {
  const j = await jget(`${GD}?types=url&source=${source}&id=${encodeURIComponent(id)}&br=${br}`);
  return j && j.url ? { url: j.url, br: j.br, size: j.size } : null;
}
async function gdPic(source, picId) {
  if (!picId) return '';
  try { const j = await jget(`${GD}?types=pic&source=${source}&id=${encodeURIComponent(picId)}&size=300`); return (j && j.url) || ''; }
  catch { return ''; }
}
async function gdLyric(source, lyricId) {
  if (!lyricId) return '';
  try { const j = await jget(`${GD}?types=lyric&source=${source}&id=${encodeURIComponent(lyricId)}`); return (j && (j.lyric || j.lrc)) || ''; }
  catch { return ''; }
}

// ── Radio Browser（全球电台直播流）─────────────────────────────────────
async function radioBrowserSearch(q, limit = 12) {
  const base = 'https://de1.api.radio-browser.info/json/stations/search';
  const list = await jget(`${base}?name=${encodeURIComponent(q || 'sleep')}&hidebroken=true&order=clickcount&reverse=true&limit=${limit}`);
  return (Array.isArray(list) ? list : []).filter(s => s.url_resolved).map(s => ({
    id: 'rb-' + s.stationuuid, title: s.name?.trim() || '电台', type: 'station',
    provider: 'radio', source: s.country || s.tags || 'Radio', artist: s.tags || '',
    url: s.url_resolved, coverUrl: s.favicon || '', durationLabel: '直播',
    description: [s.country, s.codec, s.bitrate ? s.bitrate + 'k' : ''].filter(Boolean).join(' · '),
  }));
}

// ── Audius（免费完整歌曲）──────────────────────────────────────────────
let _audiusHost = '';
async function audiusHost() {
  if (_audiusHost) return _audiusHost;
  const j = await jget('https://api.audius.co');
  const hosts = (j && j.data) || [];
  _audiusHost = hosts[Math.floor(Math.random() * hosts.length)] || '';
  return _audiusHost;
}
async function audiusSearch(q, limit = 10) {
  const host = await audiusHost();
  if (!host) return [];
  const j = await jget(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=rifugio&limit=${limit}`);
  return ((j && j.data) || []).map(t => ({
    id: 'au-' + t.id, title: t.title, type: 'song', provider: 'audius',
    source: 'Audius', artist: t.user?.name || '',
    url: `${host}/v1/tracks/${t.id}/stream?app_name=rifugio`,
    coverUrl: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
    durationLabel: t.duration ? `${Math.floor(t.duration / 60)}:${String(t.duration % 60).padStart(2, '0')}` : '',
    description: t.genre || '',
  }));
}

// ── Internet Archive（有声故事 / 有声书）────────────────────────────────
async function archiveSearch(q, limit = 10) {
  const url = 'https://archive.org/advancedsearch.php?q=' +
    encodeURIComponent(`(${q}) AND (mediatype:audio)`) +
    '&fl[]=identifier&fl[]=title&fl[]=creator&rows=' + limit + '&output=json';
  const j = await jget(url);
  const docs = (j && j.response && j.response.docs) || [];
  return docs.map(d => ({
    id: 'ia-' + d.identifier, title: d.title || d.identifier, type: 'audiobook',
    provider: 'archive', source: 'Internet Archive',
    artist: Array.isArray(d.creator) ? d.creator.join('/') : (d.creator || ''),
    // 取该条目第一首音频；前端打开详情时已能播 url，这里给可解析的 details 页直链
    url: `https://archive.org/download/${d.identifier}/`,
    needsResolve: 'archive:' + d.identifier,
    coverUrl: `https://archive.org/services/img/${d.identifier}`,
    durationLabel: '有声',
  }));
}
// 解析 Archive 条目里第一首可播音频
async function archiveResolve(identifier) {
  try {
    const meta = await jget(`https://archive.org/metadata/${identifier}`);
    const files = (meta && meta.files) || [];
    const audio = files.find(f => /\.(mp3|m4a|ogg|flac)$/i.test(f.name) && f.source === 'original')
      || files.find(f => /\.(mp3|m4a|ogg)$/i.test(f.name));
    if (!audio) return null;
    return `https://archive.org/download/${identifier}/${encodeURIComponent(audio.name)}`;
  } catch { return null; }
}

// 限并发执行（GD 解析站对密集并发会限流；控制在 4 路内更稳）
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length); let i = 0;
  async function worker() { while (i < arr.length) { const idx = i++; try { out[idx] = await fn(arr[idx], idx); } catch { out[idx] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
  return out;
}

// 把 GD 搜索结果解析成可播卡片（限并发，避免被解析站限流）
// 实测 GD 对并发解析限流狠（10 发并发只中 3），限流是返回无 url 而非报错——
// 失败的歇 500ms 重试一次；封面只给解析成功的拉，省一半调用。
async function gdToCards(items, br = 320) {
  const out = await mapLimit(items, 2, async (it) => {
    let u = await gdResolveUrl(it.source, it.raw.id, br).catch(() => null);
    if (!u || !u.url) {
      await new Promise(r => setTimeout(r, 500));
      u = await gdResolveUrl(it.source, it.raw.id, br).catch(() => null);
    }
    if (!u || !u.url) return null;
    const pic = await gdPic(it.source, it.raw.pic_id);
    return {
      id: `${it.source}-${it.raw.id}`, title: it.title, type: 'song',
      provider: it.source, source: ({ netease: '网易云', tencent: 'QQ音乐', kuwo: '酷我', joox: 'JOOX', migu: '咪咕' }[it.source] || it.source),
      artist: it.artist, url: u.url, coverUrl: pic, durationLabel: u.br ? u.br + 'k' : '',
      token: it.token, album: it.album, description: it.album || '',
    };
  });
  return out.filter(Boolean);
}

// providers 过滤 → 该跑哪些源
function planSources(providers, type) {
  const p = new Set((providers || []).map(s => String(s).trim()).filter(Boolean));
  const all = p.has('all') || p.size === 0;
  const want = (id) => all || p.has(id);
  const plan = { netease: false, tencent: false, audius: false, radio: false, archive: false };
  // 类型主导
  if (type === 'radio' || type === 'station') { plan.radio = true; return plan; }
  if (type === 'audiobook' || type === 'story' || type === 'podcast' || type === 'book') { plan.archive = true; if (want('archive') || want('librivox')) plan.archive = true; return plan; }
  // 歌曲 / 全部
  plan.netease = want('netease') || want('free') || all;
  plan.tencent = want('netease') && p.has('tencent'); // 仅显式
  plan.audius = want('free') || want('fma') || want('jamendo') || all;
  if (type === '' || type === 'all') { plan.radio = want('radio') || want('radio_garden') || all; plan.archive = false; }
  return plan;
}

function mountRadioRoutes(app, { defaultBitrate = 320 } = {}) {
  // 搜索结果内存缓存：GD 限流按 IP 记仇几秒，每次搜歌 = 搜索+每首直链/封面 ≈ 一二十发调用，
  // 是我们自己把自己打进限流窗口。同词重搜直接吃缓存，5 分钟内零外部调用。
  const searchCache = new Map(); // key -> { at, results }
  const SEARCH_CACHE_TTL = 5 * 60 * 1000;
  const SEARCH_CACHE_MAX = 60;

  // ── 聚合搜索 ──
  app.get('/api/radio/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || '').trim();
    const providers = String(req.query.providers || '').split(',').map(s => s.trim()).filter(Boolean);
    // limit：MCP 点歌只播 1 首，没必要解析 12 首直链把 GD 打进限流（默认 12 = 前端原行为）
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 12, 20));
    if (!q) return res.json({ ok: true, results: [] });
    const cacheKey = [q, type, providers.join(','), limit].join('§');
    const hit = searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL) return res.json({ ok: true, results: hit.results, cached: true });
    const plan = planSources(providers, type);
    const jobs = [];
    if (plan.netease) jobs.push(gdSearch('netease', q, Math.min(limit, 12)).then(items => gdToCards(items, defaultBitrate)));
    if (plan.tencent) jobs.push(gdSearch('tencent', q, Math.min(limit, 8)).then(items => gdToCards(items, defaultBitrate)));
    if (plan.audius) jobs.push(audiusSearch(q, Math.min(limit, 8)));
    if (plan.radio) jobs.push(radioBrowserSearch(q, Math.min(limit, 12)));
    if (plan.archive) jobs.push(archiveSearch(q, Math.min(limit, 10)));
    const settled = await Promise.allSettled(jobs);
    let results = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) results = results.concat(s.value);
      else if (s.status === 'rejected') console.warn('[radio] 搜索某一路失败:', s.reason?.message || s.reason);
    }
    // 去重
    const seen = new Set();
    results = results.filter(r => { const k = (r.title + '|' + r.artist).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (results.length) {
      searchCache.set(cacheKey, { at: Date.now(), results });
      if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    }
    res.json({ ok: true, results });
  });

  // 前端音源登录入口（当前各源无需登录，保留接口避免 404）
  app.get('/api/radio/providers/:provider/login', (req, res) => {
    res.json({ ok: true, provider: req.params.provider, message: '该音源无需登录，直接搜索即可。' });
  });

  // ── 解析单曲直链（MCP radio_play / 前端详情用）──
  // body: { token } 形如 netease:id:pic:lyric ，或 { needsResolve:'archive:identifier' }
  app.post('/api/radio/resolve', async (req, res) => {
    try {
      const b = req.body || {};
      if (b.needsResolve && b.needsResolve.startsWith('archive:')) {
        const url = await archiveResolve(b.needsResolve.slice(8));
        return res.json({ ok: !!url, url: url || '' });
      }
      const { source, id, pic, lyric } = parseToken(b.token);
      if (!id) return res.status(400).json({ ok: false, error: 'token/id required' });
      const [u, picUrl, lrc] = await Promise.all([
        gdResolveUrl(source, id, b.br || defaultBitrate),
        b.pic !== false ? gdPic(source, pic) : '',
        b.lyric === true ? gdLyric(source, lyric) : '',
      ]);
      if (!u || !u.url) return res.json({ ok: false, error: '无法解析直链' });
      res.json({ ok: true, url: u.url, br: u.br, coverUrl: picUrl, lyrics: lrc, source });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── 播放指令队列（MCP 推 → 前端轮询）──
  const queues = new Map();   // sessionId -> { latest, history:[] }
  const timers = new Map();   // sessionId -> sleep timeout
  const Q = (sid) => { if (!queues.has(sid)) queues.set(sid, { latest: null, history: [] }); return queues.get(sid); };

  function push(sessionId, cmd) {
    const c = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), status: 'pending', ...cmd };
    const q = Q(sessionId);
    q.latest = c; q.history.push(c); if (q.history.length > 50) q.history.shift();
    return c;
  }
  // 暴露给 MCP（同进程内调用，省一次 HTTP）
  app.locals.radioPush = push;
  app.locals.radioSearch = async (q, type, providers, limit) => {
    const plan = planSources(providers || [], type || '');
    const jobs = [];
    if (plan.netease) jobs.push(gdSearch('netease', q, limit || 8));
    if (plan.tencent) jobs.push(gdSearch('tencent', q, 6));
    const settled = await Promise.allSettled(jobs);
    let gd = [];
    for (const s of settled) if (s.status === 'fulfilled') gd = gd.concat(s.value);
    const extra = [];
    if (plan.audius) extra.push(...(await audiusSearch(q, limit || 6).catch(() => [])));
    if (plan.radio) extra.push(...(await radioBrowserSearch(q, limit || 8).catch(() => [])));
    if (plan.archive) extra.push(...(await archiveSearch(q, limit || 6).catch(() => [])));
    return { gd, extra };
  };
  app.locals.radioResolve = gdResolveUrl;
  app.locals.archiveResolve = archiveResolve;
  app.locals.radioSetSleep = (sessionId, minutes) => {
    clearTimeout(timers.get(sessionId));
    if (!minutes || minutes <= 0) { timers.delete(sessionId); return 0; }
    const ms = Math.min(minutes, 600) * 60000;
    timers.set(sessionId, setTimeout(() => { push(sessionId, { action: 'stop', title: '哄睡定时已到，停止播放' }); timers.delete(sessionId); }, ms));
    return Math.min(minutes, 600);
  };

  app.get('/api/playback/commands/latest', (req, res) => {
    const sid = String(req.query.sessionId || 'default');
    res.json({ ok: true, command: Q(sid).latest || null });
  });
  app.post('/api/playback/commands/:id/:status', (req, res) => {
    const sid = String((req.body && req.body.sessionId) || req.query.sessionId || 'default');
    const q = Q(sid);
    const c = q.history.find(x => x.id === req.params.id) || (q.latest && q.latest.id === req.params.id ? q.latest : null);
    if (c) { c.status = req.params.status; if (req.body && req.body.error) c.error = req.body.error; }
    res.json({ ok: true });
  });
  // 前端/手动 入队（备用，鉴权走全局门）
  app.post('/api/playback/commands', (req, res) => {
    const b = req.body || {};
    const c = push(String(b.sessionId || 'default'), { title: b.title, url: b.url, type: b.type || 'song', provider: b.provider || 'manual', source: b.source || '', durationLabel: b.durationLabel || '', action: b.action });
    res.json({ ok: true, command: c });
  });
  // 定时哄睡
  app.post('/api/playback/sleep', (req, res) => {
    const b = req.body || {};
    const mins = app.locals.radioSetSleep(String(b.sessionId || 'default'), Number(b.minutes) || 0);
    res.json({ ok: true, minutes: mins });
  });
}

module.exports = { mountRadioRoutes };
