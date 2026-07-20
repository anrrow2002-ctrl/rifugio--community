// ── Health 健康数据（2026-06-21）──────────────────────────────────────────
// 设计（用户）：自建 VPS 版"Supabase"——
//   · 月经/吃药/目标：用户在前端记录 → PUT /api/health/menstrual-records 同步（存 health_user JSON）
//   · 步数/睡眠/心率：iPhone 快捷指令 POST /api/health/ingest（带 x-health-token）→ 存 health_days/health_heart
//   · 前端 GET /api/health/summary?days=14 读取展示（只保留最近 N 天）
const Database = require('./modules/sqlite');

function initHealth(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_days (
      date         TEXT PRIMARY KEY,           -- YYYY-MM-DD
      steps        INTEGER,
      walk_speed   REAL,
      walk_heart   INTEGER,
      sleep_hours  REAL,
      bedtime      TEXT,
      wake         TEXT,
      sleep_quality TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS health_heart (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL,
      time       TEXT,
      rate       INTEGER,
      resting    INTEGER,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_health_heart_date ON health_heart(date);
    CREATE TABLE IF NOT EXISTS health_user (
      key        TEXT PRIMARY KEY,             -- 'periodDays' | 'medications' | 'goals'
      value      TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.close();
}

// 用 UTC 日期分桶。实测用户手机快捷指令的"今天步数"也是按 UTC 算（每天 UTC 0点=北京早8点清零），
// 两边对齐；且这个边界正好落在她睡眠中(4-11点睡)，故每个 UTC 日干净装下一个完整白天。别改成北京日期，否则把跨8点的累计拆两半。
const todayKey = () => new Date().toISOString().slice(0, 10);
const cutoffDate = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (Math.max(1, Number(days) || 14) - 1));
  return d.toISOString().slice(0, 10);
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
// 快捷指令"日期之间的时长"给的是中文格式（如"7小时31分钟"），不是纯数字分钟数；这里统一解析成小时数
const parseSleepHours = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  // \b 在中文字符后面不生效（分钟/钟 不是 \w），改用否定前瞻避免误吞英文单词
  const hourMatch = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:小时|hours?|hrs?|h(?![a-zA-Z]))/i);
  const minMatch = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:分钟|分|minutes?|mins?|m(?![a-zA-Z]))/i);
  if (hourMatch || minMatch) {
    const h = hourMatch ? Number(hourMatch[1]) : 0;
    const m = minMatch ? Number(minMatch[1]) : 0;
    return h + m / 60;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n / 60 : null; // 纯数字按分钟数处理
};
// sleep_start/sleep_ended 快捷指令给的是完整日期"2026-06-21 05:00"，只取时间部分展示
const extractTime = (v) => {
  if (!v) return null;
  const m = String(v).trim().match(/(\d{1,2}:\d{2})(?::\d{2})?\s*$/);
  return m ? m[1] : String(v).trim();
};

