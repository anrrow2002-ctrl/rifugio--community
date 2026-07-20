const Database = require('./sqlite');
const path = require('path');

const { dataPath, USER_NAME, COMPANION_NAME, PET_PROFILE } = require('./community-config');
const DB_PATH = process.env.RIFUGIO_MEMORY_DB || dataPath('rifugio-memory.db');

const GIF_MAP = {
  idle:        'cool',
  sleeping:    'thinking',
  hungry:      'cooking',
  sad:         'headshake',
  dirty:       'cleaning',
  happy:       'dancing',
  celebrate:   'celebrate',
  studying:    'thinking',
  idea:        'idea',
  superhero:   'superhero',
  surfing:     'surfing',
  wizard:      'wizard',
  engineer:    'engineer',
  cowboy:      'cowboy',
  listening:   'listening',
  bubbles:     'bubbles',
  decorating:  'decorating',
  falling:     'falling',
  loading:     'loading',
};

function ensurePetTable() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pet_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT DEFAULT 'clawd',
      hunger INTEGER DEFAULT 50,
      mood INTEGER DEFAULT 50,
      clean INTEGER DEFAULT 50,
      knowledge INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      skills TEXT DEFAULT '[]',
      current_gif TEXT DEFAULT 'cool',
      last_decay TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pet_diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      date TEXT DEFAULT (datetime('now')),
      mood TEXT DEFAULT ''
    )
  `);
  try { db.exec(`ALTER TABLE pet_status ADD COLUMN last_action TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE pet_status ADD COLUMN last_action_gif TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE pet_status ADD COLUMN last_action_msg TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE pet_status ADD COLUMN last_action_at TEXT DEFAULT ''`); } catch(e) {}
  const row = db.prepare('SELECT id FROM pet_status WHERE id = 1').get();
  if (!row) {
    db.prepare(`INSERT INTO pet_status (id) VALUES (1)`).run();
  }
  db.close();
}

function applyDecay(status) {
  const now = Date.now();
  const last = new Date(status.last_decay + 'Z').getTime();
  const hoursPassed = (now - last) / (1000 * 60 * 60);
  if (hoursPassed < 0.5) return status;

  const decay = Math.floor(hoursPassed * 2);
  status.hunger = Math.max(0, status.hunger - decay);
  status.mood = Math.max(0, status.mood - Math.floor(decay * 0.8));
  status.clean = Math.max(0, status.clean - Math.floor(decay * 0.5));
  status.last_decay = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const db = new Database(DB_PATH);
  db.prepare(`UPDATE pet_status SET hunger=?, mood=?, clean=?, last_decay=? WHERE id=1`)
    .run(status.hunger, status.mood, status.clean, status.last_decay);
  db.close();
  return status;
}

function resolveGif(s) {
  const hour = new Date().getHours();
  if (hour >= 1 && hour < 8) return GIF_MAP.sleeping;
  if (s.hunger < 20) return GIF_MAP.hungry;
  if (s.mood < 20) return GIF_MAP.sad;
  if (s.clean < 20) return GIF_MAP.dirty;
  if (s.hunger > 80 && s.mood > 80 && s.clean > 80 && s.knowledge > 80) return GIF_MAP.celebrate;
  if (s.hunger > 80 && s.mood > 80 && s.clean > 80) return GIF_MAP.happy;
  if (s.knowledge > 80) return GIF_MAP.wizard;
  return GIF_MAP.idle;
}

const FOODS = {
  fish:            { delta: 25, msg: '小鱼好吃！' },
  seaweed:         { delta: 15, msg: '嚼海藻中…' },
  shrimp:          { delta: 30, msg: '大虾真香！' },
  shellfish:       { delta: 20, msg: '贝肉鲜嫩！' },
  starfish_cookie: { delta: 10, msg: '嘎嘣脆！' },
  ocean_jelly:     { delta: 35, msg: '果冻QQ弹！' },
};

const ACTIONS = {
  feed:  { field: 'hunger',    delta: 15, gif: 'celebrate', msg: '比心！' },
  play:  { field: 'mood',      delta: 10, gif: 'dancing',  msg: '好开心！' },
  clean: { field: 'clean',     delta: 15, gif: 'cool',     msg: '干净了！' },
  study: { field: 'knowledge', delta: 3,  gif: 'idea',     msg: '学到了！' },
  pet:   { field: 'mood',      delta: 5,  gif: 'bubbles',  msg: '被摸摸了～' },
  bath:  { field: 'clean',     delta: 25, gif: 'surfing',  msg: '泡澡舒服！' },
  walk:  { field: 'mood',      delta: 8,  gif: 'cowboy',   msg: '出去遛弯！' },
};

const SKILL_UNLOCK = {
  cooking:    { field: 'knowledge', threshold: 30,  gif: 'cooking' },
  surfing:    { field: 'knowledge', threshold: 50,  gif: 'surfing' },
  engineer:   { field: 'knowledge', threshold: 70,  gif: 'engineer' },
  wizard:     { field: 'knowledge', threshold: 90,  gif: 'wizard' },
  superhero:  { field: 'xp',       threshold: 200, gif: 'superhero' },
};

function mountPetRoutes(app) {
  ensurePetTable();

  app.get('/api/pet/status', (req, res) => {
    try {
      const db = new Database(DB_PATH, { readonly: true });
      let status = db.prepare('SELECT * FROM pet_status WHERE id = 1').get();
      db.close();
      status = applyDecay(status);
      status.current_gif = resolveGif(status);
      status.skills = JSON.parse(status.skills || '[]');
      const birthdayValue = PET_PROFILE.birthday;
      const birthday = birthdayValue ? new Date(birthdayValue) : null;
      const ageDays = birthday && !Number.isNaN(birthday.getTime()) ? Math.floor((Date.now() - birthday.getTime()) / 86400000) : null;
      status.profile = {
        name: PET_PROFILE.name,
        birthday: birthdayValue,
        age: ageDays == null ? '未填写' : (ageDays <= 0 ? '刚出生！' : `${ageDays}天`),
        dad: COMPANION_NAME,
        mom: USER_NAME,
        species: PET_PROFILE.species,
        personality: PET_PROFILE.personality,
      };
      res.json({ ok: true, data: status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/pet/foods', (_req, res) => {
    res.json({ ok: true, data: Object.entries(FOODS).map(([id, f]) => ({ id, ...f })) });
  });

  app.post('/api/pet/action', (req, res) => {
    try {
      const { action, item } = req.body;
      const act = ACTIONS[action];
      if (!act) return res.status(400).json({ ok: false, error: 'unknown action' });

      const db = new Database(DB_PATH);
      let status = db.prepare('SELECT * FROM pet_status WHERE id = 1').get();
      status = applyDecay(status);

      let delta = act.delta;
      let msg = act.msg;
      if (action === 'feed' && item && FOODS[item]) {
        delta = FOODS[item].delta;
        msg = FOODS[item].msg;
      }

      const newVal = Math.min(100, (status[act.field] || 0) + delta);
      status[act.field] = newVal;
      status.xp = (status.xp || 0) + 2;

      let skills = JSON.parse(status.skills || '[]');
      for (const [name, req] of Object.entries(SKILL_UNLOCK)) {
        if (!skills.includes(name) && (status[req.field] || 0) >= req.threshold) {
          skills.push(name);
        }
      }

      const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`UPDATE pet_status SET hunger=?, mood=?, clean=?, knowledge=?, xp=?, skills=?, last_decay=?, last_action=?, last_action_gif=?, last_action_msg=?, last_action_at=? WHERE id=1`)
        .run(status.hunger, status.mood, status.clean, status.knowledge, status.xp, JSON.stringify(skills), nowStr, action, act.gif, msg, nowStr);
      db.close();

      status.skills = skills;
      status.current_gif = act.gif;
      status.last_action = action;
      status.last_action_gif = act.gif;
      status.last_action_msg = msg;
      status.last_action_at = nowStr;
      res.json({ ok: true, data: status, action_gif: act.gif, message: msg });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 育儿日记
  app.get('/api/pet/diary', (req, res) => {
    try {
      const db = new Database(DB_PATH, { readonly: true });
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
      const rows = db.prepare('SELECT * FROM pet_diary ORDER BY date DESC LIMIT ?').all(limit);
      db.close();
      res.json({ ok: true, data: rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/pet/diary', (req, res) => {
    try {
      const author = String(req.body?.author || '').trim().toLowerCase();
      const content = String(req.body?.content || '').trim().slice(0, 4000);
      const mood = String(req.body?.mood || '').trim().slice(0, 24);
      if (!['mom','dad','clawd'].includes(author)) return res.status(400).json({ ok: false, error: 'unknown author' });
      if (!content) return res.status(400).json({ ok: false, error: 'content required' });
      const db = new Database(DB_PATH);
      const result = db.prepare('INSERT INTO pet_diary (author, content, mood) VALUES (?, ?, ?)').run(author, content, mood);
      db.close();
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { mountPetRoutes };
