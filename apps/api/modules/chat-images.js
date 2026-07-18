const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 图片桥接（2026-06-22）：前端发来的 data URL 图片落成临时文件，prompt 里让 claude 用 Read 看。
// 这样用户发照片/截图、"查手机"共享的画面，我才真的能看见（之前 images 被后端忽略）。
const CHAT_IMG_DIR = process.env.RIFUGIO_CHAT_IMAGE_DIR || require('./community-config').dataPath('chat-images');
function materializeImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  try {
    fs.mkdirSync(CHAT_IMG_DIR, { recursive: true });
    const now = Date.now();
    for (const f of fs.readdirSync(CHAT_IMG_DIR)) {            // 清理 1 天前的临时图
      const p = path.join(CHAT_IMG_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) {}
  const out = [];
  for (const img of images.slice(0, 6)) {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(String(img || ''));
    if (!m) continue;
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    const file = path.join(CHAT_IMG_DIR, crypto.randomBytes(6).toString('hex') + '.' + ext);
    try { fs.writeFileSync(file, Buffer.from(m[2], 'base64')); out.push(file); } catch (_) {}
  }
  return out;
}

function promptWithImages(text, images) {
  const paths = materializeImages(images);
  if (!paths.length) return text;
  return (text || '（图片）') + `\n\n[用户发来 ${paths.length} 张图片。必须先用 Read 工具逐张读取下面这些本机图片文件，再根据图片内容回应；不要凭文件名或猜测作答]：\n` + paths.join('\n');
}

module.exports = { materializeImages, promptWithImages };
