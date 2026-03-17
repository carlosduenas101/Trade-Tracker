/* ════════════════════════════════════════════════════════════
   TRADE TRACKER — APP.JS
   Pure vanilla ES2020+, no frameworks.
   ════════════════════════════════════════════════════════════ */

'use strict';

const API_BASE = (typeof window.BACKEND_URL !== 'undefined' && window.BACKEND_URL)
  ? window.BACKEND_URL.replace(/\/$/, '')
  : 'http://localhost:8000';

/* ── State ─────────────────────────────────────────────────── */
const state = {
  trades: [],
  pendingDeleteId: null,
  editingId: null,
  pnlChart: null,
};

/* ════════════════════════════════════════════════════════════
   DOM REFERENCES
   ════════════════════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

const dom = {
  // Toolbar
  startDate:      $('startDate'),
  endDate:        $('endDate'),
  applyFilter:    $('applyFilter'),
  clearFilter:    $('clearFilter'),
  addTradeBtn:    $('addTradeBtn'),

  // Metrics
  metricWinRate:        $('metricWinRate'),
  metricWinRateSub:     $('metricWinRateSub'),
  metricPnl:            $('metricPnl'),
  metricPnlSub:         $('metricPnlSub'),
  metricDrawdown:       $('metricDrawdown'),
  metricDrawdownSub:    $('metricDrawdownSub'),
  metricRR:             $('metricRR'),
  metricRRSub:          $('metricRRSub'),
  metricStreak:         $('metricStreak'),
  metricStreakSub:      $('metricStreakSub'),
  metricTotal:          $('metricTotal'),
  metricTotalSub:       $('metricTotalSub'),
  metricAvgRoe:         $('metricAvgRoe'),
  metricAvgRoeSub:      $('metricAvgRoeSub'),
  metricAvgEntries:     $('metricAvgEntries'),
  metricAvgEntriesSub:  $('metricAvgEntriesSub'),

  cardWinRate:    $('card-winRate'),
  cardPnl:        $('card-pnl'),
  cardDrawdown:   $('card-drawdown'),
  cardRR:         $('card-rr'),
  cardStreak:     $('card-streak'),
  cardTotal:      $('card-total'),
  cardAvgRoe:     $('card-avgRoe'),
  cardAvgEntries: $('card-avgEntries'),

  // Table
  tradesBody:   $('tradesBody'),
  tradeCount:   $('tradeCount'),
  tableError:   $('tableError'),
  retryBtn:     $('retryBtn'),

  // Chart
  pnlChart:     $('pnlChart'),
  chartEmpty:   $('chartEmpty'),

  // Add Trade Modal
  modalBackdrop: $('modalBackdrop'),
  modalClose:    $('modalClose'),
  cancelBtn:     $('cancelBtn'),
  tradeForm:     $('tradeForm'),
  submitBtn:     $('submitBtn'),
  formError:     $('formError'),

  fSymbol:    $('fSymbol'),
  fSide:      $('fSide'),
  fEntry:     $('fEntry'),
  fExit:      $('fExit'),
  fQty:       $('fQty'),
  fPnl:       $('fPnl'),
  fRoe:       $('fRoe'),
  fLeverage:  $('fLeverage'),
  fRR:        $('fRR'),
  fOpenTime:  $('fOpenTime'),
  fCloseTime: $('fCloseTime'),
  fNotes:     $('fNotes'),
  fEntries:   $('fEntries'),
  qtyUnit:           $('qtyUnit'),
  qtyConversion:     $('qtyConversion'),
  qtyConverted:      $('qtyConverted'),
  leverageNotionalGroup: $('leverageNotionalGroup'),
  leverageNotional:      $('leverageNotional'),

  // Delete Confirm Modal
  confirmBackdrop:  $('confirmBackdrop'),
  confirmClose:     $('confirmClose'),
  confirmCancelBtn: $('confirmCancelBtn'),
  confirmDeleteBtn: $('confirmDeleteBtn'),

  // Import
  importBtn:    $('importBtn'),
  templateBtn:  $('templateBtn'),
  csvFileInput: $('csvFileInput'),

  // Toast
  toastContainer: $('toastContainer'),

  // Connection
  connectionStatus: $('connectionStatus'),
  statusLabel:      document.querySelector('.status-label'),
};

/* ════════════════════════════════════════════════════════════
   UTILITIES
   ════════════════════════════════════════════════════════════ */

