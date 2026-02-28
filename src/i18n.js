/**
 * KickKit — i18n Helper
 * Popup ve Multistream sayfaları için paylaşılan çeviri modülü.
 * Content script kendi inline versiyonunu kullanır (chrome.runtime.getURL ile).
 */

const I18n = (() => {
  let _dict = {};

  async function init(lang) {
    lang = lang || 'tr';
    try {
      const url = chrome.runtime.getURL(`locales/${lang}.json`);
      const resp = await fetch(url);
      _dict = await resp.json();
    } catch (e) {
      _dict = {};
    }
  }

  function t(key, fallback) {
    return _dict[key] != null ? _dict[key] : (fallback != null ? fallback : key);
  }

  function applyDOM(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const v = _dict[el.dataset.i18n];
      if (v != null) el.textContent = v;
    });
    root.querySelectorAll('[data-i18n-ph]').forEach(el => {
      const v = _dict[el.dataset.i18nPh];
      if (v != null) el.placeholder = v;
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const v = _dict[el.dataset.i18nTitle];
      if (v != null) el.title = v;
    });
  }

  return { init, t, applyDOM };
})();
