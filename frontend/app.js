/* ════════════════════════════════════════════════════════════
   TRADE TRACKER — APP.JS
   Pure vanilla ES2020+, no frameworks.

   Core of the dashboard: auth, period, data loading, metric cards, the main
   chart, the trade journal and its modals. Client-side analytics (edge panel,
   calendar, leaderboard, heatmaps, card micro-charts) live in insights.js and
   the live ticker tape + sessions clock in market.js.
   ════════════════════════════════════════════════════════════ */

'use strict';

const API_BASE = (typeof window.BACKEND_URL !== 'undefined' && window.BACKEND_URL)
  ? window.BACKEND_URL.replace(/\/$/, '')
  : 'http://localhost:8000';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  if (!_THEME_META[theme]) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(_THEME_KEY, theme);
  const { icon, label, logo } = _THEME_META[theme];
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
  // Charts read their colours from the CSS variables, so they redraw on a theme change
  document.dispatchEvent(new CustomEvent('illustrade:theme', { detail: theme }));
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx     = _THEME_CYCLE.indexOf(current);
  applyTheme(_THEME_CYCLE[(idx + 1) % _THEME_CYCLE.length]);
}

/* ── Language ──────────────────────────────────────────────── */
const _LANG_KEY    = 'tt_lang';
let   _currentLang = 'en';

const _LANG_META = {
  en: { flag: '🇺🇸', label: 'EN', locale: 'en-US' },
  es: { flag: '🇪🇸', label: 'ES', locale: 'es-ES' },
  fr: { flag: '🇫🇷', label: 'FR', locale: 'fr-FR' },
};

function t(key) {
  const lang = TRANSLATIONS[_currentLang] || TRANSLATIONS.en;
  return lang[key] ?? TRANSLATIONS.en[key] ?? key;
}

/** Locale for dates in the UI language (numbers stay en-US: $1,234.56). */
function uiLocale() { return (_LANG_META[_currentLang] || _LANG_META.en).locale; }

function applyLang(lang) {
  if (!_LANG_META[lang]) lang = 'en';
  _currentLang = lang;
  localStorage.setItem(_LANG_KEY, lang);
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });

  const meta = _LANG_META[lang];
  ['langDropdown', 'loginLangDropdown'].forEach(id => {
    const dd = document.getElementById(id);
    if (!dd) return;
    dd.querySelector('.lang-flag').textContent  = meta.flag;
    dd.querySelector('.lang-label').textContent = meta.label;
    dd.querySelectorAll('.lang-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.lang === lang);
    });
  });

  // Labels that depend on state, not just on the language
  updatePeriodUI();
  updateSymbolLabel();
  document.dispatchEvent(new CustomEvent('illustrade:lang', { detail: lang }));
}

function initLangDropdowns() {
  document.querySelectorAll('.lang-dropdown').forEach(dd => {
    dd.querySelector('.lang-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dd.classList.contains('open');
      document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!isOpen) dd.classList.add('open');
    });
    dd.querySelectorAll('.lang-option').forEach(opt => {
      opt.addEventListener('click', () => {
        applyLang(opt.dataset.lang);
        dd.classList.remove('open');
        // Re-render text built in JS (cards, table, chart labels)
        if (state.loaded) renderAll();
      });
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
  });
}

/* ── Animation loop helper: pauses while the tab is hidden ─── */
function makeLoop(frame) {
  let raf = 0;
  let running = false;
  const tick = () => { frame(); raf = requestAnimationFrame(tick); };
  const loop = {
    start() {
      if (running) return;
      running = true;
      if (REDUCED_MOTION) { frame(); return; }   // one still frame, no motion
      if (!document.hidden) tick();
    },
    stop() { running = false; cancelAnimationFrame(raf); raf = 0; },
  };
  document.addEventListener('visibilitychange', () => {
    if (!running || REDUCED_MOTION) return;
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) tick();
  });
  return loop;
}

/* ── Background canvas: drifting candles ───────────────────── */
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
    const th = document.documentElement.getAttribute('data-theme');
    if (th === 'blossom') return { up: '#9b5de5', down: '#ff85a1' };
    if (th === 'purple')  return { up: '#00e5ff', down: '#c030ff' };
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
    const range = canvas.height * hFrac * 0.5;
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
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x + CW / 2, cy - (c.high - 100) * scale);
    ctx.lineTo(x + CW / 2, cy - (c.low  - 100) * scale);
    ctx.stroke();
    const bTop = cy - (Math.max(c.open, c.close) - 100) * scale;
    const bH   = Math.max(Math.abs(c.close - c.open) * scale, 1.5);
    ctx.fillStyle = color;
    ctx.fillRect(x, bTop, CW, bH);
  }

  function drawTrend(row, col) {
    const scale = row.range / 42;
    ctx.strokeStyle = col.up;
    ctx.lineWidth   = 1.2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    let first = true;
    row.data.forEach((c, i) => {
      const x = i * PITCH - row.offset + CW / 2;
      if (x < -PITCH || x > canvas.width + PITCH) return;
      const y = row.cy - (c.close - 100) * scale;
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const col = themeColors();
    rows.forEach(row => {
      row.offset += row.speed;
      while (row.data.length && (PITCH - row.offset) < -PITCH * 2) {
        row.data.shift();
        row.offset -= PITCH;
      }
      while (row.data.length * PITCH - row.offset < canvas.width + PITCH * 6) {
        const last = row.data.length ? row.data[row.data.length - 1].close : 100;
        row.data.push(newCandle(last));
      }
      ctx.globalAlpha = 0.13;
      row.data.forEach((c, i) => {
        const x = i * PITCH - row.offset;
        if (x < -PITCH * 2 || x > canvas.width + PITCH) return;
        drawCandle(x, c, row.cy, row.range, col);
      });
      ctx.globalAlpha = 0.07;
      drawTrend(row, col);
    });
    ctx.globalAlpha = 1;
  }

  const loop = makeLoop(frame);
  loop.start();
  window.addEventListener('resize', () => { resize(); buildRows(); if (REDUCED_MOTION) frame(); });
  document.addEventListener('illustrade:theme', () => { if (REDUCED_MOTION) frame(); });
}

/* ── Login screen animated line-chart (runs only while visible) ── */
function initLoginCanvas() {
  const canvas = document.getElementById('loginCanvas');
  const ctx = canvas.getContext('2d');

  const SPACING = 18;    // px between price points
  const SPEED1  = 0.55;  // main line scroll speed (px/frame)
  const SPEED2  = 0.30;  // secondary line (slower "MA")

  const buf1 = [], buf2 = [];
  let off1 = 0, off2 = 0;

  function loginColors() {
    const th = document.documentElement.getAttribute('data-theme');
    if (th === 'blossom') return {
      c1: '#9b5de5', fa1: 'rgba(155,93,229,0.40)', fb1: 'rgba(155,93,229,0)',
      c2: '#ff85a1', fa2: 'rgba(255,133,161,0.22)', fb2: 'rgba(255,133,161,0)',
    };
    if (th === 'purple') return {
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
    const p = last + (Math.random() - 0.5) * vol + (mean - last) * 0.06;
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

  function smoothPath(pts) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }

  function drawSmoothLine(buf, subOff, lineColor, fillA, fillB, lineW) {
    const H = canvas.height;
    const py = p => H * 0.70 - (p / 100) * H * 0.48;
    const pts = buf.map((p, i) => ({ x: i * SPACING - subOff, y: py(p) }));
    if (pts.length < 2) return;

    ctx.beginPath();
    smoothPath(pts);
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.lineTo(pts[0].x, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, fillA);
    grad.addColorStop(1, fillB);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    smoothPath(pts);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = lineW;
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }

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
  }

  const loop = makeLoop(frame);
  window.addEventListener('resize', () => { if (!document.getElementById('loginScreen').hidden) resize(); });
  return {
    start() { resize(); loop.start(); },
    stop()  { loop.stop(); },
  };
}

let loginCanvas = null;   // controller from initLoginCanvas(), set in init()

/* ── State ─────────────────────────────────────────────────── */
const _PERIOD_KEY = 'tt_period';

const state = {
  loaded: false,          // true once the first load after sign-in finished
  trades: [],             // every trade in the period (table filters NOT applied)
  metrics: null,          // /metrics answer for the period
  pendingDelete: null,    // { ids: [...] } waiting for the confirm modal
  editingId: null,
  flashId: null,          // trade id to flash once after it was added/edited
  pnlChart: null,
  chartMode: 'equity',    // equity | daily | drawdown
  selectedIds: new Set(),
  tableFilter: { symbols: new Set(), side: '', search: '' },
  tableSort:   { col: 'date', dir: 'desc' },
  range:       { preset: '30', start: null, end: null },
};

/* ════════════════════════════════════════════════════════════
   DOM REFERENCES
   ════════════════════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

const dom = {
  // Command bar
  periodSeg:      $('periodSeg'),
  periodCaption:  $('periodCaption'),
  heroPeriod:     $('heroPeriod'),
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

  cardWinRate:     $('card-winRate'),
  cardPnl:         $('card-pnl'),
  cardTotalLosses: $('card-totalLosses'),
  cardDrawdown:    $('card-drawdown'),
  cardMaxProfit:   $('card-maxProfit'),
  cardRR:          $('card-rr'),
  cardStreak:      $('card-streak'),
  cardAvgRoe:      $('card-avgRoe'),
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
  pnlChart:        $('pnlChart'),
  chartEmpty:      $('chartEmpty'),
  chartModeSeg:    $('chartModeSeg'),
  chartFilterChip: $('chartFilterChip'),

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
  qtyConversion:         $('qtyConversion'),
  qtyConverted:          $('qtyConverted'),
  leverageNotionalGroup: $('leverageNotionalGroup'),
  leverageNotional:      $('leverageNotional'),

  // Period — custom range panel
  tfDateDropdown: $('tfDateDropdown'),
  tfDateBtn:      $('tfDateBtn'),
  tfDatePanel:    $('tfDatePanel'),
  tfStartDate:    $('tfStartDate'),
  tfEndDate:      $('tfEndDate'),
  tfApplyDate:    $('tfApplyDate'),

  // Table filters
  tfSearch:          $('tfSearch'),
  tfSymbolDropdown:  $('tfSymbolDropdown'),
  tfSymbolBtn:       $('tfSymbolBtn'),
  tfSymbolPanel:     $('tfSymbolPanel'),
  tfSymbolLabel:     $('tfSymbolLabel'),
  tfSymbolSearch:    $('tfSymbolSearch'),
  tfSymbolList:      $('tfSymbolList'),
  tfSymbolClear:     $('tfSymbolClear'),
  sideSeg:           $('sideSeg'),

  // Bulk delete
  bulkDeleteBtn: $('bulkDeleteBtn'),
  selectedCount: $('selectedCount'),
  selectAll:     $('selectAll'),

  // Delete Confirm Modal
  confirmBackdrop:  $('confirmBackdrop'),
  confirmTitle:     $('confirmTitle'),
  confirmMsg:       $('confirmMsg'),
  confirmClose:     $('confirmClose'),
  confirmCancelBtn: $('confirmCancelBtn'),
  confirmDeleteBtn: $('confirmDeleteBtn'),

  // Import / Export
  importBtn:    $('importBtn'),
  exportBtn:    $('exportBtn'),
  templateBtn:  $('templateBtn'),
  csvFileInput: $('csvFileInput'),

  // Header
  userMenuBtn: $('userMenuBtn'),
  userMenu:    $('userMenu'),

  // Toast
  toastContainer: $('toastContainer'),

  // Connection
  connectionStatus: $('connectionStatus'),
  statusLabel:      document.querySelector('#connectionStatus .status-label'),
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

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    if (getToken()) {
      clearAuth();
      doLogout();
      showToast(t('toast.session.expired'), 'error', 6000);
    }
    const err = new Error(t('toast.session.expired'));
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || j.message || msg; } catch (_) { /* not JSON */ }
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const _num = (v) => (v == null || v === '' || isNaN(v)) ? null : Number(v);

