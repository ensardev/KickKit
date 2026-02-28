let channels = [];
let groups = [];
let settings = {};
let siteSettings = {};
let channelCache = {};
let activeGroup = 'all';

const AVATAR_COLORS = [
  '#c0392b','#d35400','#d4ac0d','#1e8449',
  '#148f77','#1a5276','#6c3483','#922b21'
];

function getAvatarColor(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h << 5) - h + slug.charCodeAt(i);
    h |= 0;
  }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadStorage();
  await I18n.init(settings.lang || 'tr');
  document.documentElement.lang = settings.lang || 'tr';
  I18n.applyDOM();
  renderGroupTabs();
  renderChannels();
  bindMainEvents();
  bindSettingsEvents();
  listenBackground();
});

async function loadStorage() {
  const sync = await chrome.storage.sync.get(['channels', 'groups', 'settings', 'siteSettings']);
  const local = await chrome.storage.local.get(['channelCache']);
  channels = sync.channels || [];
  groups = sync.groups || [{ id: 'all', name: '' }];
  settings = sync.settings || { pollInterval: 60, notificationSound: true, lang: 'tr' };
  siteSettings = sync.siteSettings || defaultSiteSettings();
  channelCache = local.channelCache || {};
}

function defaultSiteSettings() {
  return {
    enabled: true, theme: 'default',
    chat: {
      filterWords: [], filterUsers: [],
      filterBots: false, filterEmojiSpam: false,
      keywords: [], fontSize: 13,
      showTimestamp: false, compactMode: false
    },
    player: { shortcuts: true, theaterMode: false, defaultQuality: 'auto' }
  };
}

function renderGroupTabs() {
  const container = document.getElementById('group-tabs');
  container.innerHTML = '';

  const liveCount = channels.filter(ch => channelCache[ch.slug]?.isLive).length;
  const builtinTabs = [
    { id: 'all', name: I18n.t('tab_all') },
    { id: 'online', name: liveCount > 0 ? I18n.t('tab_online') + ' (' + liveCount + ')' : I18n.t('tab_online') }
  ];

  [...builtinTabs, ...groups.filter(g => g.id !== 'all')].forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'group-tab' + (g.id === activeGroup ? ' active' : '');
    btn.textContent = g.name;
    btn.dataset.id = g.id;
    btn.addEventListener('click', () => {
      activeGroup = g.id;
      renderGroupTabs();
      renderChannels();
    });
    container.appendChild(btn);
  });
}

function renderChannels() {
  const list = document.getElementById('channel-list');
  const empty = document.getElementById('empty-state');

  const filtered = activeGroup === 'all'
    ? channels
    : activeGroup === 'online'
      ? channels.filter(ch => channelCache[ch.slug]?.isLive)
      : channels.filter(ch => ch.groups?.includes(activeGroup));

  const sorted = [...filtered].sort((a, b) => {
    const al = channelCache[a.slug]?.isLive ? 1 : 0;
    const bl = channelCache[b.slug]?.isLive ? 1 : 0;
    return bl - al;
  });

  const liveCount = filtered.filter(ch => channelCache[ch.slug]?.isLive).length;
  document.getElementById('stat-live').textContent = I18n.t('stat_live').replace('{n}', liveCount);
  document.getElementById('stat-total').textContent = I18n.t('stat_total').replace('{n}', filtered.length);

  if (sorted.length === 0) {
    empty.style.display = '';
    list.querySelectorAll('.channel-card').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';

  const existing = new Map();
  list.querySelectorAll('.channel-card[data-slug]').forEach(el => existing.set(el.dataset.slug, el));

  const newSlugs = new Set(sorted.map(c => c.slug));
  existing.forEach((el, slug) => { if (!newSlugs.has(slug)) el.remove(); });

  sorted.forEach(ch => {
    const cache = channelCache[ch.slug];
    if (existing.has(ch.slug)) {
      patchCard(existing.get(ch.slug), ch, cache);
    } else {
      list.appendChild(buildCard(ch, cache));
    }
  });
}

function buildCard(ch, cache) {
  const isLive = cache?.isLive ?? false;
  const displayName = cache?.displayName || ch.displayName || ch.slug;
  const avatar = cache?.avatar || ch.avatar || '';
  const initial = (displayName[0] || '?').toUpperCase();
  const color = getAvatarColor(ch.slug);
  const notifyOn = ch.notifyOnline !== false;

  const card = document.createElement('div');
  card.className = 'channel-card' + (isLive ? ' live' : '');
  card.dataset.slug = ch.slug;

  const main = document.createElement('div');
  main.className = 'card-main';

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'avatar-wrap';
  avatarWrap.style.setProperty('--avatar-color', color);
  const letter = document.createElement('span');
  letter.className = 'avatar-letter';
  letter.textContent = initial;
  avatarWrap.appendChild(letter);
  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    avatarWrap.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'card-info';
  info.innerHTML = buildCardInfoHTML(ch, cache, isLive, displayName);

  main.appendChild(avatarWrap);
  main.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.innerHTML = buildActionsHTML(notifyOn);
  actions.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn) handleCardAction(btn.dataset.action, ch.slug, card);
  });

  card.appendChild(main);
  card.appendChild(actions);
  return card;
}

