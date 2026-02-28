const ALARM_NAME = 'ke-poll';
const API_BASE = 'https://kick.com/api/v2/channels';

chrome.runtime.onInstalled.addListener(async () => {
  await initDefaultStorage();
  await setupAlarm();
  await pollAllChannels();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarm();
  await pollAllChannels();
});

async function setupAlarm() {
  const { settings } = await chrome.storage.sync.get({ settings: defaultSettings() });
  const intervalMinutes = settings.pollInterval / 60;
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(intervalMinutes, 0.5) });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await pollAllChannels();
  }
});

async function pollAllChannels() {
  const { channels, settings: st } = await chrome.storage.sync.get({ channels: [], settings: defaultSettings() });
  if (!channels.length) return;

  const { channelCache = {}, notifiedOnline = [] } = await chrome.storage.local.get({
    channelCache: {},
    notifiedOnline: []
  });

  const results = await Promise.allSettled(channels.map(ch => fetchChannel(ch.slug)));

  let liveCount = 0;
  const updatedCache = { ...channelCache };
  let updatedNotified = [...notifiedOnline];

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const result = results[i];
    if (result.status !== 'fulfilled' || !result.value) continue;

    const data = result.value;
    const wasLive = channelCache[ch.slug]?.isLive ?? false;
    const isLive = data.isLive;

    updatedCache[ch.slug] = { ...data, cachedAt: Date.now() };

    if (isLive) {
      liveCount++;
      if (!wasLive && !updatedNotified.includes(ch.slug) && ch.notifyOnline !== false && !isDndActive(st.dnd)) {
        await sendNotification(ch, data);
        updatedNotified.push(ch.slug);
      }
    } else {
      updatedNotified = updatedNotified.filter(s => s !== ch.slug);
    }
  }

  await chrome.storage.local.set({ channelCache: updatedCache, notifiedOnline: updatedNotified });
  updateBadge(liveCount);
  notifyPopup(updatedCache);
}

async function fetchChannel(slug) {
  try {
    const res = await fetch(`${API_BASE}/${slug}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    return {
      isLive: json.livestream !== null && json.livestream !== undefined,
      viewerCount: json.livestream?.viewer_count ?? 0,
      title: json.livestream?.session_title ?? '',
      category: json.livestream?.categories?.[0]?.name ?? '',
      startTime: json.livestream?.start_time ?? null,
      thumbnail: json.livestream?.thumbnail?.src ?? '',
      avatar: json.user?.profile_pic ?? '',
      displayName: json.user?.username ?? slug
    };
  } catch {
    return null;
  }
}

function updateBadge(liveCount) {
  if (liveCount > 0) {
    chrome.action.setBadgeText({ text: String(liveCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#53FC18' });
    chrome.action.setBadgeTextColor({ color: '#000000' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function sendNotification(channel, data) {
  const notifId = `ke-${channel.slug}`;
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: data.avatar || '../icons/icon128.png',
    title: `${data.displayName} yayına girdi!`,
    message: data.title || 'Kick.com yayını başladı',
    contextMessage: data.category || '',
    buttons: [{ title: 'Yayına Git' }],
    requireInteraction: false
  });
}

chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('ke-')) return;
  const slug = notifId.replace('ke-', '');
  openOrFocusTab(`https://kick.com/${slug}`);
  chrome.notifications.clear(notifId);
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (!notifId.startsWith('ke-') || btnIdx !== 0) return;
  const slug = notifId.replace('ke-', '');
  openOrFocusTab(`https://kick.com/${slug}`);
  chrome.notifications.clear(notifId);
});

async function openOrFocusTab(url) {
  const tabs = await chrome.tabs.query({ url: `${url}*` });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
}

function notifyPopup(cache) {
  chrome.runtime.sendMessage({ type: 'CACHE_UPDATED', cache }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'POLL_NOW') {
    pollAllChannels().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'SETTINGS_CHANGED') {
    setupAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'OPEN_TAB') {
    openOrFocusTab(msg.url).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'OPEN_MULTISTREAM') {
    const extUrl = chrome.runtime.getURL('multistream/index.html');
    chrome.tabs.query({}).then(allTabs => {
      const multiTab = allTabs.find(t => t.url?.startsWith(extUrl));
      if (multiTab) {
        chrome.tabs.update(multiTab.id, { active: true });
        chrome.windows.update(multiTab.windowId, { focused: true });
      } else {
        const slugs = msg.channels?.join(',') || '';
        chrome.tabs.create({ url: slugs ? `${extUrl}?channels=${slugs}` : extUrl });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'ADD_TO_MULTISTREAM') {
    const extUrl = chrome.runtime.getURL('multistream/index.html');
    chrome.tabs.query({}).then(allTabs => {
      const multiTab = allTabs.find(t => t.url?.startsWith(extUrl));
      if (multiTab) {
        chrome.tabs.update(multiTab.id, { active: true });
        chrome.windows.update(multiTab.windowId, { focused: true });
        chrome.tabs.sendMessage(multiTab.id, { type: 'ADD_TO_MULTISTREAM', slug: msg.slug }).catch(() => {});
      } else {
        chrome.tabs.create({ url: `${extUrl}?channels=${msg.slug}` });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) setupAlarm();
});

function isDndActive(dnd) {
  if (!dnd?.enabled) return false;
  const h = new Date().getHours();
  const { start = 23, end = 8 } = dnd;
  // gece geçişi: start > end ise (örn. 23→08) iki taraf kontrol et
  if (start > end) return h >= start || h < end;
  return h >= start && h < end;
}

function defaultSettings() {
  return {
    pollInterval: 60,
    notificationSound: true,
    theme: 'default',
    dnd: { enabled: false, start: 23, end: 8 }
  };
}

async function initDefaultStorage() {
  const existing = await chrome.storage.sync.get(null);
  const defaults = {
    channels: [],
    groups: [{ id: 'all', name: 'Tümü' }],
    settings: defaultSettings(),
    siteSettings: {
      enabled: true,
      theme: 'default',
      chat: {
        filterWords: [],
        filterUsers: [],
        filterWordMode: true,
        filterBots: false,
        filterEmojiSpam: false,
        keywords: [],
        fontSize: 13,
        showTimestamp: false,
        compactMode: false
      },
      player: {
        shortcuts: true,
        theaterMode: false,
        defaultQuality: 'auto'
      }
    }
  };

  const toSet = {};
  for (const [key, val] of Object.entries(defaults)) {
    if (!(key in existing)) toSet[key] = val;
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.sync.set(toSet);
  }
}