/** Signed currency: +$1,234.56 / −$12.00 / $0.00 */
function formatCurrency(val, decimals = 2) {
  const n = _num(val);
  if (n == null) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (Number(Math.abs(n).toFixed(decimals)) === 0) return '$' + abs;
  return (n > 0 ? '+' : '−') + '$' + abs;
}

/** Percentage with an optional sign. */
function formatPercent(val, decimals = 1, signed = false) {
  const n = _num(val);
  if (n == null) return '—';
  return (signed && n > 0 ? '+' : '') + n.toFixed(decimals) + '%';
}

/** Format R:R ratio. */
function formatRR(val) {
  const n = _num(val);
  return n == null ? '—' : n.toFixed(2) + 'R';
}

/** Minutes → 45m / 3.2h / 1.5d */
function formatDuration(minutes) {
  const n = _num(minutes);
  if (n == null) return '—';
  if (n < 60)   return `${Math.round(n)}m`;
  if (n < 1440) return `${(n / 60).toFixed(1)}h`;
  return `${(n / 1440).toFixed(1)}d`;
}

/** Price with precision that suits its size. */
function formatPrice(val) {
  const n = _num(val);
  if (n == null) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Escape HTML to prevent XSS. */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build query string from object, ignoring null/undefined/empty. */
function buildQuery(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return q ? `?${q}` : '';
}

/** Local calendar date as YYYY-MM-DD (toISOString would give the UTC date). */
function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD → local Date at midnight. */
function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The moment a trade counts at: close time, else open time. */
function tradeTime(tr) { return new Date(tr.close_time ?? tr.open_time); }

/** Read a CSS custom property of the active theme. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Colour with alpha from a #rrggbb CSS variable value. */
function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * Tween a number shown in `el` from its previous value to `to`.
 * `fmt` turns the number into text; the final frame is always exact.
 */
function animateNumber(el, to, fmt, duration = 750) {
  const target = _num(to);
  cancelAnimationFrame(el._tween || 0);
  if (target == null) { el.textContent = fmt(null); el._val = null; return; }
  const from = el._val ?? 0;
  el._val = target;
  if (REDUCED_MOTION || from === target || document.hidden) { el.textContent = fmt(target); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(p < 1 ? from + (target - from) * e : target);
    if (p < 1) el._tween = requestAnimationFrame(step);
  };
  el._tween = requestAnimationFrame(step);
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
 * @param {number} duration ms before auto-dismiss (0 = persistent until clicked)
 */
function showToast(msg, type = 'info', duration = 3500) {
  const icons = { success: '&#10003;', error: '&#10007;', info: '&#8505;' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${escHtml(msg)}</span>`;
  if (duration > 0) toast.style.setProperty('--toast-life', `${duration}ms`);
  dom.toastContainer.prepend(toast);

  let gone = false;
  const remove = () => {
    if (gone) return;
    gone = true;
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 320);
  };
  toast.addEventListener('click', remove);
  if (duration > 0) setTimeout(remove, duration);
}

/* ════════════════════════════════════════════════════════════
   PERIOD — one date range drives every number on the page
   ════════════════════════════════════════════════════════════ */

/** {start, end} for a preset, as YYYY-MM-DD (null = open end). */
function presetRange(preset) {
  const today = new Date();
  if (preset === 'all') return { start: null, end: null };
  if (preset === 'ytd') return { start: isoDay(new Date(today.getFullYear(), 0, 1)), end: isoDay(today) };
  const from = new Date(today);
  from.setDate(from.getDate() - Number(preset));
  return { start: isoDay(from), end: isoDay(today) };
}

/** Restore the last period (presets are recomputed so "30D" always means the last 30 days). */
function loadPeriod() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(_PERIOD_KEY)); } catch { /* corrupt entry */ }
  if (saved?.preset === 'custom' && (saved.start || saved.end)) {
    state.range = { preset: 'custom', start: saved.start || null, end: saved.end || null };
  } else if (['7', '30', '90', 'ytd', 'all'].includes(saved?.preset)) {
    state.range = { preset: saved.preset, ...presetRange(saved.preset) };
  } else {
    state.range = { preset: '30', ...presetRange('30') };
  }
}

function setPeriod(preset, start = null, end = null) {
  state.range = preset === 'custom' ? { preset, start, end } : { preset, ...presetRange(preset) };
  try { localStorage.setItem(_PERIOD_KEY, JSON.stringify(state.range)); } catch { /* storage full/blocked */ }
  updatePeriodUI();
  refreshAll();
}

function getDateRange() {
  return { start_date: state.range.start, end_date: state.range.end };
}

function periodShortLabel() {
  const p = state.range.preset;
  if (p === 'all') return t('period.alltime');
  if (p === 'ytd') return t('period.ytd');
  if (p === 'custom') return t('filter.custom');
  return `${p}D`;
}

function updatePeriodUI() {
  if (!dom.periodSeg) return;
  const { preset, start, end } = state.range;
  dom.periodSeg.querySelectorAll('.period-btn[data-preset]').forEach(b => {
    b.classList.toggle('is-active', b.dataset.preset === preset);
  });
  dom.tfDateBtn.classList.toggle('is-active', preset === 'custom');
  dom.tfStartDate.value = start || '';
  dom.tfEndDate.value   = end || '';

  const fmt = (s) => parseDay(s).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric', year: 'numeric' });
  let caption;
  if (start && end) {
    const days = Math.round((parseDay(end) - parseDay(start)) / 86400000) + 1;
    caption = `${fmt(start)} – ${fmt(end)} · ${days} ${t(days === 1 ? 'period.day' : 'period.days')}`;
  } else if (start) {
    caption = `${t('period.since')} ${fmt(start)}`;
  } else if (end) {
    caption = `${t('period.until')} ${fmt(end)}`;
  } else {
    caption = t('period.alltime');
  }
  dom.periodCaption.textContent = caption;
  dom.heroPeriod.textContent = periodShortLabel();
}

/* ════════════════════════════════════════════════════════════
   DATA
   ════════════════════════════════════════════════════════════ */

/** Skeleton shimmer on every metric value while a load is in flight. */
function setMetricsLoading(on) {
  document.querySelectorAll('.metric-value').forEach(el => el.classList.toggle('skeleton', on));
}

let _loadSeq = 0;

/** Load metrics + trades for the period, then render everything once. */
async function loadDashboard() {
  const seq = ++_loadSeq;
  const { start_date, end_date } = getDateRange();
  const qs = buildQuery({ start_date, end_date });
  dom.tableError.hidden = true;
  setMetricsLoading(true);
  if (!state.loaded) {
    dom.tradesBody.innerHTML = `<tr class="table-empty-row"><td colspan="15">${escHtml(t('table.loading'))}</td></tr>`;
  }

  const [m, tr] = await Promise.allSettled([apiFetch(`/metrics${qs}`), apiFetch(`/trades${qs}`)]);
  if (seq !== _loadSeq) return;   // a newer load started (period clicked again) — drop this one

  setMetricsLoading(false);
  if (m.status === 'fulfilled') {
    state.metrics = m.value;
    setConnectionStatus('connected', t('header.connected'));
  } else {
    state.metrics = null;
    if (m.reason?.status !== 401) {
      setConnectionStatus('error', t('header.offline'));
      console.error('metrics:', m.reason);
    }
  }
  if (tr.status === 'fulfilled') {
    const v = tr.value;
    state.trades = Array.isArray(v) ? v : (v.items ?? v.data ?? []);
  } else {
    state.trades = [];
    if (tr.reason?.status !== 401) {
      dom.tableError.hidden = false;
      console.error('trades:', tr.reason);
    }
  }
  state.loaded = true;
  populateSymbolList();
  renderAll();
}

/** Draw everything from state (no network). */
function renderAll() {
  renderMetrics();
  renderFiltered();
}

/** Table, chart and insights — everything the table filters touch. */
function renderFiltered() {
  const filtered = applyTableFilters(state.trades);
  renderTradesTable(filtered);
  renderChart(filtered);
  updateFilterChip();
  window.Insights?.render(state.trades, filtered);
}

async function refreshAll() {
  await Promise.all([
    loadDashboard(),
    // Fund Pool registers this after its IIFE runs (see initPool)
    window.refreshPool ? window.refreshPool() : Promise.resolve(),
  ]);
}

/* ════════════════════════════════════════════════════════════
   METRICS
   ════════════════════════════════════════════════════════════ */

/**
 * Count distinct calendar months touched by a [start, end] date-only range,
 * inclusive. E.g. 2026-06-27 → 2026-07-27 spans June and July = 2.
 */
function monthsSpanned(startDate, endDate) {
  const start = parseDay(startDate);
  const end   = parseDay(endDate);
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
}

function applyCardColor(cardEl, type) {
  cardEl.classList.remove('positive', 'negative', 'neutral');
  if (type) cardEl.classList.add(type);
}

const _signTone = (v) => (v > 0 ? 'positive' : v < 0 ? 'negative' : '');

/** Money metric: animated value + card tone from the sign. */
function setMoney(valueEl, cardEl, v, tone = _signTone(v)) {
  animateNumber(valueEl, v, (x) => formatCurrency(x));
  if (cardEl) applyCardColor(cardEl, _num(v) == null ? '' : tone);
}

function renderMetrics() {
  const data = state.metrics || {};
  const trades = state.trades;
  const n = trades.length;
  const {
    win_rate, total_pnl, total_losses, max_drawdown, avg_rr,
    current_streak, streak_type, total_trades, winning_trades, losing_trades,
  } = data;
  const hasData = state.metrics != null;

  // Net P&L (hero)
  setMoney(dom.metricPnl, dom.cardPnl, hasData ? total_pnl : null);
  dom.metricPnlSub.textContent = hasData
    ? `${t('metric.realized')} · ${total_trades ?? 0} ${t(total_trades === 1 ? 'unit.trade' : 'unit.trades')}`
    : ' ';

  // Win rate (edge ring centre; the ring itself is drawn by insights.js)
  animateNumber(dom.metricWinRate, hasData && total_trades ? win_rate : null, (x) => formatPercent(x));
  dom.metricWinRateSub.textContent = hasData ? `${winning_trades ?? 0}W · ${losing_trades ?? 0}L` : ' ';
  applyCardColor(dom.cardWinRate, hasData && total_trades ? (win_rate >= 50 ? 'positive' : 'negative') : '');

  // Total losses — 0 is not bad news, so it stays neutral
  setMoney(dom.metricTotalLosses, dom.cardTotalLosses, hasData ? (total_losses ?? 0) : null,
    total_losses < 0 ? 'negative' : '');
  dom.metricTotalLossesSub.textContent = hasData ? `${losing_trades ?? 0} ${t('metric.losingtrades')}` : ' ';

  // Max drawdown — shown as a negative amount
  const dd = hasData ? -Math.abs(max_drawdown ?? 0) : null;
  setMoney(dom.metricDrawdown, dom.cardDrawdown, dd, dd < 0 ? 'negative' : '');
  dom.metricDrawdownSub.textContent = t('metric.peaktotrough');

  // Max profit — backend value, else the best trade in the period
  const maxProfit = data.max_profit ?? (n ? Math.max(...trades.map(x => x.pnl ?? 0)) : null);
  setMoney(dom.metricMaxProfit, dom.cardMaxProfit, hasData ? maxProfit : null);
  dom.metricMaxProfitSub.textContent = t('metric.besttrade');

  // Avg R:R — only meaningful when trades actually logged an R:R
  const rrLogged = trades.some(x => _num(x.risk_reward ?? x.rr) != null);
  if (hasData && rrLogged && avg_rr != null) {
    animateNumber(dom.metricRR, avg_rr, formatRR);
    dom.metricRRSub.textContent = avg_rr >= 1 ? t('metric.favorable') : t('metric.unfavorable');
    applyCardColor(dom.cardRR, avg_rr >= 1 ? 'positive' : 'negative');
  } else {
    animateNumber(dom.metricRR, null, () => '—');
    dom.metricRRSub.textContent = hasData ? t('metric.norr') : ' ';
    applyCardColor(dom.cardRR, '');
  }

  // Streak
  const streakAbs  = Math.abs(current_streak ?? 0);
  const streakType = streak_type || (current_streak > 0 ? 'win' : current_streak < 0 ? 'loss' : '');
  dom.metricStreak.innerHTML = hasData && streakAbs > 0
    ? `<span class="streak-badge streak-${streakType === 'win' ? 'win' : 'loss'}">${streakType === 'win' ? 'W' : 'L'}${streakAbs}</span>`
    : '—';
  dom.metricStreakSub.textContent = streakType === 'win' ? t('metric.winstreak') : streakType === 'loss' ? t('metric.lossstreak') : ' ';
  applyCardColor(dom.cardStreak, hasData && streakAbs ? (streakType === 'win' ? 'positive' : 'negative') : '');

  // Total trades
  animateNumber(dom.metricTotal, hasData ? (total_trades ?? 0) : null, (x) => (x == null ? '—' : String(Math.round(x))));
  dom.metricTotalSub.textContent = t('metric.closedpos');

  // Avg ROE %
  animateNumber(dom.metricAvgRoe, hasData ? data.avg_roe : null, (x) => formatPercent(x, 1, true));
  dom.metricAvgRoeSub.textContent = t('metric.pertrade');
  applyCardColor(dom.cardAvgRoe, hasData ? _signTone(data.avg_roe) : '');

  // Avg entries
  const avgEntries = data.avg_entries > 0 ? data.avg_entries : null;
  animateNumber(dom.metricAvgEntries, hasData ? avgEntries : null, (x) => (x == null ? '—' : x.toFixed(1)));
  dom.metricAvgEntriesSub.textContent = t('metric.entriespertrade');

  // Avg duration
  const avgDur = data.avg_duration > 0 ? data.avg_duration : null;
  animateNumber(dom.metricAvgDuration, hasData ? avgDur : null, formatDuration);
  dom.metricAvgDurationSub.textContent = t('metric.pertrade');

  // Avg P&L — backend value, else total / count
  const avgPnl = data.avg_pnl ?? (total_trades > 0 ? total_pnl / total_trades : null);
  setMoney(dom.metricAvgPnl, dom.cardAvgPnl, hasData ? avgPnl : null);
  dom.metricAvgPnlSub.textContent = t('metric.pertrade');

  // Avg Daily / Weekly / Monthly — $ and ROE% averaged per active calendar period
  renderPeriodAverage(dom.metricAvgDaily, dom.metricAvgDailySub, dom.cardAvgDaily, data.avg_daily_pnl, data.avg_daily_roe);
  renderPeriodAverage(dom.metricAvgWeekly, dom.metricAvgWeeklySub, dom.cardAvgWeekly, data.avg_weekly_pnl, data.avg_weekly_roe);

  // Avg Monthly only means something once the period covers more than 2
  // calendar months — shorter windows collapse to 1-2 active month buckets,
  // which just echoes the weekly/total figures rather than a real average.
  const { start, end } = state.range;
  const monthlyMeaningful = !start || !end || monthsSpanned(start, end) > 2;
  if (monthlyMeaningful) {
    renderPeriodAverage(dom.metricAvgMonthly, dom.metricAvgMonthlySub, dom.cardAvgMonthly, data.avg_monthly_pnl, data.avg_monthly_roe);
    dom.cardAvgMonthly.classList.remove('is-muted');
  } else {
    animateNumber(dom.metricAvgMonthly, null, () => '—');
    dom.metricAvgMonthlySub.textContent = t('metric.monthlyneeds');
    applyCardColor(dom.cardAvgMonthly, '');
    dom.cardAvgMonthly.classList.add('is-muted');
  }
}

/** A combined $ + ROE% card (daily/weekly/monthly averages). */
function renderPeriodAverage(valueEl, subEl, cardEl, pnl, roe) {
  setMoney(valueEl, cardEl, state.metrics ? pnl : null);
  subEl.textContent = _num(roe) != null ? `${formatPercent(roe, 1, true)} ${t('metric.avgroe.short')}` : ' ';
}

/* ════════════════════════════════════════════════════════════
   TRADES TABLE
   ════════════════════════════════════════════════════════════ */

function applySortIndicators() {
  const { col, dir } = state.tableSort;
  document.querySelectorAll('.trades-table th[data-sort]').forEach(th => {
    const isActive = th.dataset.sort === col;
    th.classList.toggle('sort-active', isActive);
    th.setAttribute('aria-sort', isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.querySelector('.sort-arrow').textContent = isActive ? (dir === 'asc' ? '↑' : '↓') : '↕';
  });
}

function sortTrades(trades) {
  const { col, dir } = state.tableSort;
  const key = {
    date: (x) => tradeTime(x).getTime() || 0,
    pnl:  (x) => Number(x.pnl ?? 0),
    roe:  (x) => Number(x.roe ?? 0),
  }[col];
  if (!key) return trades;
  return [...trades].sort((a, b) => (dir === 'asc' ? key(a) - key(b) : key(b) - key(a)));
}

/** Table filters (symbol, side, search). `opts.ignoreSymbols` keeps every symbol. */
function applyTableFilters(trades, opts = {}) {
  const { symbols, side, search } = state.tableFilter;
  const q = search.trim().toLowerCase();
  return trades.filter(tr => {
    if (!opts.ignoreSymbols && symbols.size && !symbols.has((tr.symbol || '').toUpperCase())) return false;
    if (side && (tr.side || '').toLowerCase() !== side) return false;
    if (q) {
      const hay = `${tr.symbol || ''} ${tr.side || ''} ${tr.notes || ''} ${tr.source || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Stable hue per coin, so a symbol always gets the same dot colour. */
function symbolHue(sym) {
  let h = 0;
  for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function symbolHtml(symbol) {
  const s = String(symbol || '—').toUpperCase();
  const [base, quote] = s.includes('/') ? s.split('/') : [s, ''];
  return `<span class="sym"><i class="sym-dot" style="--h:${symbolHue(base)}">${escHtml(base.charAt(0))}</i>`
    + `<b>${escHtml(base)}</b>${quote ? `<span class="sym-quote">/${escHtml(quote)}</span>` : ''}</span>`;
}

function renderTradesTable(filtered) {
  const total = state.trades.length;
  dom.tradeCount.textContent = filtered.length === total
    ? `${total} ${t(total === 1 ? 'unit.trade' : 'unit.trades')}`
    : `${filtered.length} / ${total}`;
  applySortIndicators();

  state.selectedIds.clear();
  updateSelectionUI();

  if (!filtered.length) {
    const msg = total ? t('table.nomatch') : t('table.empty');
    dom.tradesBody.innerHTML = `<tr class="table-empty-row"><td colspan="15">${escHtml(msg)}</td></tr>`;
    return;
  }

  const rows = sortTrades(filtered);
  const maxAbs = Math.max(...rows.map(r => Math.abs(Number(r.pnl) || 0)), 1e-9);
  const thisYear = new Date().getFullYear();
  const loc = uiLocale();

  dom.tradesBody.innerHTML = rows.map((trade, i) => {
    const id      = escHtml(trade.id ?? '');
    const pnl     = Number(trade.pnl ?? 0);
    const tone    = _signTone(pnl);
    const side    = (trade.side ?? '').toLowerCase();
    const d       = tradeTime(trade);
    const dateTxt = isNaN(d) ? '—' : d.toLocaleDateString(loc, { month: 'short', day: 'numeric', ...(d.getFullYear() !== thisYear && { year: 'numeric' }) });
    const timeTxt = isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const dur     = trade.duration_minutes ?? calcDurationMinutes(trade.open_time, trade.close_time);
    const rr      = trade.risk_reward ?? trade.rr;
    const qty     = Number(trade.quantity);
    const roe     = _num(trade.roe);
    const sideTxt = side === 'long' ? t('filter.long') : side === 'short' ? t('filter.short') : '—';
    const flash   = String(trade.id) === String(state.flashId) ? ' row-new' : '';
    return `<tr data-id="${id}" class="${tone ? `row-${tone}` : ''}${flash}" style="--i:${Math.min(i, 20)}">
      <td class="td-check"><input type="checkbox" data-select="${id}" aria-label="Select trade" /></td>
      <td class="td-date"><span class="d-day">${escHtml(dateTxt)}</span><span class="d-time">${escHtml(timeTxt)}</span></td>
      <td>${symbolHtml(trade.symbol)}</td>
      <td><span class="side-chip side-${side || 'none'}">${side === 'long' ? '▲' : side === 'short' ? '▼' : ''} ${escHtml(sideTxt)}</span></td>
      <td class="td-num">${formatPrice(trade.entry_price)}</td>
      <td class="td-num">${formatPrice(trade.exit_price)}</td>
      <td class="td-num td-dim">${qty > 0 ? qty.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'}</td>
      <td class="td-num td-pnl ${tone}"><span class="pnl-bar" style="--w:${(Math.abs(pnl) / maxAbs * 100).toFixed(1)}%"></span><span class="pnl-val">${formatCurrency(pnl)}</span></td>
      <td class="td-num">${roe == null ? '—' : `<span class="roe-pill ${tone}">${formatPercent(roe, 2, true)}</span>`}</td>
      <td class="td-num td-dim">${_num(rr) != null ? formatRR(rr) : '—'}</td>
      <td class="td-num td-lev">${trade.leverage != null ? escHtml(Number(trade.leverage)) + '×' : '—'}</td>
      <td class="td-num td-dim">${formatDuration(dur)}</td>
      <td><span class="td-source">${escHtml(trade.source ?? 'manual')}</span></td>
      <td class="td-notes" title="${escHtml(trade.notes ?? '')}">${escHtml(trade.notes ?? '')}</td>
      <td class="td-actions">
        <button class="action-btn action-btn--edit" type="button" aria-label="Edit trade ${escHtml(trade.symbol ?? '')}"
          title="Edit" data-action="edit" data-id="${id}"><svg class="ico"><use href="#i-edit"/></svg></button>
        <button class="action-btn action-btn--delete" type="button" aria-label="Delete trade ${escHtml(trade.symbol ?? '')}"
          title="Delete" data-action="delete" data-id="${id}"><svg class="ico"><use href="#i-trash"/></svg></button>
      </td>
    </tr>`;
  }).join('');

  if (state.flashId != null) {
    dom.tradesBody.querySelector('.row-new')?.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' });
    state.flashId = null;
  }
}

/** Scroll to and pulse the rows of these trades (chart point / calendar day clicks). */
function focusTrades(ids) {
  const want = new Set(ids.map(String));
  dom.tradesBody.querySelectorAll('tr.trade-highlight').forEach(r => r.classList.remove('trade-highlight'));
  const rows = [...dom.tradesBody.querySelectorAll('tr[data-id]')].filter(r => want.has(r.dataset.id));
  if (!rows.length) {
    showToast(t('toast.hiddenbyfilter'), 'info');
    return;
  }
  rows.forEach(r => {
    r.classList.remove('trade-highlight');
    void r.offsetWidth;            // restart the pulse animation
    r.classList.add('trade-highlight');
  });
  rows[0].scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' });
}

/**
 * Quantity is always entered in USDT; show what that is in coins.
 */
function parseCoin(symbol) {
  if (!symbol) return 'COIN';
  return symbol.split('/')[0].trim().toUpperCase() || 'COIN';
}

function updateQtyConversion() {
  const entry = parseFloat(dom.fEntry.value);
  const qty   = parseFloat(dom.fQty.value);
  const coin  = parseCoin(dom.fSymbol.value);
  if (!isNaN(entry) && entry > 0 && !isNaN(qty) && qty > 0) {
    const coinAmt = qty / entry;
    const decimals = coinAmt < 0.001 ? 8 : coinAmt < 1 ? 6 : 4;
    dom.qtyConverted.textContent = coinAmt.toFixed(decimals) + ' ' + coin;
    dom.qtyConversion.hidden = false;
  } else {
    dom.qtyConversion.hidden = true;
  }
}

/** Real capital (margin) = position size / leverage. */
function updateNotional() {
  const qty      = parseFloat(dom.fQty.value);
  const leverage = parseFloat(dom.fLeverage.value);
  if (!isNaN(qty) && !isNaN(leverage) && leverage >= 1) {
    dom.leverageNotional.textContent = '$' + (qty / leverage).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    dom.leverageNotionalGroup.hidden = false;
  } else {
    dom.leverageNotional.textContent = '—';
    dom.leverageNotionalGroup.hidden = true;
  }
}

/** Duration in minutes between two ISO strings. */
function calcDurationMinutes(open, close) {
  if (!open || !close) return null;
  const ms = new Date(close) - new Date(open);
  return isNaN(ms) ? null : ms / 60000;
}

/* ════════════════════════════════════════════════════════════
   ADD / UPDATE TRADE
   ════════════════════════════════════════════════════════════ */

async function saveTrade(id, tradeData) {
  const editing = id != null;
  dom.submitBtn.disabled = true;
  dom.submitBtn.textContent = t(editing ? 'modal.saving' : 'modal.adding');
  dom.formError.hidden = true;
  try {
    const saved = await apiFetch(editing ? `/trades/${id}` : '/trades', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify(tradeData),
    });
    closeAddModal();
    state.flashId = saved?.id ?? id;
    showToast(t(editing ? 'toast.trade.updated' : 'toast.trade.added'), 'success');
    await refreshAll();
  } catch (err) {
    dom.formError.textContent = `${t('form.error')} ${err.message}`;
    dom.formError.hidden = false;
  } finally {
    dom.submitBtn.disabled = false;
    dom.submitBtn.textContent = t(state.editingId != null ? 'modal.submit.edit' : 'modal.submit.add');
  }
}

/* ════════════════════════════════════════════════════════════
   SELECTION + DELETE
   ════════════════════════════════════════════════════════════ */

function updateSelectionUI() {
  const count = state.selectedIds.size;
  dom.selectedCount.textContent = count;
  dom.bulkDeleteBtn.hidden = count === 0;
  const total = dom.tradesBody.querySelectorAll('input[data-select]').length;
  dom.selectAll.indeterminate = count > 0 && count < total;
  dom.selectAll.checked = total > 0 && count === total;
}

function openConfirmModal(ids) {
  state.pendingDelete = { ids };
  const many = ids.length > 1;
  dom.confirmTitle.textContent = many ? `${t('confirm.title.many')} (${ids.length})` : t('confirm.title');
  dom.confirmMsg.textContent = many ? `${ids.length} ${t('confirm.msg.many')}` : t('confirm.msg');
  dom.confirmBackdrop.hidden = false;
  dom.confirmDeleteBtn.focus();
  document.body.style.overflow = 'hidden';
}

function closeConfirmModal() {
  dom.confirmBackdrop.hidden = true;
  document.body.style.overflow = '';
  state.pendingDelete = null;
}

async function confirmDelete() {
  const ids = state.pendingDelete?.ids;
  if (!ids?.length) return;
  dom.confirmDeleteBtn.disabled = true;
  dom.confirmDeleteBtn.textContent = t('confirm.deleting');
  try {
    if (ids.length === 1) {
      await apiFetch(`/trades/${ids[0]}`, { method: 'DELETE' });
      showToast(t('toast.trade.deleted'), 'success');
    } else {
      await apiFetch('/trades/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
      showToast(`${ids.length} ${t('toast.bulk.deleted')}`, 'success');
    }
    closeConfirmModal();
    await refreshAll();
  } catch (err) {
    showToast(`${t(ids.length === 1 ? 'toast.delete.fail' : 'toast.bulk.fail')} ${err.message}`, 'error');
  } finally {
    dom.confirmDeleteBtn.disabled = false;
    dom.confirmDeleteBtn.textContent = t('confirm.delete');
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

  const delims = ['\t', ',', ';', '|'];
  let delim = ',';
  for (const d of delims) {
    if (lines[0].includes(d)) { delim = d; break; }
  }

  const headerLine = lines[0].replace(/^﻿/, '');
  const headers = headerLine.split(delim).map(h => h.trim().toLowerCase());
  const qtyIdx = headers.findIndex(h => ['quantity', 'qty', 'size', 'amount', 'contracts', 'volume'].includes(h));

  if (qtyIdx === -1) {
    const out = lines.map((line, i) => {
      if (!line.trim()) return line;
      return line.trimEnd() + delim + (i === 0 ? 'quantity' : '0');
    });
    return new File([out.join('\n')], file.name, { type: 'text/csv' });
  }

  const out = lines.map((line, i) => {
    if (i === 0 || !line.trim()) return line;
    const cols = line.split(delim);
    if (!cols[qtyIdx] || !cols[qtyIdx].trim()) cols[qtyIdx] = '0';
    return cols.join(delim);
  });
  return new File([out.join('\n')], file.name, { type: 'text/csv' });
}

/** Swap a toolbar button's text while keeping its icon. */
function setBtnText(btn, text) {
  btn.querySelector('span').textContent = text;
}

async function importCSV(rawFile) {
  const file = await _patchCSVQuantity(rawFile);
  const formData = new FormData();
  formData.append('file', file);

  dom.importBtn.disabled = true;
  setBtnText(dom.importBtn, t('toolbar.importing'));

  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/import`, {
      method: 'POST',
      body: formData,
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    const result = await res.json();
    const hasErrors = result.errors && result.errors.length > 0;
    let msg = `${t('toast.import.ok')} ${result.imported} ${t('unit.trades')}.`;
    if (result.skipped) msg += ` ${result.skipped} ${t('toast.import.skipped')}`;
    if (hasErrors) msg += ` ${result.errors.length} ${t('toast.import.rowsfailed')}`;
    showToast(msg, hasErrors ? 'info' : 'success', 8000);
    if (hasErrors) {
      console.warn('Import row errors:\n' + result.errors.join('\n'));
      const preview = result.errors.slice(0, 3).join('\n') + (result.errors.length > 3 ? `\n… +${result.errors.length - 3}` : '');
      showToast(preview, 'error', 12000);
    }
    await refreshAll();
  } catch (err) {
    showToast(`${t('toast.import.fail')} ${err.message}`, 'error', 8000);
    console.error('Import error:', err);
  } finally {
    dom.importBtn.disabled = false;
    setBtnText(dom.importBtn, t('toolbar.import'));
    dom.csvFileInput.value = '';
  }
}

async function exportCSV() {
  dom.exportBtn.disabled = true;
  setBtnText(dom.exportBtn, t('toolbar.exporting'));
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/export${buildQuery(getDateRange())}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    downloadBlob(await res.blob(), `trades_export_${isoDay(new Date())}.csv`);
  } catch (err) {
    showToast(`${t('toast.export.fail')} ${err.message}`, 'error', 6000);
  } finally {
    dom.exportBtn.disabled = false;
    setBtnText(dom.exportBtn, t('toolbar.export'));
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadTemplate() {
  const headers = 'symbol,side,entry_price,exit_price,quantity,pnl,roe,leverage,risk_reward,entries,open_time,close_time,notes';
  const example = 'BTC/USDT,long,60000,62000,0.1,200,3.33,10,2.0,1,2024-01-01T10:00:00,2024-01-01T12:00:00,Example trade';
  downloadBlob(new Blob([headers + '\n' + example], { type: 'text/csv' }), 'trades_template.csv');
}

/* ════════════════════════════════════════════════════════════
   CHART — equity curve, daily P&L bars, drawdown (underwater)
   ════════════════════════════════════════════════════════════ */

/** Theme colours for canvas charts, read from the CSS variables. */
function chartPalette() {
  return {
    up:      cssVar('--green'),
    down:    cssVar('--red'),
    accent:  cssVar('--accent-primary'),
    text:    cssVar('--text-secondary'),
    muted:   cssVar('--text-muted'),
    grid:    cssVar('--chart-grid') || cssVar('--border-subtle'),
    tipBg:   cssVar('--bg-elevated'),
    tipText: cssVar('--text-primary'),
    border:  cssVar('--border-default'),
    font:    cssVar('--font-mono'),
  };
}

/** Vertical crosshair under the hovered point. */
const crosshairPlugin = {
  id: 'ttCrosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = chart.options.plugins.ttCrosshair.color;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/** Series for the active chart mode. Every point keeps the trades behind it. */
function chartSeries(trades, mode) {
  const sorted = trades
    .filter(x => x.close_time || x.open_time)
    .sort((a, b) => tradeTime(a) - tradeTime(b));
  const loc = uiLocale();
  const dayLabel = (d) => d.toLocaleDateString(loc, { month: 'short', day: 'numeric' });

  if (mode === 'daily') {
    const days = new Map();
    for (const tr of sorted) {
      const key = isoDay(tradeTime(tr));
      if (!days.has(key)) days.set(key, { pnl: 0, ids: [] });
      const d = days.get(key);
      d.pnl += Number(tr.pnl ?? 0);
      d.ids.push(tr.id);
    }
    const keys = [...days.keys()];
    return {
      labels: keys.map(k => dayLabel(parseDay(k))),
      values: keys.map(k => +days.get(k).pnl.toFixed(2)),
      ids:    keys.map(k => days.get(k).ids),
    };
  }

  let cum = 0;
  let peak = 0;
  const labels = [], values = [], ids = [], pnls = [];
  for (const tr of sorted) {
    const p = Number(tr.pnl ?? 0);
    cum += p;
    peak = Math.max(peak, cum);
    labels.push(dayLabel(tradeTime(tr)));
    values.push(+(mode === 'drawdown' ? cum - peak : cum).toFixed(2));
    ids.push([tr.id]);
    pnls.push(p);
  }
  return { labels, values, ids, pnls };
}

function renderChart(trades) {
  const canvas = dom.pnlChart;
  if (state.pnlChart) {
    state.pnlChart.destroy();
    state.pnlChart = null;
  }
  if (!trades.length || typeof Chart === 'undefined') {
    dom.chartEmpty.hidden = false;
    canvas.hidden = true;
    return;
  }
  dom.chartEmpty.hidden = true;
  canvas.hidden = false;

  const mode = state.chartMode;
  const pal = chartPalette();
  const { labels, values, ids, pnls } = chartSeries(trades, mode);
  const last = values[values.length - 1] ?? 0;
  const ctx = canvas.getContext('2d');
  const h = canvas.parentElement.clientHeight || 300;
  const money = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const axisMoney = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  let dataset;
  if (mode === 'daily') {
    dataset = {
      type: 'bar',
      data: values,
      backgroundColor: values.map(v => withAlpha(v >= 0 ? pal.up : pal.down, 0.75)),
      hoverBackgroundColor: values.map(v => (v >= 0 ? pal.up : pal.down)),
      borderRadius: 4,
      maxBarThickness: 28,
    };
  } else {
    const base = mode === 'drawdown' ? pal.down : (last >= 0 ? pal.up : pal.down);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    if (mode === 'drawdown') {
      grad.addColorStop(0, withAlpha(base, 0.02));
      grad.addColorStop(1, withAlpha(base, 0.35));
    } else {
      grad.addColorStop(0, withAlpha(base, 0.32));
      grad.addColorStop(0.65, withAlpha(base, 0.06));
      grad.addColorStop(1, withAlpha(base, 0));
    }
    const many = values.length > 80;
    dataset = {
      type: 'line',
      data: values,
      borderColor: base,
      borderWidth: 2.2,
      backgroundColor: grad,
      fill: mode === 'drawdown' ? 'origin' : 'start',
      tension: 0.32,
      pointBackgroundColor: mode === 'equity' ? pnls.map(p => (p >= 0 ? pal.up : pal.down)) : base,
      pointBorderColor: 'transparent',
      pointRadius: values.map((_, i) => (i === values.length - 1 ? 5 : many ? 0 : 2.5)),
      pointHoverRadius: 6,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: pal.tipBg,
    };
  }

  state.pnlChart = new Chart(ctx, {
    data: { labels, datasets: [dataset] },
    plugins: [crosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: REDUCED_MOTION ? false : { duration: 900, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      onHover(evt, els) { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      onClick(evt, els) {
        if (els.length) focusTrades(ids[els[0].index] || []);
      },
      plugins: {
        legend: { display: false },
        ttCrosshair: { color: withAlpha(pal.text, 0.45) },
        tooltip: {
          backgroundColor: withAlpha(pal.tipBg, 0.96),
          borderColor: pal.border,
          borderWidth: 1,
          titleColor: pal.text,
          bodyColor: pal.tipText,
          titleFont: { family: pal.font, size: 11 },
          bodyFont: { family: pal.font, size: 13, weight: '700' },
          padding: 10,
          cornerRadius: 10,
          displayColors: false,
          callbacks: {
            label(c) {
              const v = c.parsed.y;
              if (mode === 'equity') {
                const p = pnls[c.dataIndex];
                return [`${t('chart.cum')} ${money(v)}`, `${t('chart.trade')} ${money(p)}`];
              }
              if (mode === 'daily') return `${money(v)} · ${ids[c.dataIndex].length} ${t(ids[c.dataIndex].length === 1 ? 'unit.trade' : 'unit.trades')}`;
              return `${t('chart.belowpeak')} ${money(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: pal.muted, font: { family: pal.font, size: 10 }, maxTicksLimit: 8, maxRotation: 0, autoSkip: true },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: { color: pal.muted, font: { family: pal.font, size: 10 }, callback: axisMoney, maxTicksLimit: 6 },
          grid: { color: pal.grid },
          border: { display: false },
        },
      },
    },
  });
}

/* ════════════════════════════════════════════════════════════
   MODAL HELPERS
   ════════════════════════════════════════════════════════════ */

/** ISO string → value for <input type="datetime-local"> (wall-clock, minutes). */
function toLocalInput(iso) {
  return iso ? String(iso).replace(' ', 'T').slice(0, 16) : '';
}

function openAddModal() {
  state.editingId = null;
  dom.tradeForm.reset();
  dom.formError.hidden = true;
  dom.modalBackdrop.querySelector('.modal-title').textContent = t('modal.addtrade');
  dom.submitBtn.textContent = t('modal.submit.add');
  dom.submitBtn.disabled = false;
  dom.qtyConversion.hidden = true;
  dom.leverageNotionalGroup.hidden = true;
  dom.modalBackdrop.hidden = false;
  dom.fSymbol.focus();
  document.body.style.overflow = 'hidden';
}

function openEditModal(id) {
  const trade = state.trades.find(x => String(x.id) === String(id));
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

  // The form takes USDT and the backend stores coins (qty / entry on save, for
  // either side), so the reverse is coins x entry for either side too.
  const entry = parseFloat(trade.entry_price);
  dom.fQty.value = entry > 0 && trade.quantity != null ? +(trade.quantity * entry).toFixed(2) : (trade.quantity ?? '');

  dom.fOpenTime.value  = toLocalInput(trade.open_time);
  dom.fCloseTime.value = toLocalInput(trade.close_time);

  updateQtyConversion();
  updateNotional();
  dom.modalBackdrop.hidden = false;
  dom.fSymbol.focus();
  document.body.style.overflow = 'hidden';
}

function closeAddModal() {
  state.editingId = null;
  dom.modalBackdrop.hidden = true;
  document.body.style.overflow = '';
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
  const qtyRaw      = (!isNaN(entryRaw) && entryRaw > 0) ? qtyUsdt / entryRaw : qtyUsdt;
  const pnlRaw      = parseFloat(dom.fPnl.value);
  const roeRaw      = parseFloat(dom.fRoe.value);
  const leverageRaw = dom.fLeverage.value ? parseFloat(dom.fLeverage.value) : null;
  const rrRaw       = dom.fRR.value ? parseFloat(dom.fRR.value) : null;
  const entriesRaw  = dom.fEntries.value ? parseInt(dom.fEntries.value, 10) : null;
  const openTime    = dom.fOpenTime.value;
  const closeTime   = dom.fCloseTime.value;
  const notes       = dom.fNotes.value.trim() || null;

  const errors = [];
  if (!symbol)           errors.push(t('form.err.symbol'));
  if (!side)             errors.push(t('form.err.side'));
  if (isNaN(entryRaw))   errors.push(t('form.err.entry'));
  if (isNaN(exitRaw))    errors.push(t('form.err.exit'));
  if (isNaN(qtyRaw) || qtyRaw <= 0) errors.push(t('form.err.qty'));
  if (isNaN(pnlRaw))     errors.push(t('form.err.pnl'));
  if (isNaN(roeRaw))     errors.push(t('form.err.roe'));
  if (!openTime)         errors.push(t('form.err.open'));
  if (!closeTime)        errors.push(t('form.err.close'));
  if (openTime && closeTime && closeTime <= openTime) errors.push(t('form.err.order'));

  if (errors.length) {
    dom.formError.textContent = errors.join(' ');
    dom.formError.hidden = false;
    return;
  }

  // Times are sent as the wall-clock the form shows (no UTC shift), the same
  // way the table reads them back — so editing a trade never moves its times.
  saveTrade(state.editingId, {
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
    open_time:   `${openTime}:00`,
    close_time:  `${closeTime}:00`,
    notes,
    source:      'manual',
  });
}

/* ════════════════════════════════════════════════════════════
   AUTH
   ════════════════════════════════════════════════════════════ */

function showLoginScreen() {
  document.getElementById('loginScreen').hidden = false;
  document.getElementById('userInfo').hidden = true;
  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled = false;
  loginBtn.textContent = t('login.submit');
  loginCanvas?.start();
}

function showApp(user) {
  document.getElementById('loginScreen').hidden = true;
  loginCanvas?.stop();
  document.getElementById('userInfo').hidden = false;
  document.getElementById('userNameDisplay').textContent = user.username;
  document.getElementById('userAvatar').textContent = (user.username || '?').charAt(0).toUpperCase();
  setConnectionStatus('', t('header.connecting'));
  document.dispatchEvent(new CustomEvent('illustrade:login'));
}

async function doLogin(username, password) {
  const loginBtn   = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');
  loginBtn.disabled = true;
  loginError.hidden = true;

  const MAX_RETRIES  = 10;
  const RETRY_DELAY  = 6000; // ms between retries while server wakes up

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    loginBtn.textContent = attempt === 0 ? t('login.signingin') : `${t('login.waking')} (${attempt}/${MAX_RETRIES})`;
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || t('login.failed'));
      }
      const data = await res.json();
      saveAuth(data.access_token, data.user);
      document.getElementById('loginPassword').value = '';
      showApp(data.user);
      await refreshAll();
      return;
    } catch (err) {
      // TypeError means a network/CORS failure (server sleeping or not yet up).
      // Retry those; surface real HTTP errors (wrong password, etc.) immediately.
      if (err instanceof TypeError && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue;
      }
      loginError.textContent = attempt >= MAX_RETRIES ? t('login.timeout') : err.message;
      loginError.hidden = false;
      break;
    }
  }

  loginBtn.disabled = false;
  loginBtn.textContent = t('login.submit');
}