function buildCardInfoHTML(ch, cache, isLive, displayName) {
  const viewers = isLive ? '<span class="viewers">' + formatNum(cache?.viewerCount) + '</span>' : '';
  const badge = isLive
    ? '<span class="live-badge"><span class="live-dot"></span>LIVE</span>'
    : '<span class="offline-badge">OFFLINE</span>';

  let row2 = '';
  let row3 = '';
  if (isLive && cache) {
    const parts = [];
    if (cache.category) parts.push(cache.category);
    if (cache.startTime) parts.push(formatDuration(cache.startTime));
    row2 = parts.join(' · ');
    row3 = escapeHtml(cache.title || '');
  }

  return '<div class="card-row1"><span class="channel-name">' + escapeHtml(displayName) + '</span>' + badge + viewers + '</div>' +
    '<div class="card-row2">' + escapeHtml(row2) + '</div>' +
    '<div class="card-row3">' + row3 + '</div>';
}

function buildActionsHTML(notifyOn) {
  const bellOn  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const bellOff = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const openSVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  const gridSVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  const trashSVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

  return '<button class="act-btn ' + (notifyOn ? 'notify-active' : '') + '" data-action="notify" title="' + (notifyOn ? I18n.t('notify_on_title') : I18n.t('notify_off_title')) + '">' + (notifyOn ? bellOn : bellOff) + (notifyOn ? I18n.t('notify_on') : I18n.t('notify_off')) + '</button>' +
    '<button class="act-btn open-btn" data-action="open" title="' + I18n.t('btn_open_title') + '">' + openSVG + I18n.t('btn_open') + '</button>' +
    '<button class="act-btn multi-btn" data-action="multi" title="' + I18n.t('btn_multi_action_title') + '">' + gridSVG + I18n.t('btn_multi') + '</button>' +
    '<div class="card-spacer"></div>' +
    '<button class="act-btn danger" data-action="remove" title="' + I18n.t('btn_remove_title') + '">' + trashSVG + '</button>';
}

function patchCard(card, ch, cache) {
  const isLive = cache?.isLive ?? false;
  const displayName = cache?.displayName || ch.displayName || ch.slug;
  const notifyOn = ch.notifyOnline !== false;

  card.className = 'channel-card' + (isLive ? ' live' : '');

  const info = card.querySelector('.card-info');
  if (info) info.innerHTML = buildCardInfoHTML(ch, cache, isLive, displayName);

  // actions elementini yeniden oluştur (event listener birikimini önler)
  const oldActions = card.querySelector('.card-actions');
  if (oldActions) {
    const newActions = document.createElement('div');
    newActions.className = 'card-actions';
    newActions.innerHTML = buildActionsHTML(notifyOn);
    newActions.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (btn) handleCardAction(btn.dataset.action, ch.slug, card);
    });
    oldActions.replaceWith(newActions);
  }

  const wrap = card.querySelector('.avatar-wrap');
  if (wrap && cache?.avatar && !wrap.querySelector('img')) {
    const img = document.createElement('img');
    img.src = cache.avatar;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    wrap.appendChild(img);
  }
}

