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
    if (t === 'purple')  return { up: '#7b2fff', down: '#e040fb' };
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
      c1: '#7b2fff', fa1: 'rgba(123,47,255,0.25)', fb1: 'rgba(123,47,255,0)',
      c2: '#e040fb', fa2: 'rgba(224,64,251,0.10)', fb2: 'rgba(224,64,251,0)',
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
    throw new Error(msg);
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
  const cards = [dom.metricWinRate, dom.metricPnl, dom.metricTotalLosses, dom.metricDrawdown, dom.metricMaxProfit, dom.metricRR, dom.metricStreak, dom.metricTotal, dom.metricAvgRoe, dom.metricAvgEntries, dom.metricAvgDuration, dom.metricAvgPnl];
  cards.forEach(el => { el.textContent = '···'; el.classList.add('skeleton'); });

  try {
    const qs = buildQuery({ start_date: startDate, end_date: endDate });
    const data = await apiFetch(`/metrics${qs}`);
    renderMetrics(data);
    setConnectionStatus('connected', t('header.connected'));
  } catch (err) {
    cards.forEach(el => { el.textContent = '—'; el.classList.remove('skeleton'); });
    setConnectionStatus('error', t('header.offline'));
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
    ? { win: '#00e5ff', winRgb: '0, 229, 255', loss: '#e040fb', lossRgb: '224, 64, 251' }
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
  document.querySelectorAll('.tf-quick-btn').forEach(b => b.classList.remove('is-active'));
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
      document.querySelectorAll('.tf-quick-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const days = parseInt(btn.dataset.days, 10);
      const today = new Date();
      const from  = new Date();
      from.setDate(from.getDate() - days);
      const todayStr = today.toISOString().slice(0, 10);
      const fromStr  = from.toISOString().slice(0, 10);
      dom.startDate.value   = fromStr;
      dom.endDate.value     = todayStr;
      dom.tfStartDate.value = fromStr;
      dom.tfEndDate.value   = todayStr;
      dom.tfDateLabel.textContent = btn.textContent.trim();
      closePanel(dom.tfDatePanel, dom.tfDateBtn);
      refreshAll();
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
(function initFibCalc() {
  const $ = (id) => document.getElementById(id);

  // ── Toggle groups ──────────────────────────────────────────
  document.querySelectorAll('.fib-toggle[data-trades]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fib-toggle[data-trades]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.querySelectorAll('.fib-toggle[data-dir]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fib-toggle[data-dir]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ── Calculate ──────────────────────────────────────────────
  $('fibCalcBtn').addEventListener('click', () => {
    const pair      = $('fcPair').value;
    const account   = parseFloat($('fcAccount').value);
    const e1Price   = parseFloat($('fcE1').value);
    const numTrades = parseInt(document.querySelector('.fib-toggle[data-trades].active')?.dataset.trades || '1');
    const direction = document.querySelector('.fib-toggle[data-dir].active')?.dataset.dir || 'long';

    if (!account || account <= 0 || !e1Price || e1Price <= 0) return;

    const isLong   = direction === 'long';
    const s        = isLong ? -1 : 1;   // -1 = subtract (long), +1 = add (short)
    const leverage = 6;

    // Account rules
    const deployed       = account * 0.45;
    const reserve        = account * 0.55;
    const maxLoss        = account * 0.10;
    const tradeCap       = deployed / numTrades;
    const maxLossPerTrade = maxLoss / numTrades;

    // Entry prices
    const e1 = e1Price;
    const e2 = e1 * (1 + s * 0.01618);
    const e3 = e2 * (1 + s * 0.02618);
    const e4 = e3 * (1 + s * 0.03618);
    const sl = e4 * (1 + s * 0.0370);

    // Capital split per entry (% of trade capital)
    const pcts    = [0.15, 0.225, 0.30, 0.325];
    const entries = [e1, e2, e3, e4];
    const labels  = ['E1', 'E2', 'E3', 'E4'];
    const capitals  = pcts.map(p => tradeCap * p);
    const exposures = capitals.map(c => c * leverage);
    const totalCap  = capitals.reduce((a, b) => a + b, 0);
    const totalExp  = exposures.reduce((a, b) => a + b, 0);

    // Weighted average entry (pcts already sum to 1.0)
    const wavg = entries.reduce((sum, e, i) => sum + e * pcts[i], 0);

    // Take profit: 5% from wavg
    const tp = isLong ? wavg * 1.05 : wavg * 0.95;

    // SL verification: tradeCap × leverage × 3.70%
    const actualLossPerTrade = tradeCap * leverage * 0.0370;
    const totalActualLoss    = actualLossPerTrade * numTrades;
    const slPass = totalActualLoss <= maxLoss + 0.01;

    // ── Render ─────────────────────────────────────────────
    const fmt  = (n, d = 2) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    const fmtP = (n, d = 5) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d });

    $('frPairBadge').textContent  = pair;
    $('frDeployed').textContent   = fmt(deployed);
    $('frTradeCap').textContent   = fmt(tradeCap) + (numTrades > 1 ? ` ×${numTrades}` : '');
    $('frReserve').textContent    = fmt(reserve);
    $('frMaxLoss').textContent    = fmt(maxLoss);
    $('frMaxLossPer').textContent = fmt(maxLossPerTrade);

    $('frE1').textContent   = fmtP(e1);
    $('frE2').textContent   = fmtP(e2);
    $('frE3').textContent   = fmtP(e3);
    $('frE4').textContent   = fmtP(e4);
    $('frSL').textContent   = fmtP(sl);
    $('frWavg').textContent = fmtP(wavg);
    $('frTP').textContent   = fmtP(tp);

    // Allocation table
    const entryColors = ['var(--accent-primary)', '#7affcc', '#7ab8ff', '#c17aff'];
    const tbody = $('frAllocBody');
    tbody.innerHTML = entries.map((e, i) => `
      <tr>
        <td style="color:${entryColors[i]}">${labels[i]}</td>
        <td>${(pcts[i] * 100).toFixed(1)}%</td>
        <td>${fmt(capitals[i])}</td>
        <td>${fmt(exposures[i])}</td>
      </tr>`).join('');

    $('frTotalCap').textContent = fmt(totalCap);
    $('frTotalExp').textContent = fmt(totalExp);

    // SL verification
    $('frActualLoss').textContent = fmt(totalActualLoss);
    $('frMaxAllowed').textContent = fmt(maxLoss);
    const badge = $('frBadge');
    if (slPass) {
      badge.textContent = '✓ Within Max Loss Limit';
      badge.className = 'fib-verify-badge pass';
    } else {
      badge.textContent = '✗ Exceeds Max Loss — Adjust Position';
      badge.className = 'fib-verify-badge fail';
    }

    $('fibResults').hidden = false;
  });

  // Also trigger on Enter key in inputs
  ['fcAccount', 'fcE1'].forEach(id => {
    $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') $('fibCalcBtn').click(); });
  });
})();

/* ════════════════════════════════════════════════════════════
   POOL FUND DASHBOARD
   ════════════════════════════════════════════════════════════ */
(function initPool() {
  const STORAGE_KEY = 'pool_contributors';
  const RETURN_RATE = 0.05;

  const $id = (id) => document.getElementById(id);
  const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── State ──────────────────────────────────────────────────
  let contributors = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

  // ── Glassmorphic SVG Pie Chart ─────────────────────────────

  const PIE_COLORS = [
    { h: '#39ff14', r: 57,  g: 255, b: 20  },
    { h: '#00cfff', r: 0,   g: 207, b: 255 },
    { h: '#c77dff', r: 199, g: 125, b: 255 },
    { h: '#ffd166', r: 255, g: 209, b: 102 },
    { h: '#ff6b35', r: 255, g: 107, b: 53  },
    { h: '#06d6a0', r: 6,   g: 214, b: 160 },
    { h: '#ff85a1', r: 255, g: 133, b: 161 },
    { h: '#ef233c', r: 239, g: 35,  b: 60  },
    { h: '#f4a261', r: 244, g: 162, b: 97  },
    { h: '#457b9d', r: 69,  g: 123, b: 157 },
  ];

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

  function renderPieSVG() {
    const container = $id('poolPieContainer');
    const total = contributors.reduce((s, c) => s + c.amount, 0);
    if (!contributors.length || !total) { container.innerHTML = ''; return; }

    let defs = `
      <filter id="pieShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgba(0,0,0,0.45)"/>
      </filter>`;
    let slicesHTML = '';
    let angle = 0;

    contributors.forEach((c, i) => {
      const frac = c.amount / total;
      const span = frac * 360 - PIE_GAP;
      if (span <= 0) { angle += frac * 360; return; }

      const start = angle + PIE_GAP / 2;
      const end   = start + span;
      const mid   = (start + end) / 2;
      const midRad = (mid - 90) * Math.PI / 180;
      const tx = (Math.cos(midRad) * 10).toFixed(2);
      const ty = (Math.sin(midRad) * 10).toFixed(2);
      const col = PIE_COLORS[i % PIE_COLORS.length];
      const d   = _arc(start, end);
      const delay = (i * 0.065).toFixed(3);

      // Per-slice gradients
      defs += `
        <radialGradient id="pg${i}" cx="40%" cy="35%" r="68%" gradientUnits="objectBoundingBox">
          <stop offset="0%"   stop-color="rgba(${col.r},${col.g},${col.b},0.95)"/>
          <stop offset="100%" stop-color="rgba(${col.r},${col.g},${col.b},0.42)"/>
        </radialGradient>
        <linearGradient id="sh${i}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stop-color="rgba(255,255,255,0.38)"/>
          <stop offset="55%" stop-color="rgba(255,255,255,0)"/>
        </linearGradient>`;

      slicesHTML += `
        <g class="pie-group" data-i="${i}"
           data-tx="${tx}" data-ty="${ty}"
           style="animation-delay:${delay}s">
          <path d="${d}"
            fill="url(#pg${i})"
            stroke="rgba(${col.r},${col.g},${col.b},0.75)"
            stroke-width="1.5"
            class="pie-slice"/>
          <path d="${d}" fill="url(#sh${i})" class="pie-sheen"/>
        </g>`;

      angle += frac * 360;
    });

    const totalFmt = '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    container.innerHTML = `
      <svg viewBox="0 0 300 300" class="pool-pie-svg" xmlns="http://www.w3.org/2000/svg">
        <defs>${defs}</defs>
        <g filter="url(#pieShadow)">${slicesHTML}</g>
        <circle cx="${PIE_CX}" cy="${PIE_CY}" r="${PIE_INNER - 2}" class="pie-center"/>
        <text x="${PIE_CX}" y="${PIE_CY - 8}" text-anchor="middle" class="pie-clabel">Pool</text>
        <text x="${PIE_CX}" y="${PIE_CY + 13}" text-anchor="middle" class="pie-cvalue">${escHtml(totalFmt)}</text>
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
      const c   = contributors[i];
      const col = PIE_COLORS[i % PIE_COLORS.length];
      const pct = (c.amount / total * 100).toFixed(1);
      const amt = '$' + c.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      g.addEventListener('mouseenter', () => {
        g.style.transform = `translate(${tx}px,${ty}px)`;
        _showTip(c.name, amt, pct, col.h);
      });
      g.addEventListener('mousemove', _moveTip);
      g.addEventListener('mouseleave', () => { g.style.transform = ''; _hideTip(); });
    });
  }

  function updatePieChart() {
    const hasData = contributors.length > 0;
    $id('poolChartWrap').hidden = !hasData;
    if (!hasData) return;

    renderPieSVG();

    const total = contributors.reduce((s, c) => s + c.amount, 0);
    $id('poolChartLegend').innerHTML = contributors.map((c, i) => {
      const pct = total > 0 ? (c.amount / total * 100).toFixed(1) : '0.0';
      const col = PIE_COLORS[i % PIE_COLORS.length];
      return `<div class="pool-legend-item">
        <span class="pool-legend-swatch" style="background:${col.h};box-shadow:0 0 7px ${col.h}88"></span>
        <span class="pool-legend-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
        <span class="pool-legend-pct">${pct}%</span>
      </div>`;
    }).join('');
  }

  // ── Render ─────────────────────────────────────────────────
  function render() {
    const tbody    = $id('poolTableBody');
    const total    = contributors.reduce((s, c) => s + c.amount, 0);
    const returns  = total * RETURN_RATE;
    const after    = total + returns;

    // Show/hide sections
    const hasData = contributors.length > 0;
    $id('poolSummary').hidden    = !hasData;
    $id('poolTableWrap').hidden  = !hasData;

    if (hasData) {
      $id('poolTotal').textContent   = fmt(total);
      $id('poolReturns').textContent = fmt(returns);
      $id('poolAfter').textContent   = fmt(after);
      $id('poolCount').textContent   = contributors.length;
    }

    tbody.innerHTML = contributors.map((c, i) => {
      const ret   = c.amount * RETURN_RATE;
      const share = total > 0 ? (c.amount / total * 100) : 0;
      return `
        <tr>
          <td class="pool-name-cell">${escHtml(c.name)}</td>
          <td>${fmt(c.amount)}</td>
          <td class="pool-return-cell">${fmt(ret)}</td>
          <td class="pool-share-cell">
            <div class="pool-bar-wrap">
              <span>${share.toFixed(1)}%</span>
              <div class="pool-bar"><div class="pool-bar-fill" style="width:${share}%"></div></div>
            </div>
          </td>
          <td><button class="pool-del-btn" data-idx="${i}" title="Remove">✕</button></td>
        </tr>`;
    }).join('');

    updatePieChart();
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(contributors));
  }

  // ── Add contributor ────────────────────────────────────────
  $id('poolAddBtn').addEventListener('click', () => {
    const name   = $id('poolName').value.trim();
    const amount = parseFloat($id('poolAmt').value);
    if (!name || !amount || amount <= 0) return;
    contributors.push({ name, amount });
    save();
    render();
    $id('poolName').value = '';
    $id('poolAmt').value  = '';
    $id('poolName').focus();
  });

  // Enter key in inputs
  [$id('poolName'), $id('poolAmt')].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') $id('poolAddBtn').click(); });
  });

  // ── Delete contributor ─────────────────────────────────────
  $id('poolTableBody').addEventListener('click', e => {
    const btn = e.target.closest('.pool-del-btn');
    if (!btn) return;
    contributors.splice(parseInt(btn.dataset.idx), 1);
    save();
    render();
  });

  // ── Toggle section ─────────────────────────────────────────
  $id('poolToggleBtn').addEventListener('click', () => {
    const body = $id('poolBody');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    $id('poolToggleBtn').textContent = hidden ? 'Hide' : 'Show';
  });

  render();
})();

/* ════════════════════════════════════════════════════════════
   MOBILE — FIB CALCULATOR DRAWER
   ════════════════════════════════════════════════════════════ */
(function initCalcDrawer() {
  const calc     = document.getElementById('fibCalc');
  const backdrop = document.getElementById('fibBackdrop');
  const fab      = document.getElementById('fibFab');
  const closeBtn = document.getElementById('fibCloseBtn');

  function openCalc() {
    calc?.classList.add('calc-open');
    backdrop?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeCalc() {
    calc?.classList.remove('calc-open');
    backdrop?.classList.remove('active');
    document.body.style.overflow = '';
  }

  fab?.addEventListener('click', openCalc);
  closeBtn?.addEventListener('click', closeCalc);
  backdrop?.addEventListener('click', closeCalc);

  // Close on Escape (unless a modal is open)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && calc?.classList.contains('calc-open')) {
      e.stopPropagation();
      closeCalc();
    }
  });

  // Close drawer automatically when resizing back to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeCalc();
  });
})();