function doLogout() {
  clearAuth();
  _loadSeq++;   // drop any load still in flight for the previous user
  state.loaded = false;
  state.trades = [];
  state.metrics = null;
  state.selectedIds.clear();
  state.tableFilter = { symbols: new Set(), side: '', search: '' };
  dom.tfSearch.value = '';
  syncSideSeg();
  closeUserMenu();
  populateSymbolList();
  renderAll();
  document.dispatchEvent(new CustomEvent('illustrade:logout'));
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
  panelEl.hidden = true;
  btnEl.classList.remove('is-open');
}

function populateSymbolList() {
  const counts = new Map();
  for (const tr of state.trades) {
    const sym = (tr.symbol || '').toUpperCase();
    if (sym) counts.set(sym, (counts.get(sym) || 0) + 1);
  }
  // Drop selections for symbols that are no longer in the period
  for (const sym of [...state.tableFilter.symbols]) if (!counts.has(sym)) state.tableFilter.symbols.delete(sym);

  dom.tfSymbolList.innerHTML = [...counts.keys()].sort().map(sym => `
    <label class="tf-symbol-item" data-sym="${escHtml(sym)}">
      <input type="checkbox" data-sym="${escHtml(sym)}" ${state.tableFilter.symbols.has(sym) ? 'checked' : ''} />
      ${symbolHtml(sym)}<span class="tf-symbol-count">${counts.get(sym)}</span>
    </label>`).join('') || `<div class="tf-symbol-empty">${escHtml(t('table.empty.short'))}</div>`;
  updateSymbolLabel();
}