async function handleCardAction(action, slug, card) {
  if (action === 'open') {
    chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: 'https://kick.com/' + slug });
    return;
  }
  if (action === 'multi') {
    chrome.runtime.sendMessage({ type: 'ADD_TO_MULTISTREAM', slug });
    return;
  }
  if (action === 'remove') {
    channels = channels.filter(c => c.slug !== slug);
    await chrome.storage.sync.set({ channels });
    renderChannels();
    return;
  }
  if (action === 'notify') {
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return;
    ch.notifyOnline = !ch.notifyOnline;
    await chrome.storage.sync.set({ channels });
    patchCard(card, ch, channelCache[slug]);
  }
}

async function addChannel(raw) {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!slug) return;
  if (channels.some(c => c.slug === slug)) { shakeInput(); return; }
  channels.push({
    slug, displayName: slug, avatar: '',
    groups: ['all'], notifyOnline: true, addedAt: Date.now()
  });
  await chrome.storage.sync.set({ channels });
  document.getElementById('input-slug').value = '';
  renderChannels();
  chrome.runtime.sendMessage({ type: 'POLL_NOW' });
}

function shakeInput() {
  const el = document.getElementById('input-slug');
  el.style.borderColor = 'rgba(255,69,69,0.6)';
  el.style.boxShadow = '0 0 0 3px rgba(255,69,69,0.1)';
  setTimeout(() => { el.style.borderColor = ''; el.style.boxShadow = ''; }, 1200);
}

function bindMainEvents() {
  const input = document.getElementById('input-slug');
  document.getElementById('btn-add').addEventListener('click', () => addChannel(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(input.value); });

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.classList.add('spinning');
    chrome.runtime.sendMessage({ type: 'POLL_NOW' });
    await new Promise(r => setTimeout(r, 800));
    await loadStorage();
    renderChannels();
    btn.classList.remove('spinning');
  });

  document.getElementById('btn-settings').addEventListener('click', () => openSettings());
  document.getElementById('btn-settings-close').addEventListener('click', () => closeSettings());

  document.getElementById('btn-multistream').addEventListener('click', () => {
    const live = channels.filter(ch => channelCache[ch.slug]?.isLive).map(ch => ch.slug);
    chrome.runtime.sendMessage({ type: 'OPEN_MULTISTREAM', channels: live });
  });
}

function openSettings() {
  document.getElementById('settings-panel').hidden = false;
  switchTab('groups');
}

function closeSettings() {
  document.getElementById('settings-panel').hidden = true;
}

