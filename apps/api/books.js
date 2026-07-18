// ── 书房 · 共读后端（2026-07-07）────────────────────────────────────
// 用户上传 TXT/EPUB → 自动拆章入库 → 前端书房 App 阅读 + 进度同步。
// 「共读」本身走前端：阅读器里的提问通过现有 sendTalkMessage 带章节上下文进聊天室。
// 表在 rifugio-memory.db（和 diario/galleria 等小 App 一个库）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const iconv = require('iconv-lite');

const CHAPTER_RE = /^\s*(?:第[0-9一二三四五六七八九十百千万零两]{1,10}[章卷回节部集]|Chapter\s{0,3}\d{1,4}|CHAPTER\s{0,3}\d{1,4}|序章|序言|楔子|引子|前言|尾声|终章|后记|番外[^\n]{0,20})[^\n]{0,40}$/;

function decodeTxt(buf) {
  // 先按 utf8 解，坏字符比例高就当 GBK/GB18030（中文小说 txt 的常态）
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > Math.max(3, utf8.length / 1000)) return iconv.decode(buf, 'gb18030');
  return utf8;
}

function splitChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = { title: '开篇', body: [] };
  for (const line of lines) {
    if (line.length <= 60 && CHAPTER_RE.test(line)) {
      if (cur.body.join('').trim()) chapters.push(cur);
      cur = { title: line.trim().slice(0, 80), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join('').trim()) chapters.push(cur);
  // 没识别出任何章节标题：按 ~8000 字硬切，别让一整本变一章
  if (chapters.length <= 1) {
    const whole = text.replace(/\r\n?/g, '\n');
    if (whole.length > 12000) {
      const out = [];
      for (let i = 0, n = 1; i < whole.length; i += 8000, n++) {
        out.push({ title: `第 ${n} 段`, body: [whole.slice(i, i + 8000)] });
      }
      return out;
    }
  }
  return chapters;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function parseEpub(buf) {
  const extract = require('extract-zip');
  const tmpZip = path.join(os.tmpdir(), `rifugio-epub-${Date.now()}.zip`);
  const tmpDir = path.join(os.tmpdir(), `rifugio-epub-${Date.now()}`);
  fs.writeFileSync(tmpZip, buf);
  try {
    await extract(tmpZip, { dir: tmpDir });
    // 找 OPF 拿 spine 顺序；找不到就按文件名排序兜底
    let htmlFiles = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const all = walk(tmpDir);
    const opfPath = all.find(f => f.endsWith('.opf'));
    if (opfPath) {
      const opf = fs.readFileSync(opfPath, 'utf8');
      const items = {};
      for (const m of opf.matchAll(/<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)) items[m[1]] = m[2];
      for (const m of opf.matchAll(/<item\s[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*>/g)) items[m[2]] = items[m[2]] || m[1];
      const spineIds = [...opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/g)].map(m => m[1]);
      const base = path.dirname(opfPath);
      htmlFiles = spineIds.map(id => items[id] && path.join(base, decodeURIComponent(items[id]))).filter(f => f && fs.existsSync(f));
    }
    if (!htmlFiles.length) htmlFiles = all.filter(f => /\.x?html?$/i.test(f)).sort();
    const chapters = [];
    for (const f of htmlFiles) {
      const html = fs.readFileSync(f, 'utf8');
      const text = stripHtml(html);
      if (!text || text.length < 20) continue;
      const tm = html.match(/<title[^>]*>([^<]{1,80})<\/title>/i) || html.match(/<h[12][^>]*>([^<]{1,80})<\/h[12]>/i);
      chapters.push({ title: (tm ? stripHtml(tm[1]) : `第 ${chapters.length + 1} 章`).slice(0, 80), body: [text] });
    }
    return chapters;
  } finally {
    try { fs.rmSync(tmpZip, { force: true }); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function mountBooksRoutes(app, { MEMORY_DB_PATH }) {
  const db = new Database(MEMORY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT DEFAULT '',
      source_name TEXT DEFAULT '',
      format TEXT DEFAULT 'txt',
      chapter_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS book_chapters (
      book_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      PRIMARY KEY (book_id, idx)
    );
    CREATE TABLE IF NOT EXISTS book_progress (
      book_id INTEGER PRIMARY KEY,
      chapter_idx INTEGER DEFAULT 0,
      scroll_pct REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS book_annotations (
      id TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL,
      chapter_idx INTEGER NOT NULL,
      anchor TEXT NOT NULL,
      note TEXT DEFAULT '',
      anchor_start INTEGER DEFAULT -1,
      anchor_end INTEGER DEFAULT -1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS book_annotation_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      annotation_id TEXT NOT NULL,
      who TEXT DEFAULT 'ai',
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_book_annotations_chapter
      ON book_annotations(book_id, chapter_idx, created_at);
    CREATE INDEX IF NOT EXISTS idx_book_annotation_replies
      ON book_annotation_replies(annotation_id, id);
  `);

  const annotationsForChapter = (bookId, chapterIdx) => {
    const annotations = db.prepare(`
      SELECT id, book_id, chapter_idx, anchor, note, anchor_start, anchor_end, created_at
      FROM book_annotations WHERE book_id = ? AND chapter_idx = ?
      ORDER BY anchor_start, created_at`).all(bookId, chapterIdx);
    const replies = db.prepare(`
      SELECT r.id, r.annotation_id, r.who, r.text, r.created_at
      FROM book_annotation_replies r
      JOIN book_annotations a ON a.id = r.annotation_id
      WHERE a.book_id = ? AND a.chapter_idx = ? ORDER BY r.id`).all(bookId, chapterIdx);
    const grouped = new Map();
    for (const reply of replies) {
      if (!grouped.has(reply.annotation_id)) grouped.set(reply.annotation_id, []);
      grouped.get(reply.annotation_id).push(reply);
    }
    return annotations.map(annotation => ({ ...annotation, replies: grouped.get(annotation.id) || [] }));
  };

  // 上传一本书：{ title?, author?, filename, data_base64 }
  app.post('/api/books', async (req, res) => {
    try {
      const { title, author, filename, data_base64 } = req.body || {};
      if (!data_base64) return res.status(400).json({ ok: false, error: 'data_base64 required' });
      const buf = Buffer.from(String(data_base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!buf.length) return res.status(400).json({ ok: false, error: 'empty file' });
      if (buf.length > 40 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'file too large (>40MB)' });
      const name = String(filename || 'book.txt');
      const isEpub = /\.epub$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b && /epub/i.test(name + ''));
      let chapters;
      let format = 'txt';
      if (isEpub || (buf[0] === 0x50 && buf[1] === 0x4b)) {
        format = 'epub';
        chapters = await parseEpub(buf);
      } else {
        chapters = splitChapters(decodeTxt(buf));
      }
      if (!chapters.length) return res.status(400).json({ ok: false, error: '没解析出任何内容' });
      const bookTitle = String(title || name.replace(/\.(txt|epub)$/i, '')).slice(0, 120);
      const info = db.prepare('INSERT INTO books (title, author, source_name, format, chapter_count) VALUES (?,?,?,?,?)')
        .run(bookTitle, String(author || '').slice(0, 80), name.slice(0, 200), format, chapters.length);
      const bookId = info.lastInsertRowid;
      const ins = db.prepare('INSERT INTO book_chapters (book_id, idx, title, content) VALUES (?,?,?,?)');
      const tx = db.transaction(() => {
        chapters.forEach((c, i) => ins.run(bookId, i, c.title, Array.isArray(c.body) ? c.body.join('\n').trim() : String(c.body || '')));
      });
      tx();
      res.json({ ok: true, id: bookId, title: bookTitle, chapter_count: chapters.length, format });
    } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
  });

  app.get('/api/books', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT b.*, COALESCE(p.chapter_idx, 0) AS chapter_idx, COALESCE(p.scroll_pct, 0) AS scroll_pct, p.updated_at AS last_read_at
        FROM books b LEFT JOIN book_progress p ON p.book_id = b.id
        ORDER BY COALESCE(p.updated_at, b.created_at) DESC`).all();
      res.json({ ok: true, books: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/books/:id/toc', (req, res) => {
    try {
      const rows = db.prepare('SELECT idx, title, length(content) AS chars FROM book_chapters WHERE book_id = ? ORDER BY idx').all(Number(req.params.id));
      res.json({ ok: true, toc: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/books/:id/chapter/:idx', (req, res) => {
    try {
      const bookId = Number(req.params.id); const idx = Number(req.params.idx);
      const row = db.prepare('SELECT idx, title, content FROM book_chapters WHERE book_id = ? AND idx = ?').get(bookId, idx);
      if (!row) return res.status(404).json({ ok: false, error: 'chapter not found' });
      const total = db.prepare('SELECT chapter_count AS n FROM books WHERE id = ?').get(bookId)?.n || 0;
      res.json({ ok: true, ...row, total });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/books/:id/chapter/:idx/annotations', (req, res) => {
    try {
      const bookId = Number(req.params.id); const chapterIdx = Number(req.params.idx);
      res.json({ ok: true, annotations: annotationsForChapter(bookId, chapterIdx) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/books/:id/chapter/:idx/annotations', (req, res) => {
    try {
      const bookId = Number(req.params.id); const chapterIdx = Number(req.params.idx);
      const chapter = db.prepare('SELECT content FROM book_chapters WHERE book_id = ? AND idx = ?').get(bookId, chapterIdx);
      if (!chapter) return res.status(404).json({ ok: false, error: 'chapter not found' });
      const anchor = String(req.body?.anchor || '').trim().slice(0, 500);
      const note = String(req.body?.note || '').trim().slice(0, 4000);
      let anchorStart = Number.isInteger(req.body?.anchor_start) ? req.body.anchor_start : -1;
      let anchorEnd = Number.isInteger(req.body?.anchor_end) ? req.body.anchor_end : -1;
      if (!anchor || anchor.length < 2) return res.status(400).json({ ok: false, error: '请至少选择两个字' });
      if (anchorStart < 0 || chapter.content.slice(anchorStart, anchorEnd) !== anchor) {
        anchorStart = chapter.content.indexOf(anchor);
        anchorEnd = anchorStart < 0 ? -1 : anchorStart + anchor.length;
      }
      if (anchorStart < 0) return res.status(400).json({ ok: false, error: '选中文字和本章内容对不上，请重新选择' });
      const id = crypto.randomBytes(8).toString('hex');
      db.prepare(`INSERT INTO book_annotations
        (id, book_id, chapter_idx, anchor, note, anchor_start, anchor_end)
        VALUES (?,?,?,?,?,?,?)`).run(id, bookId, chapterIdx, anchor, note, anchorStart, anchorEnd);
      const annotation = annotationsForChapter(bookId, chapterIdx).find(item => item.id === id);
      res.json({ ok: true, annotation });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/books/:id/annotations/:annotationId/replies', (req, res) => {
    try {
      const bookId = Number(req.params.id); const annotationId = String(req.params.annotationId || '');
      const annotation = db.prepare('SELECT id FROM book_annotations WHERE id = ? AND book_id = ?').get(annotationId, bookId);
      if (!annotation) return res.status(404).json({ ok: false, error: 'annotation not found' });
      const text = String(req.body?.text || '').trim().slice(0, 12000);
      const who = String(req.body?.who || 'ai').trim().slice(0, 24) || 'ai';
      if (!text) return res.status(400).json({ ok: false, error: 'reply text required' });
      const info = db.prepare('INSERT INTO book_annotation_replies (annotation_id, who, text) VALUES (?,?,?)')
        .run(annotationId, who, text);
      const reply = db.prepare('SELECT id, annotation_id, who, text, created_at FROM book_annotation_replies WHERE id = ?').get(info.lastInsertRowid);
      res.json({ ok: true, reply });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/books/:id/annotations/:annotationId', (req, res) => {
    try {
      const bookId = Number(req.params.id); const annotationId = String(req.params.annotationId || '');
      const tx = db.transaction(() => {
        const owned = db.prepare('SELECT id FROM book_annotations WHERE id = ? AND book_id = ?').get(annotationId, bookId);
        if (!owned) return false;
        db.prepare('DELETE FROM book_annotation_replies WHERE annotation_id = ?').run(annotationId);
        db.prepare('DELETE FROM book_annotations WHERE id = ?').run(annotationId);
        return true;
      });
      if (!tx()) return res.status(404).json({ ok: false, error: 'annotation not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/books-annotations/pending', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT a.*, b.title AS book_title, c.title AS chapter_title
        FROM book_annotations a
        JOIN books b ON b.id = a.book_id
        JOIN book_chapters c ON c.book_id = a.book_id AND c.idx = a.chapter_idx
        WHERE NOT EXISTS (SELECT 1 FROM book_annotation_replies r WHERE r.annotation_id = a.id)
        ORDER BY a.created_at`).all();
      res.json({ ok: true, annotations: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.put('/api/books/:id/progress', (req, res) => {
    try {
      const bookId = Number(req.params.id);
      const chapterIdx = Math.max(0, Number(req.body?.chapter_idx) || 0);
      const scrollPct = Math.min(100, Math.max(0, Number(req.body?.scroll_pct) || 0));
      db.prepare(`INSERT INTO book_progress (book_id, chapter_idx, scroll_pct, updated_at) VALUES (?,?,?,datetime('now','localtime'))
        ON CONFLICT(book_id) DO UPDATE SET chapter_idx=excluded.chapter_idx, scroll_pct=excluded.scroll_pct, updated_at=excluded.updated_at`)
        .run(bookId, chapterIdx, scrollPct);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/books/:id', (req, res) => {
    try {
      const bookId = Number(req.params.id);
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM book_annotation_replies WHERE annotation_id IN (SELECT id FROM book_annotations WHERE book_id = ?)').run(bookId);
        db.prepare('DELETE FROM book_annotations WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_chapters WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_progress WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
      });
      tx();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[books] Routes mounted on /api/books');
}

module.exports = { mountBooksRoutes };