function updateSymbolLabel() {
  const { symbols } = state.tableFilter;
  dom.tfSymbolLabel.textContent = symbols.size === 0 ? t('filter.allsymbols')
    : symbols.size === 1 ? [...symbols][0]
    : `${symbols.size} ${t('filter.symbols')}`;
  dom.tfSymbolBtn.classList.toggle('is-filtered', symbols.size > 0);
}

/** Add or remove one symbol from the table filter (also used by the leaderboard). */
function toggleSymbolFilter(sym) {
  const s = state.tableFilter.symbols;
  if (s.has(sym)) s.delete(sym); else s.add(sym);
  dom.tfSymbolList.querySelectorAll('input[data-sym]').forEach(cb => { cb.checked = s.has(cb.dataset.sym); });
  updateSymbolLabel();
  renderFiltered();
}

function clearTableFilters() {
  state.tableFilter.symbols.clear();
  state.tableFilter.side = '';
  state.tableFilter.search = '';
  dom.tfSearch.value = '';
  dom.tfSymbolList.querySelectorAll('input[data-sym]').forEach(cb => { cb.checked = false; });
  syncSideSeg();
  updateSymbolLabel();
  renderFiltered();
}

function syncSideSeg() {
  dom.sideSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('is-active', b.dataset.side === state.tableFilter.side));
}