function bindSettingsEvents() {
  document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-group-add').addEventListener('click', createGroup);
  document.getElementById('input-group').addEventListener('keydown', e => {
    if (e.key === 'Enter') createGroup();
  });

  document.getElementById('btn-word-add').addEventListener('click', () => {
    const inp = document.getElementById('input-word');
    addFilterItem('filterWords', inp.value.trim());
    inp.value = '';
  });
  document.getElementById('input-word').addEventListener('keydown', e => {
    if (e.key === 'Enter') { addFilterItem('filterWords', e.target.value.trim()); e.target.value = ''; }
  });

  document.getElementById('btn-user-add').addEventListener('click', () => {
    const inp = document.getElementById('input-user-filter');
    addFilterItem('filterUsers', inp.value.trim());
    inp.value = '';
  });
  document.getElementById('input-user-filter').addEventListener('keydown', e => {
    if (e.key === 'Enter') { addFilterItem('filterUsers', e.target.value.trim()); e.target.value = ''; }
  });

  ['chk-word-mode','chk-filter-bots','chk-filter-emoji','chk-timestamp','chk-compact'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveChatToggles);
  });

  document.getElementById('chk-filter-emoji')?.addEventListener('change', e => {
    const row = document.getElementById('emoji-threshold-row');
    if (row) row.style.display = e.target.checked ? '' : 'none';
  });

  document.getElementById('btn-emoji-dec')?.addEventListener('click', () => changeEmojiThreshold(-1));
  document.getElementById('btn-emoji-inc')?.addEventListener('click', () => changeEmojiThreshold(1));

  document.getElementById('chk-filter-mode')?.addEventListener('change', e => {
    updateFilterModeLabel(e.target.checked);
    saveChatToggles();
  });

  document.getElementById('btn-font-dec').addEventListener('click', () => changeFontSize(-1));
  document.getElementById('btn-font-inc').addEventListener('click', () => changeFontSize(1));

  document.getElementById('sel-poll').addEventListener('change', saveGeneralSettings);
  document.getElementById('chk-sound').addEventListener('change', saveGeneralSettings);
  document.getElementById('chk-dnd').addEventListener('change', e => {
    document.getElementById('dnd-time-row').hidden = !e.target.checked;
    saveGeneralSettings();
  });
  document.getElementById('sel-dnd-start').addEventListener('change', saveGeneralSettings);
  document.getElementById('sel-dnd-end').addEventListener('change', saveGeneralSettings);

  document.getElementById('sel-lang')?.addEventListener('change', async () => {
    settings.lang = document.getElementById('sel-lang').value;
    await chrome.storage.sync.set({ settings });
    location.reload();
  });

  document.querySelectorAll('.ustab').forEach(btn => {
    btn.addEventListener('click', () => switchUsersSubTab(btn.dataset.ustab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.stab-content').forEach(el => el.classList.add('tab-hidden'));
  const target = document.getElementById('tab-' + name);
  if (target) target.classList.remove('tab-hidden');
  if (name === 'groups') renderGroupsTab();
  if (name === 'chat') renderChatTab();
  if (name === 'general') renderGeneralTab();
  if (name === 'users') renderUsersTab();
}

async function createGroup() {
  const inp = document.getElementById('input-group');
  const name = inp.value.trim();
  if (!name) return;
  if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) { inp.select(); return; }
  const id = 'g_' + Date.now();
  groups.push({ id, name });
  await chrome.storage.sync.set({ groups });
  inp.value = '';
  renderGroupTabs();
  renderGroupsTab();
}

function renderGroupsTab() {
  const container = document.getElementById('groups-with-channels');
  const nonAll = groups.filter(g => g.id !== 'all');
  if (!nonAll.length) {
    container.innerHTML = '<p class="tab-hint">' + I18n.t('group_no_groups') + '</p>';
    return;
  }

  const openState = {};
  container.querySelectorAll('.group-block[data-gid]').forEach(el => {
    openState[el.dataset.gid] = el.classList.contains('open');
  });

  container.innerHTML = '';
  nonAll.forEach(g => {
    const inGroupCount = channels.filter(ch => ch.groups?.includes(g.id)).length;
    const isOpen = openState[g.id] === true;

    const block = document.createElement('div');
    block.className = 'group-block' + (isOpen ? ' open' : '');
    block.dataset.gid = g.id;

    const header = document.createElement('div');
    header.className = 'group-block-header';
    header.innerHTML = `
      <div class="group-block-toggle">
        <svg class="group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        <span class="group-block-name">${escapeHtml(g.name)}</span>
        <span class="group-count">${I18n.t('group_channel_count').replace('{n}', inGroupCount)}</span>
      </div>
      <button class="group-del-btn" title="${I18n.t('group_del_title')}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>`;

    header.querySelector('.group-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteGroup(g.id);
    });
    header.addEventListener('click', () => block.classList.toggle('open'));

    const chList = document.createElement('div');
    chList.className = 'group-channels';
    if (!channels.length) {
      chList.innerHTML = '<span class="group-channels-empty">' + I18n.t('group_no_channels_hint') + '</span>';
    } else {
      channels.forEach(ch => {
        const inGroup = ch.groups?.includes(g.id) ?? false;
        const displayName = channelCache[ch.slug]?.displayName || ch.displayName || ch.slug;
        const row = document.createElement('label');
        row.className = 'group-ch-row';
        row.innerHTML = '<input type="checkbox"' + (inGroup ? ' checked' : '') + '><span>' + escapeHtml(displayName) + '</span>';
        row.querySelector('input').addEventListener('change', e => assignChannelToGroup(ch.slug, g.id, e.target.checked));
        chList.appendChild(row);
      });
    }

    block.appendChild(header);
    block.appendChild(chList);
    container.appendChild(block);
  });
}

async function deleteGroup(groupId) {
  groups = groups.filter(g => g.id !== groupId);
  channels = channels.map(ch => ({
    ...ch,
    groups: (ch.groups || []).filter(id => id !== groupId).length
      ? ch.groups.filter(id => id !== groupId)
      : ['all']
  }));
  if (activeGroup === groupId) activeGroup = 'all';
  await chrome.storage.sync.set({ groups, channels });
  renderGroupTabs();
  renderGroupsTab();
  renderChannels();
}

async function assignChannelToGroup(slug, groupId, add) {
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return;
  if (add) {
    if (!ch.groups.includes(groupId)) ch.groups.push(groupId);
  } else {
    ch.groups = ch.groups.filter(id => id !== groupId);
    if (!ch.groups.length) ch.groups = ['all'];
  }
  await chrome.storage.sync.set({ channels });
}

function renderChatTab() {
  const chat = siteSettings.chat || {};
  renderChips('word-chips', chat.filterWords || [], 'filterWords');
  renderChips('user-chips', chat.filterUsers || [], 'filterUsers');
  setChk('chk-word-mode', chat.filterWordMode !== false);
  setChk('chk-filter-bots', chat.filterBots);
  setChk('chk-filter-emoji', chat.filterEmojiSpam);
  const thresholdRow = document.getElementById('emoji-threshold-row');
  if (thresholdRow) thresholdRow.style.display = chat.filterEmojiSpam ? '' : 'none';
  document.getElementById('emoji-threshold-val').textContent = chat.emojiSpamThreshold || 5;
  setChk('chk-timestamp', chat.showTimestamp);
  setChk('chk-compact', chat.compactMode);
  document.getElementById('font-size-val').textContent = chat.fontSize || 13;

  const isBlur = chat.filterAction === 'blur';
  setChk('chk-filter-mode', isBlur);
  updateFilterModeLabel(isBlur);
}

function updateFilterModeLabel(isBlur) {
  const label = document.getElementById('filter-mode-label');
  if (!label) return;
  label.textContent = isBlur ? I18n.t('filter_mode_blur') : I18n.t('filter_mode_hide');
  label.style.color = isBlur ? '#53FC18' : '#f85149';
}

function setChk(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function renderChips(containerId, items, field) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  items.forEach(word => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = escapeHtml(word) + '<button class="chip-del" title="' + I18n.t('chip_remove_title') + '">✕</button>';
    chip.querySelector('.chip-del').addEventListener('click', () => removeFilterItem(field, word));
    container.appendChild(chip);
  });
}