/**
 * Generic API fetch wrapper.
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || j.message || msg; } catch (_) {}
    throw new Error(msg);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

/** Format a number as currency. */
function formatCurrency(val, decimals = 2) {
  if (val == null || isNaN(val)) return '—';
  const abs = Math.abs(val).toFixed(decimals);
  const formatted = Number(abs).toLocaleString('en-US', { minimumFractionDigits: decimals });
  return (val >= 0 ? '+' : '−') + '$' + formatted;
}

/** Format a number as percentage. */
function formatPercent(val, decimals = 1) {
  if (val == null || isNaN(val)) return '—';
  return val.toFixed(decimals) + '%';
}

/** Format R:R ratio. */
function formatRR(val) {
  if (val == null || isNaN(val)) return '—';
  return Number(val).toFixed(2) + 'R';
}

/** Format datetime string to short display. */
function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Format duration in ms or seconds to human-readable. */
function formatDuration(minutes) {
  if (minutes == null || isNaN(minutes)) return '—';
  if (minutes < 60)   return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

/** Escape HTML to prevent XSS. */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build query string from object, ignoring null/undefined/empty. */
function buildQuery(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return q ? `?${q}` : '';
}

/** Get current date filter values. */
function getDateRange() {
  return {
    start_date: dom.startDate.value || null,
    end_date:   dom.endDate.value   || null,
  };
}

/* ════════════════════════════════════════════════════════════
   CONNECTION STATUS
   ════════════════════════════════════════════════════════════ */
function setConnectionStatus(status, label) {
  dom.connectionStatus.className = `connection-status ${status}`;
  dom.statusLabel.textContent = label;
}

/* ════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ════════════════════════════════════════════════════════════ */

/**
 * Show a toast notification.
 * @param {string} msg
 * @param {'success'|'error'|'info'} type
 * @param {number} duration ms before auto-dismiss (0 = persistent)
 */
function showToast(msg, type = 'info', duration = 3500) {
  const icons = { success: '&#10003;', error: '&#10007;', info: '&#8505;' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${escHtml(msg)}</span>`;
  dom.toastContainer.prepend(toast);

  const remove = () => {
    toast.classList.add('removing');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  if (duration > 0) setTimeout(remove, duration);
}

/* ════════════════════════════════════════════════════════════
   METRICS
   ════════════════════════════════════════════════════════════ */

/**
 * Fetch /metrics endpoint and update metric cards.
 * @param {string|null} startDate ISO date string
 * @param {string|null} endDate   ISO date string
 */
async function fetchMetrics(startDate, endDate) {
  // Skeleton loading
  const cards = [dom.metricWinRate, dom.metricPnl, dom.metricDrawdown, dom.metricRR, dom.metricStreak, dom.metricTotal, dom.metricAvgRoe, dom.metricAvgEntries];
  cards.forEach(el => { el.textContent = '···'; el.classList.add('skeleton'); });

  try {
    const qs = buildQuery({ start_date: startDate, end_date: endDate });
    const data = await apiFetch(`/metrics${qs}`);
    renderMetrics(data);
    setConnectionStatus('connected', 'Connected');
  } catch (err) {
    cards.forEach(el => { el.textContent = '—'; el.classList.remove('skeleton'); });
    setConnectionStatus('error', 'Offline');
    console.error('fetchMetrics:', err);
  }
}

/**
 * Render metric data into the DOM.
 * @param {Object} data
 */
function renderMetrics(data) {
  const {
    win_rate,
    total_pnl,
    max_drawdown,
    avg_rr,
    current_streak,
    streak_type,
    total_trades,
    winning_trades,
    losing_trades,
  } = data;

  // Win Rate
  dom.metricWinRate.textContent = win_rate != null ? formatPercent(win_rate) : '—';
  dom.metricWinRate.classList.remove('skeleton');
  dom.metricWinRateSub.textContent = `${winning_trades ?? 0}W / ${losing_trades ?? 0}L`;
  applyCardColor(dom.cardWinRate, win_rate >= 50 ? 'positive' : 'negative');

  // Total P&L
  dom.metricPnl.textContent = total_pnl != null ? formatCurrency(total_pnl) : '—';
  dom.metricPnl.classList.remove('skeleton');
  dom.metricPnlSub.textContent = 'Realized';
  applyCardColor(dom.cardPnl, total_pnl > 0 ? 'positive' : total_pnl < 0 ? 'negative' : '');

  // Max Drawdown
  dom.metricDrawdown.textContent = max_drawdown != null ? formatCurrency(max_drawdown) : '—';
  dom.metricDrawdown.classList.remove('skeleton');
  dom.metricDrawdownSub.textContent = 'Peak to trough';
  applyCardColor(dom.cardDrawdown, 'negative');

  // Avg R:R
  dom.metricRR.textContent = avg_rr != null ? formatRR(avg_rr) : '—';
  dom.metricRR.classList.remove('skeleton');
  dom.metricRRSub.textContent = avg_rr >= 1 ? 'Favorable' : avg_rr != null ? 'Unfavorable' : '';
  applyCardColor(dom.cardRR, avg_rr >= 1 ? 'positive' : avg_rr != null ? 'negative' : '');

  // Streak
  const streakAbs = Math.abs(current_streak ?? 0);
  const streakType = streak_type || (current_streak > 0 ? 'win' : current_streak < 0 ? 'loss' : '');
  const streakLabel = streakAbs > 0 ? (streakType === 'win' ? `W${streakAbs}` : `L${streakAbs}`) : '—';
  dom.metricStreak.innerHTML = streakAbs > 0
    ? `<span class="streak-badge streak-${streakType === 'win' ? 'win' : 'loss'}">${escHtml(streakLabel)}</span>`
    : '—';
  dom.metricStreak.classList.remove('skeleton');
  dom.metricStreakSub.textContent = streakType === 'win' ? 'Win streak' : streakType === 'loss' ? 'Loss streak' : '';

  // Total Trades
  dom.metricTotal.textContent = total_trades ?? '0';
  dom.metricTotal.classList.remove('skeleton');
  dom.metricTotalSub.textContent = 'Closed positions';

  // Avg ROE %
  const avg_roe = data.avg_roe;
  dom.metricAvgRoe.textContent = avg_roe != null ? formatPercent(avg_roe) : '—';
  dom.metricAvgRoe.classList.remove('skeleton');
  dom.metricAvgRoeSub.textContent = 'Per trade average';
  applyCardColor(dom.cardAvgRoe, avg_roe > 0 ? 'positive' : avg_roe < 0 ? 'negative' : '');

  // Avg Entries
  const avg_entries = data.avg_entries;
  dom.metricAvgEntries.textContent = avg_entries != null && avg_entries > 0 ? Number(avg_entries).toFixed(1) : '—';
  dom.metricAvgEntries.classList.remove('skeleton');
  dom.metricAvgEntriesSub.textContent = 'Entries per trade';
}

function applyCardColor(cardEl, type) {
  cardEl.classList.remove('positive', 'negative', 'neutral');
  if (type) cardEl.classList.add(type);
}

/* ════════════════════════════════════════════════════════════
   TRADES TABLE
   ════════════════════════════════════════════════════════════ */

/**
 * Fetch /trades endpoint and render the table.
 * @param {string|null} startDate
 * @param {string|null} endDate
 */
async function fetchTrades(startDate, endDate) {
  dom.tableError.hidden = true;

  // Loading row
  dom.tradesBody.innerHTML = `
    <tr class="table-empty-row">
      <td colspan="12">Loading trades…</td>
    </tr>`;

  try {
    const qs = buildQuery({ start_date: startDate, end_date: endDate });
    const trades = await apiFetch(`/trades${qs}`);
    state.trades = Array.isArray(trades) ? trades : (trades.items ?? trades.data ?? []);
    renderTradesTable(state.trades);
    renderChart(state.trades);
  } catch (err) {
    dom.tradesBody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="12">Failed to load trades.</td>
      </tr>`;
    dom.tableError.hidden = false;
    console.error('fetchTrades:', err);
  }
}

/**
 * Render trades array into the table body.
 * @param {Array} trades
 */
function renderTradesTable(trades) {
  dom.tradeCount.textContent = `${trades.length} trade${trades.length !== 1 ? 's' : ''}`;

  if (!trades.length) {
    dom.tradesBody.innerHTML = `
      <tr class="table-empty-row" id="tableEmpty">
        <td colspan="12">No trades found. Add your first trade or sync your exchange.</td>
      </tr>`;
    return;
  }

  const rows = trades.map((trade) => {
    const pnl     = parseFloat(trade.pnl ?? trade.profit_loss ?? 0);
    const pnlSign = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '';
    const side    = (trade.side ?? '').toLowerCase();
    const sideClass = side === 'long' ? 'td-side-long' : side === 'short' ? 'td-side-short' : '';

    const durationMins = trade.duration_minutes
      ?? trade.duration
      ?? calcDurationMinutes(trade.open_time, trade.close_time);

    const rr = trade.rr ?? trade.risk_reward ?? trade.r_r;

    return `<tr data-id="${escHtml(trade.id ?? '')}">
      <td class="td-mono">${formatDate(trade.close_time ?? trade.open_time)}</td>
      <td class="td-symbol">${escHtml(trade.symbol ?? '—')}</td>
      <td class="${sideClass}">${escHtml(side.charAt(0).toUpperCase() + side.slice(1) || '—')}</td>
      <td class="td-mono">${formatPrice(trade.entry_price)}</td>
      <td class="td-mono">${formatPrice(trade.exit_price)}</td>
      <td class="td-mono">${trade.quantity != null ? Number(trade.quantity).toLocaleString() : '—'}</td>
      <td class="td-pnl ${pnlSign}">${formatCurrency(pnl)}</td>
      <td class="td-roe ${pnlSign}">${trade.roe != null ? (trade.roe > 0 ? '+' : '') + Number(trade.roe).toFixed(2) + '%' : '—'}</td>
      <td class="td-rr">${rr != null ? formatRR(rr) : '—'}</td>
      <td class="td-leverage">${trade.leverage != null ? escHtml(trade.leverage) + 'x' : '—'}</td>
      <td class="td-mono">${formatDuration(durationMins)}</td>
      <td><span class="td-source">${escHtml(trade.source ?? 'manual')}</span></td>
      <td class="td-notes" title="${escHtml(trade.notes ?? '')}">${escHtml(trade.notes ?? '')}</td>
      <td>
        <button class="action-btn action-btn--edit"
          aria-label="Edit trade ${escHtml(trade.symbol ?? '')}"
          data-action="edit" data-id="${escHtml(trade.id ?? '')}">&#9998;</button>
        <button class="action-btn action-btn--delete"
          aria-label="Delete trade ${escHtml(trade.symbol ?? '')}"
          data-action="delete" data-id="${escHtml(trade.id ?? '')}">&#128465;</button>
      </td>
    </tr>`;
  });

  dom.tradesBody.innerHTML = rows.join('');
}

/** Format a price value cleanly. */
function formatPrice(val) {
  if (val == null || isNaN(val)) return '—';
  const n = parseFloat(val);
  return n >= 1000
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toFixed(4);
}

/**
 * Extract base coin from symbol string. e.g. "BTC/USDT" → "BTC"
 */
function parseCoin(symbol) {
  if (!symbol) return 'COIN';
  return symbol.split('/')[0].trim().toUpperCase() || 'COIN';
}

/**
 * Update quantity label unit and conversion display based on current form values.
 * Long positions: qty is in USDT → convert to coin (qty / entry_price)
 * Short positions: qty is already in coin units
 */
function updateQtyConversion() {
  const side  = dom.fSide.value;
  const entry = parseFloat(dom.fEntry.value);
  const qty   = parseFloat(dom.fQty.value);
  const coin  = parseCoin(dom.fSymbol.value);

  if (side === 'long') {
    dom.qtyUnit.textContent = 'USDT';
    dom.qtyUnit.style.display = '';
    if (!isNaN(entry) && entry > 0 && !isNaN(qty) && qty > 0) {
      const coinAmt = qty / entry;
      const decimals = coinAmt < 0.001 ? 8 : coinAmt < 1 ? 6 : 4;
      dom.qtyConverted.textContent = coinAmt.toFixed(decimals) + ' ' + coin;
      dom.qtyConversion.style.display = '';
    } else {
      dom.qtyConversion.style.display = 'none';
    }
  } else {
    // Short or unselected — qty is in coin units, no conversion needed
    dom.qtyUnit.textContent = coin !== 'COIN' ? coin : '';
    dom.qtyUnit.style.display = coin !== 'COIN' ? '' : 'none';
    dom.qtyConversion.style.display = 'none';
  }
}

/** Calculate duration in minutes from two ISO strings. */
function calcDurationMinutes(open, close) {
  if (!open || !close) return null;
  const ms = new Date(close) - new Date(open);
  return isNaN(ms) ? null : ms / 60000;
}

/* ════════════════════════════════════════════════════════════
   ADD TRADE
   ════════════════════════════════════════════════════════════ */

/**
 * POST a new trade to /trades.
 * @param {Object} tradeData
 */
async function addTrade(tradeData) {
  dom.submitBtn.disabled = true;
  dom.submitBtn.textContent = 'Adding…';
  dom.formError.hidden = true;

  try {
    await apiFetch('/trades', {
      method: 'POST',
      body: JSON.stringify(tradeData),
    });
    closeAddModal();
    showToast('Trade added successfully.', 'success');
    await refreshAll();
  } catch (err) {
    dom.formError.textContent = `Error: ${err.message}`;
    dom.formError.hidden = false;
  } finally {
    dom.submitBtn.disabled = false;
    dom.submitBtn.textContent = 'Add Trade';
  }
}

/* ════════════════════════════════════════════════════════════
   UPDATE TRADE
   ════════════════════════════════════════════════════════════ */

async function updateTrade(id, tradeData) {
  dom.submitBtn.disabled = true;
  dom.submitBtn.textContent = 'Saving…';
  dom.formError.hidden = true;

  try {
    await apiFetch(`/trades/${id}`, {
      method: 'PUT',
      body: JSON.stringify(tradeData),
    });
    closeAddModal();
    showToast('Trade updated.', 'success');
    await refreshAll();
  } catch (err) {
    dom.formError.textContent = `Error: ${err.message}`;
    dom.formError.hidden = false;
  } finally {
    dom.submitBtn.disabled = false;
    dom.submitBtn.textContent = 'Save Changes';
  }
}

/* ════════════════════════════════════════════════════════════
   DELETE TRADE
   ════════════════════════════════════════════════════════════ */

/**
 * DELETE /trades/{id}.
 * @param {string|number} id
 */
async function deleteTrade(id) {
  dom.confirmDeleteBtn.disabled = true;
  dom.confirmDeleteBtn.textContent = 'Deleting…';

  try {
    await apiFetch(`/trades/${id}`, { method: 'DELETE' });
    closeConfirmModal();
    showToast('Trade deleted.', 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
    console.error('deleteTrade:', err);
  } finally {
    dom.confirmDeleteBtn.disabled = false;
    dom.confirmDeleteBtn.textContent = 'Delete';
    state.pendingDeleteId = null;
  }
}

/* ════════════════════════════════════════════════════════════
   CSV IMPORT
   ════════════════════════════════════════════════════════════ */

async function importCSV(file) {
  const formData = new FormData();
  formData.append('file', file);

  dom.importBtn.disabled = true;
  dom.importBtn.textContent = 'Importing…';

  try {
    const res = await fetch(`${API_BASE}/import`, { method: 'POST', body: formData });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error ${res.status}: ${text}`);
    }
    const result = await res.json();
    const msg = `Imported ${result.imported} trade(s).` +
      (result.errors.length ? ` ${result.errors.length} row(s) skipped — see console.` : '');
    showToast(msg, result.errors.length ? 'info' : 'success', 6000);
    if (result.errors.length) console.warn('Import row errors:', result.errors);
    await refreshAll();
  } catch (err) {
    showToast(`Import failed: ${err.message}`, 'error', 8000);
    console.error('Import error:', err);
  } finally {
    dom.importBtn.disabled = false;
    dom.importBtn.textContent = '↑ Import CSV';
    dom.csvFileInput.value = '';
  }
}

/* ════════════════════════════════════════════════════════════
   SYNC EXCHANGE
   ════════════════════════════════════════════════════════════ */

/**
 * POST /sync — pulls latest trades from the connected exchange.
 */
async function syncExchange() {
  dom.syncBtn.disabled = true;
  dom.syncBtn.classList.add('syncing');

  try {
    const result = await apiFetch('/sync', { method: 'POST' });
    const count = result?.new_trades ?? result?.count ?? result?.synced ?? '?';
    showToast(`Sync complete. ${count} new trade(s) imported.`, 'success', 5000);
    await refreshAll();
  } catch (err) {
    showToast(`Sync failed: ${err.message}`, 'error');
    console.error('syncExchange:', err);
  } finally {
    dom.syncBtn.disabled = false;
    dom.syncBtn.classList.remove('syncing');
  }
}

/* ════════════════════════════════════════════════════════════
   CHART
   ════════════════════════════════════════════════════════════ */

/**
 * Build and render a cumulative P&L line chart using Chart.js.
 * @param {Array} trades
 */
function renderChart(trades) {
  const canvas = dom.pnlChart;

  // Destroy previous chart instance
  if (state.pnlChart) {
    state.pnlChart.destroy();
    state.pnlChart = null;
  }

  if (!trades || !trades.length) {
    dom.chartEmpty.style.display = 'flex';
    canvas.style.display = 'none';
    return;
  }

  dom.chartEmpty.style.display = 'none';
  canvas.style.display = 'block';

  // Sort by close_time asc, build cumulative P&L
  const sorted = [...trades]
    .filter(t => t.close_time || t.open_time)
    .sort((a, b) => new Date(a.close_time ?? a.open_time) - new Date(b.close_time ?? b.open_time));

  let cumulative = 0;
  const labels = [];
  const values = [];
  const pointColors = [];

  for (const trade of sorted) {
    const pnl = parseFloat(trade.pnl ?? trade.profit_loss ?? 0);
    cumulative += pnl;
    const dateStr = trade.close_time ?? trade.open_time;
    const d = new Date(dateStr);
    labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    values.push(parseFloat(cumulative.toFixed(2)));
    pointColors.push(pnl >= 0 ? '#00c853' : '#ff1744');
  }

  // Gradient fill
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  const finalValue = values[values.length - 1] ?? 0;
  const baseColor = finalValue >= 0 ? '0, 200, 83' : '255, 23, 68';
  gradient.addColorStop(0,   `rgba(${baseColor}, 0.25)`);
  gradient.addColorStop(0.6, `rgba(${baseColor}, 0.05)`);
  gradient.addColorStop(1,   `rgba(${baseColor}, 0.00)`);

  const lineColor = finalValue >= 0 ? '#00c853' : '#ff1744';

  state.pnlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P&L',
        data: values,
        borderColor: lineColor,
        borderWidth: 2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: pointColors,
        pointBorderColor: 'transparent',
        pointRadius: values.length > 60 ? 0 : 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2330',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#8b949e',
          padding: 10,
          callbacks: {
            label(ctx) {
              const val = ctx.parsed.y;
              const sign = val >= 0 ? '+' : '−';
              return ` ${sign}$${Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#484f58',
            font: { size: 11 },
            maxTicksLimit: 10,
            maxRotation: 0,
          },
          grid: { color: '#21262d', drawBorder: false },
        },
        y: {
          ticks: {
            color: '#484f58',
            font: { size: 11 },
            callback(val) {
              const sign = val >= 0 ? '+' : '−';
              return `${sign}$${Math.abs(val).toLocaleString()}`;
            },
          },
          grid: { color: '#21262d', drawBorder: false },
        },
      },
    },
  });
}

