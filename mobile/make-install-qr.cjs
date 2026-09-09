const QRCode = require('qrcode');
const path = require('node:path');
const fs = require('node:fs/promises');
(async () => {
  const folder = path.resolve(__dirname, '../dist/mobile');
  await fs.mkdir(folder, { recursive: true });
  await QRCode.toFile(path.join(folder, 'install-qr.png'), 'https://jiaban-x2m.pages.dev/install.html', { width: 320, margin: 3, errorCorrectionLevel: 'M' });
  console.log('Installation QR code generated.');
})();