async function addFilterItem(field, value) {
  if (!value) return;
  const chat = siteSettings.chat || {};
  const list = chat[field] || [];
  if (list.includes(value)) return;
  list.push(value);
  chat[field] = list;
  siteSettings.chat = chat;
  await chrome.storage.sync.set({ siteSettings });
  renderChips(field === 'filterWords' ? 'word-chips' : 'user-chips', list, field);
}

async function removeFilterItem(field, value) {
  const chat = siteSettings.chat || {};
  chat[field] = (chat[field] || []).filter(v => v !== value);
  siteSettings.chat = chat;
  await chrome.storage.sync.set({ siteSettings });
  renderChips(field === 'filterWords' ? 'word-chips' : 'user-chips', chat[field], field);
}

async function saveChatToggles() {
  const chat = siteSettings.chat || {};
  chat.filterWordMode  = document.getElementById('chk-word-mode')?.checked ?? true;
  chat.filterBots      = document.getElementById('chk-filter-bots')?.checked ?? false;
  chat.filterEmojiSpam = document.getElementById('chk-filter-emoji')?.checked ?? false;
  chat.showTimestamp   = document.getElementById('chk-timestamp')?.checked ?? false;
  chat.compactMode     = document.getElementById('chk-compact')?.checked ?? false;
  chat.filterAction    = document.getElementById('chk-filter-mode')?.checked ? 'blur' : 'hide';
  siteSettings.chat = chat;
  await chrome.storage.sync.set({ siteSettings });
}

async function changeFontSize(delta) {
  const chat = siteSettings.chat || {};
  chat.fontSize = Math.min(22, Math.max(10, (chat.fontSize || 13) + delta));
  siteSettings.chat = chat;
  document.getElementById('font-size-val').textContent = chat.fontSize;
  await chrome.storage.sync.set({ siteSettings });
}

async function changeEmojiThreshold(delta) {
  const chat = siteSettings.chat || {};
  chat.emojiSpamThreshold = Math.min(30, Math.max(1, (chat.emojiSpamThreshold || 5) + delta));
  siteSettings.chat = chat;
  document.getElementById('emoji-threshold-val').textContent = chat.emojiSpamThreshold;
  await chrome.storage.sync.set({ siteSettings });
}

