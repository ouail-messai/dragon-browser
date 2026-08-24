const { app, BrowserWindow, BrowserView, ipcMain, session } = require('electron');
const path = require('path');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const extensionsManager = require('./extensions');

const store = new Store();

// ---------- تحديث تلقائي صامت (بلا أي تنبيه أو تدخل من المستخدم) ----------
// يتفقد نسخة جديدة على GitHub Releases، ينزلها في الخلفية، ويركبها لوحدو المرة الجاية اللي يسكر/يعاود يفتح فيها البرنامج
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null; // بلا أي log مرئي أو نافذة

function setupSilentAutoUpdate() {
  autoUpdater.on('error', () => {}); // نبلع أي خطأ بصمت (مثلا ما كاين انترنت) بلا ما نزعج المستخدم
  autoUpdater.on('update-downloaded', () => {
    // النسخة الجديدة جاهزة، راح تترکب لوحدها عند أول إغلاق طبيعي للبرنامج
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 2 * 60 * 60 * 1000); // نعاود نتفقد كل ساعتين
}

// ---------- تحسينات أداء عامة (تقلل استهلاك RAM/CPU بلا ما تكسر المواقع) ----------
// ملاحظة صادقة: كان عندنا حد أقصى لذاكرة V8 (256MB) مطبق على كل صفحة — هذا كان يخلي مواقع تقيلة بالجافاسكريبت
// (كيما YouTube) تطيح (crash صامت، شاشة سوداء بلا خطأ). شلناه نهائيا لأنه يكسر الوظيفة الأساسية للمتصفح.
// التحسين الحقيقي والآمن هو Tab Suspension (تحت) اللي يحرر الرام من تبويبات ما تستخدمهاش، بلا ما يأثر على أي صفحة مفتوحة فعليا.
app.commandLine.appendSwitch('disable-background-timer-throttling', 'false'); // نخلي throttling شغال (يوفر CPU للتبويبات الخلفية)
// نعطل Client Hints (Sec-CH-UA...) لأنها تفضح Electron/Chromium الحقيقي حتى لو بدلنا الـ User-Agent المكتوب،
// وهذا التضارب يخلي مواقع كثيرة (منها YouTube) تكتشف "متصفح غريب" وتعطي نسخة معطلة أو ترفض كليا
app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');

let mainWindow;
let views = new Map(); // tabId -> BrowserView (نشيطة فقط)
let suspendedTabs = new Map(); // tabId -> { url, title } (تبويبات موقوفة لتوفير RAM)
let lastActiveTime = new Map(); // tabId -> timestamp
let activeTabId = null;
let tabCounter = 0;

const TOOLBAR_HEIGHT = 88; // 48px شريط الأزرار/التبويبات + 40px شريط العنوان (التصميم الجديد)
const SUSPEND_AFTER_MS = 5 * 60 * 1000; // نوقف أي تبويب غير نشيط بعد 5 دقايق باش نحرر الرام
const SUSPEND_CHECK_INTERVAL = 60 * 1000; // نفحص كل دقيقة

const os = require('os');
const { pathToFileURL } = require('url');
const NEW_TAB_URL = pathToFileURL(path.join(__dirname, '../renderer/newtab.html')).href + '?user=' + encodeURIComponent(os.userInfo().username || 'there');
// User-Agent واقعي (كروم حقيقي) — Electron افتراضيا يعرّف روحو كـ"Electron" وهذا يخلي مواقع كثيرة (منها YouTube) ترفضو أو تعطي نسخة معطلة
const REAL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- إنشاء النافذة الرئيسية ----------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#141824',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../renderer/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // ملاحظة صادقة: جربنا حل يدوي (نحسبو المقاس بـ JS في كل مرة نستقبل حدث resize) وطلع فيه bug —
  // كنا نحسبو يدويا **و** نخليو Electron يحسب تلقائيا (autoResize) في نفس الوقت، فكانو يتضاربو
  // ويزيدو "ينحرفو" مع كل تكبير/تصغير متتالي. الحل النهائي: نعتمدو على آلية Electron الأصلية
  // (setAutoResize) وحدها بلا أي حساب يدوي بعدها — أثبت بزاف وما فيهاش سباق توقيت (race condition).

  // أول تبويب افتراضي
  mainWindow.webContents.on('did-finish-load', () => {
    createTab(NEW_TAB_URL);
  });
}