/** Chip on the chart telling that table filters shape what it shows. */
function updateFilterChip() {
  const { symbols, side, search } = state.tableFilter;
  const parts = [];
  if (symbols.size) parts.push(symbols.size === 1 ? [...symbols][0] : `${symbols.size} ${t('filter.symbols')}`);
  if (side) parts.push(t(side === 'long' ? 'filter.long' : 'filter.short'));
  if (search.trim()) parts.push(`“${search.trim()}”`);
  dom.chartFilterChip.hidden = !parts.length;
  dom.chartFilterChip.innerHTML = parts.length
    ? `${escHtml(t('chart.filtered'))}: <b>${escHtml(parts.join(' · '))}</b><svg class="ico ico-sm"><use href="#i-close"/></svg>`
    : '';
  dom.chartFilterChip.title = t('chart.clearfilters');
}

/* ── Header user menu ─────────────────────────────────────── */
function closeUserMenu() {
  dom.userMenu.hidden = true;
  dom.userMenuBtn.setAttribute('aria-expanded', 'false');
}

/* ════════════════════════════════════════════════════════════
   EVENT LISTENERS — bound exactly once, at page load
   ════════════════════════════════════════════════════════════ */

/** True while the user is typing somewhere (keyboard shortcuts stay off). */
function isTyping(e) {
  const el = e.target;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

function anyModalOpen() {
  return [...document.querySelectorAll('.modal-backdrop')].some(m => !m.hidden)
    || document.querySelector('.calc-open, .mc-screen.mc-open') != null;
}

function handleKeydown(e) {
  if (e.key === 'Escape') {
    if (!dom.confirmBackdrop.hidden) closeConfirmModal();
    else if (!dom.modalBackdrop.hidden) closeAddModal();
    closePanel(dom.tfDatePanel, dom.tfDateBtn);
    closePanel(dom.tfSymbolPanel, dom.tfSymbolBtn);
    closeUserMenu();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || anyModalOpen() || !getToken()) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openAddModal(); }
  if (e.key === '/') { e.preventDefault(); dom.tfSearch.focus(); }
}

