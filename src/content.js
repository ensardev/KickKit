/*
 * Kick DOM (2025/2026):
 *   #chatroom-messages
 *     div.no-scrollbar
 *       [data-index="N"] div
 *         div.group
 *           div.break-words
 *             span.text-neutral              ← timestamp
 *             div.inline-flex
 *               button[title][data-prevent-expand]  ← username (title attr)
 *             span.font-normal               ← message text + span[data-emote-id]
 */

(function () {
  'use strict';

  let siteSettings   = null;
  let chatObserver   = null;
  let chatRoot       = null;
  let keyboardEnabled = false;
  let addBtnAdded    = false;
  let userCardCache  = {};
  let observedIdentityPopup = null;

  // Hyphen/underscore farkını normalize et (Kick URL'de - kullanır, username'de _ olabilir)
  // Tüm karşılaştırmalarda kullanılmalı: favori, engel, user card, cache
  const normalizeSlug = s => s?.replace(/-/g, '_')?.toLowerCase() ?? s;

  let _locale = {};
  function t(key, fb) { return _locale[key] != null ? _locale[key] : (fb != null ? fb : key); }

  async function loadLocale() {
    try {
      const { settings: s = {} } = await chrome.storage.sync.get(['settings']);
      const lang = s.lang || 'tr';
      const url = chrome.runtime.getURL(`locales/${lang}.json`);
      const resp = await fetch(url);
      _locale = await resp.json();
    } catch (e) {
      _locale = {};
    }
  }

  const CHAT_ROOT_SEL = '#chatroom-messages';
  const MSG_ITEM_SEL  = '[data-index]';
  const USERNAME_SEL  = 'button[title][data-prevent-expand]';
  const MSG_TEXT_SEL  = 'span.font-normal';
  const MSG_BOX_SEL   = '.break-words';

  async function init() {
    await loadLocale();
    const stored = await getSettings();
    if (stored?.enabled === false) return;

    siteSettings = stored || { enabled: true, chat: {}, player: { shortcuts: true } };

    document.documentElement.classList.add('ke-active');
    waitForChat(setupChat);
    waitForChatControls(injectChatSettingsBtn);
    waitForPlayerButtons(injectAddToListBtn);
    waitForPlayer(initPlayer);
    watchUserIdentityPopup();
    if (siteSettings.player?.theaterMode) enableTheaterMode(true);

    new MutationObserver(() => {
      if (chatRoot && !document.contains(chatRoot)) {
        chatRoot = null;
        chatObserver?.disconnect();
        waitForChat(setupChat);
      }
      if (!document.getElementById('ke-chat-btn') && document.querySelector('#send-message-button')) {
        const container = document.querySelector('#send-message-button')?.closest('.ml-auto');
        if (container) injectChatSettingsBtn(container);
      }
      if (!document.getElementById('ke-add-btn') && document.querySelector('[data-testid="follow-button"]')) {
        const container = document.querySelector('[data-testid="follow-button"]')?.closest('.flex.grow');
        if (container) injectAddToListBtn(container);
      }
    }).observe(document.body, { childList: true });
  }

  function getSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(['siteSettings'], r => resolve(r.siteSettings || null));
    });
  }

  function waitForChat(cb) {
    const el = document.querySelector(CHAT_ROOT_SEL);
    if (el) { cb(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector(CHAT_ROOT_SEL);
      if (found) { obs.disconnect(); cb(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function setupChat(root) {
    chatRoot = root;
    applyChatSettings(siteSettings?.chat || {});
    startChatObserver();
    root.querySelectorAll(MSG_ITEM_SEL).forEach(processMessage);
  }

  function startChatObserver() {
    chatObserver?.disconnect();
    if (!chatRoot) return;
    chatObserver = new MutationObserver(mutations => {
      const toProcess = new Set();
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.hasAttribute('data-index')) {
            toProcess.add(node);
          } else {
            const parent = node.closest?.(MSG_ITEM_SEL);
            if (parent) {
              toProcess.add(parent);
            } else {
              node.querySelectorAll(MSG_ITEM_SEL).forEach(n => toProcess.add(n));
            }
          }
        }
      }
      toProcess.forEach(processMessage);
    });
    chatObserver.observe(chatRoot, { childList: true, subtree: true });
  }

  function applyChatSettings(chat) {
    applyFontSize(chat.fontSize);
    applyTimestamps(chat.showTimestamp);
    document.documentElement.classList.toggle('ke-chat-compact', !!chat.compactMode);
  }

  function applyFontSize(size) {
    if (size && size !== 13) {
      document.documentElement.style.setProperty('--chatroom-font-size', size + 'px');
    } else {
      document.documentElement.style.removeProperty('--chatroom-font-size');
    }
  }

  function applyTimestamps(show) {
    if (show) {
      document.documentElement.style.setProperty('--chatroom-timestamps-display', 'inline');
    } else {
      document.documentElement.style.removeProperty('--chatroom-timestamps-display');
    }
  }

  // wholeWord=true: "biz" → "biz yaptı" eşleşir, "bizden" eşleşmez
  // \b Türkçe karakterlerle çalışmaz, unicode boundary manuel kontrol edilir
  function matchesWord(text, word, wholeWord) {
    const lText = text.toLowerCase();
    const lWord = word.toLowerCase();
    if (!wholeWord) return lText.includes(lWord);

    const isLetter = c => /[\p{L}\p{N}_]/u.test(c);
    let idx = 0;
    while ((idx = lText.indexOf(lWord, idx)) !== -1) {
      const before = idx > 0 ? lText[idx - 1] : '';
      const after  = idx + lWord.length < lText.length ? lText[idx + lWord.length] : '';
      if (!isLetter(before) && !isLetter(after)) return true;
      idx++;
    }
    return false;
  }

  function processMessage(node) {
    if (!node.hasAttribute('data-index')) return;
    const chat = siteSettings?.chat || {};
    const filterAction = chat.filterAction || 'hide';

    const usernameBtn = node.querySelector(USERNAME_SEL);
    const username    = usernameBtn?.getAttribute('title')?.toLowerCase() || '';

    const textSpan = node.querySelector(MSG_TEXT_SEL);
    const text     = textSpan?.textContent?.trim() || node.textContent?.trim() || '';

    if (chat.filterBots && text.startsWith('!')) {
      applyFilter(node, 'ke-filtered-bot', filterAction);
      return;
    }

    const wholeWord = chat.filterWordMode !== false;
    if (chat.filterWords?.length) {
      for (const word of chat.filterWords) {
        if (word && matchesWord(text, word, wholeWord)) {
          applyFilter(node, 'ke-filtered-word', filterAction);
          return;
        }
      }
    }

    if (chat.filterUsers?.length) {
      const normUser = normalizeSlug(username);
      if (chat.filterUsers.some(u => u && normUser.includes(normalizeSlug(u)))) {
        applyFilter(node, 'ke-filtered-user', filterAction);
        return;
      }
    }

    const isFav = chat.favoriteUsers?.length &&
      chat.favoriteUsers.some(u => u && normalizeSlug(username) === normalizeSlug(u));
    if (isFav) {
      node.classList.add('ke-fav-msg');
      const userBtn = node.querySelector(USERNAME_SEL);
      const userColor = userBtn?.style.color;
      if (userColor) node.style.setProperty('--ke-fav-color', userColor);
    } else {
      node.classList.remove('ke-fav-msg');
      node.style.removeProperty('--ke-fav-color');
    }

    if (chat.filterEmojiSpam) {
      const emoteCount   = node.querySelectorAll('[data-emote-id]').length;
      const unicodeCount = (text.match(/\p{Emoji_Presentation}/gu) || []).length;
      const threshold = chat.emojiSpamThreshold || 5;
      if (emoteCount + unicodeCount >= threshold) {
        if (filterAction === 'blur') {
          node.classList.add('ke-emoji-spam');
          node.title = `Emote spam (${emoteCount} emote, ${unicodeCount} emoji)`;
        } else {
          hideMessage(node, 'ke-filtered-emote');
        }
      }
    }

    if (chat.keywords?.length) {
      for (const kw of chat.keywords) {
        if (kw && matchesWord(text, kw, wholeWord)) {
          const box = node.querySelector(MSG_BOX_SEL);
          if (box) {
            box.style.background  = 'rgba(83,252,24,0.07)';
            box.style.borderLeft  = '2px solid #53FC18';
            box.style.paddingLeft = '8px';
          }
          break;
        }
      }
    }
  }

  function hideMessage(node, cls) {
    node.classList.add(cls);
    // preload.css zaten gizliyor; inline style ek güvence
    node.style.setProperty('display', 'none', 'important');
  }

  function syncFmodePanelLabel(isBlur) {
    const label = document.getElementById('kp-fmode-label');
    if (!label) return;
    label.textContent = isBlur ? t('panel_blur') : t('panel_hide');
    label.style.color = isBlur ? '#53FC18' : '#f85149';
  }

  function applyFilter(node, hideCls, action) {
    if (action === 'blur') {
      node.classList.add('ke-filtered-blur');
    } else {
      hideMessage(node, hideCls);
    }
  }

  function waitForChatControls(cb) {
    const el = document.querySelector('#send-message-button')?.closest('.ml-auto');
    if (el) { cb(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector('#send-message-button')?.closest('.ml-auto');
      if (found) { obs.disconnect(); cb(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function injectChatSettingsBtn(container) {
    if (document.getElementById('ke-chat-btn')) return;
    document.getElementById('ke-chat-panel')?.remove();

    const btn = document.createElement('button');
    btn.id = 'ke-chat-btn';
    btn.title = t('chat_btn_tooltip');
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 32 32" fill="#53FC18" xmlns="http://www.w3.org/2000/svg">
      <path d="M25.7,17.3c0.1-0.4,0.1-0.8,0.1-1.3c0-0.4,0-0.9-0.1-1.3l2.7-2.1c0.2-0.2,0.3-0.6,0.2-0.8L26,7.3C25.8,7,25.5,6.9,25.2,7l-3.2,1.3c-0.7-0.5-1.4-0.9-2.2-1.3l-0.5-3.4C19.2,3.3,18.9,3,18.6,3h-5.2c-0.3,0-0.6,0.2-0.6,0.6L12.3,7c-0.8,0.3-1.5,0.8-2.2,1.3L6.9,7C6.6,6.9,6.2,7,6.1,7.3l-2.6,4.5c-0.2,0.3-0.1,0.6,0.2,0.8l2.7,2.1c-0.1,0.4-0.1,0.8-0.1,1.3c0,0.4,0,0.9,0.1,1.3l-2.7,2.1c-0.2,0.2-0.3,0.6-0.2,0.8L6,24.7C6.2,25,6.5,25.1,6.8,25l3.2-1.3c0.7,0.5,1.4,0.9,2.2,1.3l0.5,3.4c0.1,0.3,0.3,0.6,0.6,0.6h5.2c0.3,0,0.6-0.2,0.6-0.6l0.5-3.4c0.8-0.3,1.5-0.8,2.2-1.3l3.2,1.3c0.3,0.1,0.6,0,0.8-0.3l2.6-4.5c0.2-0.3,0.1-0.6-0.2-0.8L25.7,17.3z M16,20.9c-2.7,0-4.9-2.2-4.9-4.9s2.2-4.9,4.9-4.9s4.9,2.2,4.9,4.9S18.7,20.9,16,20.9z"/>
    </svg>`;

    // body'e append — stacking context sorununu önler
    const panel = document.createElement('div');
    panel.id = 'ke-chat-panel';
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);

    container.insertBefore(btn, container.firstChild);
    syncPanelFromSettings(siteSettings?.chat || {});

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = !panel.classList.contains('ke-open');
      panel.classList.toggle('ke-open', isOpen);
      btn.classList.toggle('ke-active-btn', isOpen);
      if (isOpen) {
        positionPanel(btn, panel);
        syncPanelFromSettings(siteSettings?.chat || {});
      }
    });

    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('ke-open');
        btn.classList.remove('ke-active-btn');
      }
    });

    bindPanelEvents(panel);
  }

  function positionPanel(btn, panel) {
    const rect = btn.getBoundingClientRect();
    // sağ kenar taşmasın
    const right = Math.max(8, window.innerWidth - rect.right);
    panel.style.right  = right + 'px';
    panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    panel.style.left   = 'auto';
  }

  function buildPanelHTML() {
    return `
      <h3>${t('panel_title')}</h3>
      <div class="kp-content">

        <div class="kp-card">
          <div class="kp-row">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_filter_mode')}</div>
              <div class="kp-row-sub">${t('panel_filter_mode_sub')}</div>
            </div>
            <div class="ke-fmode-ctrl">
              <span id="kp-fmode-label" class="ke-fmode-label">${t('panel_hide')}</span>
              <label class="kp-sw kp-sw--fmode"><input type="checkbox" id="kp-fmode"><span class="kp-track"><span class="kp-thumb"></span></span></label>
            </div>
          </div>
          <div class="kp-row">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_emote_spam')}</div>
              <div class="kp-row-sub">${t('panel_emote_spam_sub')}</div>
            </div>
            <label class="kp-sw"><input type="checkbox" id="kp-emoji"><span class="kp-track"><span class="kp-thumb"></span></span></label>
          </div>
          <div class="kp-row kp-row-slider kp-emoji-threshold-row" id="kp-emoji-threshold-row" style="display:none">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_emoji_threshold')}</div>
            </div>
            <div class="kp-font-ctrl">
              <input type="range" id="kp-emoji-threshold" min="1" max="30" step="1" value="5">
              <span class="kp-font-val" id="kp-emoji-val">5</span>
            </div>
          </div>
          <div class="kp-row">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_bots')}</div>
              <div class="kp-row-sub">${t('panel_bots_sub')}</div>
            </div>
            <label class="kp-sw"><input type="checkbox" id="kp-bots"><span class="kp-track"><span class="kp-thumb"></span></span></label>
          </div>
          <div class="kp-row">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_timestamp')}</div>
              <div class="kp-row-sub">${t('panel_timestamp_sub')}</div>
            </div>
            <label class="kp-sw"><input type="checkbox" id="kp-ts"><span class="kp-track"><span class="kp-thumb"></span></span></label>
          </div>
          <div class="kp-row">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_compact')}</div>
              <div class="kp-row-sub">${t('panel_compact_sub')}</div>
            </div>
            <label class="kp-sw"><input type="checkbox" id="kp-compact"><span class="kp-track"><span class="kp-thumb"></span></span></label>
          </div>
          <div class="kp-row kp-row-slider">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_font_size')}</div>
              <div class="kp-row-sub">${t('panel_font_default')}</div>
            </div>
            <div class="kp-font-ctrl">
              <input type="range" id="kp-font" min="10" max="20" step="1" value="13">
              <span class="kp-font-val" id="kp-font-val">13px</span>
            </div>
          </div>
        </div>

        <div class="kp-section-title">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg>
          ${t('panel_word_filter')}
        </div>
        <div class="kp-card">
          <div class="kp-row">
            <div class="kp-row-info">
              <div class="kp-row-label">${t('panel_word_whole')}</div>
              <div class="kp-row-sub">${t('panel_word_whole_sub')}</div>
            </div>
            <label class="kp-sw"><input type="checkbox" id="kp-wordmode"><span class="kp-track"><span class="kp-thumb"></span></span></label>
          </div>
          <div class="kp-input-row">
            <input type="text" id="kp-word-input" placeholder="${t('panel_word_ph')}">
            <button class="kp-add-btn" id="kp-word-add">${t('btn_add')}</button>
          </div>
          <div class="kp-chips" id="kp-word-chips"></div>
        </div>

        <div class="kp-section-title">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${t('panel_user_filter')}
        </div>
        <div class="kp-card">
          <div class="kp-input-row">
            <input type="text" id="kp-user-input" placeholder="${t('panel_user_ph')}">
            <button class="kp-add-btn" id="kp-user-add">${t('btn_add')}</button>
          </div>
          <div class="kp-chips" id="kp-user-chips"></div>
        </div>

      </div>
    `;
  }

  function syncPanelFromSettings(chat) {
    const get = id => document.getElementById(id);
    const chk = (id, val) => { const el = get(id); if (el) el.checked = !!val; };

    const isBlur = chat.filterAction === 'blur';
    const fmodeChk = get('kp-fmode');
    if (fmodeChk) fmodeChk.checked = isBlur;
    syncFmodePanelLabel(isBlur);

    chk('kp-emoji',    chat.filterEmojiSpam);
    chk('kp-bots',     chat.filterBots);
    chk('kp-ts',       chat.showTimestamp);
    chk('kp-compact',  chat.compactMode);
    chk('kp-wordmode', chat.filterWordMode !== false);

    const thresholdRow = get('kp-emoji-threshold-row');
    const thresholdEl  = get('kp-emoji-threshold');
    const thresholdVal = get('kp-emoji-val');
    if (thresholdRow) thresholdRow.style.display = chat.filterEmojiSpam ? '' : 'none';
    if (thresholdEl)  thresholdEl.value = chat.emojiSpamThreshold || 5;
    if (thresholdVal) thresholdVal.textContent = chat.emojiSpamThreshold || 5;

    const fontEl = get('kp-font');
    const fontVal = get('kp-font-val');
    if (fontEl) { fontEl.value = chat.fontSize || 13; }
    if (fontVal) { fontVal.textContent = (chat.fontSize || 13) + 'px'; }

    renderChips('kp-word-chips', chat.filterWords || [], 'word');
    renderChips('kp-user-chips', chat.filterUsers || [], 'user');
  }

  function renderChips(containerId, items, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    items.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'kp-chip';
      chip.innerHTML = `${escapeHtml(item)}<button data-remove="${escapeHtml(item)}" data-type="${type}" title="${t('chip_remove_title')}">×</button>`;
      container.appendChild(chip);
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function bindPanelEvents(panel) {
    const fmodeEl = panel.querySelector('#kp-fmode');
    if (fmodeEl) {
      fmodeEl.addEventListener('change', () => {
        const isBlur = fmodeEl.checked;
        syncFmodePanelLabel(isBlur);
        updateChatSetting(s => { s.filterAction = isBlur ? 'blur' : 'hide'; });
      });
    }

    const toggleMap = {
      'kp-emoji':    s => {
        const on = document.getElementById('kp-emoji').checked;
        s.filterEmojiSpam = on;
        const row = document.getElementById('kp-emoji-threshold-row');
        if (row) row.style.display = on ? '' : 'none';
      },
      'kp-bots':     s => { s.filterBots      = document.getElementById('kp-bots').checked; },
      'kp-ts':       s => { s.showTimestamp   = document.getElementById('kp-ts').checked; },
      'kp-compact':  s => { s.compactMode     = document.getElementById('kp-compact').checked; },
      'kp-wordmode': s => { s.filterWordMode  = document.getElementById('kp-wordmode').checked; },
    };

    Object.keys(toggleMap).forEach(id => {
      const el = panel.querySelector('#' + id);
      if (el) el.addEventListener('change', () => updateChatSetting(toggleMap[id]));
    });

    const emojiSlider = panel.querySelector('#kp-emoji-threshold');
    const emojiVal    = panel.querySelector('#kp-emoji-val');
    if (emojiSlider) {
      emojiSlider.addEventListener('input', () => {
        if (emojiVal) emojiVal.textContent = emojiSlider.value;
        updateChatSetting(s => { s.emojiSpamThreshold = parseInt(emojiSlider.value, 10); });
      });
    }

    const fontSlider = panel.querySelector('#kp-font');
    const fontVal    = panel.querySelector('#kp-font-val');
    if (fontSlider) {
      fontSlider.addEventListener('input', () => {
        if (fontVal) fontVal.textContent = fontSlider.value + 'px';
        updateChatSetting(s => { s.fontSize = parseInt(fontSlider.value, 10); });
      });
    }

    const wordInput = panel.querySelector('#kp-word-input');
    const wordAdd   = panel.querySelector('#kp-word-add');
    if (wordAdd && wordInput) {
      const addWord = () => {
        const val = wordInput.value.trim();
        if (!val) return;
        wordInput.value = '';
        updateChatSetting(s => {
          s.filterWords = s.filterWords || [];
          if (!s.filterWords.includes(val)) s.filterWords.push(val);
        }, () => renderChips('kp-word-chips', siteSettings?.chat?.filterWords || [], 'word'));
      };
      wordAdd.addEventListener('click', addWord);
      wordInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addWord(); } });
    }

    const userInput = panel.querySelector('#kp-user-input');
    const userAdd   = panel.querySelector('#kp-user-add');
    if (userAdd && userInput) {
      const addUser = () => {
        const val = normalizeSlug(userInput.value.trim().toLowerCase());
        if (!val) return;
        userInput.value = '';
        updateChatSetting(s => {
          s.filterUsers = s.filterUsers || [];
          if (!s.filterUsers.some(u => normalizeSlug(u) === val)) s.filterUsers.push(val);
        }, () => renderChips('kp-user-chips', siteSettings?.chat?.filterUsers || [], 'user'));
      };
      userAdd.addEventListener('click', addUser);
      userInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addUser(); } });
    }

    panel.addEventListener('click', e => {
      const removeBtn = e.target.closest('[data-remove]');
      if (!removeBtn) return;
      const val  = removeBtn.dataset.remove;
      const type = removeBtn.dataset.type;
      if (type === 'word') {
        updateChatSetting(s => { s.filterWords = (s.filterWords || []).filter(w => w !== val); },
          () => renderChips('kp-word-chips', siteSettings?.chat?.filterWords || [], 'word'));
      } else if (type === 'user') {
        updateChatSetting(s => { s.filterUsers = (s.filterUsers || []).filter(u => normalizeSlug(u) !== normalizeSlug(val)); },
          () => renderChips('kp-user-chips', siteSettings?.chat?.filterUsers || [], 'user'));
      }
    });
  }

  function updateChatSetting(mutateFn, afterSave) {
    chrome.storage.sync.get(['siteSettings'], r => {
      const ss = r.siteSettings || siteSettings || { enabled: true, chat: {} };
      ss.chat = ss.chat || {};
      mutateFn(ss.chat);
      chrome.storage.sync.set({ siteSettings: ss }, () => {
        siteSettings = ss;  // afterSave çalışmadan önce güncelle
        if (afterSave) afterSave();
      });
    });
  }

  function waitForPlayerButtons(cb) {
    const el = document.querySelector('[data-testid="follow-button"]')?.closest('.flex.grow');
    if (el) { cb(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector('[data-testid="follow-button"]')?.closest('.flex.grow');
      if (found) { obs.disconnect(); cb(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function getCurrentSlug() {
    return window.location.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
  }

  function initKeTooltip() {
    if (document.getElementById('ke-tooltip')) return;
    const tip = document.createElement('div');
    tip.id = 'ke-tooltip';
    document.body.appendChild(tip);

    // native title attribute kullanılmaz — browser tooltip temadan bağımsız görünür
    document.addEventListener('mouseover', e => {
      const el = e.target.closest('[data-ke-tip]');
      if (!el || !el.dataset.keTip) { tip.style.display = 'none'; return; }
      tip.textContent = el.dataset.keTip;
      tip.style.display = 'block';
      const rect = el.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let left = rect.left + rect.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
      tip.style.left = left + 'px';
      tip.style.top  = (rect.top - tipH - 8) + 'px';
    });

    document.addEventListener('mouseout', e => {
      const el = e.target.closest('[data-ke-tip]');
      if (!el) return;
      const to = e.relatedTarget;
      if (!to || !to.closest?.('[data-ke-tip]')) tip.style.display = 'none';
    });
  }

  // style="fill:none" zorunlu — Tailwind [&_svg]:fill-current fill attr'unu ezer
  function keIconPlus() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" style="fill:none" xmlns="http://www.w3.org/2000/svg"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  }
  function keIconCheck() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" style="fill:none" xmlns="http://www.w3.org/2000/svg"><polyline points="4 13 9 18 20 6" fill="none" stroke="#53FC18" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  function keIconRemove() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" style="fill:none" xmlns="http://www.w3.org/2000/svg"><line x1="18" y1="6" x2="6" y2="18" stroke="#ff5555" stroke-width="2.5" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="#ff5555" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  }

  function injectAddToListBtn(container) {
    if (document.getElementById('ke-add-btn')) return;
    const slug = getCurrentSlug();
    if (!slug) return;

    initKeTooltip();

    const btn = document.createElement('button');
    btn.id = 'ke-add-btn';
    btn.className = 'group relative box-border shrink-0 grow-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded font-semibold ring-0 transition-all focus-visible:outline-none active:scale-[0.95] disabled:pointer-events-none [&_svg]:size-[1em] state-layer-surface bg-secondary-base text-secondary-onSecondary [&_svg]:fill-current focus-visible:bg-secondary-base disabled:bg-disabled-base size-10 text-base leading-none flex';
    btn.setAttribute('aria-label', t('add_btn_tooltip'));
    btn.dataset.keTip = t('add_btn_tooltip');
    btn.innerHTML = keIconPlus();

    const panel = document.createElement('div');
    panel.id = 'ke-add-panel';
    document.body.appendChild(panel);

    updateAddBtnState(btn, slug);

    btn.addEventListener('mouseenter', () => {
      if (addBtnAdded) btn.innerHTML = keIconRemove();
    });
    btn.addEventListener('mouseleave', () => {
      if (addBtnAdded) btn.innerHTML = keIconCheck();
    });

    btn.addEventListener('click', async e => {
      e.stopPropagation();

      if (addBtnAdded) {
        const { channels: chs = [] } = await new Promise(r =>
          chrome.storage.sync.get(['channels'], r)
        );
        await new Promise(r =>
          chrome.storage.sync.set({ channels: chs.filter(c => c.slug !== slug) }, r)
        );
        chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
        updateAddBtnState(btn, slug);
        return;
      }

      const { groups: grps = [] } = await new Promise(r =>
        chrome.storage.sync.get(['groups'], r)
      );

      const customGroups = grps.filter(g => g.id !== 'all');
      if (!customGroups.length) {
        await doAddChannel(slug, ['all']);
        updateAddBtnState(btn, slug);
        return;
      }

      if (panel.dataset.open === '1') { closeAddPanel(panel, btn); return; }

      panel.innerHTML = buildAddPanelHTML(slug, customGroups);
      positionAddPanel(btn, panel);
      panel.dataset.open = '1';

      panel.querySelector('#ke-ap-confirm')?.addEventListener('click', async () => {
        const checked = [...panel.querySelectorAll('.ke-ap-grp:checked')].map(el => el.value);
        await doAddChannel(slug, checked.length ? ['all', ...checked] : ['all']);
        closeAddPanel(panel, btn);
        updateAddBtnState(btn, slug);
      });
      panel.querySelector('#ke-ap-cancel')?.addEventListener('click', () => closeAddPanel(panel, btn));
    });

    document.addEventListener('click', e => {
      if (panel.dataset.open === '1' && !panel.contains(e.target) && e.target !== btn) {
        closeAddPanel(panel, btn);
      }
    });

    container.insertBefore(btn, container.firstChild);
  }

  function buildAddPanelHTML(slug, groups) {
    const groupRows = groups.map(g =>
      `<label class="ke-ap-row"><input type="checkbox" class="ke-ap-grp" value="${escapeHtml(g.id)}"><span>${escapeHtml(g.name)}</span></label>`
    ).join('');
    return `
      <button id="ke-ap-cancel" class="ke-ap-cancel-x">✕</button>
      <div class="ke-ap-title">${t('add_panel_title')}</div>
      <div class="ke-ap-slug">${escapeHtml(slug)}</div>
      <div class="ke-ap-groups">${groupRows}</div>
      <div class="ke-ap-actions">
        <button id="ke-ap-confirm" class="ke-ap-primary">${t('add_panel_btn')}</button>
      </div>
    `;
  }

  function positionAddPanel(btn, panel) {
    const rect = btn.getBoundingClientRect();
    const panelH = panel.offsetHeight;
    let top  = Math.max(8, rect.top - panelH - 8);
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - 228));
    panel.style.top    = top + 'px';
    panel.style.left   = left + 'px';
    panel.style.bottom = 'auto';
    panel.style.right  = 'auto';
  }

  function closeAddPanel(panel, btn) {
    panel.dataset.open = '0';
    panel.innerHTML = '';
    if (addBtnAdded) btn.innerHTML = keIconCheck();
  }

  async function doAddChannel(slug, groups) {
    return new Promise(resolve => {
      chrome.storage.sync.get(['channels'], r => {
        const chs = r.channels || [];
        if (chs.some(c => c.slug === slug)) { resolve(); return; }
        chs.push({ slug, displayName: slug, avatar: '', groups, notifyOnline: true, addedAt: Date.now() });
        chrome.storage.sync.set({ channels: chs }, () => {
          chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
          resolve();
        });
      });
    });
  }

  function updateAddBtnState(btn, slug) {
    chrome.storage.sync.get(['channels'], r => {
      const exists = (r.channels || []).some(c => c.slug === slug);
      addBtnAdded = exists;
      if (exists) {
        btn.classList.add('ke-added');
        btn.innerHTML = keIconCheck();
        btn.dataset.keTip = t('add_remove_tooltip');
      } else {
        btn.classList.remove('ke-added');
        btn.innerHTML = keIconPlus();
        btn.dataset.keTip = t('add_btn_tooltip');
      }
    });
  }

  function waitForPlayer(cb) {
    const el = document.querySelector('video');
    if (el) { cb(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector('video');
      if (found) { obs.disconnect(); cb(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function initPlayer(video) {
    if (!siteSettings?.player?.shortcuts) return;
    if (keyboardEnabled) return;
    keyboardEnabled = true;

    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      const v = document.querySelector('video');
      if (!v) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          v.paused ? v.play() : v.pause();
          break;
        case 'm': case 'M':
          v.muted = !v.muted;
          break;
        case 'f': case 'F':
          toggleFullscreen(v);
          break;
        case 't': case 'T':
          enableTheaterMode(!document.documentElement.classList.contains('ke-theater'));
          break;
        case 'ArrowUp':
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          showVolumeToast(v.volume);
          break;
        case 'ArrowDown':
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          showVolumeToast(v.volume);
          break;
        case 'ArrowRight':
          // sadece VOD'da geçerli (live stream duration === Infinity)
          if (v.duration && v.duration !== Infinity) {
            v.currentTime = Math.min(v.duration, v.currentTime + 10);
          }
          break;
      }
    });
  }

  function toggleFullscreen(video) {
    const container = video.closest('[class*="player"], [class*="video-container"]') || video;
    if (!document.fullscreenElement) container.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  function enableTheaterMode(on) {
    document.documentElement.classList.toggle('ke-theater', on);
    chrome.storage.sync.get(['siteSettings'], r => {
      const ss = r.siteSettings || {};
      ss.player = ss.player || {};
      ss.player.theaterMode = on;
      chrome.storage.sync.set({ siteSettings: ss });
    });
  }

  let toastTimer = null;
  function showPlayerToast(text, isError) {
    let toast = document.getElementById('ke-player-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ke-player-toast';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(6,9,15,0.88);backdrop-filter:blur(12px);padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;z-index:99999;pointer-events:none;transition:opacity 0.2s;border:1px solid rgba(255,255,255,0.1);';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.color  = isError ? '#f85149' : '#e9edf6';
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, isError ? 3000 : 1500);
  }

  function showVolumeToast(vol) {
    showPlayerToast(t('vol_toast').replace('{n}', Math.round(vol * 100)));
  }

  function refreshInjectedStrings() {
    const chatBtn = document.getElementById('ke-chat-btn');
    if (chatBtn) chatBtn.title = t('chat_btn_tooltip');

    const addBtn = document.getElementById('ke-add-btn');
    if (addBtn) {
      const tip = addBtnAdded ? t('add_remove_tooltip') : t('add_btn_tooltip');
      addBtn.setAttribute('aria-label', tip);
      addBtn.dataset.keTip = tip;
    }

    const chatPanel = document.getElementById('ke-chat-panel');
    if (chatPanel) {
      const wasOpen = chatPanel.classList.contains('ke-open');
      chatPanel.innerHTML = buildPanelHTML();
      syncPanelFromSettings(siteSettings?.chat || {});
      bindPanelEvents(chatPanel);
      if (wasOpen) chatPanel.classList.add('ke-open');
    }

    const ext = document.getElementById('ke-user-ext');
    if (ext) {
      const slug = ext.dataset.slug;
      const data = userCardCache[normalizeSlug(slug)] || userCardCache[slug];
      if (data) {
        const popup = ext.closest('#user-identity');
        if (popup) {
          const origCard = popup.querySelector('.bg-surface-highest');
          const currentChannel = getCurrentSlug();
          const relation = currentChannel ? parseChannelRelation(origCard, currentChannel) : null;
          buildKEUserCard(popup, slug, data, relation, currentChannel);
        }
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;

    if (changes.channels) {
      const btn = document.getElementById('ke-add-btn');
      if (btn) updateAddBtnState(btn, getCurrentSlug());
    }

    if (changes.settings) {
      const newLang = changes.settings.newValue?.lang;
      const oldLang = changes.settings.oldValue?.lang;
      if (newLang && newLang !== oldLang) {
        loadLocale().then(refreshInjectedStrings);
      }
    }

    if (!changes.siteSettings) return;
    const newSettings = changes.siteSettings.newValue;

    if (newSettings?.enabled === false) {
      document.documentElement.classList.remove('ke-active');
      chatObserver?.disconnect();
      return;
    }

    siteSettings = newSettings;
    document.documentElement.classList.add('ke-active');
    applyChatSettings(newSettings.chat || {});

    const panel = document.getElementById('ke-chat-panel');
    if (panel?.classList.contains('ke-open')) {
      syncPanelFromSettings(newSettings.chat || {});
    }

    if (chatRoot && document.contains(chatRoot)) {
      startChatObserver();
      chatRoot.querySelectorAll(MSG_ITEM_SEL).forEach(msg => {
        // önceki filtreleri temizle (class kaldırılınca preload.css display:none'ı da kaldırır)
        msg.classList.remove('ke-filtered-bot', 'ke-filtered-word', 'ke-filtered-user', 'ke-filtered-emote', 'ke-emoji-spam', 'ke-filtered-blur', 'ke-fav-msg');
        msg.style.removeProperty('display');
        msg.style.removeProperty('--ke-fav-color');
        msg.title = '';
        processMessage(msg);
      });
    } else {
      chatRoot = null;
      chatObserver?.disconnect();
      waitForChat(setupChat);
    }

    if (newSettings.player?.theaterMode !== undefined) {
      enableTheaterMode(newSettings.player.theaterMode);
    }
  });

  function watchUserIdentityPopup() {
    const trySetup = () => {
      const popup = document.getElementById('user-identity');
      if (!popup || popup === observedIdentityPopup) return;
      observedIdentityPopup = popup;
      observeUserIdentityPopup(popup);
    };
    trySetup();
    // SPA geçişlerinde Kick #user-identity'yi yok edip yeniden oluşturur
    // disconnect etmiyoruz ki her yeni popup yakalanabilsin
    new MutationObserver(() => trySetup())
      .observe(document.body, { childList: true, subtree: true });
  }

  function observeUserIdentityPopup(popup) {
    let augmenting = false;

    function tryAugment() {
      if (augmenting) return;
      const anchor = popup.querySelector('a[href*="kick.com/"]');
      if (!anchor) return;
      let slug;
      try {
        slug = new URL(anchor.href).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
      } catch (_) { return; }
      if (!slug) return;
      // normalize ederek karşılaştır — aksi halde hyphen/underscore farkı sonsuz döngüye neden olur
      const existing = popup.querySelector('#ke-user-ext')?.dataset.slug;
      if (existing && normalizeSlug(existing) === normalizeSlug(slug)) return;
      augmenting = true;
      injectUserExt(popup, slug).finally(() => {
        augmenting = false;
        // augmenting sırasında kaçırılan mutation'ları yakala
        // (ör. user A fetch'i sürerken user B'ye tıklandıysa)
        tryAugment();
      });
    }

    new MutationObserver(() => tryAugment())
      .observe(popup, { childList: true, subtree: true });
  }

  function showUserCardSkeleton(popup) {
    const origCard = popup.querySelector('.bg-surface-highest');
    if (!origCard) return;

    const bannerWrap = document.createElement('div');
    bannerWrap.className = 'ke-uc-banner-wrap';

    const banner = document.createElement('div');
    banner.className = 'ke-uc-banner ke-uc-banner-empty';
    bannerWrap.appendChild(banner);

    const avatarRow = document.createElement('div');
    avatarRow.className = 'ke-uc-avatar-row';
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'ke-uc-avatar-wrap ke-skel-pulse';
    avatarRow.appendChild(avatarWrap);
    bannerWrap.appendChild(avatarRow);

    origCard.insertAdjacentElement('beforebegin', bannerWrap);

    const currentChannel = getCurrentSlug();

    const ext = document.createElement('div');
    ext.id = 'ke-user-ext';
    ext.className = 'ke-skeleton';
    ext.innerHTML = `
      <div class="ke-ue-personal-header">
        <div class="ke-skel-block" style="width:90px;height:30px"></div>
        <div class="ke-skel-block" style="width:80px;height:22px;border-radius:20px"></div>
      </div>
      <div class="ke-skel-block" style="width:100%;height:50px"></div>
      <div style="display:flex;gap:6px">
        <div class="ke-skel-block" style="width:34px;height:34px;border-radius:10px"></div>
        <div class="ke-skel-block" style="width:34px;height:34px;border-radius:10px"></div>
        <div class="ke-skel-block" style="width:34px;height:34px;border-radius:10px"></div>
      </div>
      ${currentChannel ? `
        <hr class="ke-uc-divider"/>
        <div class="ke-skel-block" style="width:100%;height:34px;border-radius:8px"></div>
        <div class="ke-skel-block" style="width:100%;height:34px;border-radius:8px"></div>
      ` : ''}
      <div class="ke-ue-actions">
        <div class="ke-skel-block" style="flex:1;height:36px;border-radius:8px"></div>
        <div class="ke-skel-block" style="flex:1;height:36px;border-radius:8px"></div>
      </div>`;
    origCard.insertAdjacentElement('afterend', ext);

    popup.classList.add('ke-has-card');
  }

  function removeSkeleton(popup) {
    popup.querySelector('.ke-uc-banner-wrap')?.remove();
    popup.querySelector('#ke-user-ext')?.remove();
    popup.classList.remove('ke-has-card');
  }

  async function injectUserExt(popup, slug) {
    popup.querySelector('.ke-uc-banner-wrap')?.remove();
    popup.querySelector('#ke-user-ext')?.remove();
    popup.classList.remove('ke-has-card');

    let data = userCardCache[normalizeSlug(slug)] || userCardCache[slug];
    if (!data) {
      // Cache yoksa skeleton göster, veri gelene kadar placeholder
      showUserCardSkeleton(popup);
      try {
        const resp = await fetch(`https://kick.com/api/v2/channels/${slug}`);
        if (!resp.ok) { removeSkeleton(popup); return; }
        data = await resp.json();
        if (!data || data.error) { removeSkeleton(popup); return; }
      } catch (_) { removeSkeleton(popup); return; }
    }
    if (!popup.isConnected) return;
    // API'dan canonical slug'ı al; yoksa URL slug'ını normalize et
    const canonicalSlug = (data?.slug?.toLowerCase()) || normalizeSlug(slug);
    userCardCache[canonicalSlug] = data;

    const currentChannel = getCurrentSlug();

    // Kick zaten /channels/{ch}/users/{username} isteğini atıp origCard'a render ediyor
    // Aynı isteği tekrar atmak yerine DOM'dan parse ediyoruz
    const origCard = popup.querySelector('.bg-surface-highest');
    const relation = currentChannel ? parseChannelRelation(origCard, currentChannel) : null;

    buildKEUserCard(popup, canonicalSlug, data, relation, currentChannel);

    // Kick'in API yanıtı henüz gelmediyse .select-text DOM'da olmayabilir
    // origCard'ı observe edip veri gelince kanal bölümünü güncelle
    const needsMore = currentChannel && origCard &&
      (!relation?.followDate && !relation?.subscribedFor || !relation?.badges?.length);
    if (needsMore) {
      const cardObs = new MutationObserver(() => {
        const fresh = parseChannelRelation(origCard, currentChannel);
        if (!fresh.followDate && !fresh.subscribedFor && !fresh.badges?.length) return;
        cardObs.disconnect();
        updateChannelInfo(popup, fresh);
      });
      cardObs.observe(origCard, { childList: true, subtree: true });
      setTimeout(() => cardObs.disconnect(), 5000); // 5s sonra vazgeç
    }
  }

  function updateChannelInfo(popup, relation) {
    const followVal = popup.querySelector('#ke-ci-follow .ke-uc-info-value');
    const subVal    = popup.querySelector('#ke-ci-sub .ke-uc-info-value');
    if (followVal && relation.followDate)    followVal.textContent = relation.followDate;
    if (subVal    && relation.subscribedFor) subVal.textContent = `${relation.subscribedFor} ${t('ue_months','ay')}`;

    // Rozetler — geç gelen DOM parse (SVG + img karışımı)
    if (relation.badges?.length) {
      const badgesRow = popup.querySelector('#ke-ci-badges');
      if (badgesRow) {
        const container = badgesRow.querySelector('.ke-uc-badge-imgs');
        if (container) {
          container.innerHTML = relation.badges.map(b => `<span class="ke-uc-badge-icon">${b.html}</span>`).join('');
          badgesRow.style.display = '';
        }
      }
      // origCard'daki rozet container'ını gizle
      if (relation.badgeContainer) {
        relation.badgeContainer.classList.add('ke-hide-badges');
      }
    }
  }

  function parseChannelRelation(origCard, channelSlug) {
    const info = { channelSlug, badges: [], badgeContainer: null };
    if (!origCard) return info;

    // Rozetler: "Rozetler" / "Badges" başlık metnini içeren leaf elementi bul
    // Kick rozetleri SVG + img karışımı: div.flex.items-center.gap-2.5 container'ında
    const badgeLabels = /^(rozetler|badges|insignias|abzeichen|badge|значки|バッジ|배지|徽章|الشارات)$/i;
    for (const el of origCard.querySelectorAll('*')) {
      if (el.children.length > 0) continue; // sadece leaf text node
      const txt = el.textContent?.trim();
      if (!txt || !badgeLabels.test(txt)) continue;

      // Başlığın üst container'ını bul — rozet ikonlarını da kapsayan bölüm
      // Kick yapısı: parent > [label, badgeIconsContainer]
      let section = el.parentElement;
      // Section'ın kendisi veya bir üstü tüm rozet bölümünü kapsar
      // İçinde size-[18px] veya svg/img olan sibling container'ı ara
      if (section && section !== origCard) {
        const iconContainer = section.querySelector('.flex.items-center') ||
          section.querySelector('[class*="gap-"]');
        if (!iconContainer && section.parentElement && section.parentElement !== origCard) {
          section = section.parentElement;
        }
        info.badgeContainer = section;
        // Tüm rozet ikonlarının (SVG + img) outerHTML'ini topla
        const icons = section.querySelectorAll('.inline-flex, [class*="size-"]');
        icons.forEach(icon => {
          info.badges.push({ html: icon.outerHTML });
        });
        // Fallback: hiç .inline-flex yoksa container içindeki svg/img'leri al
        if (!info.badges.length) {
          section.querySelectorAll('svg, img').forEach(el => {
            if (el.closest('.shrink-0.overflow-hidden.rounded-full')) return;
            info.badges.push({ html: el.outerHTML });
          });
        }
      }
      break;
    }

    // Kick .select-text.gap-6 div'inde sub süresi + takip tarihi render eder
    // NOT: origCard'da <a> tag'ı da .select-text class'ına sahip, .gap-6 ile ayırt ediyoruz
    const infoContainer = origCard.querySelector('.select-text.gap-6');
    if (!infoContainer) return info;

    for (const block of infoContainer.children) {
      const divs = block.querySelectorAll(':scope > div');
      if (divs.length < 2) continue;
      const value = divs[1]?.textContent?.trim() || '';
      if (!value) continue;

      if (/\d{4}/.test(value)) {
        // 4 haneli yıl içeriyorsa → takip tarihi (ör. "9 Şub 2024")
        info.followDate = value;
      } else {
        // Yıl yoksa sayı varsa → abone süresi (ör. "20 aylık")
        const m = value.match(/(\d+)/);
        if (m) info.subscribedFor = parseInt(m[1]);
      }
    }

    return info;
  }

  const keSvg = (d, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none;flex-shrink:0">${d}</svg>`;
  const keIcons = {
    users:    keSvg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    verified: keSvg('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor" stroke="none"/>', 12),
    affiliate:keSvg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" stroke="none"/>', 12),
    star:     keSvg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    starFill: keSvg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" stroke="none"/>'),
    block:    keSvg('<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
    unblock:  keSvg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
    x:        `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="fill:currentColor;flex-shrink:0"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
    instagram:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none;flex-shrink:0"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
    youtube:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="fill:currentColor;flex-shrink:0"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
    discord:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="fill:currentColor;flex-shrink:0"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>`,
    tiktok:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="fill:currentColor;flex-shrink:0"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.75a8.18 8.18 0 0 0 4.78 1.53V6.84a4.86 4.86 0 0 1-1.02-.15z"/></svg>`,
    calendar: keSvg('<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', 14),
    shield:   keSvg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 14),
    crown:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="fill:currentColor;flex-shrink:0"><path d="M2 20h20L19 9l-5 5-2-7-2 7-5-5z"/></svg>`,
  };

  function buildKEUserCard(popup, slug, data, relation, currentChannel) {
    popup.querySelector('.ke-uc-banner-wrap')?.remove();
    popup.querySelector('#ke-user-ext')?.remove();

    // origCard'a HİÇ dokunmuyoruz — React elementini koruyoruz
    const origCard = popup.querySelector('.bg-surface-highest');
    if (!origCard) return;

    const user      = data?.user || {};
    const followers = data?.followers_count ?? 0;
    const bannerUrl = data?.banner_image?.url || '';
    const avatarUrl = origCard.querySelector('img[alt]')?.src || user.profile_pic || '';

    const chat      = siteSettings?.chat || {};
    const normSlug   = normalizeSlug(slug);
    const isBlocked  = (chat.filterUsers   || []).some(u => normalizeSlug(u) === normSlug);
    const isFavorite = (chat.favoriteUsers || []).some(u => normalizeSlug(u) === normSlug);

    const bannerWrap = document.createElement('div');
    bannerWrap.className = 'ke-uc-banner-wrap';

    const bannerEl = document.createElement('div');
    bannerEl.className = bannerUrl ? 'ke-uc-banner' : 'ke-uc-banner ke-uc-banner-empty';
    if (bannerUrl) bannerEl.style.backgroundImage = `url('${bannerUrl}')`;
    bannerWrap.appendChild(bannerEl);

    const avatarRowEl = document.createElement('div');
    avatarRowEl.className = 'ke-uc-avatar-row';
    const avatarWrapEl = document.createElement('div');
    avatarWrapEl.className = 'ke-uc-avatar-wrap';
    const avatarImgEl = document.createElement('img');
    avatarImgEl.className = 'ke-uc-avatar';
    avatarImgEl.src = avatarUrl;
    avatarWrapEl.appendChild(avatarImgEl);
    avatarRowEl.appendChild(avatarWrapEl);
    bannerWrap.appendChild(avatarRowEl);

    origCard.insertAdjacentElement('beforebegin', bannerWrap);

    // origCard'daki rozet bölümünü gizle — bizim kanal bölümüne taşıyoruz
    if (relation?.badgeContainer) {
      relation.badgeContainer.classList.add('ke-hide-badges');
    }

    const ext = document.createElement('div');
    ext.id = 'ke-user-ext';
    ext.dataset.slug = slug;

    let extHtml = '';
    const badgePills = [];
    if (data?.verified) badgePills.push(`<span class="ke-ue-badge ke-ue-badge-verified">${keIcons.verified} ${t('ue_verified','Dogrulanmis')}</span>`);
    if (data?.is_affiliate) badgePills.push(`<span class="ke-ue-badge ke-ue-badge-affiliate">${keIcons.affiliate} ${t('ue_affiliate','Affiliate')}</span>`);

    extHtml += `<div class="ke-ue-personal-header">
      <div class="ke-ue-stat">
        <span class="ke-ue-stat-icon">${keIcons.users}</span>
        <span class="ke-ue-stat-val">${formatCount(followers)}</span>
        <span class="ke-ue-stat-lbl">${t('ue_followers','Takipci')}</span>
      </div>
      ${badgePills.length ? `<div class="ke-ue-badges">${badgePills.join('')}</div>` : ''}
    </div>`;

    if (user.bio) {
      extHtml += `<div class="ke-uc-bio-section">
        <div class="ke-uc-bio-label">${t('ue_about','Hakkinda')}</div>
        <div class="ke-uc-bio">${escapeHtml(user.bio)}</div>
      </div>`;
    }

    const socialLinks = [];
    if (user.twitter)   socialLinks.push(`<a href="https://twitter.com/${encodeURIComponent(user.twitter)}" target="_blank" rel="noreferrer" class="ke-ue-social ke-ue-social-x" data-ke-tip="${escapeHtml(user.twitter)}">${keIcons.x}</a>`);
    if (user.instagram) socialLinks.push(`<a href="https://instagram.com/${encodeURIComponent(user.instagram)}" target="_blank" rel="noreferrer" class="ke-ue-social ke-ue-social-ig" data-ke-tip="${escapeHtml(user.instagram)}">${keIcons.instagram}</a>`);
    if (user.youtube)   socialLinks.push(`<a href="${escapeHtml(user.youtube)}" target="_blank" rel="noreferrer" class="ke-ue-social ke-ue-social-yt" data-ke-tip="YouTube">${keIcons.youtube}</a>`);
    if (user.discord)   socialLinks.push(`<span class="ke-ue-social ke-ue-social-dc" data-ke-tip="${escapeHtml(user.discord)}">${keIcons.discord}</span>`);
    if (user.tiktok)    socialLinks.push(`<a href="https://tiktok.com/@${encodeURIComponent(user.tiktok)}" target="_blank" rel="noreferrer" class="ke-ue-social ke-ue-social-tt" data-ke-tip="${escapeHtml(user.tiktok)}">${keIcons.tiktok}</a>`);
    if (socialLinks.length) extHtml += `<div class="ke-ue-socials-section"><div class="ke-uc-bio-label">${t('ue_socials','Sosyal')}</div><div class="ke-ue-socials">${socialLinks.join('')}</div></div>`;

    if (currentChannel) {
      extHtml += `<hr class="ke-uc-divider"/>`;

      const channelName = currentChannel;
      extHtml += `<div class="ke-uc-channel-section">`;
      extHtml += `<div class="ke-uc-channel-title">${escapeHtml(channelName)} ${t('ue_channel_ctx','kanalinda')}</div>`;

      // Takip bilgisi — DOM'dan parse edilen hazır format (ör. "9 Şub 2024")
      extHtml += `<div class="ke-uc-info-row" id="ke-ci-follow">
        <span class="ke-uc-info-label">${keIcons.calendar} ${t('ue_follow_date','Takip Tarihi')}</span>
        <span class="ke-uc-info-value">${relation?.followDate || '—'}</span>
      </div>`;

      // Abonelik bilgisi — DOM'dan parse edilen ay sayısı
      const subFor = relation?.subscribedFor;
      const subVal = (subFor != null && subFor > 0)
        ? `${subFor} ${t('ue_months','ay')}`
        : '—';
      extHtml += `<div class="ke-uc-info-row" id="ke-ci-sub">
        <span class="ke-uc-info-label">${keIcons.crown} ${t('ue_subscription','Abonelik')}</span>
        <span class="ke-uc-info-value">${subVal}</span>
      </div>`;

      // Kanal rozetleri — DOM'dan parse edilen rozet elementleri (SVG + img)
      const badges = relation?.badges || [];
      const badgesHtml = badges.map(b => `<span class="ke-uc-badge-icon">${b.html}</span>`).join('');
      extHtml += `<div class="ke-uc-badges-row" id="ke-ci-badges"${badges.length ? '' : ' style="display:none"'}>
        <span class="ke-uc-info-label">${keIcons.shield} ${t('ue_badges','Rozetler')}</span>
        <div class="ke-uc-badge-imgs">${badgesHtml}</div>
      </div>`;

      extHtml += `</div>`;
    }

    extHtml += `<div class="ke-ue-actions">
      <button class="ke-ue-btn${isFavorite ? ' ke-ue-btn-fav' : ''}" id="ke-ue-fav">
        ${isFavorite ? keIcons.starFill : keIcons.star}
        <span>${isFavorite ? t('ue_fav_remove','Favoriden cikar') : t('ue_fav_add','Favoriye ekle')}</span>
      </button>
      <button class="ke-ue-btn${isBlocked ? ' ke-ue-btn-danger' : ''}" id="ke-ue-block">
        ${isBlocked ? keIcons.unblock : keIcons.block}
        <span>${isBlocked ? t('ue_unblock','Engeli kaldir') : t('ue_block','Engelle')}</span>
      </button>
    </div>`;

    ext.innerHTML = extHtml;
    origCard.insertAdjacentElement('afterend', ext);

    popup.classList.add('ke-has-card');

    ext.querySelector('#ke-ue-fav')?.addEventListener('click', e => {
      e.stopPropagation();
      toggleFavoriteUser(slug);
    });
    ext.querySelector('#ke-ue-block')?.addEventListener('click', e => {
      e.stopPropagation();
      toggleBlockUser(slug);
    });
  }

  function formatCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toLocaleString();
  }

  function refreshKEActionBtns(slug) {
    const ext = document.querySelector(`#ke-user-ext[data-slug="${slug}"]`);
    if (!ext) return;
    const chat = siteSettings?.chat || {};
    const normSlug   = normalizeSlug(slug);
    const isBlocked  = (chat.filterUsers   || []).some(u => normalizeSlug(u) === normSlug);
    const isFavorite = (chat.favoriteUsers || []).some(u => normalizeSlug(u) === normSlug);
    const favBtn   = ext.querySelector('#ke-ue-fav');
    const blockBtn = ext.querySelector('#ke-ue-block');
    if (favBtn) {
      favBtn.className = `ke-ue-btn${isFavorite ? ' ke-ue-btn-fav' : ''}`;
      favBtn.innerHTML = `${isFavorite ? keIcons.starFill : keIcons.star}<span>${isFavorite ? t('ue_fav_remove','Favoriden cikar') : t('ue_fav_add','Favoriye ekle')}</span>`;
    }
    if (blockBtn) {
      blockBtn.className = `ke-ue-btn${isBlocked ? ' ke-ue-btn-danger' : ''}`;
      blockBtn.innerHTML = `${isBlocked ? keIcons.unblock : keIcons.block}<span>${isBlocked ? t('ue_unblock','Engeli kaldir') : t('ue_block','Engelle')}</span>`;
    }
  }

  function toggleFavoriteUser(slug) {
    const norm = normalizeSlug(slug);
    updateChatSetting(s => {
      s.favoriteUsers = s.favoriteUsers || [];
      const idx = s.favoriteUsers.findIndex(u => normalizeSlug(u) === norm);
      if (idx >= 0) s.favoriteUsers.splice(idx, 1);
      else s.favoriteUsers.push(norm);
    }, () => {
      refreshKEActionBtns(slug);
      reprocessAllMessages();
      renderChips('kp-fav-chips', siteSettings?.chat?.favoriteUsers || [], 'fav');
    });
  }

  function toggleBlockUser(slug) {
    const norm = normalizeSlug(slug);
    updateChatSetting(s => {
      s.filterUsers = s.filterUsers || [];
      const idx = s.filterUsers.findIndex(u => normalizeSlug(u) === norm);
      if (idx >= 0) s.filterUsers.splice(idx, 1);
      else s.filterUsers.push(norm);
    }, () => {
      refreshKEActionBtns(slug);
      reprocessAllMessages();
      renderChips('kp-user-chips', siteSettings?.chat?.filterUsers || [], 'user');
    });
  }

  function reprocessAllMessages() {
    if (!chatRoot || !document.contains(chatRoot)) return;
    chatRoot.querySelectorAll(MSG_ITEM_SEL).forEach(msg => {
      msg.classList.remove(
        'ke-filtered-bot', 'ke-filtered-word', 'ke-filtered-user',
        'ke-filtered-emote', 'ke-emoji-spam', 'ke-filtered-blur', 'ke-fav-msg'
      );
      msg.style.removeProperty('display');
      msg.style.removeProperty('--ke-fav-color');
      processMessage(msg);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