function getUser(db, key, fallback) {
  const row = db.prepare('SELECT value FROM health_user WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (_) { return fallback; }
}
function setUser(db, key, value) {
  db.prepare(`INSERT INTO health_user (key,value,updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).run(key, JSON.stringify(value));
}

function mountHealthRoutes(app, dbPath, { ingestToken } = {}) {
  // ── GET summary（前端展示）──
  app.get('/api/health/summary', (req, res) => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
      const since = cutoffDate(days);
      const dayRows = db.prepare('SELECT * FROM health_days WHERE date >= ? ORDER BY date ASC').all(since);
      const stepsHistory = dayRows.filter(r => r.steps != null).map(r => ({ date: r.date, steps: r.steps, speed: r.walk_speed, heart: r.walk_heart }));
      const sleepHistory = dayRows.filter(r => r.sleep_hours != null).map(r => ({ date: r.date, hours: r.sleep_hours, bedtime: r.bedtime, wake: r.wake, quality: r.sleep_quality }));
      const heartHistory = db.prepare('SELECT * FROM health_heart WHERE date >= ? ORDER BY date ASC, time ASC').all(since)
        .map(r => ({ date: r.date, time: r.time, rate: r.rate, resting: r.resting, note: r.note }));
      const periodDays = getUser(db, 'periodDays', {});
      const medications = getUser(db, 'medications', []);
      const goals = getUser(db, 'goals', { steps: 8000, sleep: 8 });
      const lastDay = dayRows[dayRows.length - 1] || {};
      const lastHeart = heartHistory[heartHistory.length - 1] || {};
      res.json({
        ok: true,
        data: {
          stepsHistory, sleepHistory, heartHistory,
          periodDays, medications, goals,
          steps: lastDay.steps ?? 0,
          sleepHours: lastDay.sleep_hours ?? 0,
          heartRate: lastHeart.rate ?? 0,
          restingHeartRate: lastHeart.resting ?? 0,
        },
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // ── PUT 月经记录（+ 顺带同步吃药/目标）──
  // body: { record, date?, periodDays?, medications?, goals? }
  app.put('/api/health/menstrual-records', (req, res) => {
    const db = new Database(dbPath);
    try {
      const b = req.body || {};
      // 月经：单条 record 合并进 periodDays，或整体替换
      if (b.periodDays && typeof b.periodDays === 'object') {
        setUser(db, 'periodDays', b.periodDays);
      } else if (b.record && typeof b.record === 'object') {
        const date = b.date || b.record.date || b.record.dateKey;
        if (!date) return res.status(400).json({ ok: false, error: 'record date required' });
        const pd = getUser(db, 'periodDays', {});
        pd[date] = { ...b.record, date };
        setUser(db, 'periodDays', pd);
      }
      if (Array.isArray(b.medications)) setUser(db, 'medications', b.medications);
      if (b.goals && typeof b.goals === 'object') setUser(db, 'goals', b.goals);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // ── 删除某天月经记录 ──
  app.delete('/api/health/menstrual-records/:date', (req, res) => {
    const db = new Database(dbPath);
    try {
      const pd = getUser(db, 'periodDays', {});
      delete pd[req.params.date];
      setUser(db, 'periodDays', pd);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });

  // ── POST ingest（iPhone 快捷指令上传，带 x-health-token，免登录）──
  // body: { date?, steps, walk_speed, walk_heart, sleep_hours, bedtime, wake, sleep_quality,
  //         heart_rate, resting_heart, heart_time, note, heart:[{time,rate,resting,note}] }
  app.post('/api/health/ingest', (req, res) => {
    const tok = req.headers['x-health-token'] || (req.query.token);
    if (!ingestToken || tok !== ingestToken) return res.status(401).json({ ok: false, error: 'invalid health token' });
    const db = new Database(dbPath);
    try {
      const b = req.body || {};
      const date = (b.date || todayKey()).slice(0, 10);
      const cur = db.prepare('SELECT * FROM health_days WHERE date=?').get(date) || {};
      // 步数/睡眠 → 当天 upsert（只更新提供的字段）
      const dayFields = {
        // 兼容多种 key 写法，免得快捷指令字段名对不上
        steps: num(b.steps ?? b.step ?? b.step_count ?? b.stepCount),
        walk_speed: num(b.walk_speed ?? b.speed ?? b.walking_speed ?? b.walkingSpeed),
        walk_heart: num(b.walk_heart ?? b.walking_heart ?? b.walking_heart_rate ?? b.walk_heart_rate ?? b.walkingHeartRate ?? b.walkingHeartRateAverage ?? b.heart_walk),
        sleep_hours: (() => {
          const v = num(b.sleep_hours ?? b.sleepHours ?? b.sleep ?? b.sleep_h) ?? parseSleepHours(b.sleep_min ?? b.sleepMin);
          const hours = v == null ? null : Math.round(v * 100) / 100;
          // 兜底：若快捷指令给的时长为 0/null 但有 bedtime/wake，从时差算
          if (hours == null || hours === 0) {
            const bt = extractTime(b.bedtime || b.bed_time || b.sleep_start || b.sleepStart);
            const wk = extractTime(b.wake || b.wake_time || b.wakeup || b.sleep_ended || b.sleepEnded);
            if (bt && wk && bt.length >= 5 && wk.length >= 5) {
              const toMin = (t) => Number(t.slice(0,2)) * 60 + Number(t.slice(3,5));
              let diff = toMin(wk) - toMin(bt);
              if (diff < 0) diff += 1440;  // 跨午夜：睡前是昨晚（如 23:00 睡→07:00 醒）
              if (diff > 0) return Math.round(diff / 60 * 100) / 100;
            }
            // 这次请求没带新的 bedtime/wake：裸 0 多半是上游别的字段顶位，不是真没睡，别用它覆盖已有的正常记录
            if (hours === 0 && !bt && !wk && cur.sleep_hours > 0) return null;
          }
          return hours;
        })(),
        bedtime: extractTime(b.bedtime || b.bed_time || b.sleep_start || b.sleepStart),
        wake: extractTime(b.wake || b.wake_time || b.wakeup || b.sleep_ended || b.sleepEnded),
        sleep_quality: b.sleep_quality || b.quality || b.sleepQuality || null,
      };
      const has = Object.values(dayFields).some(v => v != null);
      if (has) {
        const merged = {
          // 步数=当天累计、只增不减；多次上传取最大值，免得傍晚一个小样本把早上的好数据冲掉
          steps: (() => {
            const n = dayFields.steps, c = cur.steps;
            if (n == null) return c ?? null;   // 这次没带步数 → 保留已有
            if (c == null) return n;           // 当天第一次
            return Math.max(n, c);
          })(),
          walk_speed: dayFields.walk_speed ?? cur.walk_speed ?? null,
          walk_heart: dayFields.walk_heart ?? cur.walk_heart ?? null,
          sleep_hours: dayFields.sleep_hours ?? cur.sleep_hours ?? null,
          bedtime: dayFields.bedtime ?? cur.bedtime ?? null,
          wake: dayFields.wake ?? cur.wake ?? null,
          sleep_quality: dayFields.sleep_quality ?? cur.sleep_quality ?? null,
        };
        db.prepare(`INSERT INTO health_days (date,steps,walk_speed,walk_heart,sleep_hours,bedtime,wake,sleep_quality,updated_at)
          VALUES (@date,@steps,@walk_speed,@walk_heart,@sleep_hours,@bedtime,@wake,@sleep_quality,datetime('now'))
          ON CONFLICT(date) DO UPDATE SET steps=@steps,walk_speed=@walk_speed,walk_heart=@walk_heart,
            sleep_hours=@sleep_hours,bedtime=@bedtime,wake=@wake,sleep_quality=@sleep_quality,updated_at=datetime('now')`)
          .run({ date, ...merged });
      }
      // 心率 → 同一天覆盖（自动化每次开 App 都上传，不再堆重复；当天先清旧的再写）
      const heartList = Array.isArray(b.heart) ? b.heart
        : (b.heart_rate != null || b.rate != null ? [{ time: b.heart_time || b.time, rate: b.heart_rate ?? b.rate, resting: b.resting_heart ?? b.resting, note: b.note }] : []);
      const insHeart = db.prepare('INSERT INTO health_heart (id,date,time,rate,resting,note) VALUES (?,?,?,?,?,?)');
      let heartCount = 0;
      if (heartList.some(h => num(h.rate) != null)) db.prepare('DELETE FROM health_heart WHERE date=?').run(date);  // 当天覆盖
      for (const h of heartList) {
        if (num(h.rate) == null) continue;
        insHeart.run(require('crypto').randomBytes(6).toString('hex'), h.date || date, h.time || null, num(h.rate), num(h.resting), h.note || null);
        heartCount++;
      }
      res.json({ ok: true, date, day_updated: has, heart_added: heartCount });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  });
}

module.exports = { initHealth, mountHealthRoutes };
