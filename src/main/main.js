const { app, BrowserWindow, BrowserView, ipcMain, session } = require('electron');
const path = require('path');
const { ElectronBlocker } = require('@cliqz/adblocker-electron');
const fetch = require('cross-fetch');
const Store = require('electron-store');

const store = new Store();

// ---------- تحسينات أداء عامة (تقلل استهلاك RAM/CPU) ----------
// V8: تحديد سقف الذاكرة لكل عملية رندرة بدل ما تكبر بلا حدود
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
// تعطيل تسريع الأجهزة إذا الجهاز ضعيف يقلل استهلاك CPU/GPU (يبقى قابل للتفعيل لاحقا كخيار في الإعدادات)
// app.commandLine.appendSwitch('disable-gpu'); // نخليها معطلة افتراضيا، تفعّل فقط لو المستخدم يحب "وضع توفير الطاقة"
app.commandLine.appendSwitch('disable-background-timer-throttling', 'false'); // نخلي throttling شغال (يوفر CPU للتبويبات الخلفية)
app.commandLine.appendSwitch('renderer-process-limit', '4'); // يحد عدد عمليات الرندرة المتوازية

let mainWindow;
let views = new Map(); // tabId -> BrowserView (نشيطة فقط)
let suspendedTabs = new Map(); // tabId -> { url, title } (تبويبات موقوفة لتوفير RAM)
let lastActiveTime = new Map(); // tabId -> timestamp
let activeTabId = null;
let tabCounter = 0;

const TOOLBAR_HEIGHT = 84; // مساحة شريط العنوان + التبويبات فوق كل صفحة
const SUSPEND_AFTER_MS = 5 * 60 * 1000; // نوقف أي تبويب غير نشيط بعد 5 دقايق باش نحرر الرام
const SUSPEND_CHECK_INTERVAL = 60 * 1000; // نفحص كل دقيقة

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

  mainWindow.on('resize', () => resizeActiveView());

  // أول تبويب افتراضي
  mainWindow.webContents.on('did-finish-load', () => {
    createTab('https://www.google.com');
  });
}

// ---------- تفعيل حجب الإعلانات والتتبع (built-in, بلا إضافات) ----------
async function setupAdBlocker() {
  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: path.join(app.getPath('userData'), 'adblocker-engine.bin'),
    read: require('fs').promises.readFile,
    write: require('fs').promises.writeFile
  });

  blocker.enableBlockingInSession(session.defaultSession);

  // فرض HTTPS كل ما أمكن (حماية إضافية)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame' && !details.url.startsWith('http://localhost')) {
      callback({ redirectURL: details.url.replace('http://', 'https://') });
    } else {
      callback({});
    }
  });

  console.log('[Dragon Browser] Ad & tracker blocker: ACTIVE');
  return blocker;
}

// ---------- إدارة التبويبات (مع تحسينات ذاكرة) ----------
function createTab(url = 'https://www.google.com') {
  const id = ++tabCounter;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // sandboxing قوي - كل تبويب معزول
      backgroundThrottling: true, // يبطّئ تلقائيا JS/timers في التبويبات غير الظاهرة (يوفر CPU)
      spellcheck: false, // تعطيل التدقيق الإملائي المدمج يقلل استهلاك الذاكرة والـCPU
      webgl: true,
      enableWebSQL: false // ميزة قديمة غير مستخدمة، تعطيلها يقلل overhead
    }
  });

  views.set(id, view);
  view.webContents.loadURL(url);
  lastActiveTime.set(id, Date.now());

  view.webContents.on('page-title-updated', (e, title) => {
    mainWindow.webContents.send('tab-title-updated', { id, title });
  });

  view.webContents.on('did-navigate', (e, navUrl) => {
    mainWindow.webContents.send('tab-url-updated', { id, url: navUrl });
  });

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
      spellcheck: false
    }
  });
  views.set(id, view);
  view.webContents.loadURL(url);
  suspendedTabs.delete(id);

  view.webContents.on('page-title-updated', (e, title) => {
    mainWindow.webContents.send('tab-title-updated', { id, title });
  });
  view.webContents.on('did-navigate', (e, navUrl) => {
    mainWindow.webContents.send('tab-url-updated', { id, url: navUrl });
  });

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

function resizeActiveView() {
  if (!activeTabId) return;
  const view = views.get(activeTabId);
  if (!view) return;
  const bounds = mainWindow.getContentBounds();
  view.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: bounds.width,
    height: bounds.height - TOOLBAR_HEIGHT
  });
  view.setAutoResize({ width: true, height: true });
}

// ---------- IPC: التواصل بين الواجهة (شريط العنوان/التبويبات) ونواة المتصفح ----------
ipcMain.on('new-tab', (e, url) => createTab(url));
ipcMain.on('switch-tab', (e, id) => switchTab(id));
ipcMain.on('close-tab', (e, id) => closeTab(id));
ipcMain.on('navigate', (e, { id, url }) => {
  const view = views.get(id);
  if (view) view.webContents.loadURL(url.startsWith('http') ? url : `https://www.google.com/search?q=${encodeURIComponent(url)}`);
});
ipcMain.on('go-back', (e, id) => views.get(id)?.webContents.goBack());
ipcMain.on('go-forward', (e, id) => views.get(id)?.webContents.goForward());
ipcMain.on('reload', (e, id) => views.get(id)?.webContents.reload());

// ---------- دورة حياة التطبيق ----------
app.whenReady().then(async () => {
  await setupAdBlocker();
  createMainWindow();
  startAutoSuspendLoop(); // يبدا مراقبة التبويبات غير النشيطة لتحرير الرام تلقائيا

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
