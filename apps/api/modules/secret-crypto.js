const crypto = require('crypto');

function createSecretCrypto({ isProd = false } = {}) {
  if (!process.env.RIFUGIO_SECRET) {
    const msg = '[server] RIFUGIO_SECRET 未配置，无法安全解密已保存的 API key。';
    if (isProd) throw new Error(msg);
    console.warn(msg + ' 当前按开发模式继续运行。');
  }
  const secret = process.env.RIFUGIO_SECRET || 'dev-only-rifugio-secret';

  function maskKey(key) {
    if (!key || key.length < 8) return '***';
    return key.slice(0, 3) + '***' + key.slice(-4);
  }

  function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', crypto.createHash('sha256').update(secret).digest(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  function decrypt(text) {
    const [ivHex, encrypted] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.createHash('sha256').update(secret).digest(), Buffer.from(ivHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  return { maskKey, encrypt, decrypt, secret };
}

module.exports = { createSecretCrypto };
