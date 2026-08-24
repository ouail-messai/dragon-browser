const path = require('path');
const fs = require('fs');
const https = require('https');
const { app, session } = require('electron');
const extractZip = require('extract-zip');

const EXTENSIONS_DIR = () => path.join(app.getPath('userData'), 'extensions');
const listPath = () => path.join(EXTENSIONS_DIR(), 'installed.json');

function readInstalledList() {
  const p = listPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return []; }
}
function writeInstalledList(list) {
  fs.mkdirSync(EXTENSIONS_DIR(), { recursive: true });
  fs.writeFileSync(listPath(), JSON.stringify(list, null, 2));
}

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
  if (magic !== 'Cr24') throw new Error('ملف الإضافة غير صالح (ماشي CRX حقيقي)');
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

// نلقى أفضل أيقونة متوفرة في manifest.json ونرجع مسارها الكامل (file://) باش تنعرض في الواجهة
function resolveIconPath(extractPath, manifest) {
  try {
    let iconRel = null;
    if (manifest.icons) {
      const sizes = Object.keys(manifest.icons).map(Number).sort((a, b) => b - a);
      if (sizes.length) iconRel = manifest.icons[sizes[0]];
    }
    if (!iconRel && manifest.action?.default_icon) {
      const icons = manifest.action.default_icon;
      iconRel = typeof icons === 'string' ? icons : Object.values(icons)[0];
    }
    if (!iconRel && manifest.browser_action?.default_icon) {
      const icons = manifest.browser_action.default_icon;
      iconRel = typeof icons === 'string' ? icons : Object.values(icons)[0];
    }
    if (iconRel) {
      const fullPath = path.join(extractPath, iconRel);
      if (fs.existsSync(fullPath)) return 'file://' + fullPath.replace(/\\/g, '/');
    }
  } catch (e) { /* نتجاهل، نستعمل أيقونة افتراضية في الواجهة */ }
  return null;
}

function readManifest(extractPath) {
  const manifestPath = path.join(extractPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { return null; }
}

// تنصيب إضافة كاملة انطلاقا من ID أو رابط تاعها في Chrome Web Store
async function installExtension(extensionIdOrUrl) {
  let extensionId = extensionIdOrUrl.trim();
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

  const manifest = readManifest(extractPath);
  if (!manifest) throw new Error('الإضافة ما فيهاش manifest.json صالح بعد فك الضغط.');

  const loaded = await session.defaultSession.loadExtension(extractPath, { allowFileAccess: true });

  const entry = {
    id: extensionId,
    name: loaded.name || manifest.name || extensionId,
    version: loaded.version || manifest.version || '',
    description: manifest.description || '',
    icon: resolveIconPath(extractPath, manifest),
    enabled: true
  };

  let installed = readInstalledList().filter(e => e.id !== extensionId);
  installed.push(entry);
  writeInstalledList(installed);

  return entry;
}

// تفعيل/تعطيل إضافة بلا حذفها (نحتفظ بالملفات، غير نحمّلها/نشيلها من الـ session)
async function setExtensionEnabled(extensionId, enabled) {
  const baseDir = EXTENSIONS_DIR();
  const extractPath = path.join(baseDir, extensionId);
  let installed = readInstalledList();
  const entry = installed.find(e => e.id === extensionId);
  if (!entry) throw new Error('الإضافة غير موجودة');

  if (enabled) {
    if (!fs.existsSync(path.join(extractPath, 'manifest.json'))) {
      throw new Error('ملفات الإضافة مفقودة، جرب تحذفها وتعاود تنصبها');
    }
    const alreadyLoaded = session.defaultSession.getAllExtensions().find(e => e.id === extensionId);
    if (!alreadyLoaded) {
      await session.defaultSession.loadExtension(extractPath, { allowFileAccess: true });
    }
  } else {
    const loaded = session.defaultSession.getAllExtensions().find(e => e.id === extensionId);
    if (loaded) session.defaultSession.removeExtension(loaded.id);
  }

  entry.enabled = enabled;
  writeInstalledList(installed);
  return entry;
}

// حذف إضافة نهائيا (ملفات + من الـ session + من القايمة المحفوظة)
function removeExtension(extensionId) {
  const baseDir = EXTENSIONS_DIR();
  const extractPath = path.join(baseDir, extensionId);

  const loaded = session.defaultSession.getAllExtensions().find(e => e.id === extensionId);
  if (loaded) session.defaultSession.removeExtension(loaded.id);

  if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });

  const installed = readInstalledList().filter(e => e.id !== extensionId);
  writeInstalledList(installed);
}

// عند بداية تشغيل المتصفح، نعاود نحمّل فقط الإضافات المفعّلة (enabled: true)
async function loadSavedExtensions() {
  const baseDir = EXTENSIONS_DIR();
  const installed = readInstalledList();
  for (const entry of installed) {
    if (!entry.enabled) continue;
    const extractPath = path.join(baseDir, entry.id);
    if (fs.existsSync(path.join(extractPath, 'manifest.json'))) {
      try {
        await session.defaultSession.loadExtension(extractPath, { allowFileAccess: true });
      } catch (e) {
        console.error(`[Dragon Browser] فشل تحميل إضافة محفوظة ${entry.id}:`, e.message);
      }
    }
  }
  return installed;
}

// القايمة الكاملة (مفعّلة ومعطّلة) — هذا اللي تعرضو صفحة الإضافات بالتفصيل
function listInstalledExtensions() {
  return readInstalledList();
}

module.exports = {
  installExtension,
  removeExtension,
  setExtensionEnabled,
  loadSavedExtensions,
  listInstalledExtensions
};
