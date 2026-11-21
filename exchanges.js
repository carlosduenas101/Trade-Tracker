/**
 * My Exchanges: the exchanges the user trades on, saved to the account
 * (GET/PUT /settings/exchanges) so they never have to be re-entered.
 * Fees are OPTIONAL per exchange; a blank fee means "not set".
 * When an exchange with a taker fee is picked in the Liq Ladder calculator,
 * its taker fee fills "Fee per side (%)". Otherwise that field is untouched.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const PRESETS = ['KCEX', 'Bitunix', 'LBank'];
  const SEL_KEY = 'illustrade:lcExchange';
  // Published futures base rates (%, VIP0). Used only to PRE-FILL blanks; saved values always win.
  const KNOWN_FEES = {
    kcex:    { maker: 0,    taker: 0.01 },
    bitunix: { maker: 0.02, taker: 0.06 },
    lbank:   { maker: 0.02, taker: 0.06 },
  };
  const knownFor = name => KNOWN_FEES[String(name || '').trim().toLowerCase()] || null;
  let list = [];      // saved exchanges
  let draft = [];     // rows being edited in the modal

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const feeVal = v => (v === null || v === undefined || v === '' ? null : Number(v));

  async function load() {
    try {
      const r = await apiFetch('/settings/exchanges');
      list = Array.isArray(r.exchanges) ? r.exchanges : [];
    } catch (e) {
      list = [];
    }
    fillCalcSelect();
  }

  // ── Calculator selector ────────────────────────────────────
  function fillCalcSelect() {
    const sel = $('lcExchange');
    if (!sel) return;
    let keep = '';
    try { keep = localStorage.getItem(SEL_KEY) || ''; } catch { /* storage unavailable */ }
    // Always offer the built-in exchanges (unless the user saved one as not used), plus their own
    const names = PRESETS.filter(p => !list.some(x => x.name.toLowerCase() === p.toLowerCase() && !x.enabled));
    for (const x of list) if (x.enabled && !names.some(n => n.toLowerCase() === x.name.toLowerCase())) names.push(x.name);
    sel.innerHTML = '<option value="">Not set</option>' +
      names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = names.includes(keep) ? keep : '';
  }
  function onCalcPick() {
    const sel = $('lcExchange');
    try { localStorage.setItem(SEL_KEY, sel.value); } catch { /* storage unavailable */ }
    const ex = list.find(x => x.name.toLowerCase() === sel.value.toLowerCase());
    let fee = ex ? feeVal(ex.taker_fee_pct) : null;      // saved fee wins
    if (fee === null && sel.value && knownFor(sel.value)) fee = knownFor(sel.value).taker;
    if (fee !== null && Number.isFinite(fee)) {
      const el = $('lcFee');
      el.value = fee;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ── Modal ──────────────────────────────────────────────────
  function rowHtml(r, i) {
    return `<div class="ex-row" data-i="${i}">
      <label class="ex-on"><input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''} /> Use</label>
      <input class="input-field" type="text" data-f="name" maxlength="30" placeholder="Exchange" value="${esc(r.name)}" />
      <input class="input-field" type="number" data-f="maker_fee_pct" min="0" max="5" step="any" placeholder="Maker % (optional)" value="${r.maker_fee_pct ?? ''}" />
      <input class="input-field" type="number" data-f="taker_fee_pct" min="0" max="5" step="any" placeholder="Taker % (optional)" value="${r.taker_fee_pct ?? ''}" />
      <button type="button" class="btn btn-ghost btn-sm" data-rm="${i}" aria-label="Remove">&times;</button>
    </div>`;
  }
  function renderRows() {
    $('exRows').innerHTML = draft.length ? draft.map(rowHtml).join('') : '<p class="ex-empty">No exchanges yet. Add one below.</p>';
    $('exPresets').innerHTML = PRESETS.filter(p => !draft.some(d => d.name.toLowerCase() === p.toLowerCase()))
      .map(p => `<button type="button" class="btn btn-ghost btn-sm" data-preset="${esc(p)}">+ ${esc(p)}</button>`).join('');
  }
  function readRows() {
    document.querySelectorAll('#exRows .ex-row').forEach(row => {
      const i = +row.dataset.i;
      const get = f => row.querySelector(`[data-f="${f}"]`);
      draft[i] = {
        name: get('name').value,
        enabled: get('enabled').checked,
        maker_fee_pct: get('maker_fee_pct').value === '' ? null : parseFloat(get('maker_fee_pct').value),
        taker_fee_pct: get('taker_fee_pct').value === '' ? null : parseFloat(get('taker_fee_pct').value),
      };
    });
  }
  function openModal() {
    draft = list.map(x => ({ ...x }));
    $('exMsg').textContent = '';
    renderRows();
    $('exBackdrop').hidden = false;
  }
  function closeModal() { $('exBackdrop').hidden = true; }

  async function save() {
    readRows();
    const items = draft.filter(r => r.name.trim() !== '');
    for (const r of items) {
      for (const f of ['maker_fee_pct', 'taker_fee_pct']) {
        if (r[f] !== null && (!Number.isFinite(r[f]) || r[f] < 0 || r[f] > 5)) {
          $('exMsg').textContent = 'Fees must be between 0 and 5 (%), or left blank.';
          return;
        }
      }
    }
    const names = items.map(r => r.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) { $('exMsg').textContent = 'Each exchange can only be listed once.'; return; }
    $('exSave').disabled = true;
    try {
      const r = await apiFetch('/settings/exchanges', { method: 'PUT', body: JSON.stringify({ exchanges: items }) });
      list = r.exchanges;
      fillCalcSelect();
      closeModal();
    } catch (e) {
      $('exMsg').textContent = 'Could not save: ' + e.message;
    } finally {
      $('exSave').disabled = false;
    }
  }

  function bind() {
    if (!$('exBackdrop')) return;
    $('exchangesBtn').addEventListener('click', openModal);
    $('exClose').addEventListener('click', closeModal);
    $('exCancel').addEventListener('click', closeModal);
    $('exBackdrop').addEventListener('click', e => { if (e.target === $('exBackdrop')) closeModal(); });
    $('exSave').addEventListener('click', save);
    $('exAdd').addEventListener('click', () => { readRows(); draft.push({ name: '', enabled: true, maker_fee_pct: null, taker_fee_pct: null }); renderRows(); });
    $('exPresets').addEventListener('click', e => {
      const p = e.target.closest('[data-preset]');
      if (!p) return;
      readRows();
      const k = knownFor(p.dataset.preset);
      draft.push({ name: p.dataset.preset, enabled: true, maker_fee_pct: k ? k.maker : null, taker_fee_pct: k ? k.taker : null });
      renderRows();
    });
    // Typing a known exchange name pre-fills its blank fee fields (never overwrites anything entered)
    $('exRows').addEventListener('change', e => {
      if (!e.target.matches('[data-f="name"]')) return;
      const row = e.target.closest('.ex-row');
      const k = knownFor(e.target.value);
      const mk = row.querySelector('[data-f="maker_fee_pct"]'), tk = row.querySelector('[data-f="taker_fee_pct"]');
      if (k && mk.value === '' && tk.value === '') { mk.value = k.maker; tk.value = k.taker; }
    });
    $('exRows').addEventListener('click', e => {
      const b = e.target.closest('[data-rm]');
      if (!b) return;
      readRows();
      draft.splice(+b.dataset.rm, 1);
      renderRows();
    });
    if ($('lcExchange')) $('lcExchange').addEventListener('change', onCalcPick);
    document.addEventListener('illustrade:login', load);
    document.addEventListener('illustrade:logout', () => { list = []; fillCalcSelect(); });
    if (typeof getToken === 'function' && getToken()) load();   // already signed in on page load
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