// ---------- تفعيل حجب الإعلانات والتتبع (built-in, بلا إضافات) ----------
async function setupAdBlocker() {
  // User-Agent حقيقي لكل الجلسة — يصلح مواقع كثيرة (منها YouTube) اللي كانت ترفض Electron الافتراضي
  session.defaultSession.setUserAgent(REAL_CHROME_UA);

  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: path.join(app.getPath('userData'), 'adblocker-engine.bin'),
    read: require('fs').promises.readFile,
    write: require('fs').promises.writeFile
  });

  // استثناءات صريحة لدومينات YouTube/Google الأساسية — بعض قوايم الحجب الجاهزة تحجب بالغلط
  // موارد أساسية (كيما googlevideo.com) وتكسر الموقع كامل. هذا حل رسمي عبر آلية exceptions تاع المكتبة،
  // ماشي عبر onBeforeRequest يدوي (باش ما نرجعوش لنفس bug تضارب الـ handlers اللي صلحناه قبل).
  blocker.updateFromDiff({
    added: [
      '@@||googlevideo.com^$important',
      '@@||ytimg.com^$important',
      '@@||ggpht.com^$important',
      '@@||youtubei.googleapis.com^$important',
      '@@||play.google.com^$important',
      '@@||youtube.com^$important',
      '@@||www.youtube.com^$important'
    ]
  });

  // هذا هو الـ handler الوحيد المسموح به لـ onBeforeRequest في الـ session —
  // لازم يكون واحد فقط، فخليناه هو المسؤول على الحجب + فرض HTTPS مع بعض (بدل ما يتلغاو من بعضهم)
  blocker.enableBlockingInSession(session.defaultSession);

  console.log('[Dragon Browser] Ad & tracker blocker: ACTIVE');
  return blocker;
}

// ---------- فرض HTTPS (بطريقة ما تلغيش حاجب الإعلانات) ----------
// نديروها عبر will-navigate بدل webRequest.onBeforeRequest، باش ما يتضاربش مع الـ blocker
function enforceHttpsOnView(view) {
  view.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') && !url.startsWith('http://localhost')) {
      event.preventDefault();
      view.webContents.loadURL(url.replace('http://', 'https://'));
    }
  });
}

// ---------- حجب popup الإعلانات (نوافذ جديدة غير مرغوبة) ----------
// إعلانات كثيرة تفتح نافذة جديدة بدل ما تكون مجرد request عادي، وهذا حاجب الإعلانات وحده ما يوقفوش
function blockAdPopups(view) {
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    // نفتحو أي رابط "target=_blank" شرعي كتبويب جديد عندنا، بدل ما نخليو نافذة منفصلة (اللي غالبا تكون إعلان/popunder)
    if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
      createTab(url);
    }
    return { action: 'deny' }; // نمنع أي نافذة Electron منفصلة تنفتح بروحها (أغلبها إعلانات)
  });
}

// إذا صفحة طاحت (crash) لأي سبب، نعاود نحملها أوتوماتيكيا بدل ما تبقى شاشة سوداء بلا تفسير
function attachCrashRecovery(view) {
  view.webContents.on('render-process-gone', (event, details) => {
    console.error(`[Dragon Browser] Renderer crashed (reason: ${details.reason}), reloading...`);
    if (!view.webContents.isDestroyed()) {
      setTimeout(() => view.webContents.reload(), 300);
    }
  });
}