/* ════════════════════════════════════════════════════════════
   MODAL HELPERS
   ════════════════════════════════════════════════════════════ */

function openAddModal() {
  state.editingId = null;
  dom.tradeForm.reset();
  dom.formError.hidden = true;
  dom.modalBackdrop.querySelector('.modal-title').textContent = 'Add Trade';
  dom.submitBtn.textContent = 'Add Trade';
  dom.submitBtn.disabled = false;
  dom.modalBackdrop.hidden = false;
  dom.qtyConversion.style.display = 'none';
  dom.qtyUnit.textContent = 'USDT';
  dom.fSymbol.focus();
  document.body.style.overflow = 'hidden';
}

function openEditModal(id) {
  const trade = state.trades.find(t => String(t.id) === String(id));
  if (!trade) return;
  state.editingId = id;

  dom.tradeForm.reset();
  dom.formError.hidden = true;
  dom.modalBackdrop.querySelector('.modal-title').textContent = 'Edit Trade';
  dom.submitBtn.textContent = 'Save Changes';
  dom.submitBtn.disabled = false;

  dom.fSymbol.value   = trade.symbol ?? '';
  dom.fSide.value     = trade.side ?? '';
  dom.fEntry.value    = trade.entry_price ?? '';
  dom.fExit.value     = trade.exit_price ?? '';
  dom.fPnl.value      = trade.pnl ?? '';
  dom.fRoe.value      = trade.roe ?? '';
  dom.fLeverage.value = trade.leverage ?? '';
  dom.fRR.value       = trade.risk_reward ?? '';
  dom.fEntries.value  = trade.entries ?? '';
  dom.fNotes.value    = trade.notes ?? '';

  // Qty: reverse-convert for long (backend stores coin units)
  const entry = parseFloat(trade.entry_price);
  const side  = (trade.side ?? '').toLowerCase();
  if (side === 'long' && entry > 0) {
    dom.fQty.value = (trade.quantity * entry).toFixed(2);
  } else {
    dom.fQty.value = trade.quantity ?? '';
  }

  // Times
  const toLocal = (iso) => iso ? iso.replace('T', 'T').slice(0, 16) : '';
  dom.fOpenTime.value  = toLocal(trade.open_time);
  dom.fCloseTime.value = toLocal(trade.close_time);

  updateQtyConversion();
  dom.modalBackdrop.hidden = false;
  dom.fSymbol.focus();
  document.body.style.overflow = 'hidden';
}

