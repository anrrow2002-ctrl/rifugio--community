const crypto = require('crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const Database = require('better-sqlite3');

const PRIVATE_NETS = new net.BlockList();
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]) PRIVATE_NETS.addSubnet(network, prefix, family);

async function assertPublicHttpUrl(target) {
  if (!/^https?:$/.test(target.protocol)) throw new Error('unsupported protocol');
  const hostname = target.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('private target denied');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) =>
    PRIVATE_NETS.check(address, family === 6 ? 'ipv6' : 'ipv4'))) {
    throw new Error('private target denied');
  }
}

function mountTalkMediaRoutes(app, { DB_PATH }) {
  function listAiStickers(req, res) {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const stickers = db.prepare('SELECT * FROM ai_stickers ORDER BY datetime(updated_at) DESC, name ASC').all();
      res.json({ ok: true, stickers });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  }

  function upsertAiSticker(req, res) {
    const db = new Database(DB_PATH);
    try {
      const b = req.body || {};
      const id = String(b.id || crypto.randomUUID());
      const existing = db.prepare('SELECT resident FROM ai_stickers WHERE id=?').get(id);
      const requestedResident = b.resident == null
        ? Number(existing?.resident || 0)
        : ([true, 1, '1', 'true'].includes(b.resident) ? 1 : 0);
      if (requestedResident && !Number(existing?.resident || 0)) {
        const count = Number(db.prepare('SELECT COUNT(*) AS n FROM ai_stickers WHERE resident=1').get()?.n || 0);
        if (count >= 50) return res.status(409).json({ ok: false, error: '常驻高频区最多 50 张' });
      }
      const row = {
        id,
        name: String(b.name || b.semantic || '表情包').trim().slice(0, 120),
        url: String(b.url || '').trim(),
        data_url: String(b.dataUrl || b.data_url || '').trim(),
        category: String(b.category || '').trim().slice(0, 80),
        keywords: String(b.keywords || b.aliases || '').trim().slice(0, 300),
        semantic: String(b.semantic || b.name || '').trim().slice(0, 300),
        stolen_from: String(b.stolenFrom || b.stolen_from || '').trim().slice(0, 300),
        created_by: String(b.createdBy || b.created_by || 'user').trim().slice(0, 40),
        resident: requestedResident,
      };
      if (!row.url && !row.data_url) return res.status(400).json({ ok: false, error: 'url or dataUrl required' });
      db.prepare(`INSERT INTO ai_stickers (id, name, url, data_url, category, keywords, semantic, stolen_from, created_by, resident, created_at, updated_at)
        VALUES (@id, @name, @url, @data_url, @category, @keywords, @semantic, @stolen_from, @created_by, @resident, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, url=excluded.url, data_url=excluded.data_url, category=excluded.category,
          keywords=excluded.keywords, semantic=excluded.semantic, stolen_from=excluded.stolen_from,
          created_by=excluded.created_by, resident=excluded.resident, updated_at=datetime('now')`).run(row);
      res.json({ ok: true, sticker: row });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  }

  function deleteAiSticker(req, res) {
    const db = new Database(DB_PATH);
    try { db.prepare('DELETE FROM ai_stickers WHERE id=?').run(String(req.params.id || '')); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    finally { db.close(); }
  }

  app.get('/api/talk/image-proxy', async (req, res) => {
    try {
      const raw = String(req.query.url || '').trim();
      if (!raw || raw.length > 2048) return res.status(400).json({ ok: false, error: 'bad url' });
      let target = new URL(raw);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let r;
      try {
        for (let hop = 0; hop < 4; hop += 1) {
          await assertPublicHttpUrl(target);
          r = await fetch(target.href, {
            signal: controller.signal,
            redirect: 'manual',
            headers: {
              'User-Agent': 'Rifugio image proxy',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            },
          });
          if (r.status < 300 || r.status >= 400) break;
          const location = r.headers.get('location');
          if (!location) throw new Error('invalid redirect');
          target = new URL(location, target);
          r = null;
        }
        if (!r) throw new Error('too many redirects');
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) return res.status(502).json({ ok: false, error: 'image fetch failed' });
      const type = String(r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      if (type && !type.startsWith('image/')) return res.status(415).json({ ok: false, error: 'not an image' });
      const len = Number(r.headers.get('content-length') || 0);
      if (len > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'image too large' });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return res.status(404).json({ ok: false, error: 'empty image' });
      if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'image too large' });
      res.setHeader('Content-Type', type || 'image/*');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    } catch (e) {
      const status = e.name === 'AbortError' ? 504 : (/private target denied|unsupported protocol/.test(e.message || '') ? 400 : 500);
      res.status(status).json({ ok: false, error: status === 500 ? 'image proxy failed' : (e.message || String(e)) });
    }
  });

  app.get('/api/talk/ai-stickers', listAiStickers);
  app.post('/api/talk/ai-stickers', upsertAiSticker);
  app.delete('/api/talk/ai-stickers/:id', deleteAiSticker);
  // Backward-compatible alias for older frontends; new UI treats this as AI-only, not the user's local sticker library.
  app.get('/api/talk/stickers', listAiStickers);
  app.post('/api/talk/stickers', upsertAiSticker);
  app.delete('/api/talk/stickers/:id', deleteAiSticker);

  // ── 长截图服务端渲染：前端把内联好样式+dataURL 图片的自包含导出 DOM 发来，
  // 无头 Chromium 出全页 PNG（真·所见即所得；浏览器端 foreignObject/canvas 只留兜底）。
  // 串行锁：2G 内存的机器一次只跑一个 Chromium。Chromium 常驻复用，60s 闲置自动关。
  const EXPORT_CHROMIUM = process.env.RIFUGIO_CHROMIUM || '/usr/bin/chromium';
  let exportImageBusy = Promise.resolve();
  let exportBrowser = null;
  let exportBrowserIdleTimer = null;

  async function getExportBrowser() {
    const puppeteer = require('puppeteer-core');
    if (exportBrowserIdleTimer) { clearTimeout(exportBrowserIdleTimer); exportBrowserIdleTimer = null; }
    if (exportBrowser) {
      try { await exportBrowser.pages(); return exportBrowser; }
      catch (_) { exportBrowser = null; }
    }
    exportBrowser = await puppeteer.launch({
      executablePath: EXPORT_CHROMIUM,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
    });
    exportBrowser.on('disconnected', () => { exportBrowser = null; });
    return exportBrowser;
  }

  function scheduleExportBrowserIdle() {
    if (exportBrowserIdleTimer) clearTimeout(exportBrowserIdleTimer);
    exportBrowserIdleTimer = setTimeout(async () => {
      exportBrowserIdleTimer = null;
      const b = exportBrowser;
      exportBrowser = null;
      if (b) await b.close().catch(() => {});
    }, 60000);
  }

  app.post('/api/talk/export-image', async (req, res) => {
    const html = String(req.body?.html || '');
    const width = Math.max(280, Math.min(1200, Number(req.body?.width) || 390));
    const reqScale = Math.max(1, Math.min(3, Number(req.body?.scale) || 2));
    if (!html) return res.status(400).json({ ok: false, error: 'html required' });
    if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'html too large' });
    }
    const run = exportImageBusy.then(async () => {
      const browser = await getExportBrowser();
      try {
        // 单次 setViewport：pm2 进程里内容加载后再改 deviceScaleFactor 会把 renderer 弄死（实测），
        // 所以 scale 在装内容前设定；超高图（height*scale>16k，Chromium 单边上限）降 scale 重渲一次。
        const renderOnce = async (scale) => {
          const page = await browser.newPage();
          page.on('error', (e) => console.error('[export-image] page crashed:', e && e.message));
          await page.setViewport({ width, height: 800, deviceScaleFactor: scale });
          // load 而非 networkidle0：内容全为 dataURL 自包含，无需等网络静默窗口
          await page.setContent(
            `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data:; font-src data:;"></head><body style="margin:0;background:transparent;">${html}</body></html>`,
            { waitUntil: 'load', timeout: 45000 },
          );
          await page.evaluate(() => (document.fonts && document.fonts.ready) || true).catch(() => {});
          // 真实内容高度（body.scrollHeight 不会小于视口，短内容会多出一截空白）
          const height = await page.evaluate(() => {
            const bottoms = Array.from(document.body.children).map(el => el.getBoundingClientRect().bottom);
            const content = Math.ceil(Math.max(0, ...bottoms));
            return content || Math.ceil(document.body.scrollHeight);
          });
          return { page, height };
        };
        let scale = reqScale;
        let { page, height } = await renderOnce(scale);
        if (height > 40000) throw new Error('内容太长，请少选几条再截');
        const fitScale = Math.max(1, Math.min(reqScale, Math.floor((16000 / Math.max(1, height)) * 10) / 10));
        if (fitScale < scale) {
          await page.close().catch(() => {});
          scale = fitScale;
          ({ page, height } = await renderOnce(scale));
        }
        // 必须 await：return 裸 promise 的话 finally 的 scheduleExportBrowserIdle 会在截图进行中启动闲置计时
        const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true, omitBackground: true });
        await page.close().catch(() => {});
        return buf;
      } catch (e) {
        // 渲染出错则丢弃当前 browser 实例，下次请求重新启动
        const b = exportBrowser;
        exportBrowser = null;
        await b?.close().catch(() => {});
        throw e;
      } finally {
        scheduleExportBrowserIdle();
      }
    });
    exportImageBusy = run.then(() => {}, () => {});
    try {
      const buf = await run;
      res.set('Content-Type', 'image/png').send(buf);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
}

module.exports = { mountTalkMediaRoutes };
