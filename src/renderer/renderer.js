let activeId = null;
const tabsContainer = document.getElementById('tabs-container');
const addressBar = document.getElementById('address-bar');

function renderTabs(tabs) {
  tabsContainer.innerHTML = '';
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeId ? ' active' : '');
    el.innerHTML = `<span>${tab.title || 'New Tab'}</span><span class="close-btn">&times;</span>`;
    el.querySelector('span').onclick = () => {
      activeId = tab.id;
      window.dragon.switchTab(tab.id);
      addressBar.value = (tab.url || '').startsWith('file://') ? '' : (tab.url || '');
      renderTabs(tabs);
    };
    el.querySelector('.close-btn').onclick = (e) => {
      e.stopPropagation();
      window.dragon.closeTab(tab.id);
    };
    tabsContainer.appendChild(el);
  });
}

let tabsState = [];

document.getElementById('new-tab-btn').onclick = () => window.dragon.newTab();
document.getElementById('back').onclick = () => window.dragon.goBack(activeId);
document.getElementById('forward').onclick = () => window.dragon.goForward(activeId);
document.getElementById('reload').onclick = () => window.dragon.reload(activeId);

addressBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.dragon.navigate(activeId, addressBar.value.trim());
  }
});

window.dragon.onTabCreated(({ id, url }) => {
  tabsState.push({ id, title: 'New Tab', url });
  activeId = id;
  addressBar.value = url.startsWith('file://') ? '' : url;
  renderTabs(tabsState);
});

window.dragon.onTabClosed(({ id }) => {
  tabsState = tabsState.filter(t => t.id !== id);
  renderTabs(tabsState);
});

window.dragon.onTitleUpdated(({ id, title }) => {
  const tab = tabsState.find(t => t.id === id);
  if (tab) tab.title = title;
  renderTabs(tabsState);
});

window.dragon.onUrlUpdated(({ id, url }) => {
  const tab = tabsState.find(t => t.id === id);
  if (tab) tab.url = url;
  if (id === activeId) addressBar.value = url.startsWith('file://') ? '' : url;
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