function closeAddModal() {
  state.editingId = null;
  dom.modalBackdrop.hidden = true;
  document.body.style.overflow = '';
}

function openConfirmModal(id) {
  state.pendingDeleteId = id;
  dom.confirmBackdrop.hidden = false;
  dom.confirmDeleteBtn.focus();
  document.body.style.overflow = 'hidden';
}

function closeConfirmModal() {
  dom.confirmBackdrop.hidden = true;
  document.body.style.overflow = '';
  state.pendingDeleteId = null;
}

/* ════════════════════════════════════════════════════════════
   FORM SUBMISSION
   ════════════════════════════════════════════════════════════ */

function handleFormSubmit(e) {
  e.preventDefault();
  dom.formError.hidden = true;

  const symbol      = dom.fSymbol.value.trim().toUpperCase();
  const side        = dom.fSide.value;
  const entryRaw    = parseFloat(dom.fEntry.value);
  const exitRaw     = parseFloat(dom.fExit.value);
  const qtyUsdt     = parseFloat(dom.fQty.value);
  const qtyRaw      = (side === 'long' && !isNaN(entryRaw) && entryRaw > 0)
    ? qtyUsdt / entryRaw
    : qtyUsdt;
  const pnlRaw      = parseFloat(dom.fPnl.value);
  const roeRaw      = parseFloat(dom.fRoe.value);
  const leverageRaw = dom.fLeverage.value ? parseFloat(dom.fLeverage.value) : null;
  const rrRaw       = dom.fRR.value ? parseFloat(dom.fRR.value) : null;
  const entriesRaw  = dom.fEntries.value ? parseInt(dom.fEntries.value, 10) : null;
  const openTime    = dom.fOpenTime.value;
  const closeTime   = dom.fCloseTime.value;
  const notes       = dom.fNotes.value.trim() || null;

  // Client-side validation
  const errors = [];
  if (!symbol)           errors.push('Symbol is required.');
  if (!side)             errors.push('Side is required.');
  if (isNaN(entryRaw))   errors.push('Entry price must be a number.');
  if (isNaN(exitRaw))    errors.push('Exit price must be a number.');
  if (isNaN(qtyRaw))     errors.push('Quantity must be a number.');
  if (qtyRaw <= 0)       errors.push('Quantity must be greater than zero.');
  if (isNaN(pnlRaw))     errors.push('P&L is required.');
  if (isNaN(roeRaw))     errors.push('ROE % is required.');
  if (!openTime)         errors.push('Open time is required.');
  if (!closeTime)        errors.push('Close time is required.');
  if (openTime && closeTime && new Date(closeTime) <= new Date(openTime)) {
    errors.push('Close time must be after open time.');
  }

  if (errors.length) {
    dom.formError.textContent = errors.join(' ');
    dom.formError.hidden = false;
    return;
  }

  const tradeData = {
    symbol,
    side,
    entry_price: entryRaw,
    exit_price:  exitRaw,
    quantity:    qtyRaw,
    pnl:         pnlRaw,
    roe:         roeRaw,
    leverage:    leverageRaw,
    risk_reward: rrRaw,
    entries:     entriesRaw,
    open_time:   new Date(openTime).toISOString(),
    close_time:  new Date(closeTime).toISOString(),
    notes,
    source:      'manual',
  };

  if (state.editingId != null) {
    updateTrade(state.editingId, tradeData);
  } else {
    addTrade(tradeData);
  }
}

