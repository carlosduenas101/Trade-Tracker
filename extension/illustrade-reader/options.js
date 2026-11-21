const $ = id => document.getElementById(id);
chrome.storage.local.get(['url', 'token', 'kcexAccount', 'lbankAccount'], c => {
  $('url').value = c.url || 'https://trade-tracker-api-5e2o.onrender.com';
  $('kcex').value = c.kcexAccount || '';
  $('lbank').value = c.lbankAccount || '';
  $('token').placeholder = c.token ? 'Saved (hidden). Paste a new one to replace it.' : 'HUB_INGEST_TOKEN from backend\\.env';
});
$('save').addEventListener('click', () => {
  const data = { url: $('url').value.trim(), kcexAccount: $('kcex').value.trim(), lbankAccount: $('lbank').value.trim() };
  const t = $('token').value.trim();
  if (t) data.token = t;
  chrome.storage.local.set(data, () => {
    $('token').value = '';
    $('token').placeholder = 'Saved (hidden). Paste a new one to replace it.';
    $('status').textContent = 'Saved. Reload your KCEX / LBank futures tabs.';
    $('status').style.color = '#39ff14';
  });
});
