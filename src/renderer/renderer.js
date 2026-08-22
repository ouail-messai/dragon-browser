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

document.getElementById('new-tab-btn').onclick = () => window.dragon.newTab('https://www.google.com');
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
  addressBar.value = url;
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
  if (id === activeId) addressBar.value = url;
});
