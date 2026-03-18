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
const _LANG_KEY   = 'tt_lang';
let   _currentLang = 'en';

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

  // Language toggle button labels
  ['langToggle', 'loginLangToggle'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.querySelector('.lang-label').textContent = lang.toUpperCase();
  });

  // Default date filter label
  const tfDateLabel = document.getElementById('tfDateLabel');
  if (tfDateLabel && tfDateLabel.textContent) {
    tfDateLabel.textContent = t('filter.last30');
  }

  // Symbol filter labels
  const tfSymbolLabel = document.getElementById('tfSymbolLabel');
  if (tfSymbolLabel) tfSymbolLabel.textContent = t('filter.allsymbols');
}

function toggleLang() {
  applyLang(_currentLang === 'en' ? 'es' : 'en');
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
  metricAvgDuration:    $('metricAvgDuration'),
  metricAvgDurationSub: $('metricAvgDurationSub'),

  cardWinRate:    $('card-winRate'),
  cardPnl:        $('card-pnl'),
  cardDrawdown:   $('card-drawdown'),
  cardRR:         $('card-rr'),
  cardStreak:     $('card-streak'),
  cardTotal:      $('card-total'),
  cardAvgRoe:     $('card-avgRoe'),
  cardAvgEntries:  $('card-avgEntries'),
  cardAvgDuration: $('card-avgDuration'),

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
  const cards = [dom.metricWinRate, dom.metricPnl, dom.metricDrawdown, dom.metricRR, dom.metricStreak, dom.metricTotal, dom.metricAvgRoe, dom.metricAvgEntries, dom.metricAvgDuration];
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

  // Max Drawdown
  dom.metricDrawdown.textContent = max_drawdown != null ? formatCurrency(max_drawdown) : '—';
  dom.metricDrawdown.classList.remove('skeleton');
  dom.metricDrawdownSub.textContent = t('metric.peaktotrough');
  applyCardColor(dom.cardDrawdown, 'negative');

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
  trades = filtered;

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

async function importCSV(file) {
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
    const msg = `${t('toast.import.ok')} ${result.imported} trade(s).` +
      (result.errors.length ? ` ${result.errors.length} ${t('toast.import.skipped')}` : '');
    showToast(msg, result.errors.length ? 'info' : 'success', 6000);
    if (result.errors.length) console.warn('Import row errors:', result.errors);
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
   AUTH
   ════════════════════════════════════════════════════════════ */

function showLoginScreen() {
  document.getElementById('loginScreen').hidden = false;
  document.getElementById('userInfo').hidden = true;
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
  loginBtn.textContent = 'Signing in…';
  loginError.hidden = true;

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
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
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
  document.getElementById('langToggle')?.addEventListener('click', toggleLang);
  document.getElementById('loginLangToggle')?.addEventListener('click', toggleLang);
  initBgCanvas();
  initLoginCanvas();

  // Always wire the login form first (it's in the DOM from page load)
  bindLoginEvents();

  const token = getToken();
  const user  = getStoredUser();

  if (token && user) {
    // Verify the stored token is still accepted by the server
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('token invalid');
      const currentUser = await res.json();
      saveAuth(token, currentUser);   // refresh stored user data
      showApp(currentUser);
      setDefaultDateRange();
      bindEvents();
      setConnectionStatus('', 'Connecting…');
      await refreshAll();
      return;
    } catch {
      clearAuth();
    }
  }

  showLoginScreen();
}

document.addEventListener('DOMContentLoaded', init);
