let activeId = null;
let tabsState = [];

const tabsStrip = document.getElementById('tabs-strip');
const addressBar = document.getElementById('address-bar');
const progressBar = document.getElementById('progress-bar');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');

function displayUrl(url) {
  return (!url || url.startsWith('file://')) ? '' : url;
}

function renderTabs() {
  tabsStrip.innerHTML = '';
  tabsState.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeId ? ' active' : '');
    el.innerHTML = `<span class="tab-title">${tab.title || 'New Tab'}</span><span class="close-btn material-symbols-outlined" style="font-size:14px;">close</span>`;
    el.querySelector('.tab-title').onclick = () => {
      activeId = tab.id;
      window.dragon.switchTab(tab.id);
      addressBar.value = displayUrl(tab.url);
      renderTabs();
    };
    el.querySelector('.close-btn').onclick = (e) => {
      e.stopPropagation();
      window.dragon.closeTab(tab.id);
    };
    tabsStrip.appendChild(el);
  });
}

document.getElementById('new-tab-btn').onclick = () => window.dragon.newTab();
document.getElementById('home').onclick = () => window.dragon.newTab();
backBtn.onclick = () => window.dragon.goBack(activeId);
forwardBtn.onclick = () => window.dragon.goForward(activeId);
document.getElementById('reload').onclick = () => window.dragon.reload(activeId);

addressBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.dragon.navigate(activeId, addressBar.value.trim());
  }
});

window.dragon.onTabCreated(({ id, url }) => {
  tabsState.push({ id, title: 'New Tab', url });
  activeId = id;
  addressBar.value = displayUrl(url);
  renderTabs();
});

window.dragon.onTabClosed(({ id }) => {
  tabsState = tabsState.filter(t => t.id !== id);
  renderTabs();
});

window.dragon.onTitleUpdated(({ id, title }) => {
  const tab = tabsState.find(t => t.id === id);
  if (tab) tab.title = title;
  renderTabs();
});

window.dragon.onUrlUpdated(({ id, url }) => {
  const tab = tabsState.find(t => t.id === id);
  if (tab) tab.url = url;
  if (id === activeId) addressBar.value = displayUrl(url);
});

// ---------- شريط تحميل الصفحة (2px أحمر) ----------
window.dragon.onLoadingStart(({ id }) => {
  if (id !== activeId) return;
  progressBar.classList.add('loading');
  progressBar.style.width = '30%';
});
window.dragon.onLoadingStop(({ id }) => {
  if (id !== activeId) return;
  progressBar.style.width = '100%';
  setTimeout(() => {
    progressBar.classList.remove('loading');
    progressBar.style.width = '0%';
  }, 250);
});

// ---------- الإضافات (Extensions) ----------
const extPanel = document.getElementById('ext-panel');
const extBtn = document.getElementById('extensions-btn');
const extInput = document.getElementById('ext-id-input');
const extInstallBtn = document.getElementById('ext-install-btn');
const extStatus = document.getElementById('ext-status');
const extList = document.getElementById('ext-list');

async function refreshExtensionsList() {
  const list = await window.dragon.listExtensions();
  extList.innerHTML = '';
  list.forEach(ext => {
    const row = document.createElement('div');
    row.className = 'ext-item';
    row.innerHTML = `<span>${ext.name} (v${ext.version})</span><span class="remove">&times;</span>`;
    row.querySelector('.remove').onclick = async () => {
      await window.dragon.removeExtension(ext.id);
      refreshExtensionsList();
    };
    extList.appendChild(row);
  });
}

extBtn.onclick = () => {
  document.getElementById('menu-panel').classList.remove('open');
  extPanel.classList.toggle('open');
  if (extPanel.classList.contains('open')) refreshExtensionsList();
};

extInstallBtn.onclick = async () => {
  const val = extInput.value.trim();
  if (!val) return;
  extStatus.textContent = 'جاري التنصيب...';
  extInstallBtn.disabled = true;
  const result = await window.dragon.installExtension(val);
  extInstallBtn.disabled = false;
  if (result.success) {
    extStatus.textContent = `✅ تم تنصيب: ${result.extension.name}`;
    extInput.value = '';
    refreshExtensionsList();
  } else {
    extStatus.textContent = `❌ ${result.error}`;
  }
};

// ---------- قائمة "..." ----------
const menuPanel = document.getElementById('menu-panel');
document.getElementById('menu-btn').onclick = () => {
  extPanel.classList.remove('open');
  menuPanel.classList.toggle('open');
};
document.getElementById('menu-new-tab').onclick = () => { window.dragon.newTab(); menuPanel.classList.remove('open'); };
document.getElementById('menu-reload').onclick = () => { window.dragon.reload(activeId); menuPanel.classList.remove('open'); };
document.getElementById('menu-home').onclick = () => { window.dragon.newTab(); menuPanel.classList.remove('open'); };

document.addEventListener('click', (e) => {
  if (!extPanel.contains(e.target) && e.target.id !== 'extensions-btn' && !document.getElementById('extensions-btn').contains(e.target)) {
    extPanel.classList.remove('open');
  }
  if (!menuPanel.contains(e.target) && e.target.id !== 'menu-btn' && !document.getElementById('menu-btn').contains(e.target)) {
    menuPanel.classList.remove('open');
  }
});