// أحداث مشتركة لكل تبويب: عنوان، رابط، وشريط تحميل الصفحة (progress bar)
function attachTabEvents(id, view) {
  view.webContents.on('page-title-updated', (e, title) => {
    mainWindow.webContents.send('tab-title-updated', { id, title });
  });
  view.webContents.on('did-navigate', (e, navUrl) => {
    mainWindow.webContents.send('tab-url-updated', { id, url: navUrl });
  });
  view.webContents.on('did-navigate-in-page', (e, navUrl) => {
    mainWindow.webContents.send('tab-url-updated', { id, url: navUrl });
  });
  view.webContents.on('did-start-loading', () => {
    mainWindow.webContents.send('tab-loading-start', { id });
  });
  view.webContents.on('did-stop-loading', () => {
    mainWindow.webContents.send('tab-loading-stop', { id });
  });

  // إذا صفحة فشلت تحميل فعليا (ماشي إلغاء عادي)، نوري صفحة خطأ واضحة فيها السبب —
  // بدل ما تبقى شاشة سوداء صامتة بلا أي تفسير (هذا كان يصعب علينا نعرفو وين المشكل بالضبط)
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return; // نتجاهل فشل موارد فرعية (صور/إعلانات محجوبة...)، نهتمو غير بفشل الصفحة الرئيسية
    if (errorCode === -3) return; // -3 = ABORTED، يصير عادي عند إلغاء تنقل أو تحويل، ماشي خطأ حقيقي
    const errPage = 'file://' + path.join(__dirname, '../renderer/error-page.html')
      + `?code=${errorCode}&desc=${encodeURIComponent(errorDescription)}&url=${encodeURIComponent(validatedURL)}`;
    view.webContents.loadURL(errPage);
  });
}

// ---------- إدارة التبويبات (مع تحسينات ذاكرة) ----------
function createTab(url = NEW_TAB_URL) {
  const id = ++tabCounter;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // sandboxing قوي - كل تبويب معزول
      backgroundThrottling: true, // يبطّئ تلقائيا JS/timers في التبويبات غير الظاهرة (يوفر CPU)
      spellcheck: false, // تعطيل التدقيق الإملائي المدمج يقلل استهلاك الذاكرة والـCPU
      webgl: true,
      enableWebSQL: false, // ميزة قديمة غير مستخدمة، تعطيلها يقلل overhead
      preload: path.join(__dirname, '../renderer/tab-preload.js') // خفيف، يخدم غير مع صفحاتنا الداخلية
    }
  });

  views.set(id, view);
  view.webContents.loadURL(url);
  lastActiveTime.set(id, Date.now());
  enforceHttpsOnView(view);
  blockAdPopups(view);
  attachCrashRecovery(view);

  attachTabEvents(id, view);

  switchTab(id);
  mainWindow.webContents.send('tab-created', { id, url });
  return id;
}

function switchTab(id) {
  // إذا التبويب موقوف (suspended) نعيد تحميله أول
  if (suspendedTabs.has(id) && !views.has(id)) {
    const { url } = suspendedTabs.get(id);
    resumeTab(id, url);
    return;
  }
  const view = views.get(id);
  if (!view) return;
  activeTabId = id;
  lastActiveTime.set(id, Date.now());
  mainWindow.setBrowserView(view);
  resizeActiveView();
}

function closeTab(id) {
  const view = views.get(id);
  if (view) {
    if (activeTabId === id) mainWindow.removeBrowserView(view);
    view.webContents.close();
    views.delete(id);
  }
  suspendedTabs.delete(id);
  lastActiveTime.delete(id);
  mainWindow.webContents.send('tab-closed', { id });
}

// ---------- توقيف التبويبات غير النشيطة لتحرير RAM (أهم تحسين للأداء) ----------
// أي تبويب مفتوح بصح ما تستعملوش لمدة، نسكر عملية الرندرة تاعو كليا (يحرر الرام الحقيقية)
// ونحتفظ فقط بالعنوان والـURL، ونعاود نحمّلو كي ترجع تلمسو
function suspendTab(id) {
  if (id === activeTabId) return; // ما نوقفوش التبويب النشيط
  const view = views.get(id);
  if (!view) return;

  const url = view.webContents.getURL();
  const title = view.webContents.getTitle();

  mainWindow.removeBrowserView(view);
  view.webContents.close(); // يسكر عملية الرندرة كليا ويحرر الذاكرة المرتبطة بيها

  views.delete(id);
  suspendedTabs.set(id, { url, title });
  mainWindow.webContents.send('tab-suspended', { id });
  console.log(`[Dragon Browser] Tab ${id} suspended, RAM freed`);
}