function bindEvents() {
  // Header user menu
  dom.userMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dom.userMenu.hidden;
    dom.userMenu.hidden = !open;
    dom.userMenuBtn.setAttribute('aria-expanded', String(open));
  });
  dom.userMenu.addEventListener('click', (e) => { if (e.target.closest('.user-menu-item')) closeUserMenu(); });
  document.getElementById('logoutBtn').addEventListener('click', doLogout);

  // Period presets
  dom.periodSeg.querySelectorAll('.period-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => setPeriod(btn.dataset.preset));
  });

  // Custom range panel
  dom.tfDateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(dom.tfDatePanel, dom.tfDateBtn);
    if (!dom.tfDatePanel.hidden) closePanel(dom.tfSymbolPanel, dom.tfSymbolBtn);
  });
  dom.tfApplyDate.addEventListener('click', () => {
    let start = dom.tfStartDate.value || null;
    let end   = dom.tfEndDate.value   || null;
    if (start && end && start > end) [start, end] = [end, start];
    closePanel(dom.tfDatePanel, dom.tfDateBtn);
    if (!start && !end) setPeriod('all');
    else setPeriod('custom', start, end);
  });

  dom.addTradeBtn.addEventListener('click', openAddModal);

  // Symbol dropdown
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
      item.hidden = !(item.dataset.sym || '').toLowerCase().includes(q);
    });
  });
  dom.tfSymbolList.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-sym]');
    if (cb) toggleSymbolFilter(cb.dataset.sym);
  });
  dom.tfSymbolClear.addEventListener('click', () => {
    state.tableFilter.symbols.clear();
    dom.tfSymbolList.querySelectorAll('input[data-sym]').forEach(cb => { cb.checked = false; });
    updateSymbolLabel();
    renderFiltered();
  });

  // Side
  dom.sideSeg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.tableFilter.side = b.dataset.side;
    syncSideSeg();
    renderFiltered();
  });

  // Free-text search (debounced so typing stays smooth)
  let searchTimer = 0;
  dom.tfSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.tableFilter.search = dom.tfSearch.value;
      renderFiltered();
    }, 160);
  });

  dom.chartFilterChip.addEventListener('click', clearTableFilters);

  // Chart mode
  dom.chartModeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b || b.dataset.mode === state.chartMode) return;
    state.chartMode = b.dataset.mode;
    dom.chartModeSeg.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('is-active', x === b));
    renderChart(applyTableFilters(state.trades));
  });
  document.addEventListener('illustrade:theme', () => { if (state.loaded) renderChart(applyTableFilters(state.trades)); });

  // Close floating panels on outside press. mousedown fires before the native
  // date picker opens, so the panel stays open while a date is being picked.
  document.addEventListener('mousedown', (e) => {
    if (!dom.tfDateDropdown.contains(e.target))   closePanel(dom.tfDatePanel, dom.tfDateBtn);
    if (!dom.tfSymbolDropdown.contains(e.target)) closePanel(dom.tfSymbolPanel, dom.tfSymbolBtn);
    if (!dom.userMenu.hidden && !e.target.closest('#userInfo')) closeUserMenu();
  });

  // CSV import / export / template
  dom.importBtn.addEventListener('click', () => dom.csvFileInput.click());
  dom.csvFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importCSV(file);
  });
  dom.exportBtn.addEventListener('click', exportCSV);
  dom.templateBtn.addEventListener('click', downloadTemplate);

  // Live quantity unit + coin conversion, and real capital
  [dom.fSymbol, dom.fEntry, dom.fQty].forEach(el => el.addEventListener('input', updateQtyConversion));
  [dom.fQty, dom.fLeverage].forEach(el => el.addEventListener('input', updateNotional));

  // Add/Edit modal
  dom.modalClose.addEventListener('click', closeAddModal);
  dom.cancelBtn.addEventListener('click', closeAddModal);
  dom.modalBackdrop.addEventListener('click', (e) => { if (e.target === dom.modalBackdrop) closeAddModal(); });
  dom.tradeForm.addEventListener('submit', handleFormSubmit);

  // Delete confirm modal
  dom.confirmClose.addEventListener('click', closeConfirmModal);
  dom.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  dom.confirmDeleteBtn.addEventListener('click', confirmDelete);
  dom.confirmBackdrop.addEventListener('click', (e) => { if (e.target === dom.confirmBackdrop) closeConfirmModal(); });

  // Sort column headers
  document.querySelectorAll('.trades-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.tableSort.col === col) {
        state.tableSort.dir = state.tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.tableSort = { col, dir: 'desc' };
      }
      renderTradesTable(applyTableFilters(state.trades));
    });
  });

  // Row actions
  dom.tradesBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'delete') openConfirmModal([btn.dataset.id]);
    if (btn.dataset.action === 'edit') openEditModal(btn.dataset.id);
  });

  // Row checkboxes
  dom.tradesBody.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-select]');
    if (!cb) return;
    const id = Number(cb.dataset.select);
    if (cb.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    cb.closest('tr').classList.toggle('is-selected', cb.checked);
    updateSelectionUI();
  });
  dom.selectAll.addEventListener('change', () => {
    dom.tradesBody.querySelectorAll('input[data-select]').forEach(cb => {
      const id = Number(cb.dataset.select);
      cb.checked = dom.selectAll.checked;
      cb.closest('tr').classList.toggle('is-selected', cb.checked);
      if (cb.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    });
    updateSelectionUI();
  });
  dom.bulkDeleteBtn.addEventListener('click', () => {
    if (state.selectedIds.size) openConfirmModal([...state.selectedIds]);
  });

  dom.retryBtn.addEventListener('click', refreshAll);
  document.addEventListener('keydown', handleKeydown);
}

