/* ════════════════════════════════════════════════════════════
   TRADE TRACKER — APP.JS
   Pure vanilla ES2020+, no frameworks.
   ════════════════════════════════════════════════════════════ */

'use strict';

const API_BASE = (typeof window.BACKEND_URL !== 'undefined' && window.BACKEND_URL)
  ? window.BACKEND_URL.replace(/\/$/, '')
  : 'http://localhost:8000';

/* ── Auth token helpers ────────────────────────────────────── */
const _TOKEN_KEY = 'tt_token';
const _USER_KEY  = 'tt_user';

function getToken()      { return localStorage.getItem(_TOKEN_KEY); }
function getStoredUser() { try { return JSON.parse(localStorage.getItem(_USER_KEY)); } catch { return null; } }
function saveAuth(token, user) {
  localStorage.setItem(_TOKEN_KEY, token);
  localStorage.setItem(_USER_KEY, JSON.stringify(user));
}
function clearAuth() {
  localStorage.removeItem(_TOKEN_KEY);
  localStorage.removeItem(_USER_KEY);
}

/* ── Theme ─────────────────────────────────────────────────── */
const _THEME_KEY = 'tt_theme';

const _THEME_META = {
  dark:    { icon: '🌙', label: 'Dark',    logo: 'Imges/NeonGreenLogo.png' },
  purple:  { icon: '🟣', label: 'Purple',  logo: 'Imges/PurpleLogo.png'    },
  blossom: { icon: '🌸', label: 'Blossom', logo: 'Imges/BloomLogo.png'     },
};
const _THEME_CYCLE = ['dark', 'purple', 'blossom'];

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(_THEME_KEY, theme);
  const { icon, label, logo } = _THEME_META[theme] || _THEME_META.dark;
  ['themeToggle', 'loginThemeToggle'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.querySelector('.theme-icon').textContent  = icon;
    btn.querySelector('.theme-label').textContent = label;
  });
  ['headerLogo', 'loginLogo'].forEach(id => {
    const img = document.getElementById(id);
    if (img) img.src = logo;
  });
  // Re-render the P&L chart so theme-aware colours apply immediately
  if (typeof renderChart === 'function' && state?.trades) {
    renderChart(applyTableFilters ? applyTableFilters(state.trades) : state.trades);
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx     = _THEME_CYCLE.indexOf(current);
  applyTheme(_THEME_CYCLE[(idx + 1) % _THEME_CYCLE.length]);
}

/* ── Language / i18n ───────────────────────────────────────── */
const _LANG_KEY    = 'tt_lang';
let   _currentLang = 'en';

const _LANG_META = {
  en: { flag: '🇺🇸', label: 'EN' },
  es: { flag: '🇪🇸', label: 'ES' },
  fr: { flag: '🇫🇷', label: 'FR' },
};

function t(key) {
  const lang = TRANSLATIONS[_currentLang] || TRANSLATIONS.en;
  return lang[key] ?? TRANSLATIONS.en[key] ?? key;
}

function applyLang(lang) {
  _currentLang = lang;
  localStorage.setItem(_LANG_KEY, lang);
  document.documentElement.lang = lang;

  // Static elements with data-i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const val = t(el.dataset.i18n);
    if (val !== undefined) el.textContent = val;
  });

  // Placeholder attributes
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const val = t(el.dataset.i18nPh);
    if (val !== undefined) el.placeholder = val;
  });

  // Update all dropdown toggle buttons + mark active option
  const meta = _LANG_META[lang] || _LANG_META.en;
  ['langDropdown', 'loginLangDropdown'].forEach(id => {
    const dd = document.getElementById(id);
    if (!dd) return;
    const flagEl  = dd.querySelector('.lang-flag');
    const labelEl = dd.querySelector('.lang-label');
    if (flagEl)  flagEl.textContent  = meta.flag;
    if (labelEl) labelEl.textContent = meta.label;
    dd.querySelectorAll('.lang-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.lang === lang);
    });
  });

  // Default date filter label
  const tfDateLabel = document.getElementById('tfDateLabel');
  if (tfDateLabel) tfDateLabel.textContent = t('filter.last30');

  // Symbol filter label
  const tfSymbolLabel = document.getElementById('tfSymbolLabel');
  if (tfSymbolLabel) tfSymbolLabel.textContent = t('filter.allsymbols');
}

function initLangDropdowns() {
  document.querySelectorAll('.lang-dropdown').forEach(dd => {
    const btn = dd.querySelector('.lang-toggle');

    // Toggle open/close on button click
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dd.classList.contains('open');
      // Close every dropdown first
      document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!isOpen) dd.classList.add('open');
    });

    // Select language on option click
    dd.querySelectorAll('.lang-option').forEach(opt => {
      opt.addEventListener('click', () => {
        applyLang(opt.dataset.lang);
        dd.classList.remove('open');
      });
    });
  });

  // Close all dropdowns when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
  });
}

/* ── Background canvas animation ───────────────────────────── */
function initBgCanvas() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const CW    = 10;       // candle body width (px)
  const GAP   = 8;        // gap between candles
  const PITCH = CW + GAP; // px per candle slot

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();

  function themeColors() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'blossom') return { up: '#9b5de5', down: '#ff85a1' };
    if (t === 'purple')  return { up: '#00e5ff', down: '#c030ff' };
    return { up: '#39ff14', down: '#ff1744' };
  }

  // Mean-reverting candle so the chart stays in the visible range
  function newCandle(prev) {
    const pull  = (100 - prev) * 0.07;
    const close = Math.max(58, Math.min(142, prev + (Math.random() - 0.5) * 22 + pull));
    const high  = Math.max(prev, close) + Math.random() * 7 + 1;
    const low   = Math.min(prev, close) - Math.random() * 7 - 1;
    return { open: prev, high, low, close };
  }

  function makeRow(cy, hFrac, speed) {
    const range = canvas.height * hFrac * 0.5; // px for ±42 price units
    const data  = [];
    let price   = 85 + Math.random() * 30;
    const need  = Math.ceil((canvas.width + PITCH * 8) / PITCH);
    for (let i = 0; i < need; i++) {
      data.push(newCandle(price));
      price = data[data.length - 1].close;
    }
    return { cy, range, speed, data, offset: 0 };
  }

  let rows = [];
  function buildRows() {
    rows = [
      makeRow(canvas.height * 0.30, 0.30, 0.30),
      makeRow(canvas.height * 0.72, 0.22, 0.50),
    ];
  }
  buildRows();

  function drawCandle(x, c, cy, range, col) {
    const scale = range / 42;
    const color = c.close >= c.open ? col.up : col.down;
    const mid   = cy;

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x + CW / 2, mid - (c.high - 100) * scale);
    ctx.lineTo(x + CW / 2, mid - (c.low  - 100) * scale);
    ctx.stroke();

    const bTop = mid - (Math.max(c.open, c.close) - 100) * scale;
    const bH   = Math.max(Math.abs(c.close - c.open) * scale, 1.5);
    ctx.fillStyle = color;
    ctx.fillRect(x, bTop, CW, bH);
  }

  function drawTrend(row, col) {
    const { data, cy, range, offset } = row;
    const scale = range / 42;
    ctx.strokeStyle = col.up;
    ctx.lineWidth   = 1.2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    let first = true;
    data.forEach((c, i) => {
      const x = i * PITCH - offset + CW / 2;
      if (x < -PITCH || x > canvas.width + PITCH) return;
      const y = cy - (c.close - 100) * scale;
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  let rafId;
  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const col = themeColors();

    rows.forEach(row => {
      row.offset += row.speed;

      // Drop candles scrolled off the left
      while (row.data.length && (PITCH - row.offset) < -PITCH * 2) {
        row.data.shift();
        row.offset -= PITCH;
      }
      // Fill candles on the right
      while (row.data.length * PITCH - row.offset < canvas.width + PITCH * 6) {
        const last = row.data.length ? row.data[row.data.length - 1].close : 100;
        row.data.push(newCandle(last));
      }

      ctx.globalAlpha = 0.18;
      row.data.forEach((c, i) => {
        const x = i * PITCH - row.offset;
        if (x < -PITCH * 2 || x > canvas.width + PITCH) return;
        drawCandle(x, c, row.cy, row.range, col);
      });

      ctx.globalAlpha = 0.09;
      drawTrend(row, col);
    });

    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(frame);
  }
  frame();

  window.addEventListener('resize', () => { resize(); buildRows(); });
}

/* ── Login screen animated line-chart ──────────────────────── */
function initLoginCanvas() {
  const canvas = document.getElementById('loginCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const SPACING = 18;    // px between price points
  const SPEED1  = 0.55;  // main line scroll speed (px/frame)
  const SPEED2  = 0.30;  // secondary line (slower "MA")

  let buf1 = [], buf2 = [];
  let off1 = 0,  off2 = 0;

  function loginColors() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'blossom') return {
      c1: '#9b5de5', fa1: 'rgba(155,93,229,0.40)', fb1: 'rgba(155,93,229,0)',
      c2: '#ff85a1', fa2: 'rgba(255,133,161,0.22)', fb2: 'rgba(255,133,161,0)',
    };
    if (t === 'purple') return {
      c1: '#00e5ff', fa1: 'rgba(0,229,255,0.25)',   fb1: 'rgba(0,229,255,0)',
      c2: '#c030ff', fa2: 'rgba(192,48,255,0.10)',   fb2: 'rgba(192,48,255,0)',
    };
    return {
      c1: '#39ff14', fa1: 'rgba(57,255,20,0.18)',  fb1: 'rgba(57,255,20,0)',
      c2: '#00e5ff', fa2: 'rgba(0,229,255,0.09)',  fb2: 'rgba(0,229,255,0)',
    };
  }

  function nextP(buf, mean, vol) {
    const last = buf[buf.length - 1] ?? mean;
    let p = last + (Math.random() - 0.5) * vol + (mean - last) * 0.06;
    return Math.max(10, Math.min(90, p));
  }

  function initBuf(buf, mean, vol) {
    buf.length = 0;
    let p = mean;
    const needed = Math.ceil(canvas.width / SPACING) + 8;
    for (let i = 0; i < needed; i++) {
      p += (Math.random() - 0.5) * vol + (mean - p) * 0.06;
      p = Math.max(10, Math.min(90, p));
      buf.push(p);
    }
  }

  function resize() {
    canvas.width  = canvas.offsetWidth  || window.innerWidth;
    canvas.height = canvas.offsetHeight || 600;
    initBuf(buf1, 58, 10);
    initBuf(buf2, 44, 6);
  }
  resize();
  window.addEventListener('resize', resize);

  // Smooth bezier through points: draw filled area + stroke line
  function drawSmoothLine(buf, subOff, lineColor, fillA, fillB, lineW) {
    const W = canvas.width;
    const H = canvas.height;
    const py = p => H * 0.70 - (p / 100) * H * 0.48;
    const pts = buf.map((p, i) => ({ x: i * SPACING - subOff, y: py(p) }));
    if (pts.length < 2) return;

    // Draw filled area below the curve
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.lineTo(pts[0].x, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, fillA);
    grad.addColorStop(1, fillB);
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw the line itself on top
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = lineW;
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }

  let rafId;
  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.80;

    off1 += SPEED1;
    off2 += SPEED2;
    while (off1 >= SPACING) { off1 -= SPACING; buf1.push(nextP(buf1, 58, 10)); buf1.shift(); }
    while (off2 >= SPACING) { off2 -= SPACING; buf2.push(nextP(buf2, 44,  6)); buf2.shift(); }

    const c = loginColors();
    drawSmoothLine(buf1, off1, c.c1, c.fa1, c.fb1, 1.8);
    drawSmoothLine(buf2, off2, c.c2, c.fa2, c.fb2, 1.3);

    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(frame);
  }

  frame();
}