function renderGeneralTab() {
  const langSel = document.getElementById('sel-lang');
  if (langSel) langSel.value = settings.lang || 'tr';
  const pollSel = document.getElementById('sel-poll');
  if (pollSel) pollSel.value = settings.pollInterval || 60;
  const soundChk = document.getElementById('chk-sound');
  if (soundChk) soundChk.checked = settings.notificationSound !== false;

  const dnd = settings.dnd || { enabled: false, start: 23, end: 8 };
  const dndChk = document.getElementById('chk-dnd');
  if (dndChk) dndChk.checked = dnd.enabled;
  const dndRow = document.getElementById('dnd-time-row');
  if (dndRow) dndRow.hidden = !dnd.enabled;

  ['sel-dnd-start', 'sel-dnd-end'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel && !sel.options.length) {
      for (let h = 0; h < 24; h++) {
        sel.add(new Option(String(h).padStart(2, '0') + ':00', h));
      }
    }
  });
  const startSel = document.getElementById('sel-dnd-start');
  if (startSel) startSel.value = dnd.start;
  const endSel = document.getElementById('sel-dnd-end');
  if (endSel) endSel.value = dnd.end;
}

async function saveGeneralSettings() {
  settings.pollInterval = parseInt(document.getElementById('sel-poll')?.value || '60');
  settings.notificationSound = document.getElementById('chk-sound')?.checked ?? true;
  settings.dnd = {
    enabled: document.getElementById('chk-dnd')?.checked ?? false,
    start: parseInt(document.getElementById('sel-dnd-start')?.value ?? '23'),
    end: parseInt(document.getElementById('sel-dnd-end')?.value ?? '8')
  };
  await chrome.storage.sync.set({ settings });
  chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
}

function listenBackground() {
  chrome.runtime.onMessage.addListener(async msg => {
    if (msg.type === 'CACHE_UPDATED') {
      channelCache = msg.cache || {};
      const sync = await chrome.storage.sync.get(['channels']);
      if (sync.channels) channels = sync.channels;
      renderChannels();
    }
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNum(n) {
  if (!n) return '';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(startTime) {
  if (!startTime) return '';
  const diff = Date.now() - new Date(startTime).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? h + 's ' + m + 'd' : m + 'd';
}

function renderUsersTab() {
  const chat = siteSettings.chat || {};
  renderUserList('fav-user-list', chat.favoriteUsers || [], 'favoriteUsers');
  renderUserList('blocked-user-list', chat.filterUsers || [], 'filterUsers');
}

function renderUserList(containerId, users, field) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!users.length) {
    const emptyKey = field === 'favoriteUsers' ? 'users_empty_favs' : 'users_empty_blocked';
    const fallback = field === 'favoriteUsers' ? 'Henüz favori kullanıcı yok.' : 'Henüz engelli kullanıcı yok.';
    container.innerHTML = '<p class="user-list-empty">' + I18n.t(emptyKey, fallback) + '</p>';
    return;
  }
  users.forEach(slug => {
    const color = getAvatarColor(slug);
    const initial = slug.charAt(0).toUpperCase();
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML =
      '<div class="user-row-av" style="background:' + color + '">' + escapeHtml(initial) + '</div>' +
      '<span class="user-row-name">' + escapeHtml(slug) + '</span>' +
      '<button class="user-row-del" title="' + I18n.t('chip_remove_title', 'Kaldır') + '">' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
          '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
        '</svg>' +
      '</button>';
    row.querySelector('.user-row-del').addEventListener('click', () => removeUserItem(field, slug));
    container.appendChild(row);
  });
}

async function removeUserItem(field, value) {
  const chat = siteSettings.chat || {};
  chat[field] = (chat[field] || []).filter(v => v !== value);
  siteSettings.chat = chat;
  await chrome.storage.sync.set({ siteSettings });
  renderUsersTab();
  if (!document.getElementById('tab-chat')?.classList.contains('tab-hidden')) renderChatTab();
}

function switchUsersSubTab(name) {
  document.querySelectorAll('.ustab').forEach(b => b.classList.toggle('active', b.dataset.ustab === name));
  document.querySelectorAll('.ustab-content').forEach(el => {
    el.classList.toggle('ustab-hidden', el.id !== 'ustab-' + name);
  });
}
