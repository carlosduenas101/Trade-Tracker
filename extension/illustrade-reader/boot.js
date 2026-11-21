// Starts the page reader with the settings saved on the extension's options page.
// Runs after lbank_reader.js / kcex_reader.js, which define window.__hubLbank / __hubKcex.
(function () {
  'use strict';
  const isLbank = location.hostname.endsWith('lbank.com');
  const reader = isLbank ? window.__hubLbank : window.__hubKcex;
  const accountKey = isLbank ? 'lbankAccount' : 'kcexAccount';
  const label = isLbank ? 'LBank' : 'KCEX';

  function pill(text) {
    let el = document.getElementById('illustrade-hub-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'illustrade-hub-badge';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;font:11px/1.4 system-ui,sans-serif;' +
        'padding:3px 9px;border-radius:10px;color:#000;pointer-events:none;opacity:.92;max-width:60vw;background:#ff5252';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
  }

  chrome.storage.local.get(['url', 'token', accountKey], cfg => {
    const device = (cfg[accountKey] || '').trim();
    const missing = [!cfg.url && 'server URL', !cfg.token && 'token', !device && label + ' account name'].filter(Boolean);
    if (!reader) { pill('Illustrade ' + label + ' reader: failed to load'); return; }
    if (missing.length) {
      pill('Illustrade ' + label + ' reader: not configured (' + missing.join(', ') + '). Click the Illustrade Reader icon to set it up.');
      return;
    }
    reader.start({ url: cfg.url.trim(), token: cfg.token.trim(), device });
  });
})();