/* ── State ─────────────────────────────────────────────────── */
const state = {
  trades: [],
  pendingDeleteId: null,
  editingId: null,
  pnlChart: null,
  selectedIds: new Set(),
  tableFilter: { symbols: new Set(), side: '' },
  tableSort:   { col: 'date', dir: 'desc' },
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
  metricTotalLosses:    $('metricTotalLosses'),
  metricTotalLossesSub: $('metricTotalLossesSub'),
  metricDrawdown:       $('metricDrawdown'),
  metricDrawdownSub:    $('metricDrawdownSub'),
  metricMaxProfit:      $('metricMaxProfit'),
  metricMaxProfitSub:   $('metricMaxProfitSub'),
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
  metricAvgDuration:    $('metricAvgDuration'),
  metricAvgDurationSub: $('metricAvgDurationSub'),
  metricAvgPnl:         $('metricAvgPnl'),
  metricAvgPnlSub:      $('metricAvgPnlSub'),
  metricAvgDaily:       $('metricAvgDaily'),
  metricAvgDailySub:    $('metricAvgDailySub'),
  metricAvgWeekly:      $('metricAvgWeekly'),
  metricAvgWeeklySub:   $('metricAvgWeeklySub'),
  metricAvgMonthly:     $('metricAvgMonthly'),
  metricAvgMonthlySub:  $('metricAvgMonthlySub'),

  cardWinRate:    $('card-winRate'),
  cardPnl:          $('card-pnl'),
  cardTotalLosses:  $('card-totalLosses'),
  cardDrawdown:     $('card-drawdown'),
  cardMaxProfit:  $('card-maxProfit'),
  cardRR:         $('card-rr'),
  cardStreak:     $('card-streak'),
  cardTotal:      $('card-total'),
  cardAvgRoe:     $('card-avgRoe'),
  cardAvgEntries:  $('card-avgEntries'),
  cardAvgDuration: $('card-avgDuration'),
  cardAvgPnl:      $('card-avgPnl'),
  cardAvgDaily:    $('card-avgDaily'),
  cardAvgWeekly:   $('card-avgWeekly'),
  cardAvgMonthly:  $('card-avgMonthly'),

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

  // Table filter — dropdown wrappers
  tfDateDropdown:   $('tfDateDropdown'),
  tfSymbolDropdown: $('tfSymbolDropdown'),

  // Table filter — date dropdown
  tfDateBtn:    $('tfDateBtn'),
  tfDatePanel:  $('tfDatePanel'),
  tfDateLabel:  $('tfDateLabel'),
  tfStartDate:  $('tfStartDate'),
  tfEndDate:    $('tfEndDate'),
  tfApplyDate:  $('tfApplyDate'),

  // Table filter — symbol dropdown
  tfSymbolBtn:       $('tfSymbolBtn'),
  tfSymbolPanel:     $('tfSymbolPanel'),
  tfSymbolLabel:     $('tfSymbolLabel'),
  tfSymbolSearch:    $('tfSymbolSearch'),
  tfSymbolList:      $('tfSymbolList'),
  tfSymbolSelectAll: $('tfSymbolSelectAll'),
  tfSymbolClear:     $('tfSymbolClear'),

  // Table filter — direction
  filterSide: $('filterSide'),

  // Bulk delete
  bulkDeleteBtn: $('bulkDeleteBtn'),
  selectedCount: $('selectedCount'),
  selectAll:     $('selectAll'),

  // Delete Confirm Modal
  confirmBackdrop:  $('confirmBackdrop'),
  confirmClose:     $('confirmClose'),
  confirmCancelBtn: $('confirmCancelBtn'),
  confirmDeleteBtn: $('confirmDeleteBtn'),

  // Import / Export
  importBtn:    $('importBtn'),
  exportBtn:    $('exportBtn'),
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
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers, ...options });

  if (res.status === 401) {
    clearAuth();
    showLoginScreen();
    throw new Error('Session expired — please sign in again.');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || j.message || msg; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
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

/** Get current date filter values (table filter panel takes precedence). */
function getDateRange() {
  return {
    start_date: dom.tfStartDate.value || dom.startDate.value || null,
    end_date:   dom.tfEndDate.value   || dom.endDate.value   || null,
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
  const cards = [dom.metricWinRate, dom.metricPnl, dom.metricTotalLosses, dom.metricDrawdown, dom.metricMaxProfit, dom.metricRR, dom.metricStreak, dom.metricTotal, dom.metricAvgRoe, dom.metricAvgEntries, dom.metricAvgDuration, dom.metricAvgPnl, dom.metricAvgDaily, dom.metricAvgWeekly, dom.metricAvgMonthly];
  cards.forEach(el => { el.textContent = '···'; el.classList.add('skeleton'); });

  try {
    const qs = buildQuery({ start_date: startDate, end_date: endDate });
    const data = await apiFetch(`/metrics${qs}`);
    renderMetrics(data, startDate, endDate);
    setConnectionStatus('connected', t('header.connected'));
  } catch (err) {
    cards.forEach(el => { el.textContent = '—'; el.classList.remove('skeleton'); });
    setConnectionStatus('error', t('header.offline'));
    console.error('fetchMetrics:', err);
  }
}

/**
 * Count distinct calendar months touched by a [start, end] date-only range,
 * inclusive. E.g. 2026-06-27 → 2026-07-27 spans June and July = 2.
 */
function monthsSpanned(startDate, endDate) {
  const start = new Date(startDate);
  const end   = new Date(endDate);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12
       + (end.getUTCMonth() - start.getUTCMonth()) + 1;
}

/**
 * Render metric data into the DOM.
 * @param {Object} data
 * @param {string|null} startDate ISO date string of the active filter (or null for "All time")
 * @param {string|null} endDate   ISO date string of the active filter (or null for "All time")
 */
function renderMetrics(data, startDate, endDate) {
  const {
    win_rate,
    total_pnl,
    total_losses,
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
  dom.metricPnlSub.textContent = t('metric.realized');
  applyCardColor(dom.cardPnl, total_pnl > 0 ? 'positive' : total_pnl < 0 ? 'negative' : '');

  // Total Losses — use backend value if available, otherwise sum losing trades from state
  const total_losses_val = total_losses != null
    ? total_losses
    : (state.trades && state.trades.length
        ? state.trades.reduce((sum, tr) => { const p = tr.pnl ?? 0; return p < 0 ? sum + p : sum; }, 0)
        : null);
  dom.metricTotalLosses.textContent = total_losses_val != null ? formatCurrency(total_losses_val) : '—';
  dom.metricTotalLosses.classList.remove('skeleton');
  dom.metricTotalLossesSub.textContent = `${losing_trades ?? 0} ${t('metric.losingtrades')}`;
  applyCardColor(dom.cardTotalLosses, 'negative');

  // Max Drawdown
  dom.metricDrawdown.textContent = max_drawdown != null ? formatCurrency(max_drawdown > 0 ? -max_drawdown : max_drawdown) : '—';
  dom.metricDrawdown.classList.remove('skeleton');
  dom.metricDrawdownSub.textContent = t('metric.peaktotrough');
  applyCardColor(dom.cardDrawdown, 'negative');

  // Max Profit — use backend value if available, otherwise derive from state.trades
  const max_profit = data.max_profit != null
    ? data.max_profit
    : (state.trades && state.trades.length
        ? Math.max(...state.trades.map(t => t.pnl ?? 0))
        : null);
  dom.metricMaxProfit.textContent = max_profit != null ? formatCurrency(max_profit) : '—';
  dom.metricMaxProfit.classList.remove('skeleton');
  dom.metricMaxProfitSub.textContent = t('metric.besttrade');
  applyCardColor(dom.cardMaxProfit, max_profit > 0 ? 'positive' : max_profit < 0 ? 'negative' : '');

  // Avg R:R
  dom.metricRR.textContent = avg_rr != null ? formatRR(avg_rr) : '—';
  dom.metricRR.classList.remove('skeleton');
  dom.metricRRSub.textContent = avg_rr >= 1 ? t('metric.favorable') : avg_rr != null ? t('metric.unfavorable') : '';
  applyCardColor(dom.cardRR, avg_rr >= 1 ? 'positive' : avg_rr != null ? 'negative' : '');

  // Streak
  const streakAbs = Math.abs(current_streak ?? 0);
  const streakType = streak_type || (current_streak > 0 ? 'win' : current_streak < 0 ? 'loss' : '');
  const streakLabel = streakAbs > 0 ? (streakType === 'win' ? `W${streakAbs}` : `L${streakAbs}`) : '—';
  dom.metricStreak.innerHTML = streakAbs > 0
    ? `<span class="streak-badge streak-${streakType === 'win' ? 'win' : 'loss'}">${escHtml(streakLabel)}</span>`
    : '—';
  dom.metricStreak.classList.remove('skeleton');
  dom.metricStreakSub.textContent = streakType === 'win' ? t('metric.winstreak') : streakType === 'loss' ? t('metric.lossstreak') : '';

  // Total Trades
  dom.metricTotal.textContent = total_trades ?? '0';
  dom.metricTotal.classList.remove('skeleton');
  dom.metricTotalSub.textContent = t('metric.closedpos');

  // Avg ROE %
  const avg_roe = data.avg_roe;
  dom.metricAvgRoe.textContent = avg_roe != null ? formatPercent(avg_roe) : '—';
  dom.metricAvgRoe.classList.remove('skeleton');
  dom.metricAvgRoeSub.textContent = t('metric.pertrade');
  applyCardColor(dom.cardAvgRoe, avg_roe > 0 ? 'positive' : avg_roe < 0 ? 'negative' : '');

  // Avg Entries
  const avg_entries = data.avg_entries;
  dom.metricAvgEntries.textContent = avg_entries != null && avg_entries > 0 ? Number(avg_entries).toFixed(1) : '—';
  dom.metricAvgEntries.classList.remove('skeleton');
  dom.metricAvgEntriesSub.textContent = t('metric.entriespertrade');

  // Avg Duration
  const avg_duration = data.avg_duration;
  dom.metricAvgDuration.textContent = avg_duration != null && avg_duration > 0 ? formatDuration(avg_duration) : '—';
  dom.metricAvgDuration.classList.remove('skeleton');
  dom.metricAvgDurationSub.textContent = t('metric.pertrade');

  // Avg P&L — use backend value if available, otherwise derive from total_pnl / total_trades
  const avg_pnl = data.avg_pnl != null
    ? data.avg_pnl
    : (total_trades > 0 ? total_pnl / total_trades : null);
  dom.metricAvgPnl.textContent = avg_pnl != null ? formatCurrency(avg_pnl) : '—';
  dom.metricAvgPnl.classList.remove('skeleton');
  dom.metricAvgPnlSub.textContent = t('metric.pertrade');
  applyCardColor(dom.cardAvgPnl, avg_pnl > 0 ? 'positive' : avg_pnl < 0 ? 'negative' : '');

  // Avg Daily / Weekly / Monthly — $ and ROE% averaged per active calendar period
  renderPeriodAverage(dom.metricAvgDaily, dom.metricAvgDailySub, dom.cardAvgDaily, data.avg_daily_pnl, data.avg_daily_roe);
  renderPeriodAverage(dom.metricAvgWeekly, dom.metricAvgWeeklySub, dom.cardAvgWeekly, data.avg_weekly_pnl, data.avg_weekly_roe);

  // Avg Monthly only means something once the filter covers more than 2
  // calendar months — shorter windows collapse to 1-2 active month buckets,
  // which just echoes the weekly/total figures rather than a real average.
  // No explicit range ("All time") always shows it.
  const monthlyMeaningful = !startDate || !endDate || monthsSpanned(startDate, endDate) > 2;
  dom.cardAvgMonthly.style.display = monthlyMeaningful ? '' : 'none';
  if (monthlyMeaningful) {
    renderPeriodAverage(dom.metricAvgMonthly, dom.metricAvgMonthlySub, dom.cardAvgMonthly, data.avg_monthly_pnl, data.avg_monthly_roe);
  }
}

/** Render a combined $ + ROE% metric card (used for the daily/weekly/monthly averages). */
function renderPeriodAverage(valueEl, subEl, cardEl, pnl, roe) {
  valueEl.textContent = pnl != null ? formatCurrency(pnl) : '—';
  valueEl.classList.remove('skeleton');
  subEl.textContent = roe != null ? `${formatPercent(roe)} ${t('metric.avgroe.short')}` : ' ';
  applyCardColor(cardEl, pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '');
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
      <td colspan="12">${t('table.loading')}</td>
    </tr>`;

  try {
    const qs = buildQuery({ start_date: startDate, end_date: endDate });
    const trades = await apiFetch(`/trades${qs}`);
    state.trades = Array.isArray(trades) ? trades : (trades.items ?? trades.data ?? []);
    populateSymbolList(state.trades);
    renderTradesTable(state.trades);
    renderChart(state.trades);
  } catch (err) {
    dom.tradesBody.innerHTML = `
      <tr class="table-empty-row">
        <td colspan="12">${t('table.error')}</td>
      </tr>`;
    dom.tableError.hidden = false;
    console.error('fetchTrades:', err);
  }
}

/**
 * Render trades array into the table body.
 * @param {Array} trades
 */
function applySortIndicators() {
  const { col, dir } = state.tableSort;
  document.querySelectorAll('.trades-table th[data-sort]').forEach(th => {
    const isActive = th.dataset.sort === col;
    th.classList.toggle('sort-active', isActive);
    th.classList.toggle('sort-asc',  isActive && dir === 'asc');
    th.classList.toggle('sort-desc', isActive && dir === 'desc');

    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;

    if (isActive) {
      const accentColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent-primary').trim() || '#39ff14';
      arrow.textContent = dir === 'asc' ? ' ↑' : ' ↓';
      arrow.style.cssText = `color:${accentColor};font-size:16px;font-weight:700;line-height:1;vertical-align:middle;`;
    } else {
      arrow.textContent = ' ↕';
      arrow.style.cssText = 'color:#888;font-size:13px;font-weight:400;line-height:1;vertical-align:middle;';
    }
  });
}

function sortTrades(trades) {
  const { col, dir } = state.tableSort;
  if (!col) return trades;
  return [...trades].sort((a, b) => {
    let aVal, bVal;
    if (col === 'date') {
      aVal = new Date(a.close_time ?? a.open_time ?? 0).getTime();
      bVal = new Date(b.close_time ?? b.open_time ?? 0).getTime();
    } else if (col === 'pnl') {
      aVal = parseFloat(a.pnl ?? a.profit_loss ?? 0);
      bVal = parseFloat(b.pnl ?? b.profit_loss ?? 0);
    } else if (col === 'roe') {
      aVal = parseFloat(a.roe ?? 0);
      bVal = parseFloat(b.roe ?? 0);
    } else {
      return 0;
    }
    return dir === 'asc' ? aVal - bVal : bVal - aVal;
  });
}

function applyTableFilters(trades) {
  const { symbols, side } = state.tableFilter;
  return trades.filter(t => {
    const symMatch = symbols.size === 0 || symbols.has((t.symbol || '').toUpperCase());
    const sideMatch = !side || (t.side || '').toLowerCase() === side;
    return symMatch && sideMatch;
  });
}

function renderTradesTable(trades) {
  const filtered = applyTableFilters(trades);
  dom.tradeCount.textContent = `${filtered.length} trade${filtered.length !== 1 ? 's' : ''}${filtered.length !== trades.length ? ` (of ${trades.length})` : ''}`;
  trades = sortTrades(filtered);
  applySortIndicators();

  if (!trades.length) {
    dom.tradesBody.innerHTML = `
      <tr class="table-empty-row" id="tableEmpty">
        <td colspan="12">${t('table.empty')}</td>
      </tr>`;
    return;
  }

  state.selectedIds.clear();
  updateSelectionUI();

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
      <td><input type="checkbox" data-select="${escHtml(trade.id ?? '')}" /></td>
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
  const entry = parseFloat(dom.fEntry.value);
  const qty   = parseFloat(dom.fQty.value);
  const coin  = parseCoin(dom.fSymbol.value);

  // Quantity is always entered in USDT regardless of side
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
  dom.submitBtn.textContent = t('modal.adding');
  dom.formError.hidden = true;

  try {
    await apiFetch('/trades', {
      method: 'POST',
      body: JSON.stringify(tradeData),
    });
    closeAddModal();
    showToast(t('toast.trade.added'), 'success');
    await refreshAll();
  } catch (err) {
    dom.formError.textContent = `Error: ${err.message}`;
    dom.formError.hidden = false;
  } finally {
    dom.submitBtn.disabled = false;
    dom.submitBtn.textContent = t('modal.submit.add');
  }
}

/* ════════════════════════════════════════════════════════════
   UPDATE TRADE
   ════════════════════════════════════════════════════════════ */

async function updateTrade(id, tradeData) {
  dom.submitBtn.disabled = true;
  dom.submitBtn.textContent = t('modal.saving');
  dom.formError.hidden = true;

  try {
    await apiFetch(`/trades/${id}`, {
      method: 'PUT',
      body: JSON.stringify(tradeData),
    });
    closeAddModal();
    showToast(t('toast.trade.updated'), 'success');
    await refreshAll();
  } catch (err) {
    dom.formError.textContent = `Error: ${err.message}`;
    dom.formError.hidden = false;
  } finally {
    dom.submitBtn.disabled = false;
    dom.submitBtn.textContent = t('modal.submit.edit');
  }
}

/* ════════════════════════════════════════════════════════════
   SELECTION HELPERS
   ════════════════════════════════════════════════════════════ */

function updateSelectionUI() {
  const count = state.selectedIds.size;
  dom.selectedCount.textContent = count;
  dom.bulkDeleteBtn.hidden = count === 0;
  // Sync select-all checkbox state
  const total = dom.tradesBody.querySelectorAll('input[type="checkbox"]').length;
  dom.selectAll.indeterminate = count > 0 && count < total;
  dom.selectAll.checked = total > 0 && count === total;
}

function clearSelection() {
  state.selectedIds.clear();
  dom.tradesBody.querySelectorAll('input[data-select]').forEach(cb => cb.checked = false);
  updateSelectionUI();
}

/* ════════════════════════════════════════════════════════════
   BULK DELETE
   ════════════════════════════════════════════════════════════ */

async function bulkDeleteTrades() {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} ${t('toast.bulk.confirm')}`)) return;

  dom.bulkDeleteBtn.disabled = true;
  try {
    await apiFetch('/trades/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    showToast(`${ids.length} ${t('toast.bulk.deleted')}`, 'success');
    state.selectedIds.clear();
    await refreshAll();
  } catch (err) {
    showToast(`${t('toast.bulk.fail')} ${err.message}`, 'error');
  } finally {
    dom.bulkDeleteBtn.disabled = false;
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
  dom.confirmDeleteBtn.textContent = t('confirm.deleting');

  try {
    await apiFetch(`/trades/${id}`, { method: 'DELETE' });
    closeConfirmModal();
    showToast(t('toast.trade.deleted'), 'success');
    await refreshAll();
  } catch (err) {
    showToast(`${t('toast.delete.fail')} ${err.message}`, 'error');
    console.error('deleteTrade:', err);
  } finally {
    dom.confirmDeleteBtn.disabled = false;
    dom.confirmDeleteBtn.textContent = t('confirm.delete');
    state.pendingDeleteId = null;
  }
}

/* ════════════════════════════════════════════════════════════
   CSV IMPORT
   ════════════════════════════════════════════════════════════ */

/**
 * Ensure every row in the CSV has a non-empty "quantity" cell.
 * If the column is missing entirely, appends it with value 0.
 * If cells are blank, fills them with 0.
 * Handles tab, comma, semicolon, pipe delimiters.
 */
async function _patchCSVQuantity(file) {
  const raw = await file.text();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return file;

  // Detect delimiter (try tab first, then others)
  const delims = ['\t', ',', ';', '|'];
  let delim = ',';
  for (const d of delims) {
    if (lines[0].includes(d)) { delim = d; break; }
  }

  // Strip BOM from header line
  const headerLine = lines[0].replace(/^\uFEFF/, '');
  const headers = headerLine.split(delim).map(h => h.trim().toLowerCase());
  let qtyIdx = headers.findIndex(h => ['quantity','qty','size','amount','contracts','volume'].includes(h));

  if (qtyIdx === -1) {
    // Column doesn't exist at all — append it to every row
    const out = lines.map((line, i) => {
      if (!line.trim()) return line;
      return line.trimEnd() + delim + (i === 0 ? 'quantity' : '0');
    });
    return new File([out.join('\n')], file.name, { type: 'text/csv' });
  }

  // Column exists — replace any empty cells with '0'
  const out = lines.map((line, i) => {
    if (i === 0 || !line.trim()) return line;
    const cols = line.split(delim);
    if (!cols[qtyIdx] || !cols[qtyIdx].trim()) cols[qtyIdx] = '0';
    return cols.join(delim);
  });
  return new File([out.join('\n')], file.name, { type: 'text/csv' });
}

async function importCSV(rawFile) {
  const file = await _patchCSVQuantity(rawFile);
  const formData = new FormData();
  formData.append('file', file);

  dom.importBtn.disabled = true;
  dom.importBtn.textContent = t('modal.adding');

  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/import`, {
      method: 'POST',
      body: formData,
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error ${res.status}: ${text}`);
    }
    const result = await res.json();
    const hasErrors = result.errors && result.errors.length > 0;
    let msg = `${t('toast.import.ok')} ${result.imported} trade(s).`;
    if (result.skipped) msg += ` ${result.skipped} duplicate(s) skipped.`;
    if (hasErrors) msg += ` ${result.errors.length} row(s) failed.`;
    showToast(msg, hasErrors ? 'info' : 'success', 8000);
    if (hasErrors) {
      console.warn('Import row errors:\n' + result.errors.join('\n'));
      // Show first 3 errors in a second toast so user sees what went wrong
      const preview = result.errors.slice(0, 3).join('\n') + (result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more` : '');
      showToast(preview, 'error', 12000);
    }
    await refreshAll();
  } catch (err) {
    showToast(`${t('toast.import.fail')} ${err.message}`, 'error', 8000);
    console.error('Import error:', err);
  } finally {
    dom.importBtn.disabled = false;
    dom.importBtn.textContent = t('toolbar.import');
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

  // Theme-aware chart colours
  const _chartTheme = document.documentElement.getAttribute('data-theme');
  const _chartColors = _chartTheme === 'purple'
    ? { win: '#00e5ff', winRgb: '0, 229, 255', loss: '#c030ff', lossRgb: '192, 48, 255' }
    : { win: '#00c853', winRgb: '0, 200, 83',  loss: '#ff1744', lossRgb: '255, 23, 68'  };

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
    pointColors.push(pnl >= 0 ? _chartColors.win : _chartColors.loss);
  }

  // Gradient fill
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  const finalValue = values[values.length - 1] ?? 0;
  const baseColor = finalValue >= 0 ? _chartColors.winRgb : _chartColors.lossRgb;
  gradient.addColorStop(0,   `rgba(${baseColor}, 0.25)`);
  gradient.addColorStop(0.6, `rgba(${baseColor}, 0.05)`);
  gradient.addColorStop(1,   `rgba(${baseColor}, 0.00)`);

  const lineColor = finalValue >= 0 ? _chartColors.win : _chartColors.loss;

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
        pointRadius: values.length > 100 ? 2 : 4,
        pointHoverRadius: 7,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick(evt, elements) {
        if (!elements.length) return;
        const trade = sorted[elements[0].index];
        if (!trade) return;
        const row = document.querySelector(`.trades-table tr[data-id="${trade.id}"]`);
        if (!row) return;
        document.querySelectorAll('.trades-table tr.trade-highlight').forEach(r => r.classList.remove('trade-highlight'));
        row.classList.add('trade-highlight');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
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
  dom.modalBackdrop.querySelector('.modal-title').textContent = t('modal.addtrade');
  dom.submitBtn.textContent = t('modal.submit.add');
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
  dom.modalBackdrop.querySelector('.modal-title').textContent = t('modal.edittrade');
  dom.submitBtn.textContent = t('modal.submit.edit');
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
  const qtyRaw      = (!isNaN(entryRaw) && entryRaw > 0)
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
    // Fund Pool registers this after its IIFE runs (see initPool)
    window.refreshPool ? window.refreshPool() : Promise.resolve(),
  ]);
}

/* ════════════════════════════════════════════════════════════
   AUTH
   ════════════════════════════════════════════════════════════ */

function showLoginScreen() {
  document.getElementById('loginScreen').hidden = false;
  document.getElementById('userInfo').hidden = true;
  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled = false;
  loginBtn.textContent = 'Sign In';
}

function showApp(user) {
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('userInfo').hidden = false;
  document.getElementById('userNameDisplay').textContent = user.username;
}

async function doLogin(username, password) {
  const loginBtn   = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');
  loginBtn.disabled = true;
  loginError.hidden = true;

  const MAX_RETRIES  = 10;
  const RETRY_DELAY  = 6000; // ms between retries while server wakes up

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    loginBtn.textContent = attempt === 0 ? 'Signing in…' : `Server starting up… (${attempt}/${MAX_RETRIES})`;

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || 'Login failed.');
      }
      const data = await res.json();
      saveAuth(data.access_token, data.user);
      showApp(data.user);
      setDefaultDateRange();
      bindEvents();
      setConnectionStatus('', 'Connecting…');
      await refreshAll();
      return; // success — exit loop
    } catch (err) {
      // TypeError means a network/CORS failure (server sleeping or not yet up)
      // Retry those; surface real HTTP errors (wrong password, etc.) immediately
      if (err instanceof TypeError && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue;
      }
      loginError.textContent = (attempt >= MAX_RETRIES)
        ? 'Server is taking too long to respond. Please try again in a moment.'
        : err.message;
      loginError.hidden = false;
      break;
    }
  }

  loginBtn.disabled = false;
  loginBtn.textContent = 'Sign In';
}

function doLogout() {
  clearAuth();
  // Reset any state that was loaded for the previous user
  state.trades = [];
  state.selectedIds.clear();
  state.tableFilter = { symbols: new Set(), side: '' };
  showLoginScreen();
}

function bindLoginEvents() {
  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;
    if (u && p) doLogin(u, p);
  });
}

/* ════════════════════════════════════════════════════════════
   FILTER HELPERS
   ════════════════════════════════════════════════════════════ */

function togglePanel(panelEl, btnEl) {
  panelEl.hidden = !panelEl.hidden;
  btnEl.classList.toggle('is-open', !panelEl.hidden);
}

function closePanel(panelEl, btnEl) {
  if (!panelEl) return;
  panelEl.hidden = true;
  btnEl?.classList.remove('is-open');
}

function clearActivePreset() {
  document.querySelectorAll('.tf-quick-btn, .quick-range-btn').forEach(b => b.classList.remove('is-active'));
}

/**
 * Apply a rolling N-day range (today minus `days` through today) to both the
 * toolbar date inputs and the table-filter panel inputs, then refresh.
 * Shared by the toolbar quick-range buttons and the table filter's preset list.
 */
function applyQuickRange(days, label) {
  const today = new Date();
  const from  = new Date();
  from.setDate(from.getDate() - days);
  const todayStr = today.toISOString().slice(0, 10);
  const fromStr  = from.toISOString().slice(0, 10);

  dom.startDate.value   = fromStr;
  dom.endDate.value     = todayStr;
  dom.tfStartDate.value = fromStr;
  dom.tfEndDate.value   = todayStr;
  dom.tfDateLabel.textContent = label;

  clearActivePreset();
  document.querySelectorAll(`.tf-quick-btn[data-days="${days}"], .quick-range-btn[data-days="${days}"]`)
    .forEach(b => b.classList.add('is-active'));

  refreshAll();
}

function populateSymbolList(trades) {
  const unique = [...new Set(
    trades.map(t => (t.symbol || '').toUpperCase()).filter(Boolean)
  )].sort();

  dom.tfSymbolList.innerHTML = unique.map(sym => `
    <label class="tf-symbol-item" data-sym="${escHtml(sym)}">
      <input type="checkbox" data-sym="${escHtml(sym)}" />
      ${escHtml(sym)}
    </label>
  `).join('');

  // Re-check any previously selected symbols
  if (state.tableFilter.symbols.size > 0) {
    dom.tfSymbolList.querySelectorAll('input[data-sym]').forEach(cb => {
      cb.checked = state.tableFilter.symbols.has(cb.dataset.sym);
    });
  }
  updateSymbolLabel();
}

function updateSymbolLabel() {
  const { symbols } = state.tableFilter;
  if (symbols.size === 0) {
    dom.tfSymbolLabel.textContent = t('filter.allsymbols');
  } else if (symbols.size === 1) {
    dom.tfSymbolLabel.textContent = [...symbols][0];
  } else {
    dom.tfSymbolLabel.textContent = `${symbols.size} Symbols`;
  }
}

/* ════════════════════════════════════════════════════════════
   EVENT LISTENERS
   ════════════════════════════════════════════════════════════ */
function bindEvents() {
  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', doLogout);

  // Toolbar (legacy date inputs)
  dom.applyFilter.addEventListener('click', () => {
    // Sync toolbar dates to panel inputs so getDateRange() picks them up
    dom.tfStartDate.value = dom.startDate.value;
    dom.tfEndDate.value   = dom.endDate.value;
    dom.tfDateLabel.textContent = dom.startDate.value && dom.endDate.value
      ? `${dom.startDate.value} → ${dom.endDate.value}` : 'All time';
    refreshAll();
  });
  dom.clearFilter.addEventListener('click', () => {
    dom.startDate.value = '';
    dom.endDate.value   = '';
    dom.tfStartDate.value = '';
    dom.tfEndDate.value   = '';
    dom.tfDateLabel.textContent = 'All time';
    clearActivePreset();
    refreshAll();
  });
  dom.startDate.addEventListener('keydown', (e) => e.key === 'Enter' && refreshAll());
  dom.endDate.addEventListener(  'keydown', (e) => e.key === 'Enter' && refreshAll());

  // Add Trade button
  dom.addTradeBtn.addEventListener('click', openAddModal);

  // ── Table filter: date dropdown ──────────────────────────────
  dom.tfDateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(dom.tfDatePanel, dom.tfDateBtn);
    if (!dom.tfDatePanel.hidden) closePanel(dom.tfSymbolPanel, dom.tfSymbolBtn);
  });

  dom.tfApplyDate.addEventListener('click', () => {
    const start = dom.tfStartDate.value;
    const end   = dom.tfEndDate.value;
    dom.startDate.value = start;
    dom.endDate.value   = end;
    dom.tfDateLabel.textContent = start && end
      ? `${start} → ${end}` : start ? `From ${start}` : end ? `Until ${end}` : 'All time';
    clearActivePreset();
    closePanel(dom.tfDatePanel, dom.tfDateBtn);
    refreshAll();
  });

  document.querySelectorAll('.tf-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.dataset.days, 10);
      applyQuickRange(days, btn.textContent.trim());
      closePanel(dom.tfDatePanel, dom.tfDateBtn);
    });
  });

  // ── Toolbar: quick range buttons (7/30/90 days) ──────────────
  document.querySelectorAll('.toolbar .quick-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.dataset.days, 10);
      applyQuickRange(days, btn.textContent.trim());
    });
  });

  // ── Table filter: symbol dropdown ────────────────────────────
  dom.tfSymbolBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(dom.tfSymbolPanel, dom.tfSymbolBtn);
    if (!dom.tfSymbolPanel.hidden) {
      closePanel(dom.tfDatePanel, dom.tfDateBtn);
      dom.tfSymbolSearch.focus();
    }
  });

  dom.tfSymbolSearch.addEventListener('input', () => {
    const q = dom.tfSymbolSearch.value.trim().toLowerCase();
    dom.tfSymbolList.querySelectorAll('.tf-symbol-item').forEach(item => {
      const sym = item.dataset.sym || '';
      item.style.display = sym.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  dom.tfSymbolList.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-sym]');
    if (!cb) return;
    const sym = cb.dataset.sym;
    if (cb.checked) state.tableFilter.symbols.add(sym);
    else state.tableFilter.symbols.delete(sym);
    updateSymbolLabel();
    renderTradesTable(state.trades);
    renderChart(applyTableFilters(state.trades));
  });

  dom.tfSymbolSelectAll.addEventListener('click', () => {
    state.tableFilter.symbols.clear();
    dom.tfSymbolList.querySelectorAll('input[data-sym]').forEach(cb => { cb.checked = false; });
    updateSymbolLabel();
    renderTradesTable(state.trades);
    renderChart(applyTableFilters(state.trades));
  });

  dom.tfSymbolClear.addEventListener('click', () => {
    state.tableFilter.symbols.clear();
    dom.tfSymbolList.querySelectorAll('input[data-sym]').forEach(cb => { cb.checked = false; });
    updateSymbolLabel();
    renderTradesTable(state.trades);
    renderChart(applyTableFilters(state.trades));
  });

  // ── Table filter: direction ──────────────────────────────────
  dom.filterSide.addEventListener('change', () => {
    state.tableFilter.side = dom.filterSide.value;
    renderTradesTable(state.trades);
    renderChart(applyTableFilters(state.trades));
  });

  // Close dropdowns on outside click.
  // Use mousedown (fires before the browser opens the native date-picker calendar)
  // so the panel stays open while the user interacts with the date picker.
  document.addEventListener('mousedown', (e) => {
    if (!dom.tfDateDropdown?.contains(e.target))   closePanel(dom.tfDatePanel, dom.tfDateBtn);
    if (!dom.tfSymbolDropdown?.contains(e.target)) closePanel(dom.tfSymbolPanel, dom.tfSymbolBtn);
  });
  // Prevent mousedown inside a panel from bubbling to the above handler
  dom.tfDatePanel.addEventListener(  'mousedown', (e) => e.stopPropagation());
  dom.tfSymbolPanel.addEventListener('mousedown', (e) => e.stopPropagation());

  // CSV Import
  dom.importBtn.addEventListener('click', () => dom.csvFileInput.click());
  dom.csvFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importCSV(file);
  });

  // CSV Export
  dom.exportBtn.addEventListener('click', async () => {
    dom.exportBtn.disabled = true;
    dom.exportBtn.textContent = t('toolbar.exporting');
    try {
      const qs = buildQuery({ start_date: dom.startDate.value || null, end_date: dom.endDate.value || null });
      const token = getToken();
      const res = await fetch(`${API_BASE}/export${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `trades_export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showToast(`${t('toast.export.fail')} ${err.message}`, 'error', 6000);
    } finally {
      dom.exportBtn.disabled = false;
      dom.exportBtn.textContent = t('toolbar.export');
    }
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

  // Sort column headers
  document.querySelectorAll('.trades-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.tableSort.col === col) {
        state.tableSort.dir = state.tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.tableSort.col = col;
        state.tableSort.dir = 'desc';
      }
      renderTradesTable(state.trades);
    });
  });

  // Table delegation
  dom.tradesBody.addEventListener('click', handleTableClick);

  // Row checkboxes
  dom.tradesBody.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-select]');
    if (!cb) return;
    const id = Number(cb.dataset.select);
    if (cb.checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
    updateSelectionUI();
  });

  // Select all
  dom.selectAll.addEventListener('change', () => {
    const checkboxes = dom.tradesBody.querySelectorAll('input[data-select]');
    checkboxes.forEach(cb => {
      const id = Number(cb.dataset.select);
      cb.checked = dom.selectAll.checked;
      if (dom.selectAll.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
    });
    updateSelectionUI();
  });

  // Bulk delete
  dom.bulkDeleteBtn.addEventListener('click', bulkDeleteTrades);

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
  const todayStr = today.toISOString().slice(0, 10);
  const priorStr = prior.toISOString().slice(0, 10);

  dom.endDate.value     = todayStr;
  dom.startDate.value   = priorStr;
  dom.tfEndDate.value   = todayStr;
  dom.tfStartDate.value = priorStr;
  if (dom.tfDateLabel) dom.tfDateLabel.textContent = t('filter.last30');
}

async function init() {
  // Apply saved theme before anything renders
  applyTheme(localStorage.getItem(_THEME_KEY) || 'dark');
  applyLang(localStorage.getItem(_LANG_KEY) || 'en');
  document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
  document.getElementById('loginThemeToggle')?.addEventListener('click', toggleTheme);
  initLangDropdowns();
  initBgCanvas();
  initLoginCanvas();

  // Always wire the login form first (it's in the DOM from page load)
  bindLoginEvents();

  const token = getToken();
  const user  = getStoredUser();

  if (token && user) {
    // Show login screen locked while we verify the stored token
    document.getElementById('loginScreen').hidden = false;
    const _verifyBtn = document.getElementById('loginBtn');
    _verifyBtn.disabled = true;
    _verifyBtn.textContent = 'Verifying…';

    // Verify the stored token is still accepted by the server
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('token_invalid');
      const currentUser = await res.json();
      saveAuth(token, currentUser);   // refresh stored user data
      showApp(currentUser);
      setDefaultDateRange();
      bindEvents();
      setConnectionStatus('', 'Connecting…');
      await refreshAll();
      return;
    } catch (err) {
      // Only clear stored credentials on an explicit auth rejection (401/403).
      // A network/CORS failure (TypeError) means the server is sleeping — keep
      // the token so the user can log in again without re-entering credentials.
      if (err.message === 'token_invalid') {
        clearAuth();
      }
      // Either way fall through to show the login screen
    }
  }

  showLoginScreen();

  // If a stored user exists (server was just sleeping), pre-fill the username
  const storedUser = getStoredUser();
  if (storedUser?.username) {
    const usernameEl = document.getElementById('loginUsername');
    if (usernameEl && !usernameEl.value) usernameEl.value = storedUser.username;
    document.getElementById('loginPassword')?.focus();
  }
}

document.addEventListener('DOMContentLoaded', init);

/* ════════════════════════════════════════════════════════════
   FIB MULTI-ENTRY CALCULATOR
   ════════════════════════════════════════════════════════════ */

/*
 * FibCalc-v4
 * Pure calculation engine for Fibonacci Multi-Entry Calculator.
 * No DOM/framework dependencies — pass inputs, receive all output variables.
 *
 * Inputs: { account, riskPct, leverage, e1Price, slMode, tpPct, side }
 *   account   — total account balance in USDT
 *   riskPct   — risk percentage (e.g. 16 = 16%)
 *   leverage  — leverage multiplier
 *   e1Price   — first entry price
 *   slMode    — "aggressive" | "conservative"
 *   tpPct     — take profit % from wavg (default 5)
 *   side      — "short" | "long"
 */
function calcFib({ account, riskPct, leverage, e1Price, slMode, tpPct = 5, side }) {
  const isShort = side === 'short';
  const dir     = isShort ? 1 : -1;

  // Step 1 — Entry price cascade (each step compounds from previous entry)
  const e1 = e1Price;
  const e2 = e1 * (1 + dir * 0.01618);
  const e3 = e2 * (1 + dir * 0.03618);   // v4: 3.618% from E2
  const e4 = e3 * (1 + dir * 0.04236);   // v4: 4.236% from E3

  // Step 2 — Stop loss
  const slPct = slMode === 'aggressive' ? 0.02618 : 0.03618;
  const sl    = e4 * (1 + dir * slPct);

  // Step 3 — Fixed allocation weights (must sum to 1.0)
  const ALLOC  = [0.05, 0.10, 0.20, 0.65];
  const prices = [e1, e2, e3, e4];

  // Step 4 — Individual SL distance per entry
  const dists = prices.map(p => isShort ? (sl - p) / p : (p - sl) / p);

  // Step 5 — Aggregate weighted loss fraction at leverage
  const lossMultiplier = (
    ALLOC[0] * dists[0] + ALLOC[1] * dists[1] + ALLOC[2] * dists[2] + ALLOC[3] * dists[3]
  ) * leverage;

  // Step 6 — Solve for total capital directly
  const maxLoss      = account * (riskPct / 100);
  const totalCapital = maxLoss / lossMultiplier;

  // Step 7 — Capital allocation
  const e1Capital    = totalCapital * ALLOC[0];
  const e2Capital    = totalCapital * ALLOC[1];
  const e3Capital    = totalCapital * ALLOC[2];
  const e4Capital    = totalCapital * ALLOC[3];
  const capitals     = [e1Capital, e2Capital, e3Capital, e4Capital];
  const exposures    = capitals.map(c => c * leverage);
  const totalExposure = totalCapital * leverage;

  // Step 8 — Weighted average entry (from actual capital and quantity)
  const qtys     = capitals.map((c, i) => c / prices[i]);
  const totalQty = qtys.reduce((a, b) => a + b, 0);
  const wavg     = totalCapital / totalQty;

  // Step 9 — Take profit
  const tp = isShort ? wavg * (1 - tpPct / 100) : wavg * (1 + tpPct / 100);

  // Summary metrics
  const wavgToSL = isShort ? (sl - wavg) / wavg * 100 : (wavg - sl) / wavg * 100;
  const rr       = Math.abs((tp - wavg) / (wavg - sl));
  const allocs   = capitals.map(c => (c / totalCapital) * 100);

  // Actual real loss at SL (used for verification)
  const realLoss = qtys.reduce((sum, q, i) => sum + q * Math.abs(sl - prices[i]), 0) * leverage;

  // Verification assertions (console only, never shown to user)
  console.assert(Math.abs(realLoss - maxLoss) < 0.10,
    `FibCalc-v4 LOSS MISMATCH: ${maxLoss.toFixed(4)} vs ${realLoss.toFixed(4)}`);
  console.assert(Math.abs(ALLOC.reduce((a, b) => a + b, 0) - 1.0) < 1e-9,
    'FibCalc-v4 ALLOC must sum to 1.0');
  const wavgInRange = isShort ? (wavg > e1 && wavg < sl) : (wavg < e1 && wavg > sl);
  console.assert(wavgInRange, `FibCalc-v4 WAVG OUT OF RANGE: ${wavg}`);

  return {
    e1, e2, e3, e4, sl, slPct, tp,
    wavg, wavgToSL, rr,
    maxLoss, totalCapital, totalExposure,
    e1Capital, e2Capital, e3Capital, e4Capital,
    capitals, exposures, allocs,
    qtys, totalQty, lossMultiplier, realLoss,
  };
}

(function initFibCalc() {
  const $ = (id) => document.getElementById(id);

  const TRADE_COLORS = ['#39ff14', '#7ab8ff', '#c17aff', '#ffb400', '#ff7a7a'];
  const ENTRY_COLORS = ['#39ff14', '#7affcc', '#7ab8ff', '#c17aff'];
  let slMode = 'conservative';

  // ── Pinned trades persistence ──────────────────────────
  const PINS_KEY = 'illustrade:pins';

  function getPins() {
    try { return JSON.parse(localStorage.getItem(PINS_KEY) || '[]'); } catch { return []; }
  }
  function savePins(pins) { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); }

  function pinTrade(data) {
    const pins = getPins();
    pins.push(Object.assign({ id: Date.now(), ts: new Date().toISOString() }, data));
    if (pins.length > 50) pins.splice(0, pins.length - 50);
    savePins(pins);
    renderPinsPanel();
  }

  function renderPinsPanel() {
    const pins  = getPins();
    const list  = $('fcPinsList');
    const badge = $('fcPinsCount');
    badge.textContent = pins.length;
    badge.hidden = pins.length === 0;

    const fP = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
    const fM = n => '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fD = ts => new Date(ts).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });

    if (!pins.length) {
      list.innerHTML = '<div class="fib-pins-empty">No pinned trades yet.</div>';
      return;
    }

    list.innerHTML = [...pins].reverse().map(p => `
      <div class="fib-pin-card" data-pin-id="${p.id}">
        <div class="fib-pin-card-header">
          <span class="fib-pin-symbol">${escHtml(p.symbol)}</span>
          <span class="fib-pin-side ${p.side}">${p.side.toUpperCase()}</span>
          <span class="fib-pin-ts">${fD(p.ts)}</span>
          <button class="fib-pin-remove" title="Remove pin">&times;</button>
        </div>
        <div class="fib-pin-body">
          <div class="fib-pin-prices">
            <div class="fib-pin-price-cell"><span class="fib-pin-price-lbl fib-e1">E1</span><span class="fib-pin-price-val">${fP(p.e1)}</span></div>
            <div class="fib-pin-price-cell"><span class="fib-pin-price-lbl fib-e2">E2</span><span class="fib-pin-price-val">${fP(p.e2)}</span></div>
            <div class="fib-pin-price-cell"><span class="fib-pin-price-lbl fib-e3">E3</span><span class="fib-pin-price-val">${fP(p.e3)}</span></div>
            <div class="fib-pin-price-cell"><span class="fib-pin-price-lbl fib-e4">E4</span><span class="fib-pin-price-val">${fP(p.e4)}</span></div>
          </div>
          ${p.e1Cap != null ? `
          <table class="fib-table" style="margin-top:4px">
            <thead><tr><th>Entry</th><th>Alloc</th><th>Capital</th><th>Exposure</th></tr></thead>
            <tbody>
              ${['E1','E2','E3','E4'].map((lbl,i) => {
                const caps = [p.e1Cap,p.e2Cap,p.e3Cap,p.e4Cap];
                const exps = p.exposures || [];
                const allc = p.allocs || [];
                return `<tr>
                  <td class="fib-e${i+1}">${lbl}</td>
                  <td>${allc[i] != null ? allc[i].toFixed(2)+'%' : '—'}</td>
                  <td>${fM(caps[i])}</td>
                  <td>${exps[i] != null ? fM(exps[i]) : '—'}</td>
                </tr>`;
              }).join('')}
            </tbody>
            <tfoot>
              <tr class="fib-table-total">
                <td colspan="2">Total</td>
                <td>${fM(p.capital)}</td>
                <td>${p.totalExposure != null ? fM(p.totalExposure) : '—'}</td>
              </tr>
            </tfoot>
          </table>` : ''}
          <div class="fib-pin-metrics">
            <div class="fib-pin-metric"><span class="fib-pin-metric-lbl">SL</span><span class="fib-pin-metric-val fib-red">${fP(p.sl)}</span></div>
            <div class="fib-pin-metric"><span class="fib-pin-metric-lbl">Wavg</span><span class="fib-pin-metric-val fib-accent">${fP(p.wavg)}</span></div>
            <div class="fib-pin-metric"><span class="fib-pin-metric-lbl">TP</span><span class="fib-pin-metric-val fib-green">${fP(p.tp)}</span></div>
            <div class="fib-pin-metric"><span class="fib-pin-metric-lbl">Max Loss</span><span class="fib-pin-metric-val fib-red">${fM(p.maxLoss)}</span></div>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.fib-pin-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = +btn.closest('.fib-pin-card').dataset.pinId;
        savePins(getPins().filter(p => p.id !== id));
        renderPinsPanel();
      });
    });
  }

  const PAIR_OPTIONS = `
    <optgroup label="── Bitcoin">
      <option value="BTC/USDT">BTC/USDT</option>
      <option value="BTC/USDC">BTC/USDC</option>
    </optgroup>
    <optgroup label="── Ethereum">
      <option value="ETH/USDT">ETH/USDT</option>
      <option value="ETH/USDC">ETH/USDC</option>
      <option value="ETH/BTC">ETH/BTC</option>
    </optgroup>
    <optgroup label="── Large Cap">
      <option value="SOL/USDT">SOL/USDT</option>
      <option value="BNB/USDT">BNB/USDT</option>
      <option value="XRP/USDT">XRP/USDT</option>
      <option value="ADA/USDT">ADA/USDT</option>
      <option value="AVAX/USDT">AVAX/USDT</option>
      <option value="DOGE/USDT">DOGE/USDT</option>
      <option value="DOT/USDT">DOT/USDT</option>
      <option value="LTC/USDT">LTC/USDT</option>
      <option value="LINK/USDT">LINK/USDT</option>
      <option value="BCH/USDT">BCH/USDT</option>
    </optgroup>
    <optgroup label="── Mid Cap">
      <option value="SUI/USDT">SUI/USDT</option>
      <option value="APT/USDT">APT/USDT</option>
      <option value="ARB/USDT">ARB/USDT</option>
      <option value="OP/USDT">OP/USDT</option>
      <option value="INJ/USDT">INJ/USDT</option>
      <option value="TIA/USDT">TIA/USDT</option>
      <option value="MATIC/USDT">MATIC/USDT</option>
      <option value="ATOM/USDT">ATOM/USDT</option>
      <option value="NEAR/USDT">NEAR/USDT</option>
      <option value="FTM/USDT">FTM/USDT</option>
      <option value="SEI/USDT">SEI/USDT</option>
      <option value="WIF/USDT">WIF/USDT</option>
      <option value="PEPE/USDT">PEPE/USDT</option>
      <option value="HBAR/USDT">HBAR/USDT</option>
      <option value="TAO/USDT">TAO/USDT</option>
    </optgroup>
    <optgroup label="── Forex">
      <option value="EUR/USD">EUR/USD</option>
      <option value="GBP/USD">GBP/USD</option>
      <option value="USD/JPY">USD/JPY</option>
      <option value="USD/CHF">USD/CHF</option>
      <option value="AUD/USD">AUD/USD</option>
      <option value="USD/CAD">USD/CAD</option>
    </optgroup>
    <optgroup label="── Commodities">
      <option value="XAU/USD">XAU/USD (Gold)</option>
      <option value="XAG/USD">XAG/USD (Silver)</option>
      <option value="WTI/USD">WTI/USD (Oil)</option>
    </optgroup>`;

  // ── Render per-trade INPUT slots ───────────────────────────
  function renderTradeSlots() {
    const n       = parseInt($('fcTrades').value);
    const slotsEl = $('fcTradeSlots');
    // Preserve existing E1 values & pair selections across re-renders
    const prev = [];
    slotsEl.querySelectorAll('.fib-trade-slot').forEach((el, i) => {
      prev[i] = {
        pair: el.querySelector('.fib-slot-pair')?.value || 'BTC/USDT',
        dir:  el.querySelector('.fib-toggle[data-dir].active')?.dataset.dir || 'long',
        e1:   el.querySelector('.fib-slot-e1')?.value || '',
      };
    });

    slotsEl.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const color = TRADE_COLORS[i] || '#39ff14';
      const saved = prev[i] || {};
      const slot  = document.createElement('div');
      slot.className = 'fib-trade-slot';
      slot.style.setProperty('--trade-color', color);
      slot.innerHTML = `
        <div class="fib-trade-slot-header">
          <span class="fib-trade-slot-num">Trade ${i + 1}</span>
        </div>
        <select class="fib-input fib-select fib-slot-pair" aria-label="Pair for trade ${i + 1}">
          ${PAIR_OPTIONS}
        </select>
        <div class="fib-toggle-group fib-slot-dir-group">
          <button class="fib-toggle${saved.dir !== 'short' ? ' active' : ''}" data-dir="long">▲ Long</button>
          <button class="fib-toggle${saved.dir === 'short' ? ' active' : ''}" data-dir="short">▼ Short</button>
        </div>
        <input class="fib-input fib-slot-e1" type="number"
               placeholder="E1 Entry Price" min="0" step="any"
               value="${saved.e1 || ''}" />
        <div class="fib-slot-result" hidden></div>`;

      // Restore pair selection
      if (saved.pair) slot.querySelector('.fib-slot-pair').value = saved.pair;

      // Wire direction toggles
      slot.querySelectorAll('.fib-toggle[data-dir]').forEach(btn => {
        btn.addEventListener('click', () => {
          slot.querySelectorAll('.fib-toggle[data-dir]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      // Enter key on E1 triggers calculate
      slot.querySelector('.fib-slot-e1').addEventListener('keydown', e => {
        if (e.key === 'Enter') $('fibCalcBtn').click();
      });

      slotsEl.appendChild(slot);
    }
  }

  // ── Build inline result HTML for one trade slot ────────────
  // Delegates all math to calcFib (FibCalc-v3).
  // Returns { html, tradeCap, totalExp, totalRealLoss }.
  function tradeResultHTML(isLong, e1Price, maxLossPerTrade, leverage, account, numTrades) {
    const fmt  = (n, d = 2) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    const fmtP = (n)        => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 });

    // Derive riskPct from maxLossPerTrade so calcFib receives the correct maxLoss
    const riskPct = (maxLossPerTrade / account) * 100;
    const c = calcFib({ account, riskPct, leverage, e1Price, slMode, tpPct: 5, side: isLong ? 'long' : 'short' });

    const slModeLabel          = slMode === 'conservative' ? 'Conservative 3.618%' : 'Aggressive 2.618%';
    const realLossPctOfAccount = (c.realLoss * numTrades / account) * 100;

    // Step labels derived from the same constants as the price cascade
    const stepSign = isLong ? '−' : '+';
    const e2Step   = stepSign + (0.01618 * 100).toFixed(3) + '%';
    const e3Step   = stepSign + (0.03618 * 100).toFixed(3) + '%';
    const e4Step   = stepSign + (0.04236 * 100).toFixed(3) + '%';

    const allocRows = ['E1','E2','E3','E4'].map((lbl, j) => `
      <tr>
        <td style="color:${ENTRY_COLORS[j]}">${lbl}</td>
        <td>${c.allocs[j].toFixed(2)}%</td>
        <td>${fmt(c.capitals[j])}</td>
        <td>${fmt(c.exposures[j])}</td>
      </tr>`).join('');

    const html = `
      <div class="fib-section-title fib-slot-result-title">Entry Structure</div>
      <div class="fib-grid">
        <div class="fib-row"><span class="fib-key">SL Mode</span><span class="fib-val fib-accent">${slModeLabel}</span></div>
        <div class="fib-row fib-divider"><span class="fib-key fib-e1">E1</span><span class="fib-val">${fmtP(c.e1)}</span></div>
        <div class="fib-row"><span class="fib-key fib-e2">E2 <span class="fib-pct">${e2Step}</span></span><span class="fib-val">${fmtP(c.e2)}</span></div>
        <div class="fib-row"><span class="fib-key fib-e3">E3 <span class="fib-pct">${e3Step}</span></span><span class="fib-val">${fmtP(c.e3)}</span></div>
        <div class="fib-row"><span class="fib-key fib-e4">E4 <span class="fib-pct">${e4Step}</span></span><span class="fib-val">${fmtP(c.e4)}</span></div>
        <div class="fib-row fib-divider"><span class="fib-key">Weighted Avg</span><span class="fib-val fib-accent">${fmtP(c.wavg)}</span></div>
        <div class="fib-row"><span class="fib-key fib-sl">Stop Loss <span class="fib-pct">−${(c.slPct * 100).toFixed(3)}%</span></span><span class="fib-val fib-red">${fmtP(c.sl)}</span></div>
        <div class="fib-row"><span class="fib-key fib-tp">Take Profit <span class="fib-pct">+5%</span></span><span class="fib-val fib-green">${fmtP(c.tp)}</span></div>
        <div class="fib-row fib-divider"><span class="fib-key">Wavg → SL</span><span class="fib-val fib-red">−${c.wavgToSL.toFixed(2)}% from avg entry</span></div>
        <div class="fib-row"><span class="fib-key">R:R</span><span class="fib-val fib-accent">1 : ${c.rr.toFixed(2)}</span></div>
      </div>
      <div class="fib-section-title fib-slot-result-title">Capital Allocation</div>
      <table class="fib-table">
        <thead><tr><th>Entry</th><th>Alloc</th><th>Capital</th><th>Exposure</th></tr></thead>
        <tbody>${allocRows}</tbody>
        <tfoot>
          <tr class="fib-table-total">
            <td colspan="2">Total</td>
            <td>${fmt(c.totalCapital)}</td>
            <td>${fmt(c.totalExposure)}</td>
          </tr>
        </tfoot>
      </table>
      <div class="fib-grid" style="margin-top:6px">
        <div class="fib-row"><span class="fib-key">Trade Capital</span><span class="fib-val">${fmt(c.totalCapital)}</span></div>
        <div class="fib-row"><span class="fib-key">Total Exposure</span><span class="fib-val">${fmt(c.totalExposure)}</span></div>
        <div class="fib-row fib-divider"><span class="fib-key">Real loss at SL</span><span class="fib-val fib-red">${fmt(c.realLoss)} / trade &rarr; ${fmt(c.realLoss * numTrades)} total <span class="fib-pct">(${realLossPctOfAccount.toFixed(2)}% of acct)</span> <span class="fib-check-ok">✓</span></span></div>
      </div>
      <button class="fib-pin-btn">⊕ Pin</button>`;

    return { html, tradeCap: c.totalCapital, totalExp: c.totalExposure, totalRealLoss: c.realLoss, calcResult: c };
  }

  // ── Leverage slider ────────────────────────────────────────
  const levSlider  = $('fcLeverage');
  const levDisplay = $('fcLeverageDisplay');

  function updateLevDisplay() {
    levDisplay.textContent = levSlider.value + '×';
    const pct = ((levSlider.value - 1) / (125 - 1)) * 100;
    levSlider.style.background =
      `linear-gradient(to right, var(--accent-primary) ${pct}%, var(--border-default) ${pct}%)`;
  }
  levSlider.addEventListener('input', updateLevDisplay);
  updateLevDisplay();
  $('fcLevMinus').addEventListener('click', () => { levSlider.value = Math.max(1,   parseInt(levSlider.value) - 1); updateLevDisplay(); });
  $('fcLevPlus' ).addEventListener('click', () => { levSlider.value = Math.min(125, parseInt(levSlider.value) + 1); updateLevDisplay(); });

  // ── Trades slider ──────────────────────────────────────────
  const tradesSlider  = $('fcTrades');
  const tradesDisplay = $('fcTradesDisplay');

  function updateTradesDisplay() {
    const v = parseInt(tradesSlider.value);
    tradesDisplay.textContent = v + (v === 1 ? ' Trade' : ' Trades');
    const pct = ((v - 1) / (5 - 1)) * 100;
    tradesSlider.style.background =
      `linear-gradient(to right, var(--accent-primary) ${pct}%, var(--border-default) ${pct}%)`;
    renderTradeSlots();
  }
  tradesSlider.addEventListener('input', updateTradesDisplay);
  $('fcTradesMinus').addEventListener('click', () => { tradesSlider.value = Math.max(1, parseInt(tradesSlider.value) - 1); updateTradesDisplay(); });
  $('fcTradesPlus' ).addEventListener('click', () => { tradesSlider.value = Math.min(5, parseInt(tradesSlider.value) + 1); updateTradesDisplay(); });

  // Init on load
  updateTradesDisplay();

  // ── Risk % slider ──────────────────────────────────────────
  const riskSlider  = $('fcRisk');
  const riskDisplay = $('fcRiskDisplay');

  function updateRiskDisplay() {
    riskDisplay.textContent = parseFloat(riskSlider.value).toFixed(1) + '%';
    const pct = ((riskSlider.value - 0.5) / (50 - 0.5)) * 100;
    riskSlider.style.background =
      `linear-gradient(to right, var(--accent-primary) ${pct}%, var(--border-default) ${pct}%)`;
  }
  riskSlider.addEventListener('input', updateRiskDisplay);
  updateRiskDisplay();
  $('fcRiskMinus').addEventListener('click', () => { riskSlider.value = Math.max(0.5, parseFloat(riskSlider.value) - 0.5); updateRiskDisplay(); });
  $('fcRiskPlus' ).addEventListener('click', () => { riskSlider.value = Math.min(50,  parseFloat(riskSlider.value) + 0.5); updateRiskDisplay(); });

  // ── Stop Loss mode toggle ──────────────────────────────────
  $('fcSlConservative').addEventListener('click', () => {
    slMode = 'conservative';
    $('fcSlConservative').classList.add('active');
    $('fcSlAggressive').classList.remove('active');
    if (!$('fibResults').hidden) $('fibCalcBtn').click();
  });
  $('fcSlAggressive').addEventListener('click', () => {
    slMode = 'aggressive';
    $('fcSlAggressive').classList.add('active');
    $('fcSlConservative').classList.remove('active');
    if (!$('fibResults').hidden) $('fibCalcBtn').click();
  });

  // ── Calculate ──────────────────────────────────────────────
  $('fibCalcBtn').addEventListener('click', () => {
    const account   = parseFloat($('fcAccount').value);
    const riskPct   = parseFloat($('fcRisk').value);
    const leverage  = parseInt($('fcLeverage').value);
    const numTrades = parseInt($('fcTrades').value);

    const fmt = (n, d = 2) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

    // ── Input validation ───────────────────────────────────
    if (!account || account <= 0) return;
    if (!riskPct || riskPct < 0.5 || riskPct > 50) {
      $('frWarning').textContent = riskPct < 0.5 ? '⚠ Minimum risk is 0.5%' : '⚠ Maximum risk is 50%';
      $('frWarning').hidden = false;
      return;
    }
    if (!leverage || leverage < 1 || leverage > 125) {
      $('frWarning').textContent = '⚠ Leverage must be an integer between 1× and 125×.';
      $('frWarning').hidden = false;
      return;
    }

    // Read per-trade inputs — skip slots without an E1 price
    const slots = $('fcTradeSlots').querySelectorAll('.fib-trade-slot');
    const tradeInputs = [];
    slots.forEach(slot => {
      const e1Price = parseFloat(slot.querySelector('.fib-slot-e1')?.value);
      const resultEl = slot.querySelector('.fib-slot-result');
      if (!e1Price || e1Price <= 0) {
        if (resultEl) { resultEl.innerHTML = ''; resultEl.hidden = true; }
        return;
      }
      tradeInputs.push({
        pair:  slot.querySelector('.fib-slot-pair')?.value || 'BTC/USDT',
        dir:   slot.querySelector('.fib-toggle[data-dir].active')?.dataset.dir || 'long',
        e1Price,
        resultEl,
      });
    });
    if (!tradeInputs.length) return;

    $('frWarning').hidden = true;

    // ── Account risk rules ─────────────────────────────────
    const maxLoss         = account * (riskPct / 100);
    const maxLossPerTrade = maxLoss / numTrades;

    // ── Inject results inline into each completed trade slot ─
    let firstResult = null;
    tradeInputs.forEach(t => {
      if (!t.resultEl) return;
      const result = tradeResultHTML(t.dir === 'long', t.e1Price, maxLossPerTrade, leverage, account, numTrades);
      t.resultEl.innerHTML = result.html;
      t.resultEl.hidden = false;
      if (!firstResult) firstResult = result;

      // Wire Pin button — only appears after successful calc
      const pinBtn = t.resultEl.querySelector('.fib-pin-btn');
      if (pinBtn) {
        pinBtn.addEventListener('click', () => {
          const c = result.calcResult;
          pinTrade({
            symbol:  t.pair,
            side:    t.dir,
            account, riskPct, leverage, slMode,
            tpPct:   5,
            e1: +c.e1.toFixed(5), e2: +c.e2.toFixed(5),
            e3: +c.e3.toFixed(5), e4: +c.e4.toFixed(5),
            sl: +c.sl.toFixed(5), wavg: +c.wavg.toFixed(5),
            tp: +c.tp.toFixed(5),
            capital: +c.totalCapital.toFixed(2),
            maxLoss: +c.maxLoss.toFixed(2),
            totalExposure: +c.totalExposure.toFixed(2),
            e1Cap: +c.e1Capital.toFixed(2), e2Cap: +c.e2Capital.toFixed(2),
            e3Cap: +c.e3Capital.toFixed(2), e4Cap: +c.e4Capital.toFixed(2),
            allocs: c.allocs.map(a => +a.toFixed(2)),
            exposures: c.exposures.map(e => +e.toFixed(2)),
          });
          pinBtn.textContent = 'Pinned ✓';
          pinBtn.disabled = true;
          setTimeout(() => { pinBtn.textContent = '⊕ Pin'; pinBtn.disabled = false; }, 2000);
        });
      }
    });
    if (!firstResult) return;

    // ── Account overview ───────────────────────────────────
    $('frRiskPct').textContent    = riskPct.toFixed(2) + '%';
    $('frSlMode').textContent     = slMode === 'conservative' ? 'Conservative 3.618%' : 'Aggressive 2.618%';
    $('frMaxLoss').textContent    = fmt(maxLoss);
    $('frMaxLossPer').textContent = fmt(maxLossPerTrade);
    $('frTradeCap').textContent   = fmt(firstResult.tradeCap) + (numTrades > 1 ? ` ×${numTrades}` : '');
    $('frTotalExp').textContent   = fmt(firstResult.totalExp) + (numTrades > 1 ? ` ×${numTrades}` : '');
    $('frLeverage').textContent   = leverage + '×';

    // ── Verification rows ──────────────────────────────────
    const totalRealLossBoth = firstResult.totalRealLoss * numTrades;
    const realLossPct       = (totalRealLossBoth / account) * 100;
    const lossMatchPass     = Math.abs(realLossPct - riskPct) < 0.01;
    const riskCapPass       = riskPct <= 50;

    const mkCheck = (pass, failNote) => pass
      ? '<span class="fib-check-ok">✓</span>'
      : `<span class="fib-check-fail">✗ ${failNote}</span>`;

    $('frActualLoss').textContent = fmt(totalRealLossBoth);
    $('frMaxAllowed').textContent = fmt(maxLoss);
    $('frRiskCheck').innerHTML    = mkCheck(riskCapPass, `${riskPct.toFixed(2)}% > 50%`);

    const badge   = $('frBadge');
    const allPass = lossMatchPass && riskCapPass;
    badge.textContent = allPass ? '✓ All Checks Passed' : '✗ Review Warnings Above';
    badge.className   = 'fib-verify-badge ' + (allPass ? 'pass' : 'fail');

    $('fibResults').hidden = false;
  });

  $('fcAccount').addEventListener('keydown', e => { if (e.key === 'Enter') $('fibCalcBtn').click(); });

  // ── Pinned trades panel toggle + initial render ────────
  $('fcPinsToggle').addEventListener('click', () => {
    const panel   = $('fcPinsPanel');
    const chevron = $('fcPinsChevron');
    const opening = panel.hidden;
    panel.hidden      = !opening;
    chevron.textContent = opening ? '▴' : '▾';
  });

  renderPinsPanel();
})();