/* ════════════════════════════════════════════════════════════
   DELEGATION: TABLE ACTION BUTTONS
   ════════════════════════════════════════════════════════════ */
function handleTableClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const { action, id } = btn.dataset;

  if (action === 'delete') {
    openConfirmModal(id);
  }
  if (action === 'edit') {
    openEditModal(id);
  }
}

/* ════════════════════════════════════════════════════════════
   KEYBOARD TRAP FOR MODALS
   ════════════════════════════════════════════════════════════ */
function handleKeydown(e) {
  if (e.key === 'Escape') {
    if (!dom.confirmBackdrop.hidden) closeConfirmModal();
    else if (!dom.modalBackdrop.hidden) closeAddModal();
  }
}

/* ════════════════════════════════════════════════════════════
   REFRESH ALL DATA
   ════════════════════════════════════════════════════════════ */
async function refreshAll() {
  const { start_date, end_date } = getDateRange();
  await Promise.all([
    fetchMetrics(start_date, end_date),
    fetchTrades(start_date, end_date),
  ]);
}

/* ════════════════════════════════════════════════════════════
   EVENT LISTENERS
   ════════════════════════════════════════════════════════════ */
function bindEvents() {
  // Toolbar
  dom.applyFilter.addEventListener('click', refreshAll);
  dom.clearFilter.addEventListener('click', () => {
    dom.startDate.value = '';
    dom.endDate.value   = '';
    refreshAll();
  });

  // Also trigger on Enter in date inputs
  dom.startDate.addEventListener('keydown', (e) => e.key === 'Enter' && refreshAll());
  dom.endDate.addEventListener(  'keydown', (e) => e.key === 'Enter' && refreshAll());

  // Add Trade button
  dom.addTradeBtn.addEventListener('click', openAddModal);

  // CSV Import
  dom.importBtn.addEventListener('click', () => dom.csvFileInput.click());
  dom.csvFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importCSV(file);
  });

  // Template download — generated client-side, no backend needed
  dom.templateBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const headers = 'symbol,side,entry_price,exit_price,quantity,pnl,roe,leverage,risk_reward,entries,open_time,close_time,notes';
    const example = 'BTC/USDT,long,60000,62000,0.1,200,3.33,10,2.0,1,2024-01-01T10:00:00,2024-01-01T12:00:00,Example trade';
    const blob = new Blob([headers + '\n' + example], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'trades_template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Live quantity unit + coin conversion
  dom.fSide.addEventListener('change', updateQtyConversion);
  dom.fSymbol.addEventListener('input', updateQtyConversion);
  dom.fEntry.addEventListener('input', updateQtyConversion);
  dom.fQty.addEventListener('input', updateQtyConversion);

  // Live leverage notional calculator
  function updateNotional() {
    const qty      = parseFloat(dom.fQty.value);
    const leverage = parseFloat(dom.fLeverage.value);
    if (!isNaN(qty) && !isNaN(leverage) && leverage >= 1) {
      const realCapital = qty / leverage;
      dom.leverageNotional.textContent = '$' + realCapital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      dom.leverageNotionalGroup.style.display = '';
    } else {
      dom.leverageNotional.textContent = '—';
      dom.leverageNotionalGroup.style.display = 'none';
    }
  }
  dom.fEntry.addEventListener('input', updateNotional);
  dom.fQty.addEventListener('input', updateNotional);
  dom.fLeverage.addEventListener('input', updateNotional);

  // Add Trade Modal
  dom.modalClose.addEventListener('click', closeAddModal);
  dom.cancelBtn.addEventListener( 'click', closeAddModal);
  dom.modalBackdrop.addEventListener('click', (e) => {
    if (e.target === dom.modalBackdrop) closeAddModal();
  });
  dom.tradeForm.addEventListener('submit', handleFormSubmit);

  // Delete Confirm Modal
  dom.confirmClose.addEventListener(    'click', closeConfirmModal);
  dom.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  dom.confirmDeleteBtn.addEventListener('click', () => {
    if (state.pendingDeleteId != null) deleteTrade(state.pendingDeleteId);
  });
  dom.confirmBackdrop.addEventListener('click', (e) => {
    if (e.target === dom.confirmBackdrop) closeConfirmModal();
  });

  // Table delegation
  dom.tradesBody.addEventListener('click', handleTableClick);

  // Retry button
  dom.retryBtn.addEventListener('click', refreshAll);

  // Keyboard
  document.addEventListener('keydown', handleKeydown);
}

/* ════════════════════════════════════════════════════════════
   INITIALISE
   ════════════════════════════════════════════════════════════ */

/**
 * Set a sensible default date range (last 30 days).
 */
function setDefaultDateRange() {
  const today = new Date();
  const prior = new Date();
  prior.setDate(prior.getDate() - 30);

  dom.endDate.value   = today.toISOString().slice(0, 10);
  dom.startDate.value = prior.toISOString().slice(0, 10);
}

async function init() {
  setDefaultDateRange();
  bindEvents();
  setConnectionStatus('', 'Connecting…');
  await refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
