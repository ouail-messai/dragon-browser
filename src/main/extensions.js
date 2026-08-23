const path = require('path');
const fs = require('fs');
const https = require('https');
const { app, session } = require('electron');
const extractZip = require('extract-zip');

const EXTENSIONS_DIR = () => path.join(app.getPath('userData'), 'extensions');

// تحميل ملف CRX من Chrome Web Store عبر endpoint التحديث الرسمي لجوجل
function downloadCrx(extensionId, destPath) {
  return new Promise((resolve, reject) => {
    const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=126.0.0.0&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc`;

    const download = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('عدد كبير جدا من إعادة التوجيه'));
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`فشل تحميل الإضافة (HTTP ${res.statusCode}). تأكد أن الـ ID صحيح.`));
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', reject);
      }).on('error', reject);
    };

    download(url);
  });
}

// ملف CRX = هيدر خاص بجوجل (توقيع) + محتوى ZIP عادي بعده. نشيل الهيدر ونستخرج الـ ZIP فقط.
function stripCrxHeaderToZip(crxPath, zipPath) {
  const buffer = fs.readFileSync(crxPath);
  const magic = buffer.toString('utf8', 0, 4);
  if (magic !== 'Cr24') {
    throw new Error('ملف الإضافة غير صالح (ماشي CRX حقيقي)');
  }
  const version = buffer.readUInt32LE(4);
  let zipStart;
  if (version === 2) {
    const pubKeyLen = buffer.readUInt32LE(8);
    const sigLen = buffer.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else if (version === 3) {
    const headerLen = buffer.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else {
    throw new Error('نسخة CRX غير مدعومة: ' + version);
  }
  fs.writeFileSync(zipPath, buffer.subarray(zipStart));
}

// تنصيب إضافة كاملة انطلاقا من ID تاعها في Chrome Web Store
async function installExtension(extensionId) {
  extensionId = extensionId.trim();
  // إذا المستخدم لصق رابط Chrome Web Store كامل، نستخرج الـ ID منو
  const urlMatch = extensionId.match(/chrome\.google\.com\/webstore\/detail\/[^/]+\/([a-p]{32})/i)
    || extensionId.match(/chromewebstore\.google\.com\/detail\/[^/]+\/([a-p]{32})/i);
  if (urlMatch) extensionId = urlMatch[1];

  if (!/^[a-p]{32}$/i.test(extensionId)) {
    throw new Error('معرّف الإضافة غير صالح. لازم يكون 32 حرف (a-p)، أو الصق رابط الإضافة كامل من المتجر.');
  }

  const baseDir = EXTENSIONS_DIR();
  fs.mkdirSync(baseDir, { recursive: true });

  const crxPath = path.join(baseDir, `${extensionId}.crx`);
  const zipPath = path.join(baseDir, `${extensionId}.zip`);
  const extractPath = path.join(baseDir, extensionId);

  await downloadCrx(extensionId, crxPath);
  stripCrxHeaderToZip(crxPath, zipPath);

  if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
  await extractZip(zipPath, { dir: extractPath });

  fs.unlinkSync(crxPath);
  fs.unlinkSync(zipPath);

  const manifestPath = path.join(extractPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('الإضافة ما فيهاش manifest.json صالح بعد فك الضغط.');
  }

  const loaded = await session.defaultSession.loadExtension(extractPath, { allowFileAccess: true });

  // نحفظ قايمة الإضافات المنصبة باش نعاودو نحملهم عند فتح المتصفح مرة ثانية
  const listPath = path.join(baseDir, 'installed.json');
  let installed = [];
  if (fs.existsSync(listPath)) {
    try { installed = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch (e) { installed = []; }
  }
  if (!installed.includes(extensionId)) {
    installed.push(extensionId);
    fs.writeFileSync(listPath, JSON.stringify(installed, null, 2));
  }

  return { id: loaded.id, name: loaded.name, version: loaded.version, path: extractPath };
}

// حذف إضافة
function removeExtension(extensionId) {
  const baseDir = EXTENSIONS_DIR();
  const extractPath = path.join(baseDir, extensionId);
  const listPath = path.join(baseDir, 'installed.json');

  const ext = session.defaultSession.getAllExtensions().find(e => e.id === extensionId || e.path === extractPath);
  if (ext) session.defaultSession.removeExtension(ext.id);

  if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });

  if (fs.existsSync(listPath)) {
    let installed = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    installed = installed.filter(id => id !== extensionId);
    fs.writeFileSync(listPath, JSON.stringify(installed, null, 2));
  }
}

// عند بداية تشغيل المتصفح، نعاود نحمّل كل الإضافات المنصبة سابقا
async function loadSavedExtensions() {
  const baseDir = EXTENSIONS_DIR();
  const listPath = path.join(baseDir, 'installed.json');
  if (!fs.existsSync(listPath)) return [];

  let installed = [];
  try { installed = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch (e) { return []; }

  const results = [];
  for (const id of installed) {
    const extractPath = path.join(baseDir, id);
    if (fs.existsSync(path.join(extractPath, 'manifest.json'))) {
      try {
        const loaded = await session.defaultSession.loadExtension(extractPath, { allowFileAccess: true });
        results.push({ id: loaded.id, name: loaded.name, version: loaded.version });
      } catch (e) {
        console.error(`[Dragon Browser] فشل تحميل إضافة محفوظة ${id}:`, e.message);
      }
    }
  }
  return results;
}

function listInstalledExtensions() {
  return session.defaultSession.getAllExtensions().map(e => ({
    id: e.id, name: e.name, version: e.manifest?.version || ''
  }));
}

module.exports = { installExtension, removeExtension, loadSavedExtensions, listInstalledExtensions };