function resumeTab(id, url) {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      spellcheck: false,
      preload: path.join(__dirname, '../renderer/tab-preload.js')
    }
  });
  views.set(id, view);
  view.webContents.loadURL(url);
  suspendedTabs.delete(id);
  enforceHttpsOnView(view);
  blockAdPopups(view);
  attachCrashRecovery(view);

  attachTabEvents(id, view);

  activeTabId = id;
  lastActiveTime.set(id, Date.now());
  mainWindow.setBrowserView(view);
  resizeActiveView();
  mainWindow.webContents.send('tab-resumed', { id });
}

function startAutoSuspendLoop() {
  setInterval(() => {
    const now = Date.now();
    for (const [id] of views) {
      if (id === activeTabId) continue;
      const last = lastActiveTime.get(id) || now;
      if (now - last > SUSPEND_AFTER_MS) {
        suspendTab(id);
      }
    }
  }, SUSPEND_CHECK_INTERVAL);
}

// نحسب المقاس مرة وحدة (وقت إنشاء/تبديل التبويب)، وبعدها نخلي Electron نفسها تتابع أي تغيير حجم
// للنافذة (تكبير/تصغير/تعظيم) عبر setAutoResize — آلية أصلية داخل Electron، ماشي حساب يدوي بـ JS
// عرضة لمشاكل التوقيت. هذا هو الفرق الجوهري اللي يصلح "الانحراف" اللي كان يصير عند التكبير.
function resizeActiveView() {
  if (!activeTabId) return;
  const view = views.get(activeTabId);
  if (!view) return;
  const bounds = mainWindow.getContentBounds();
  view.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - TOOLBAR_HEIGHT)
  });
  view.setAutoResize({ width: true, height: true, horizontal: false, vertical: false });
}

// ---------- IPC: التواصل بين الواجهة (شريط العنوان/التبويبات) ونواة المتصفح ----------
ipcMain.on('new-tab', (e, url) => createTab(url));
ipcMain.on('switch-tab', (e, id) => switchTab(id));
ipcMain.on('close-tab', (e, id) => closeTab(id));
ipcMain.on('navigate', (e, { id, url }) => {
  const view = views.get(id);
  if (!view) return;
  if (url === 'dragon://extensions') {
    view.webContents.loadFile(path.join(__dirname, '../renderer/extensions-page.html'));
    return;
  }
  view.webContents.loadURL(url.startsWith('http') ? url : `https://www.google.com/search?q=${encodeURIComponent(url)}`);
});
ipcMain.on('go-back', (e, id) => views.get(id)?.webContents.goBack());
ipcMain.on('go-forward', (e, id) => views.get(id)?.webContents.goForward());
ipcMain.on('reload', (e, id) => views.get(id)?.webContents.reload());
ipcMain.on('open-devtools', (e, id) => views.get(id)?.webContents.openDevTools({ mode: 'detach' }));
ipcMain.on('open-devtools-self', (e) => e.sender.openDevTools({ mode: 'detach' }));

// ---------- IPC: الإضافات (Extensions) ----------
ipcMain.handle('install-extension', async (e, extensionIdOrUrl) => {
  try {
    const result = await extensionsManager.installExtension(extensionIdOrUrl);
    return { success: true, extension: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('list-extensions', () => extensionsManager.listInstalledExtensions());
ipcMain.handle('remove-extension', (e, id) => {
  extensionsManager.removeExtension(id);
  return true;
});
ipcMain.handle('toggle-extension', async (e, id, enabled) => {
  try {
    await extensionsManager.setExtensionEnabled(id, enabled);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- دورة حياة التطبيق ----------
app.whenReady().then(async () => {
  await setupAdBlocker();
  await extensionsManager.loadSavedExtensions(); // نعاود نحمّل الإضافات اللي كانت منصبة من قبل
  createMainWindow();
  startAutoSuspendLoop(); // يبدا مراقبة التبويبات غير النشيطة لتحرير الرام تلقائيا
  setupSilentAutoUpdate(); // يبدا التحقق من التحديثات في الخلفية، بصمت تام

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