/* ════════════════════════════════════════════════════════════
   POOL FUND DASHBOARD
   ════════════════════════════════════════════════════════════ */
(function initPool() {
  const $id = (id) => document.getElementById(id);
  // Sign goes outside the symbol: -$2,538.13, not $-2,538.13. Owner equity
  // and owner withdrawals are the only negatives here, and both matter.
  const fmt = (n) => {
    const v = Number(n);
    return (v < 0 ? '-$' : '$') +
      Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtTicker = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  // Average days per monthly return cycle — only used to pace the cosmetic
  // client-side "Returns Owed" ticker between refreshes. The real accrual is
  // computed server-side per anniversary month (see fund_pool.sync_ledger);
  // this constant never affects a stored value, only how fast the display
  // ticks up before the next reconciliation.
  const ACCRUAL_DAYS_IN_CYCLE = 30;

  // Flag a single contributor holding more than this share of the active pool
  const CONCENTRATION_WARNING_THRESHOLD_PCT = 50;

  // Status badge turns amber ("due in Nd") once this many days or fewer remain
  // until the next payout is due; above it, it's cyan ("on track, Nd left").
  // Reused as the overdue grace window: a past-due unpaid return only flips
  // the badge to red once it's been sitting unpaid for MORE than this many
  // days — a 1-2 day gap is normal processing lag, not delinquency, and
  // shouldn't mask the current cycle's own on-track/due-soon countdown.
  const DUE_SOON_WINDOW_DAYS = 7;

  // Whole days between two dates (accepts Date objects or ISO date strings)
  function daysBetween(a, b) {
    const MS_PER_DAY = 86400000;
    return Math.round((new Date(b) - new Date(a)) / MS_PER_DAY);
  }

  // Thin payout-cycle progress bar (days elapsed / days in cycle) — shown for
  // every active monthly row regardless of overdue status, since it tracks
  // the CURRENT cycle, separate from any older unpaid backlog.
  function renderCycleBar(c, todayIso) {
    if (!c.current_period_start || !c.next_due_date) return '';
    const cycleLen = Math.max(daysBetween(c.current_period_start, c.next_due_date), 1);
    const elapsed  = Math.min(Math.max(daysBetween(c.current_period_start, todayIso), 0), cycleLen);
    const pct = Math.round((elapsed / cycleLen) * 100);
    return `<div class="pool-cycle-bar" title="${elapsed} of ${cycleLen} days into this cycle">
      <div class="pool-cycle-bar-fill" style="width:${pct}%"></div>
    </div>`;
  }

  // Badge + payout-cycle progress bar for an active monthly contribution
  function renderMonthlyStatus(c) {
    const todayIso = new Date().toISOString().slice(0, 10);

    if (c.unpaid_ledger_id && c.oldest_unpaid_due_date) {
      const daysLate = daysBetween(c.oldest_unpaid_due_date, todayIso);
      if (daysLate > DUE_SOON_WINDOW_DAYS) {
        return `<div class="pool-status-cell">
          <span class="pool-status-overdue">Overdue</span>
          ${renderCycleBar(c, todayIso)}
        </div>`;
      }
    }

    if (!c.next_due_date) {
      return '<span class="pool-status-withdrawn">—</span>';
    }

    const daysLeft = daysBetween(todayIso, c.next_due_date);
    const dueSoon  = daysLeft <= DUE_SOON_WINDOW_DAYS;
    const badge = dueSoon
      ? `<span class="pool-status-duesoon">Due in ${Math.max(daysLeft, 0)}d</span>`
      : `<span class="pool-status-ontrack">On track, ${daysLeft}d left</span>`;

    return `<div class="pool-status-cell">${badge}${renderCycleBar(c, todayIso)}</div>`;
  }

  // ── State — persisted server-side via the /fund-pool endpoints ─────────
  let contributions  = [];   // rows from GET /fund-pool/contributions
  let summary        = null; // GET /fund-pool/summary
  let ownerSummary   = null; // GET /fund-pool/owner-summary
  let snapshots      = [];   // GET /fund-pool/equity-snapshots
  let composition    = null; // GET /fund-pool/equity-composition

  // Mirrors SNAPSHOT_STALE_DAYS in backend/fund_pool.py — used only for the
  // badge wording; the backend decides is_stale.
  const SNAPSHOT_STALE_DAYS = 7;
  let payoutType     = 'monthly';
  let expandedId     = null; // contribution id whose inline detail panel is open

  const fmtPct = (r) => (r * 100).toFixed(2) + '%';
  const fmtSignedPct = (r) => (r >= 0 ? '+' : '') + fmtPct(r);

  // ── Live "Returns Owed" ticker — cosmetic, reconciled on every load() ──
  let tickerValue        = 0;
  let tickerBase         = 0; // monthly_principal_base — the amount actively accruing
  let tickerRatePerSecond = 0;

  function reconcileTicker() {
    if (!summary) return;
    tickerValue = summary.returns_owed;
    tickerBase = summary.monthly_principal_base || 0;
    tickerRatePerSecond = (summary.monthly_return_rate || 0) / ACCRUAL_DAYS_IN_CYCLE / 86400;
  }

  setInterval(() => {
    if (!summary || $id('poolSummary').hidden) return;
    tickerValue += tickerBase * tickerRatePerSecond;
    $id('poolReturns').textContent = fmtTicker(tickerValue);
  }, 1000);

  // ── Growth chart — pool value trend vs a flat-APY savings benchmark ────
  let growthData  = null; // GET /fund-pool/growth
  let growthChart = null;

  function renderGrowthChart() {
    const wrap = $id('poolGrowthWrap');
    const points = growthData && growthData.points ? growthData.points : [];
    wrap.hidden = points.length < 2;
    if (points.length < 2) {
      if (growthChart) { growthChart.destroy(); growthChart = null; }
      return;
    }

    $id('poolBenchApy').textContent = ((growthData.savings_apy || 0) * 100).toFixed(1) + '%';

    const labels = points.map(p => new Date(p.date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    const poolValues  = points.map(p => p.pool_value);
    const benchValues = points.map(p => p.benchmark_value);
    // Index of the last non-projected point — segments after it render dashed
    const lastHistoricalIndex = points.reduce((acc, p, i) => (p.projected ? acc : i), 0);

    const theme = document.documentElement.getAttribute('data-theme');
    const poolColor  = theme === 'purple' ? '#00e5ff' : '#39ff14';
    const benchColor = theme === 'purple' ? '#c084fc' : '#8b949e';

    const ctx = $id('poolGrowthChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0,   poolColor + '33');
    gradient.addColorStop(1,   poolColor + '00');

    if (growthChart) growthChart.destroy();
    growthChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Pool Value',
            data: poolValues,
            borderColor: poolColor,
            backgroundColor: gradient,
            borderWidth: 2,
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            segment: {
              borderDash: (segCtx) => (segCtx.p0DataIndex >= lastHistoricalIndex ? [6, 4] : undefined),
            },
          },
          {
            label: 'Savings Benchmark',
            data: benchValues,
            borderColor: benchColor,
            borderDash: [4, 4],
            borderWidth: 1.5,
            fill: false,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (tCtx) => `${tCtx.dataset.label}: ${fmt(tCtx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
          y: { ticks: { callback: (v) => '$' + Number(v).toLocaleString('en-US') } },
        },
      },
    });
  }
  let expandedLedger = null; // ledger rows for expandedId (from /ledger)

  // ── Glassmorphic SVG Pie Chart ─────────────────────────────
  //
  // The ring plots CLAIM ON ACCOUNT EQUITY, not capital contributed:
  // each investor's slice is their compounded balance plus any cash return
  // accrued but unpaid, and the remainder of the account is mine. Slice
  // values and shares come from GET /fund-pool/equity-composition — the
  // frontend never recomputes them.
  //
  // The owner slice is always index 0 of composition.slices, so its position
  // and colour never shift as investors are added or removed, and it is
  // painted in the app accent rather than a rotation colour.

  // Neither the accent (#39ff14 in the default theme, reserved for the owner)
  // nor a yellow (reserved for the deficit wedge) appears early in this
  // rotation — an investor sharing a hue with either would read as if they
  // were that slice.
  const PIE_COLORS = [
    { h: '#00cfff', r: 0,   g: 207, b: 255 },
    { h: '#c77dff', r: 199, g: 125, b: 255 },
    { h: '#ff6b35', r: 255, g: 107, b: 53  },
    { h: '#06d6a0', r: 6,   g: 214, b: 160 },
    { h: '#ff85a1', r: 255, g: 133, b: 161 },
    { h: '#ef233c', r: 239, g: 35,  b: 60  },
    { h: '#f4a261', r: 244, g: 162, b: 97  },
    { h: '#457b9d', r: 69,  g: 123, b: 157 },
    { h: '#39ff14', r: 57,  g: 255, b: 20  },
  ];

  // Theme tokens resolve to different hexes per theme, so read them at
  // render time rather than hard-coding. The accent is reserved for the
  // owner slice and deliberately absent from PIE_COLORS above — in the
  // default theme they would both be #39ff14.
  function _themeColor(varName, fallback) {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim();
    return _hexToRgb(raw || fallback);
  }

  function _hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return { h: '#' + h, r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // Colour for slice i of the composition. The owner keeps the accent; the
  // deficit takes the warning colour; investors rotate independently of both
  // so their colours don't shift when the owner slice appears or vanishes.
  function _sliceColor(slice, investorIndex) {
    if (slice.is_owner) return _themeColor('--accent-primary', '#39ff14');
    if (slice.label === 'Deficit') return _themeColor('--yellow', '#ffd700');
    return PIE_COLORS[investorIndex % PIE_COLORS.length];
  }

  // SVG layout constants
  const PIE_CX = 150, PIE_CY = 150, PIE_R = 116, PIE_INNER = 64, PIE_GAP = 1.8;

  function _pxy(r, deg) {
    const rad = (deg - 90) * Math.PI / 180;
    return [(PIE_CX + r * Math.cos(rad)).toFixed(3), (PIE_CY + r * Math.sin(rad)).toFixed(3)];
  }

  function _arc(startDeg, endDeg) {
    const [ox1, oy1] = _pxy(PIE_R,     startDeg);
    const [ox2, oy2] = _pxy(PIE_R,     endDeg);
    const [ix1, iy1] = _pxy(PIE_INNER, startDeg);
    const [ix2, iy2] = _pxy(PIE_INNER, endDeg);
    const lg = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M${ox1},${oy1} A${PIE_R},${PIE_R},0,${lg},1,${ox2},${oy2} L${ix2},${iy2} A${PIE_INNER},${PIE_INNER},0,${lg},0,${ix1},${iy1}Z`;
  }

  // Floating tooltip (shared, created once)
  let _pieTip = null;
  function _ensureTip() {
    if (_pieTip) return;
    _pieTip = document.createElement('div');
    _pieTip.className = 'pie-tooltip';
    document.body.appendChild(_pieTip);
  }
  function _showTip(name, amt, pct, color) {
    _ensureTip();
    _pieTip.innerHTML =
      `<div class="pie-tip-name">${escHtml(name)}</div>` +
      `<div class="pie-tip-amt">${amt}</div>` +
      `<div class="pie-tip-pct" style="color:${color}">${pct}%</div>`;
    _pieTip.style.display = 'block';
  }
  function _moveTip(e) {
    if (!_pieTip) return;
    _pieTip.style.left = (e.clientX + 18) + 'px';
    _pieTip.style.top  = (e.clientY - 12) + 'px';
  }
  function _hideTip() { if (_pieTip) _pieTip.style.display = 'none'; }

  // Walk the slices assigning each one its colour, so the ring, the legend
  // and the tooltips can never disagree about which colour means what.
  function _decoratedSlices() {
    let investorIndex = 0;
    return (composition && composition.slices ? composition.slices : []).map(s => {
      const isDeficit = !s.is_owner && s.label === 'Deficit';
      const col = _sliceColor(s, investorIndex);
      if (!s.is_owner && !isDeficit) investorIndex += 1;
      return { ...s, col, isDeficit };
    });
  }

  function renderPieSVG() {
    const container = $id('poolPieContainer');
    const slices = _decoratedSlices();
    const deficit = composition && composition.mode === 'deficit';
    if (!slices.length) { container.innerHTML = ''; return; }

    let defs = `
      <filter id="pieShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.45)"/>
      </filter>
      <pattern id="deficitHatch" width="8" height="8" patternUnits="userSpaceOnUse"
               patternTransform="rotate(45)">
        <rect width="8" height="8" fill="rgba(0,0,0,0.35)"/>
        <line x1="0" y1="0" x2="0" y2="8" stroke-width="4"
              stroke="${_themeColor('--yellow', '#ffd700').h}" stroke-opacity="0.85"/>
      </pattern>`;
    let slicesHTML = '';
    let angle = 0;

    slices.forEach((s, i) => {
      const frac = s.share;
      const span = frac * 360 - PIE_GAP;
      if (span <= 0) { angle += frac * 360; return; }

      const start = angle + PIE_GAP / 2;
      const end   = start + span;
      const mid   = (start + end) / 2;
      const midRad = (mid - 90) * Math.PI / 180;
      // The deficit wedge sits further out than a hover offset ever goes —
      // it is not one claim among others, it is the part that isn't there.
      const push = s.isDeficit ? 16 : 10;
      const tx = (Math.cos(midRad) * push).toFixed(2);
      const ty = (Math.sin(midRad) * push).toFixed(2);
      const col = s.col;
      const d   = _arc(start, end);
      const delay = (i * 0.065).toFixed(3);

      defs += `
        <radialGradient id="pg${i}" cx="40%" cy="35%" r="68%" gradientUnits="objectBoundingBox">
          <stop offset="0%"   stop-color="rgba(${col.r},${col.g},${col.b},0.95)"/>
          <stop offset="100%" stop-color="rgba(${col.r},${col.g},${col.b},0.42)"/>
        </radialGradient>
        <linearGradient id="sh${i}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stop-color="rgba(255,255,255,0.38)"/>
          <stop offset="55%" stop-color="rgba(255,255,255,0)"/>
        </linearGradient>`;

      // Deficit renders hatched and permanently offset; owner gets a heavier
      // stroke so the accent reads as "mine" rather than another investor.
      const fill = s.isDeficit ? 'url(#deficitHatch)' : `url(#pg${i})`;
      const strokeW = s.is_owner ? 2.5 : 1.5;
      const offsetAttr = s.isDeficit ? ` transform="translate(${tx},${ty})"` : '';

      slicesHTML += `
        <g class="pie-group ${s.isDeficit ? 'pie-group-deficit' : ''}" data-i="${i}"
           data-tx="${tx}" data-ty="${ty}"${offsetAttr}
           style="animation-delay:${delay}s">
          <path d="${d}"
            fill="${fill}"
            stroke="rgba(${col.r},${col.g},${col.b},${s.isDeficit ? 1 : 0.75})"
            stroke-width="${strokeW}"
            ${s.isDeficit ? 'stroke-dasharray="6 3"' : ''}
            class="pie-slice"/>
          <path d="${d}" fill="url(#sh${i})" class="pie-sheen"/>
        </g>`;

      angle += frac * 360;
    });

    const equity = composition.account_equity;
    const centreValue = fmt(equity);
    const centreClass = deficit ? 'pie-cvalue pie-cvalue-deficit' : 'pie-cvalue';
    const labelClass  = deficit ? 'pie-clabel pie-clabel-deficit' : 'pie-clabel';
    const deficitLine = deficit
      ? `<text x="${PIE_CX}" y="${PIE_CY + 30}" text-anchor="middle" class="pie-cdeficit">${escHtml('-' + fmt(composition.deficit_amount).replace('-', ''))} deficit</text>`
      : '';

    container.innerHTML = `
      <svg viewBox="0 0 300 300" class="pool-pie-svg" xmlns="http://www.w3.org/2000/svg">
        <defs>${defs}</defs>
        <g filter="url(#pieShadow)">${slicesHTML}</g>
        <circle cx="${PIE_CX}" cy="${PIE_CY}" r="${PIE_INNER - 2}" class="pie-center"/>
        <text x="${PIE_CX}" y="${PIE_CY - (deficit ? 14 : 8)}" text-anchor="middle" class="${labelClass}">Account</text>
        <text x="${PIE_CX}" y="${PIE_CY + (deficit ? 7 : 13)}" text-anchor="middle" class="${centreClass}">${escHtml(centreValue)}</text>
        ${deficitLine}
      </svg>`;

    // Trigger fade-in after browser has painted (avoids opacity-0 stuck state)
    const groups = [...container.querySelectorAll('.pie-group')];
    requestAnimationFrame(() => {
      groups.forEach((g, idx) => {
        setTimeout(() => g.classList.add('pie-visible'), idx * 65);
      });
    });

    // Wire hover — use SVG transform attribute so units stay in SVG-space
    groups.forEach(g => {
      const i   = parseInt(g.dataset.i);
      const tx  = g.dataset.tx;   // already in SVG user units
      const ty  = g.dataset.ty;
      const s   = slices[i];
      const pct = (s.share * 100).toFixed(1);
      const amt = fmt(s.value);
      const name = s.is_owner ? 'My Equity' : s.label;

      g.addEventListener('mouseenter', () => {
        g.style.transform = `translate(${tx}px,${ty}px)`;
        _showTip(name, amt, pct, s.col.h);
      });
      g.addEventListener('mousemove', _moveTip);
      g.addEventListener('mouseleave', () => { g.style.transform = ''; _hideTip(); });
    });
  }

  function updatePieChart() {
    const wrap  = $id('poolChartWrap');
    const empty = $id('poolChartEmpty');
    const slices = _decoratedSlices();

    // Without a snapshot there is no denominator, so there is no honest ring
    // to draw. Show the prompt instead of inventing an account total.
    const noEquity = !composition || composition.mode === 'unknown';
    empty.hidden = !(noEquity && contributions.length > 0);
    wrap.hidden = noEquity || !slices.length;
    if (wrap.hidden) {
      $id('poolConcentrationWarning').hidden = true;
      return;
    }

    renderPieSVG();

    const deficit = composition.mode === 'deficit';
    $id('poolChartLegend').innerHTML = slices.map(s => {
      const pct = (s.share * 100).toFixed(1);
      const name = s.is_owner ? 'My Equity' : s.label;
      const cls = [
        'pool-legend-item',
        s.is_owner ? 'pool-legend-owner' : '',
        s.isDeficit ? 'pool-legend-deficit' : '',
      ].filter(Boolean).join(' ');
      return `<div class="${cls}" title="${escHtml(name)} — ${escHtml(fmt(s.value))}">
        <span class="pool-legend-swatch" style="background:${s.col.h};box-shadow:0 0 7px ${s.col.h}88"></span>
        <span class="pool-legend-name">${escHtml(name)}</span>
        <span class="pool-legend-value">${escHtml(fmt(s.value))}</span>
        <span class="pool-legend-pct">${pct}%</span>
      </div>`;
    }).join('');

    const note = $id('poolDeficitNote');
    note.hidden = !deficit;
    if (deficit) note.textContent = 'Liabilities exceed account equity';

    const stale = $id('poolStaleBadge');
    stale.hidden = !composition.is_stale;
    if (composition.is_stale) {
      stale.textContent = `⚠ Equity as of ${composition.snapshot_date} — over ${SNAPSHOT_STALE_DAYS} days old`;
    }

    // Concentration is about investor claims on the account, so the owner
    // slice and the deficit wedge are both excluded from the comparison.
    const investorSlices = slices.filter(s => !s.is_owner && !s.isDeficit);
    const investorTotal = investorSlices.reduce((sum, s) => sum + s.value, 0);
    const warningEl = $id('poolConcentrationWarning');
    const top = investorSlices.length
      ? investorSlices.reduce((best, s) => (s.value > best.value ? s : best), investorSlices[0])
      : null;
    const topPct = top && investorTotal > 0 ? (top.value / investorTotal * 100) : 0;
    if (top && topPct > CONCENTRATION_WARNING_THRESHOLD_PCT) {
      warningEl.hidden = false;
      warningEl.textContent = `⚠ Concentration risk: ${top.label} holds ${topPct.toFixed(1)}% of investor claims.`;
    } else {
      warningEl.hidden = true;
    }
  }

  // ── Owner equity ───────────────────────────────────────────
  // account_equity is whatever the last snapshot recorded; the liability is
  // live, so this tile shows what's mine RIGHT NOW — including returns that
  // have accrued since the snapshot was taken.
  function renderOwnerSummary() {
    const row = $id('poolOwnerSummary');
    row.hidden = !ownerSummary;
    const warn = $id('ownerEquityWarning');
    if (!ownerSummary) { warn.hidden = true; return; }

    const s = ownerSummary;

    $id('ownerAccountEquity').textContent = s.account_equity === null ? '—' : fmt(s.account_equity);
    // Staleness comes from the backend so the tile and the chart badge can
    // never disagree about what counts as stale.
    const dateEl = $id('ownerSnapshotDate');
    dateEl.textContent = s.snapshot_date
      ? (s.is_stale ? `⚠ as of ${s.snapshot_date} — over ${SNAPSHOT_STALE_DAYS} days old`
                    : `as of ${s.snapshot_date}`)
      : 'no snapshot yet — enter account equity above';
    dateEl.classList.toggle('pool-card-sub-stale', !!s.is_stale);

    $id('ownerLiability').textContent = fmt(s.total_liability);
    $id('ownerLiabilitySplit').textContent =
      `${fmt(s.investor_balance)} balance + ${fmt(s.returns_owed)} owed`;

    // A negative equity is never hidden or clamped — it is the whole point.
    const negative = s.owner_equity !== null && s.owner_equity < 0;
    const valueEl = $id('ownerEquity');
    valueEl.textContent = s.owner_equity === null ? '—' : fmt(s.owner_equity);
    valueEl.classList.toggle('pool-card-green', !negative);
    valueEl.classList.toggle('pool-card-negative', negative);
    $id('ownerEquityCard').classList.toggle('pool-card-danger', negative);

    $id('ownerBreakEven').textContent = s.break_even_account_return === null
      ? ''
      : `break-even: account must return ${fmtPct(s.break_even_account_return)} next month`;

    const growthEl = $id('ownerGrowth');
    growthEl.textContent = s.cumulative_return === null ? '—' : fmtSignedPct(s.cumulative_return);
    growthEl.classList.toggle('pool-card-green', s.cumulative_return !== null && s.cumulative_return >= 0);
    growthEl.classList.toggle('pool-card-negative', s.cumulative_return !== null && s.cumulative_return < 0);
    $id('ownerGrowthSub').textContent = s.period_return === null
      ? 'time-weighted, chained'
      : `${fmtSignedPct(s.period_return)} last period · time-weighted`;

    warn.hidden = !negative;
    if (negative) {
      warn.textContent =
        `⚠ Negative owner equity: the account holds ${fmt(s.account_equity)} against ` +
        `${fmt(s.total_liability)} owed to investors. You are short ` +
        `${fmt(Math.abs(s.owner_equity))} — every further 5% period widens the gap.`;
    }
  }

  function renderSnapshots() {
    const wrap = $id('poolSnapshotWrap');
    wrap.hidden = snapshots.length === 0;
    if (!snapshots.length) return;

    // Newest first reads better as history, even though the chain is computed
    // oldest-first server-side.
    $id('poolSnapshotBody').innerHTML = [...snapshots].reverse().map(s => {
      const negative = s.owner_equity_at < 0;
      const period = s.period_skipped
        ? '<span class="pool-status-withdrawn" title="Previous snapshot had no positive equity to measure from">skipped</span>'
        : s.period_return === null ? '—' : fmtSignedPct(s.period_return);
      const cumulative = s.cumulative_return === null ? '—' : fmtSignedPct(s.cumulative_return);
      const noteAttr = s.note ? ` title="${s.note.replace(/"/g, '&quot;')}"` : '';
      return `<tr${noteAttr}>
        <td>${s.snapshot_date}</td>
        <td>${fmt(s.account_equity)}</td>
        <td>${fmt(s.total_liability_at)}</td>
        <td class="${negative ? 'pool-card-negative' : ''}">${fmt(s.owner_equity_at)}</td>
        <td>${period}</td>
        <td>${cumulative}</td>
        <td><button class="btn btn-sm pool-action-btn" data-action="delete-snapshot" data-snapshot="${s.id}">Delete</button></td>
      </tr>`;
    }).join('');
  }

  // ── Render ─────────────────────────────────────────────────
  function render() {
    const tbody   = $id('poolTableBody');
    const hasData = contributions.length > 0;
    $id('poolSummary').hidden    = !hasData;
    $id('poolTableWrap').hidden  = !hasData;

    if (summary && hasData) {
      $id('poolTotal').textContent   = fmt(summary.total_pool);
      $id('poolReturns').textContent = fmt(summary.returns_owed);
      $id('poolAfter').textContent   = fmt(summary.investor_balance);
      $id('poolCount').textContent   = summary.contributors_count;
      $id('poolPaidOut').textContent = fmt(summary.total_paid_out);
      reconcileTicker();
    }

    renderOwnerSummary();
    renderSnapshots();

    tbody.innerHTML = contributions.map(c => {
      const isMonthly = c.payout_type === 'monthly';
      const active    = c.status === 'active';
      const isOwner   = c.investor_is_owner;

      // Owner rows are capital in/out, not an investment: they never accrue,
      // so the payout type and every accrual affordance are meaningless on
      // them. Capital out is recorded as a negative contribution, not a
      // Withdraw (which would write a payout ledger row).
      const typeBadge = isOwner
        ? '<span class="pool-type-badge type-owner">Owner</span>'
        : `<span class="pool-type-badge ${isMonthly ? 'type-monthly' : 'type-compound'}">${isMonthly ? 'Monthly' : 'Compound'}</span>`;

      const dueOrStatus = isOwner
        ? `<span class="pool-status-owner">${c.amount < 0 ? 'Capital out' : 'Capital in'}</span>`
        : !active
          ? '<span class="pool-status-withdrawn">Withdrawn</span>'
          : isMonthly
            ? renderMonthlyStatus(c)
            : '<span class="pool-status-compounding">Compounding</span>';

      // A compound-default contribution can still owe cash if individual
      // periods were flipped to 'paid' — show Mark Paid whenever cash is owed
      let action = '';
      if (!isOwner && c.unpaid_ledger_id) {
        action = `<button class="btn btn-sm pool-action-btn" data-action="mark-paid" data-ledger="${c.unpaid_ledger_id}">Mark Paid</button>`;
      }
      if (!isOwner && !isMonthly && active) {
        action += `<button class="btn btn-sm pool-action-btn pool-withdraw-btn" data-action="withdraw" data-id="${c.id}">Withdraw</button>`;
      }

      const expanded = expandedId === c.id;

      const mainRow = `
        <tr class="pool-row ${active ? '' : 'pool-row-closed'} ${expanded ? 'pool-row-expanded' : ''}" data-cid="${c.id}" title="Show payment details">
          <td class="pool-name-cell">
            <span class="pool-inv-link">
              <span class="pool-inv-caret ${expanded ? 'pool-inv-caret-open' : ''}">▸</span> ${escHtml(c.investor_name)}
            </span>
          </td>
          <td>${fmt(c.amount)}</td>
          <td>${escHtml(c.date_contributed)}</td>
          <td>${typeBadge}</td>
          <td>${c.months_elapsed}</td>
          <td class="pool-return-cell">${fmt(c.current_owed_or_balance)}</td>
          <td>${dueOrStatus}</td>
          <td>${action}</td>
        </tr>`;

      const detailRow = (expanded && expandedLedger) ? renderDetailRow(c, expandedLedger) : '';

      return mainRow + detailRow;
    }).join('');

    updatePieChart();
  }

  // ── Inline detail panel: contribution terms + full payment history ─
  function renderDetailRow(c, ledgerRows) {
    const isMonthly = c.payout_type === 'monthly';
    const editable  = c.status === 'active';

    const rowsHtml = ledgerRows.length ? ledgerRows.map(r => {
      const isCompound = r.period_action === 'compound';

      const balance = r.running_balance != null
        ? `${fmt(r.running_balance)} <span class="pool-balance-arrow">→</span> ${fmt(r.post_action_balance != null ? r.post_action_balance : r.running_balance)}`
        : '—';

      return `
        <tr data-ledger-row="${r.id}">
          <td>${escHtml(r.period_start)} – ${escHtml(r.period_end)}</td>
          <td><input class="input-field pool-edit-input pool-edit-amount" type="number" min="0" step="0.01" value="${r.amount}" /></td>
          <td>
            <select class="pool-action-select pool-edit-action">
              <option value="paid" ${isCompound ? '' : 'selected'}>Paid</option>
              <option value="compound" ${isCompound ? 'selected' : ''}>Compound</option>
            </select>
          </td>
          <td>
            <select class="pool-action-select pool-edit-status">
              <option value="unpaid" ${r.paid ? '' : 'selected'}>Owed</option>
              <option value="paid" ${r.paid ? 'selected' : ''}>Paid</option>
            </select>
          </td>
          <td><input class="input-field pool-edit-input pool-edit-date" type="date" value="${r.paid_date ? escHtml(r.paid_date.slice(0, 10)) : ''}" /></td>
          <td>
            <select class="pool-action-select pool-edit-method">
              <option value="">—</option>
              ${Object.entries(METHOD_LABELS).map(([val, label]) =>
                `<option value="${val}" ${r.payment_method === val ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </td>
          <td class="pool-balance-cell">${balance}</td>
          <td><button class="btn btn-sm pool-action-btn" data-ledger-save="${r.id}">Save</button></td>
        </tr>`;
    }).join('') : '<tr><td colspan="8" class="pool-ledger-empty-cell">No ledger entries yet.</td></tr>';

    return `
      <tr class="pool-detail-row" data-detail-for="${c.id}">
        <td colspan="8">
          <div class="pool-detail-panel">
            <div class="pool-detail-head">
              <span class="pool-detail-inv">${escHtml(c.investor_name)}</span>
              <span class="pool-type-badge ${isMonthly ? 'type-monthly' : 'type-compound'}">${isMonthly ? 'Monthly default' : 'Compound default'}</span>
              <span class="${c.status === 'active' ? 'pool-status-compounding' : 'pool-status-withdrawn'}">${c.status === 'active' ? 'Active' : 'Withdrawn'}</span>
              <button type="button" class="pool-inv-edit-link" data-inv-edit="${c.investor_id}">Edit contact</button>
            </div>

            ${editable ? `
            <div class="pool-detail-terms">
              <label>Principal ($)
                <input class="input-field" type="number" min="0" step="any" id="detAmount-${c.id}" value="${c.amount}" />
              </label>
              <label>Date Contributed
                <input class="input-field" type="date" id="detDate-${c.id}" value="${c.date_contributed}" />
              </label>
              <label>Default Payout
                <select class="input-field" id="detType-${c.id}">
                  <option value="monthly" ${isMonthly ? 'selected' : ''}>Monthly (pay out)</option>
                  <option value="compound" ${!isMonthly ? 'selected' : ''}>Compound (let it ride)</option>
                </select>
              </label>
              <button type="button" class="btn btn-primary btn-sm" data-save-terms="${c.id}">Save</button>
            </div>
            <div class="form-error pool-detail-error" data-detail-error="${c.id}" hidden></div>` : ''}

            <table class="pool-table pool-ledger-inline">
              <thead>
                <tr>
                  <th>Period</th><th>Return</th><th>Action</th><th>Status</th>
                  <th>Paid Date</th><th>Method</th><th>Balance (before → after)</th><th></th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </td>
      </tr>`;
  }

  // Fetch the ledger for a contribution and (re)render its detail panel open
  async function loadDetail(cid) {
    try {
      const detail = await apiFetch(`/fund-pool/contributions/${cid}/ledger`);
      expandedId     = cid;
      expandedLedger = detail.ledger;
    } catch (err) {
      showError(err.message);
    }
    render();
  }

  function toggleDetail(c) {
    if (expandedId === c.id) {
      expandedId = null;
      expandedLedger = null;
      render();
    } else {
      loadDetail(c.id);
    }
  }

  async function saveContributionTerms(cid) {
    const c = contributions.find(x => x.id === cid);
    const errEl = document.querySelector(`[data-detail-error="${cid}"]`);
    if (!c || !errEl) return;

    const amount = parseFloat($id(`detAmount-${cid}`).value);
    const dateIn = $id(`detDate-${cid}`).value;
    const type   = $id(`detType-${cid}`).value;
    if (!amount || amount <= 0 || !dateIn) {
      errEl.textContent = 'Enter a valid amount and date.';
      errEl.hidden = false;
      return;
    }

    const payload = {};
    if (amount !== c.amount)           payload.amount = amount;
    if (dateIn !== c.date_contributed) payload.date_contributed = dateIn;
    if (type !== c.payout_type)        payload.payout_type = type;
    if (!Object.keys(payload).length) return;

    // Only amount/date changes regenerate the unpaid ledger — that's the
    // destructive part worth confirming; a payout-type-only change just
    // sets the default for future periods.
    const needsRecompute = 'amount' in payload || 'date_contributed' in payload;
    if (needsRecompute && !confirm('This will recalculate unpaid returns going forward. Continue?')) return;

    errEl.hidden = true;
    try {
      await apiFetch(`/fund-pool/contributions/${cid}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      showToast('Contribution updated.', 'success');
      await load();
      await loadDetail(cid);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  function showError(msg) {
    const el = $id('poolError');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  // ── Load everything from the backend ───────────────────────
  async function load() {
    if (!getToken()) return;
    try {
      const [s, list, growth, owner, snaps, comp] = await Promise.all([
        apiFetch('/fund-pool/summary'),
        apiFetch('/fund-pool/contributions'),
        apiFetch('/fund-pool/growth'),
        apiFetch('/fund-pool/owner-summary'),
        apiFetch('/fund-pool/equity-snapshots'),
        apiFetch('/fund-pool/equity-composition'),
      ]);
      summary       = s;
      contributions = list;
      growthData    = growth;
      ownerSummary  = owner;
      snapshots     = snaps;
      composition   = comp;

      showError(null);
      poolSection().hidden = false;
      render();
      renderGrowthChart();
    } catch (err) {
      if (err.status === 403) { lockPool(); return; }   // not the pool owner: no pool UI, no pool data
      showError(err.message);
    }
  }

  // The backend is what enforces access (403 for everyone but the owner); this
  // only keeps the pool UI out of sight and drops anything already held in memory.
  function poolSection() { return document.querySelector('.pool-section'); }
  function lockPool() {
    summary = null; contributions = []; growthData = null; ownerSummary = null; snapshots = []; composition = null;
    const sec = poolSection();
    sec.hidden = true;
    sec.querySelectorAll('tbody').forEach(t => { t.innerHTML = ''; });
    sec.querySelectorAll('[id^="pool"]').forEach(el => { if (!el.matches('input,select,button,textarea')) el.textContent = ''; });
    showError(null);
  }
  // refreshAll() calls this after login / on refresh
  window.refreshPool = load;

  // ── Add contribution (get-or-create investor, then contribution) ──
  $id('poolAddBtn').addEventListener('click', async () => {
    const name   = $id('poolName').value.trim();
    const amount = parseFloat($id('poolAmt').value);
    const dateIn = $id('poolDate').value;
    if (!name || !amount || amount <= 0 || !dateIn) return;

    const btn = $id('poolAddBtn');
    btn.disabled = true;
    try {
      const investor = await apiFetch('/fund-pool/investors', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      await apiFetch('/fund-pool/contributions', {
        method: 'POST',
        body: JSON.stringify({
          investor_id: investor.id,
          amount,
          date_contributed: dateIn,
          payout_type: payoutType,
        }),
      });
      $id('poolName').value = '';
      $id('poolAmt').value  = '';
      $id('poolName').focus();
      await load();
    } catch (err) {
      showError(err.message);
    }
    btn.disabled = false;
  });

  // Enter key in inputs
  [$id('poolName'), $id('poolAmt')].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') $id('poolAddBtn').click(); });
  });

  // ── Payout type toggle ─────────────────────────────────────
  $id('poolTypeToggle').addEventListener('click', e => {
    const btn = e.target.closest('.pool-type-btn');
    if (!btn) return;
    payoutType = btn.dataset.type;
    $id('poolTypeToggle').querySelectorAll('.pool-type-btn').forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
  });

  // Default the date picker to today (local time)
  $id('poolDate').value = new Date().toLocaleDateString('en-CA');
  $id('poolEquityDate').value = new Date().toLocaleDateString('en-CA');

  /* ── Modals: payment method / edit investor ─────────────────
        (contribution terms + payment history now live inline —
        see renderDetailRow / toggleDetail above) ────────────── */

  const METHOD_LABELS = {
    bank_transfer: 'Bank Transfer', crypto: 'Crypto', cash: 'Cash', other: 'Other',
  };

  function openModal(id)  { $id(id).hidden = false; }
  function closeModal(id) { $id(id).hidden = true; }

  // Close on backdrop click / ✕ / Cancel, for both remaining pool modals
  [
    ['poolInvBackdrop', ['poolInvClose', 'poolInvCancel']],
    ['poolPayBackdrop', ['poolPayClose', 'poolPayCancel']],
  ].forEach(([backdrop, buttons]) => {
    $id(backdrop).addEventListener('click', e => { if (e.target === $id(backdrop)) closeModal(backdrop); });
    buttons.forEach(b => $id(b).addEventListener('click', () => closeModal(backdrop)));
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    ['poolPayBackdrop', 'poolInvBackdrop'].forEach(id => {
      if (!$id(id).hidden) closeModal(id);
    });
  });

  // ── Payment method modal (serves both Mark Paid and Withdraw) ──
  let payCtx = null; // { mode, ledgerId?, contributionId?, overrideAction? }

  function openPayModal(ctx) {
    payCtx = ctx;
    $id('poolPayMethod').value = '';
    $id('poolPayError').hidden = true;
    if (ctx.mode === 'withdraw') {
      const c = contributions.find(x => x.id === ctx.contributionId);
      const gain = c ? fmt(c.current_owed_or_balance - c.amount) : 'the accrued return';
      $id('poolPayTitle').textContent = 'Withdraw Contribution';
      $id('poolPayMsg').textContent   = `This pays out ${gain} on top of the principal and closes the contribution.`;
      $id('poolPayConfirm').textContent = 'Withdraw';
    } else {
      $id('poolPayTitle').textContent = 'Mark as Paid';
      $id('poolPayMsg').textContent   = ctx.overrideAction
        ? 'This period is set to compound — paying it out in cash recalculates all future unpaid periods.'
        : 'Record this return as paid out to the investor.';
      $id('poolPayConfirm').textContent = 'Confirm';
    }
    openModal('poolPayBackdrop');
  }

  $id('poolPayConfirm').addEventListener('click', async () => {
    const method = $id('poolPayMethod').value;
    if (!method) {
      $id('poolPayError').textContent = 'Please select a payment method.';
      $id('poolPayError').hidden = false;
      return;
    }
    const btn = $id('poolPayConfirm');
    btn.disabled = true;
    try {
      const payload = { payment_method: method };
      if (payCtx.overrideAction) payload.period_action = 'paid';
      const body = JSON.stringify(payload);
      if (payCtx.mode === 'withdraw') {
        await apiFetch(`/fund-pool/contributions/${payCtx.contributionId}/withdraw`, { method: 'POST', body });
      } else {
        await apiFetch(`/fund-pool/ledger/${payCtx.ledgerId}/mark-paid`, { method: 'PATCH', body });
      }
      closeModal('poolPayBackdrop');
      showToast(payCtx.mode === 'withdraw' ? 'Contribution withdrawn.' : 'Payment recorded.', 'success');
      await load();
      if (expandedId) await loadDetail(expandedId);
    } catch (err) {
      $id('poolPayError').textContent = err.message;
      $id('poolPayError').hidden = false;
    }
    btn.disabled = false;
  });

  // ── Edit investor modal ─────────────────────────────────────
  // (contribution terms are edited inline — see saveContributionTerms)
  let invId = null;

  function openInvModal(c) {
    invId = c.investor_id;
    $id('piName').value    = c.investor_name;
    $id('piContact').value = c.investor_contact || '';
    $id('poolInvError').hidden = true;
    openModal('poolInvBackdrop');
  }

  $id('poolInvForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $id('piName').value.trim();
    if (!name) {
      $id('poolInvError').textContent = 'Name is required.';
      $id('poolInvError').hidden = false;
      return;
    }
    const btn = $id('poolInvSave');
    btn.disabled = true;
    try {
      await apiFetch(`/fund-pool/investors/${invId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, contact: $id('piContact').value.trim() || null }),
      });
      closeModal('poolInvBackdrop');
      showToast('Investor updated.', 'success');
      await load();
    } catch (err) {
      $id('poolInvError').textContent = err.message;
      $id('poolInvError').hidden = false;
    }
    btn.disabled = false;
  });

  // ── Table interactions: quick actions, investor toggle, inline panel ──
  // ── Equity snapshot: record the account value, freeze the liability ──
  $id('poolSnapshotBtn').addEventListener('click', async () => {
    const raw  = $id('poolEquityAmt').value;
    const date = $id('poolEquityDate').value;
    const note = $id('poolEquityNote').value.trim();
    const equity = parseFloat(raw);
    if (raw === '' || Number.isNaN(equity) || !date) {
      showError('Enter an account equity value and a snapshot date.');
      return;
    }

    const btn = $id('poolSnapshotBtn');
    btn.disabled = true;
    try {
      await apiFetch('/fund-pool/equity-snapshots', {
        method: 'POST',
        body: JSON.stringify({
          snapshot_date: date,
          account_equity: equity,
          note: note || null,
        }),
      });
      $id('poolEquityAmt').value  = '';
      $id('poolEquityNote').value = '';
      showError(null);
      await load();
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $id('poolSnapshotBody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="delete-snapshot"]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await apiFetch(`/fund-pool/equity-snapshots/${btn.dataset.snapshot}`, { method: 'DELETE' });
      showError(null);
      await load();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
    }
  });

  $id('poolTableBody').addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      if (actionBtn.dataset.action === 'mark-paid') {
        openPayModal({ mode: 'mark-paid', ledgerId: parseInt(actionBtn.dataset.ledger) });
      } else {
        openPayModal({ mode: 'withdraw', contributionId: parseInt(actionBtn.dataset.id) });
      }
      return;
    }

    // Clicking anywhere on a contribution row (outside the quick-action
    // buttons handled above) toggles its inline terms + payment-history panel
    const row = e.target.closest('.pool-row');
    if (row) {
      const c = contributions.find(x => x.id === parseInt(row.dataset.cid));
      if (c) toggleDetail(c);
      return;
    }

    // "Edit contact" link inside the panel — name/contact only, separate
    // from the contribution terms since one investor can have many contributions
    const invEditBtn = e.target.closest('[data-inv-edit]');
    if (invEditBtn) {
      const c = contributions.find(x => x.investor_id === parseInt(invEditBtn.dataset.invEdit));
      if (c) openInvModal(c);
      return;
    }

    const saveBtn = e.target.closest('[data-save-terms]');
    if (saveBtn) saveContributionTerms(parseInt(saveBtn.dataset.saveTerms));

    // Save an edited ledger row (amount / action / status / paid date / method)
    const ledgerSaveBtn = e.target.closest('[data-ledger-save]');
    if (ledgerSaveBtn) saveLedgerRow(parseInt(ledgerSaveBtn.dataset.ledgerSave), ledgerSaveBtn);
  });

  async function saveLedgerRow(ledgerId, btn) {
    const tr = btn.closest('tr[data-ledger-row]');
    const amount = parseFloat(tr.querySelector('.pool-edit-amount').value);
    const action = tr.querySelector('.pool-edit-action').value;
    const paid   = tr.querySelector('.pool-edit-status').value === 'paid';
    const dateVal   = tr.querySelector('.pool-edit-date').value;
    const method    = tr.querySelector('.pool-edit-method').value;

    if (isNaN(amount) || amount < 0) {
      showToast('Enter a valid amount.', 'error');
      return;
    }
    if (paid && !method) {
      showToast('Select a payment method for a paid entry.', 'error');
      return;
    }
    if (!confirm('Save this ledger entry? This may recalculate later periods.')) return;

    btn.disabled = true;
    try {
      await apiFetch(`/fund-pool/ledger/${ledgerId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          amount,
          period_action: action,
          paid,
          paid_date: dateVal ? `${dateVal}T00:00:00` : null,
          payment_method: method || null,
        }),
      });
      showToast('Ledger entry updated.', 'success');
      await load();
      if (expandedId) await loadDetail(expandedId);
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
    }
  }

  // ── Toggle section ─────────────────────────────────────────
  $id('poolToggleBtn').addEventListener('click', () => {
    const body = $id('poolBody');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    $id('poolToggleBtn').textContent = hidden ? 'Hide' : 'Show';
  });
})();

/* ════════════════════════════════════════════════════════════
   MOBILE — FIB CALCULATOR DRAWER
   ════════════════════════════════════════════════════════════ */
(function initCalcDrawer() {
  const calc     = document.getElementById('fibCalc');
  const backdrop = document.getElementById('fibBackdrop');
  const notch    = document.getElementById('fibNotch');
  const closeBtn = document.getElementById('fibCloseBtn');

  function openCalc() {
    calc?.classList.add('calc-open');
    backdrop?.classList.add('active');
    notch?.classList.add('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeCalc() {
    calc?.classList.remove('calc-open');
    backdrop?.classList.remove('active');
    notch?.classList.remove('hidden');
    document.body.style.overflow = '';
  }

  notch?.addEventListener('click', openCalc);
  closeBtn?.addEventListener('click', closeCalc);
  backdrop?.addEventListener('click', closeCalc);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && calc?.classList.contains('calc-open')) {
      e.stopPropagation();
      closeCalc();
    }
  });

  // Restore on resize to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeCalc();
  });
})();

/* ════════════════════════════════════════════════════════════
   ADVANCE CALCULATOR — multi-strategy entry cascade simulator

   A left-edge drawer holding up to three independently configured entry
   strategies, all sharing one set of global inputs, compared on one price
   ladder and one table.

   Four modes per slot — Fibonacci, Custom %, Manual Price, Monte Carlo —
   differ ONLY in how they produce {price, weight}[] plus a stop price.
   Everything downstream (Wavg, capital, qty, TP, R:R) runs through the
   single engine in computeStrategy, so a mode can never quietly grow its
   own arithmetic.

   Input handling note: number fields are NOT bound to parseFloat on every
   keystroke. "", "-", "0." and "1e" all parse to NaN mid-typing, and
   writing that back into a controlled input freezes the field. Instead each
   input owns its live text, commits to state only when the parse is finite,
   and restores the last good value on blur. renderSlots() rebuilds inputs;
   recompute() only ever touches OUTPUT nodes, so typing never re-renders
   the field under the cursor.
   ════════════════════════════════════════════════════════════ */
(function initAdvCalcDrawer() {
  const $ = (id) => document.getElementById(id);
  const calc     = $('advCalc');
  const backdrop = $('advBackdrop');
  const notch    = $('advNotch');
  const closeBtn = $('advCloseBtn');
  if (!calc) return;

  // ── Drawer open/close — mirrors initCalcDrawer for the adv- elements ──
  function openAdv() {
    calc.classList.add('calc-open');
    backdrop?.classList.add('active');
    notch?.classList.add('hidden');
    document.body.style.overflow = 'hidden';
    render();
  }

  function closeAdv() {
    calc.classList.remove('calc-open');
    backdrop?.classList.remove('active');
    notch?.classList.remove('hidden');
    document.body.style.overflow = '';
  }

  notch?.addEventListener('click', openAdv);
  closeBtn?.addEventListener('click', closeAdv);
  backdrop?.addEventListener('click', closeAdv);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && calc.classList.contains('calc-open')) {
      e.stopPropagation();
      closeAdv();
    }
  });

  // Unlike the Fib panel this one is an overlay at every width, so a resize
  // to desktop still closes it rather than reflowing into a sidebar.
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeAdv();
  });

  // ── Constants ────────────────────────────────────────────────────────
  // Fibonacci cascade: each step is a percentage BEYOND the previous entry.
  const FIB_STEPS = [0.01618, 0.03618, 0.04236];
  const FIB_WEIGHTS = [5, 10, 20, 65];
  // Back-weighted defaults for the shorter cascades Custom/Manual/MC allow.
  const DEFAULT_WEIGHTS = { 2: [25, 75], 3: [10, 25, 65], 4: [5, 10, 20, 65] };
  const SL_AGGRESSIVE = 2.618;
  const SL_CONSERVATIVE = 3.618;
  const MODES = [
    { key: 'fib',    label: 'Fibonacci' },
    { key: 'custom', label: 'Custom %' },
    { key: 'manual', label: 'Manual Price' },
    { key: 'monte',  label: 'Monte Carlo' },
  ];
  const MODE_LABEL = Object.fromEntries(MODES.map(m => [m.key, m.label]));

  function accentColor() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-primary').trim() || '#39ff14';
  }
  // Slot A takes the theme accent; B and C are fixed hues that stay legible
  // against all three themes.
  const slotColor = (i) => [accentColor(), '#00cfff', '#c77dff'][i] || '#c77dff';

  // ── State ────────────────────────────────────────────────────────────
  const state = {
    account: 4400,
    riskPct: 16,
    leverage: 6,
    direction: 'short',
    e1: 0.09554,
    slots: [
      makeSlot('fib', true),
      makeSlot('custom', false),
      makeSlot('monte', false),
    ],
  };

  function makeSlot(mode, enabled) {
    return {
      enabled,
      mode,
      fib:    { slMode: 'aggressive' },
      // x100 lands on 1.6179999999999999 in binary floating point; round so the
      // field shows 1.618 rather than a wall of noise the moment it opens.
      custom: { count: 4, steps: FIB_STEPS.map(s => +(s * 100).toFixed(6)), weights: [...FIB_WEIGHTS], slOffset: SL_AGGRESSIVE },
      manual: { count: 4, prices: [], weights: [...FIB_WEIGHTS], slPrice: null },
      monte:  { count: 4, stepMin: 1.0, stepMax: 5.0, weightMode: 'fixed', slOffset: SL_AGGRESSIVE, sims: 300 },
    };
  }

  // ── Calculation engine (mode-agnostic) ───────────────────────────────

  /** Cascade from E1. Long steps DOWN into the move, short steps UP. */
  function cascade(e1, direction, stepFractions) {
    const sign = direction === 'long' ? -1 : 1;
    const out = [e1];
    let p = e1;
    for (const s of stepFractions) { p = p * (1 + sign * s); out.push(p); }
    return out;
  }

  /** Stop placed `offsetPct` BEYOND the last entry, on the losing side. */
  function slFromOffset(lastEntry, direction, offsetPct) {
    const sign = direction === 'long' ? -1 : 1;
    return lastEntry * (1 + sign * offsetPct / 100);
  }

  /**
   * The one place position maths happens.
   *
   * Wavg is the harmonic mean of entry prices weighted by allocation — the
   * price a single lump-sum entry of the same capital would have paid.
   *
   * Note Σ(wᵢ·|pᵢ−SL|/pᵢ) reduces exactly to |SL−Wavg|/Wavg, so capital is
   * equivalently maxLoss / (leverage × distance-to-stop-from-Wavg). The
   * per-entry form is kept because it is the one that stays correct if
   * weights ever stop summing to 100.
   *
   * Returns null when any input is non-finite or non-positive — callers
   * surface that as an inline message rather than letting NaN spread.
   */
  function computeStrategy({ entries, slPrice, accountSize, riskPct, leverage, direction }) {
    if (!Array.isArray(entries) || entries.length < 2) return null;
    if (!Number.isFinite(slPrice) || slPrice <= 0) return null;
    if (!Number.isFinite(accountSize) || accountSize <= 0) return null;
    if (!Number.isFinite(riskPct) || riskPct <= 0) return null;
    if (!Number.isFinite(leverage) || leverage <= 0) return null;
    for (const e of entries) {
      if (!Number.isFinite(e.price) || e.price <= 0) return null;
      if (!Number.isFinite(e.weight)) return null;
    }

    const invSum = entries.reduce((s, e) => s + (e.weight / 100) / e.price, 0);
    if (!Number.isFinite(invSum) || invSum <= 0) return null;
    const wavg = 1 / invSum;

    const maxLoss = accountSize * riskPct / 100;
    const lossUnit = entries.reduce(
      (s, e) => s + (e.weight / 100) * Math.abs(e.price - slPrice) / e.price, 0);
    if (!Number.isFinite(lossUnit) || lossUnit <= 0) return null;

    const capital = maxLoss / (leverage * lossUnit);
    const qty = capital * leverage / wavg;

    const e1 = entries[0].price;
    const candidate = wavg * (direction === 'long' ? 1.05 : 0.95);
    const tp = direction === 'long'
      ? ((e1 > wavg && e1 < candidate) ? e1 : candidate)
      : ((e1 < wavg && e1 > candidate) ? e1 : candidate);

    const rr = (Math.abs(tp - wavg) / wavg * 100) / riskPct;
    if (![wavg, capital, qty, tp, rr].every(Number.isFinite)) return null;
    return { wavg, maxLoss, capital, qty, tp, rr, slPrice, entries };
  }

  // ── Deterministic PRNG ───────────────────────────────────────────────
  // Monte Carlo re-runs on every keystroke; an unseeded Math.random would
  // make the histogram jump around while the user is only editing a label's
  // worth of digits. Seeding from the slot config keeps a given
  // configuration reproducible and only re-rolls when something changes.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ── Mode → entries resolution ────────────────────────────────────────

  /** Build {entries, slPrice} for a slot, or {error} if it can't be formed. */
  function resolveSlot(slot) {
    const { e1, direction } = state;
    if (!Number.isFinite(e1) || e1 <= 0) return { error: 'Set a positive E1 price.' };

    if (slot.mode === 'fib') {
      const prices = cascade(e1, direction, FIB_STEPS);
      const offset = slot.fib.slMode === 'aggressive' ? SL_AGGRESSIVE : SL_CONSERVATIVE;
      return {
        entries: prices.map((price, i) => ({ price, weight: FIB_WEIGHTS[i] })),
        slPrice: slFromOffset(prices[prices.length - 1], direction, offset),
      };
    }

    if (slot.mode === 'custom') {
      const c = slot.custom;
      const steps = c.steps.slice(0, c.count - 1).map(v => v / 100);
      if (steps.some(v => !Number.isFinite(v))) return { error: 'Check your inputs — step %.' };
      const prices = cascade(e1, direction, steps);
      const weights = c.weights.slice(0, c.count);
      if (weights.some(v => !Number.isFinite(v))) return { error: 'Check your inputs — weights.' };
      if (!Number.isFinite(c.slOffset)) return { error: 'Check your inputs — SL offset.' };
      return {
        entries: prices.map((price, i) => ({ price, weight: weights[i] })),
        slPrice: slFromOffset(prices[prices.length - 1], direction, c.slOffset),
      };
    }

    if (slot.mode === 'manual') {
      const m = slot.manual;
      const prices = m.prices.slice(0, m.count);
      if (prices.length < m.count || prices.some(v => !Number.isFinite(v) || v <= 0)) {
        return { error: 'Check your inputs — every entry needs a price.' };
      }
      const weights = m.weights.slice(0, m.count);
      if (weights.some(v => !Number.isFinite(v))) return { error: 'Check your inputs — weights.' };
      if (!Number.isFinite(m.slPrice) || m.slPrice <= 0) return { error: 'Check your inputs — SL price.' };
      return {
        entries: prices.map((price, i) => ({ price, weight: weights[i] })),
        slPrice: m.slPrice,
      };
    }

    // Monte Carlo — the median run stands in for the slot on the ladder.
    const mc = runMonteCarlo(slot);
    if (mc.error) return { error: mc.error };
    return { entries: mc.median.entries, slPrice: mc.median.slPrice, monte: mc };
  }

  /** Default cascade prices for a given entry count — Manual's starting point. */
  function defaultCascadePrices(count) {
    return cascade(state.e1, state.direction, FIB_STEPS.slice(0, count - 1));
  }

  // ── Monte Carlo ──────────────────────────────────────────────────────
  function runMonteCarlo(slot) {
    const mc = slot.monte;
    const { e1, direction, account, riskPct, leverage } = state;
    if (![mc.stepMin, mc.stepMax, mc.slOffset].every(Number.isFinite)) {
      return { error: 'Check your inputs — step band or SL offset.' };
    }
    if (mc.stepMax < mc.stepMin) return { error: 'Step band max is below min.' };

    const sims = Math.max(1, Math.round(mc.sims));
    const rand = mulberry32(hashSeed(JSON.stringify([
      mc.count, mc.stepMin, mc.stepMax, mc.weightMode, mc.slOffset, sims,
      e1, direction, account, riskPct, leverage,
    ])));

    const runs = [];
    for (let n = 0; n < sims; n++) {
      const steps = [];
      for (let i = 0; i < mc.count - 1; i++) {
        steps.push((mc.stepMin + rand() * (mc.stepMax - mc.stepMin)) / 100);
      }
      let weights;
      if (mc.weightMode === 'random') {
        const raw = Array.from({ length: mc.count }, () => rand() + 0.02);
        const total = raw.reduce((a, b) => a + b, 0);
        weights = raw.map(v => v / total * 100);   // normalised to 100
      } else {
        weights = [...(DEFAULT_WEIGHTS[mc.count] || DEFAULT_WEIGHTS[4])];
      }
      const prices = cascade(e1, direction, steps);
      const slPrice = slFromOffset(prices[prices.length - 1], direction, mc.slOffset);
      const res = computeStrategy({
        entries: prices.map((price, i) => ({ price, weight: weights[i] })),
        slPrice, accountSize: account, riskPct, leverage, direction,
      });
      if (res) runs.push(res);
    }

    if (!runs.length) return { error: 'Check your inputs — no run produced a result.' };

    const sorted = [...runs].sort((a, b) => a.wavg - b.wavg);
    const median = sorted[Math.floor(sorted.length / 2)];
    const wavgs = runs.map(r => r.wavg);
    const mean = wavgs.reduce((a, b) => a + b, 0) / wavgs.length;
    const variance = wavgs.reduce((s, v) => s + (v - mean) ** 2, 0) / wavgs.length;
    return {
      runs, median, wavgs,
      stats: { mean, std: Math.sqrt(variance), min: Math.min(...wavgs), max: Math.max(...wavgs), n: runs.length },
    };
  }

  // ── Formatting ───────────────────────────────────────────────────────
  const price = (v) => Number.isFinite(v) ? v.toPrecision(6).replace(/\.?0+$/, '') : '—';
  const money = (v) => Number.isFinite(v)
    ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
  const qtyFmt = (v) => Number.isFinite(v)
    ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
  const num = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '—';

  // ── Robust number-input binding ──────────────────────────────────────
  /**
   * Commit only finite parses; leave partial text ("", "-", "0.") alone so
   * the field never fights the person typing into it. On blur, an
   * still-unparseable field falls back to the last committed value.
   */
  function bindNum(el, get, set, { onCommit = recompute } = {}) {
    el.value = get() === null || get() === undefined ? '' : String(get());
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (Number.isFinite(v)) { set(v); onCommit(); }
    });
    el.addEventListener('blur', () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) {
        const last = get();
        el.value = last === null || last === undefined ? '' : String(last);
        onCommit();
      }
    });
  }

  // ── Slot rendering ───────────────────────────────────────────────────
  function renderSlots() {
    const host = $('advSlots');
    host.innerHTML = '';
    state.slots.forEach((slot, idx) => {
      const card = document.createElement('div');
      card.className = 'adv-slot' + (slot.enabled ? '' : ' adv-slot-off');

      const head = document.createElement('div');
      head.className = 'adv-slot-head';
      head.innerHTML =
        `<span class="adv-slot-dot" style="background:${slotColor(idx)}"></span>` +
        `<span class="adv-slot-name">Strategy ${'ABC'[idx]}</span>`;
      const onBtn = document.createElement('button');
      onBtn.type = 'button';
      onBtn.className = 'adv-slot-toggle';
      onBtn.textContent = slot.enabled ? 'On' : 'Off';
      onBtn.addEventListener('click', () => {
        slot.enabled = !slot.enabled;
        renderSlots(); recompute();
      });
      head.appendChild(onBtn);
      card.appendChild(head);

      // 4-way mode toggle
      const modeGroup = document.createElement('div');
      modeGroup.className = 'fib-toggle-group adv-mode-group';
      MODES.forEach(m => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fib-toggle' + (slot.mode === m.key ? ' active' : '');
        b.textContent = m.label;
        b.addEventListener('click', () => {
          slot.mode = m.key;
          if (m.key === 'manual' && !slot.manual.prices.length) resetManual(slot);
          renderSlots(); recompute();
        });
        modeGroup.appendChild(b);
      });
      card.appendChild(modeGroup);

      const body = document.createElement('div');
      body.className = 'adv-slot-fields';
      card.appendChild(body);
      renderSlotFields(slot, idx, body);

      const warn = document.createElement('div');
      warn.className = 'adv-warn';
      warn.id = `advWarn${idx}`;
      warn.hidden = true;
      card.appendChild(warn);

      const out = document.createElement('div');
      out.id = `advOut${idx}`;
      card.appendChild(out);

      host.appendChild(card);
    });
  }

  function countRow(slot, cfgKey, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'fib-field';
    wrap.innerHTML = '<label class="fib-label">Entries</label>';
    const group = document.createElement('div');
    group.className = 'fib-toggle-group';
    [2, 3, 4].forEach(n => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fib-toggle' + (slot[cfgKey].count === n ? ' active' : '');
      b.textContent = String(n);
      b.addEventListener('click', () => {
        slot[cfgKey].count = n;
        slot[cfgKey].weights = [...(DEFAULT_WEIGHTS[n] || DEFAULT_WEIGHTS[4])];
        if (onChange) onChange();
        renderSlots(); recompute();
      });
      group.appendChild(b);
    });
    wrap.appendChild(group);
    return wrap;
  }

  function miniInput(value, onSet, placeholder) {
    const el = document.createElement('input');
    el.type = 'number';
    el.step = 'any';
    el.className = 'adv-mini-input';
    if (placeholder) el.placeholder = placeholder;
    bindNum(el, () => value(), onSet);
    return el;
  }

  function labelledPair(a, b) {
    const head = document.createElement('div');
    head.className = 'adv-mini-head';
    head.innerHTML = `<span></span><span class="adv-mini-label">${a}</span><span class="adv-mini-label">${b}</span>`;
    return head;
  }

  function resetManual(slot) {
    const prices = defaultCascadePrices(slot.manual.count);
    slot.manual.prices = prices.map(p => +p.toPrecision(8));
    slot.manual.weights = [...(DEFAULT_WEIGHTS[slot.manual.count] || DEFAULT_WEIGHTS[4])];
    const last = prices[prices.length - 1];
    slot.manual.slPrice = +slFromOffset(last, state.direction, SL_AGGRESSIVE).toPrecision(8);
  }

  function renderSlotFields(slot, idx, host) {
    if (slot.mode === 'fib') {
      const f = document.createElement('div');
      f.className = 'fib-field';
      f.innerHTML = '<label class="fib-label">Stop Loss Mode</label>';
      const g = document.createElement('div');
      g.className = 'fib-toggle-group';
      [['conservative', 'Conservative 3.618%'], ['aggressive', 'Aggressive 2.618%']].forEach(([k, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fib-toggle' + (slot.fib.slMode === k ? ' active' : '');
        b.textContent = lbl;
        b.addEventListener('click', () => { slot.fib.slMode = k; renderSlots(); recompute(); });
        g.appendChild(b);
      });
      f.appendChild(g);
      host.appendChild(f);
      const note = document.createElement('div');
      note.className = 'adv-mini-label';
      note.textContent = 'Fixed cascade 1.618 / 3.618 / 4.236% · weights 5/10/20/65';
      host.appendChild(note);
      return;
    }

    if (slot.mode === 'custom') {
      const c = slot.custom;
      host.appendChild(countRow(slot, 'custom'));
      host.appendChild(labelledPair('Step % vs prev', 'Weight %'));
      for (let i = 0; i < c.count; i++) {
        const row = document.createElement('div');
        row.className = 'adv-entry-row';
        row.innerHTML = `<span class="adv-entry-tag">E${i + 1}</span>`;
        if (i === 0) {
          const dash = document.createElement('span');
          dash.className = 'adv-mini-label';
          dash.textContent = 'E1 (base)';
          row.appendChild(dash);
        } else {
          row.appendChild(miniInput(
            () => c.steps[i - 1], v => { c.steps[i - 1] = v; }, 'step %'));
        }
        row.appendChild(miniInput(
          () => c.weights[i], v => { c.weights[i] = v; }, 'weight'));
        host.appendChild(row);
      }
      const sl = document.createElement('div');
      sl.className = 'adv-inline-row';
      sl.innerHTML = '<span class="adv-mini-label">SL offset % beyond last</span>';
      sl.appendChild(miniInput(() => c.slOffset, v => { c.slOffset = v; }));
      host.appendChild(sl);
      return;
    }

    if (slot.mode === 'manual') {
      const m = slot.manual;
      host.appendChild(countRow(slot, 'manual', () => resetManual(slot)));
      host.appendChild(labelledPair('Price', 'Weight %'));
      for (let i = 0; i < m.count; i++) {
        const row = document.createElement('div');
        row.className = 'adv-entry-row';
        row.innerHTML = `<span class="adv-entry-tag">E${i + 1}</span>`;
        row.appendChild(miniInput(
          () => m.prices[i], v => { m.prices[i] = v; }, 'price'));
        row.appendChild(miniInput(
          () => m.weights[i], v => { m.weights[i] = v; }, 'weight'));
        host.appendChild(row);
      }
      const sl = document.createElement('div');
      sl.className = 'adv-inline-row';
      sl.innerHTML = '<span class="adv-mini-label">SL price</span>';
      sl.appendChild(miniInput(() => m.slPrice, v => { m.slPrice = v; }));
      host.appendChild(sl);

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'adv-btn-ghost';
      reset.textContent = 'Reset to cascade';
      reset.addEventListener('click', () => { resetManual(slot); renderSlots(); recompute(); });
      host.appendChild(reset);
      return;
    }

    // Monte Carlo
    const mc = slot.monte;
    host.appendChild(countRow(slot, 'monte'));

    host.appendChild(labelledPair('Step min %', 'Step max %'));
    const band = document.createElement('div');
    band.className = 'adv-entry-row';
    band.innerHTML = '<span class="adv-entry-tag">Band</span>';
    band.appendChild(miniInput(() => mc.stepMin, v => { mc.stepMin = v; }, 'min %'));
    band.appendChild(miniInput(() => mc.stepMax, v => { mc.stepMax = v; }, 'max %'));
    host.appendChild(band);

    const wf = document.createElement('div');
    wf.className = 'fib-field';
    wf.innerHTML = '<label class="fib-label">Weights</label>';
    const wg = document.createElement('div');
    wg.className = 'fib-toggle-group';
    [['fixed', 'Fixed'], ['random', 'Random']].forEach(([k, lbl]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fib-toggle' + (mc.weightMode === k ? ' active' : '');
      b.textContent = lbl;
      b.addEventListener('click', () => { mc.weightMode = k; renderSlots(); recompute(); });
      wg.appendChild(b);
    });
    wf.appendChild(wg);
    host.appendChild(wf);

    const sl = document.createElement('div');
    sl.className = 'adv-inline-row';
    sl.innerHTML = '<span class="adv-mini-label">SL offset %</span>';
    sl.appendChild(miniInput(() => mc.slOffset, v => { mc.slOffset = v; }));
    host.appendChild(sl);

    const simField = document.createElement('div');
    simField.className = 'fib-field';
    simField.innerHTML =
      `<div class="fib-lev-header"><label class="fib-label">Simulations</label>` +
      `<span class="fib-lev-val" id="advSims${idx}">${mc.sims}</span></div>`;
    const simRow = document.createElement('div');
    simRow.className = 'fib-lev-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'fib-lev-slider';
    slider.min = '50'; slider.max = '1000'; slider.step = '50';
    slider.value = String(mc.sims);
    slider.addEventListener('input', () => {
      mc.sims = parseInt(slider.value, 10);
      const lbl = $(`advSims${idx}`);
      if (lbl) lbl.textContent = mc.sims;
      recompute();
    });
    simRow.appendChild(slider);
    simField.appendChild(simRow);
    host.appendChild(simField);

    const hist = document.createElement('div');
    hist.className = 'adv-hist-wrap';
    hist.innerHTML =
      `<div class="adv-hist-canvas-wrap"><canvas id="advHist${idx}"></canvas></div>` +
      `<div class="adv-chips" id="advChips${idx}"></div>`;
    host.appendChild(hist);
  }

  // ── Histogram ────────────────────────────────────────────────────────
  const histCharts = {};

  function renderHistogram(idx, mc) {
    const canvas = $(`advHist${idx}`);
    const chips = $(`advChips${idx}`);
    if (!canvas || typeof Chart === 'undefined') return;

    // Guard the binning: a degenerate spread (every run identical, or a
    // non-finite sneaking through) would otherwise produce Infinity bin
    // widths and an unrenderable chart.
    const vals = (mc.wavgs || []).filter(Number.isFinite);
    if (histCharts[idx]) { histCharts[idx].destroy(); histCharts[idx] = null; }
    if (chips) chips.innerHTML = '';
    if (vals.length < 2) return;

    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min;
    const bins = 18;
    const width = span > 0 ? span / bins : 1;
    const counts = new Array(bins).fill(0);
    for (const v of vals) {
      const i = span > 0 ? Math.min(bins - 1, Math.floor((v - min) / width)) : 0;
      counts[i] += 1;
    }
    const labels = counts.map((_, i) => (min + width * (i + 0.5)).toPrecision(5));

    const col = slotColor(idx);
    const grid = getComputedStyle(document.documentElement)
      .getPropertyValue('--border-subtle').trim() || 'rgba(255,255,255,0.08)';
    const text = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-muted').trim() || '#888';

    histCharts[idx] = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Runs', data: counts, backgroundColor: col + 'cc', borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (t) => 'Wavg ≈ ' + t[0].label } },
        },
        scales: {
          x: { ticks: { color: text, maxTicksLimit: 6, font: { size: 9 } }, grid: { display: false } },
          y: { ticks: { color: text, precision: 0, font: { size: 9 } }, grid: { color: grid } },
        },
      },
    });

    if (chips) {
      const s = mc.stats;
      chips.innerHTML = [
        ['n', s.n], ['mean', price(s.mean)], ['std', s.std.toPrecision(3)],
        ['min', price(s.min)], ['max', price(s.max)],
      ].map(([k, v]) => `<span class="adv-chip">${k} <b>${v}</b></span>`).join('');
    }
  }

  // ── Price ladder ─────────────────────────────────────────────────────
  function renderLadder(results) {
    const host = $('advLadder');
    const active = results.filter(r => r.res);
    if (!active.length) {
      host.innerHTML = '<div class="adv-ladder-empty">Enable a strategy to plot the ladder.</div>';
      return;
    }

    // Shared axis across every visible entry, stop and target.
    const all = [];
    active.forEach(r => {
      r.res.entries.forEach(e => all.push(e.price));
      all.push(r.res.slPrice, r.res.tp, r.res.wavg);
    });
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || (hi * 0.08) || 1;
    const min = lo - pad, max = hi + pad;

    const W = 760, rowH = 54, padL = 74, padR = 16, padT = 18;
    const H = padT + active.length * rowH + 26;
    const x = (p) => padL + ((p - min) / (max - min)) * (W - padL - padR);

    const textMuted = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-muted').trim() || '#888';
    const textPrim = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-primary').trim() || '#fff';
    const green = getComputedStyle(document.documentElement)
      .getPropertyValue('--green').trim() || '#39ff14';
    const red = getComputedStyle(document.documentElement)
      .getPropertyValue('--red').trim() || '#ff1744';
    const border = getComputedStyle(document.documentElement)
      .getPropertyValue('--border-subtle').trim() || 'rgba(255,255,255,0.08)';

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Entry price ladder">`;

    // Axis ticks
    for (let i = 0; i <= 4; i++) {
      const p = min + (max - min) * (i / 4);
      svg += `<line x1="${x(p).toFixed(1)}" y1="${padT - 6}" x2="${x(p).toFixed(1)}" y2="${H - 22}" stroke="${border}" stroke-width="1"/>`;
      svg += `<text x="${x(p).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="${textMuted}" font-family="monospace">${price(p)}</text>`;
    }

    active.forEach((r, i) => {
      const cy = padT + i * rowH + rowH / 2;
      const col = slotColor(r.idx);
      svg += `<text x="8" y="${cy + 3}" font-size="10" fill="${textMuted}" font-family="sans-serif">Strategy ${'ABC'[r.idx]}</text>`;
      svg += `<line x1="${padL}" y1="${cy}" x2="${W - padR}" y2="${cy}" stroke="${border}" stroke-width="1"/>`;

      const marker = (p, colour, dash) =>
        `<line x1="${x(p).toFixed(1)}" y1="${(cy - 17).toFixed(1)}" x2="${x(p).toFixed(1)}" y2="${(cy + 17).toFixed(1)}" stroke="${colour}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
      svg += marker(r.res.slPrice, red, '3 2');
      svg += marker(r.res.tp, green, '3 2');
      svg += marker(r.res.wavg, textPrim, '');

      // Dot radius scales with allocation so the heavy entry reads at a glance.
      const maxW = Math.max(...r.res.entries.map(e => Math.abs(e.weight))) || 1;
      r.res.entries.forEach((e, j) => {
        const rad = 3.5 + 6.5 * Math.sqrt(Math.abs(e.weight) / maxW);
        svg += `<circle cx="${x(e.price).toFixed(1)}" cy="${cy}" r="${rad.toFixed(2)}" fill="${col}" fill-opacity="0.75" stroke="${col}" stroke-width="1.2"><title>E${j + 1} ${price(e.price)} · ${num(e.weight, 1)}%</title></circle>`;
      });
    });

    svg += '</svg>';
    host.innerHTML = svg;
  }

  // ── Comparison table ─────────────────────────────────────────────────
  function renderTable(results) {
    const body = $('advTableBody');
    const active = results.filter(r => r.res);
    if (!active.length) {
      body.innerHTML = '<tr><td class="adv-td-empty" colspan="8">No active strategy.</td></tr>';
      return;
    }
    body.innerHTML = active.map(r => `<tr>
      <td class="adv-td-name"><span class="adv-swatch" style="background:${slotColor(r.idx)}"></span>Strategy ${'ABC'[r.idx]}</td>
      <td>${MODE_LABEL[r.slot.mode]}</td>
      <td>${price(r.res.wavg)}</td>
      <td>${money(r.res.capital)}</td>
      <td>${qtyFmt(r.res.qty)}</td>
      <td>${price(r.res.slPrice)}</td>
      <td>${price(r.res.tp)}</td>
      <td>${num(r.res.rr, 2)}</td>
    </tr>`).join('');
  }

  // ── Recompute — outputs only, never input values ─────────────────────
  function recompute() {
    const results = state.slots.map((slot, idx) => {
      const outHost = $(`advOut${idx}`);
      const warnHost = $(`advWarn${idx}`);
      if (!slot.enabled) {
        if (outHost) outHost.innerHTML = '';
        if (warnHost) warnHost.hidden = true;
        return { idx, slot, res: null };
      }

      const resolved = resolveSlot(slot);
      if (resolved.error) {
        if (outHost) outHost.innerHTML = `<div class="adv-error">${resolved.error}</div>`;
        if (warnHost) warnHost.hidden = true;
        return { idx, slot, res: null };
      }

      // Weights that miss 100 are a warning, never a block — the engine
      // still produces a coherent (if under/over-allocated) position.
      if (warnHost) {
        const sum = resolved.entries.reduce((s, e) => s + e.weight, 0);
        const off = Math.abs(sum - 100) > 0.01;
        warnHost.hidden = !off;
        if (off) warnHost.textContent = `Weights sum to ${num(sum, 1)}%, not 100%.`;
      }

      const res = computeStrategy({
        entries: resolved.entries,
        slPrice: resolved.slPrice,
        accountSize: state.account,
        riskPct: state.riskPct,
        leverage: state.leverage,
        direction: state.direction,
      });

      if (!res) {
        if (outHost) outHost.innerHTML = '<div class="adv-error">Check your inputs — no valid position.</div>';
        return { idx, slot, res: null };
      }

      if (outHost) {
        outHost.innerHTML = `<div class="adv-out">
          ${[['Wavg', price(res.wavg)], ['Capital', money(res.capital)],
             ['Qty', qtyFmt(res.qty)], ['Max loss', money(res.maxLoss)],
             ['SL', price(res.slPrice)], ['TP', price(res.tp)],
             ['R:R', num(res.rr, 2)]]
            .map(([k, v]) => `<div class="adv-out-row"><span class="adv-out-k">${k}</span><span class="adv-out-v">${v}</span></div>`)
            .join('')}
        </div>`;
      }

      if (slot.mode === 'monte' && resolved.monte) renderHistogram(idx, resolved.monte);
      return { idx, slot, res };
    });

    renderLadder(results);
    renderTable(results);
    return results;
  }

  function render() { renderSlots(); recompute(); }

  // ── Global input wiring ──────────────────────────────────────────────
  bindNum($('advAccount'), () => state.account, v => { state.account = v; });
  bindNum($('advE1'), () => state.e1, v => { state.e1 = v; });

  function wireSlider(sliderId, displayId, minusId, plusId, key, fmt) {
    const slider = $(sliderId), display = $(displayId);
    const sync = () => {
      state[key] = parseFloat(slider.value);
      display.textContent = fmt(state[key]);
      recompute();
    };
    slider.addEventListener('input', sync);
    $(minusId).addEventListener('click', () => {
      slider.value = Math.max(parseFloat(slider.min), parseFloat(slider.value) - parseFloat(slider.step));
      sync();
    });
    $(plusId).addEventListener('click', () => {
      slider.value = Math.min(parseFloat(slider.max), parseFloat(slider.value) + parseFloat(slider.step));
      sync();
    });
    slider.value = String(state[key]);
    display.textContent = fmt(state[key]);
  }

  wireSlider('advRisk', 'advRiskDisplay', 'advRiskMinus', 'advRiskPlus', 'riskPct', v => v.toFixed(1) + '%');
  wireSlider('advLeverage', 'advLevDisplay', 'advLevMinus', 'advLevPlus', 'leverage', v => v + '×');

  calc.querySelectorAll('[data-dir]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.direction = btn.dataset.dir;
      calc.querySelectorAll('[data-dir]').forEach(b => b.classList.toggle('active', b === btn));
      // Manual prices were derived from the old direction's cascade; leaving
      // them would silently plot a long ladder under a short label.
      state.slots.forEach(s => { if (s.manual.prices.length) resetManual(s); });
      render();
    });
  });

  // Expose the engine for the verification harness (see the test case in the
  // Advance Calculator spec) without leaking the whole module.
  window.__advCalc = { computeStrategy, cascade, slFromOffset, state, recompute,
                       FIB_STEPS, FIB_WEIGHTS };

  render();
})();
