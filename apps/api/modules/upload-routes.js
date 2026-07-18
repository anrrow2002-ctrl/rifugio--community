const fs = require('fs');
const path = require('path');
const { dataPath } = require('./community-config');

function mountUploadRoutes(app) {
  // --- Icon upload ---
  try {
    const multer = require('multer');
    const sharp = require('sharp');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });
    app.post('/api/upload-icon', upload.single('icon'), async (req, res) => {
      try {
        if (!req.file) return res.json({ ok: false, error: 'no file' });
        const iconPath = dataPath('uploads', 'app-icon.png');
        fs.mkdirSync(path.dirname(iconPath), { recursive: true });
        await sharp(req.file.buffer).resize(180,180,{fit:'cover'}).png().toFile(iconPath);
        res.json({ ok: true, url: '/api/community/icon' });
      } catch(e) { res.json({ ok: false, error: e.message }); }
    });
    app.get('/api/community/icon', (_req, res) => {
      const iconPath = dataPath('uploads', 'app-icon.png');
      if (!fs.existsSync(iconPath)) return res.status(404).end();
      res.sendFile(iconPath);
    });
  } catch(e) { console.log('multer/sharp not available, upload disabled'); }
}

module.exports = { mountUploadRoutes };