/* ════════════════════════════════════════════════════════════
   INITIALISE
   ════════════════════════════════════════════════════════════ */

async function init() {
  loadPeriod();
  applyTheme(localStorage.getItem(_THEME_KEY) || 'dark');
  applyLang(localStorage.getItem(_LANG_KEY) || 'en');
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('loginThemeToggle').addEventListener('click', toggleTheme);
  initLangDropdowns();
  initBgCanvas();
  loginCanvas = initLoginCanvas();
  bindLoginEvents();
  bindEvents();
  renderAll();

  const token = getToken();
  const user  = getStoredUser();

  if (token && user) {
    // Show the login screen locked while the stored token is verified
    document.getElementById('loginScreen').hidden = false;
    const verifyBtn = document.getElementById('loginBtn');
    verifyBtn.disabled = true;
    verifyBtn.textContent = t('login.verifying');
    try {
      const res = await fetch(`${API_BASE}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error('token_invalid');
      const currentUser = await res.json();
      saveAuth(token, currentUser);
      showApp(currentUser);
      await refreshAll();
      return;
    } catch (err) {
      // Only clear stored credentials on an explicit auth rejection. A network
      // failure (TypeError) means the server is sleeping — keep the token.
      if (err.message === 'token_invalid') clearAuth();
    }
  }

  showLoginScreen();

  // If a stored user exists (server was just sleeping), pre-fill the username
  const storedUser = getStoredUser();
  if (storedUser?.username) {
    const usernameEl = document.getElementById('loginUsername');
    if (!usernameEl.value) usernameEl.value = storedUser.username;
    document.getElementById('loginPassword').focus();
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

  const TRADE_COLORS = ['var(--accent-primary)', '#7ab8ff', '#c17aff', '#ffb400', '#ff7a7a'];
  const ENTRY_COLORS = ['var(--accent-primary)', '#7affcc', '#7ab8ff', '#c17aff'];
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
      const color = TRADE_COLORS[i] || TRADE_COLORS[0];
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

    const pal = chartPalette();
    const poolColor  = pal.up;
    const benchColor = pal.muted;

    const ctx = $id('poolGrowthChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0,   withAlpha(poolColor, 0.2));
    gradient.addColorStop(1,   withAlpha(poolColor, 0));

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
            backgroundColor: withAlpha(pal.tipBg, 0.96),
            borderColor: pal.border,
            borderWidth: 1,
            titleColor: pal.text,
            bodyColor: pal.tipText,
            callbacks: {
              label: (tCtx) => `${tCtx.dataset.label}: ${fmt(tCtx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: pal.muted, maxTicksLimit: 8 } },
          y: { grid: { color: pal.grid }, border: { display: false }, ticks: { color: pal.muted, callback: (v) => '$' + Number(v).toLocaleString('en-US') } },
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
    // Wipe the numbers, never the structure: the same page may sign the owner in again
    sec.querySelectorAll('.pool-card-value, .pool-card-sub, #poolChartLegend, #poolPieContainer, #poolStaleBadge, #poolDeficitNote, #poolConcentrationWarning')
      .forEach(el => { el.textContent = ''; });
    if (growthChart) { growthChart.destroy(); growthChart = null; }
    showError(null);
  }
  document.addEventListener('illustrade:logout', lockPool);
  // Pool chart colours come from the theme
  document.addEventListener('illustrade:theme', () => { if (growthChart) renderGrowthChart(); });
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
