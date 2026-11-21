/* ════════════════════════════════════════════════════════════
   MARKET — live ticker tape (header) + sessions clock (command bar)

   Ticker tape: real last prices from GET /market/pulse (Bitunix futures,
   proxied by the backend because Bitunix has no CORS). BTC and ETH always,
   then the coins traded in the selected period, then a few majors. Polls
   every 10 s while the tab is visible; a price that moved flashes up/down.
   Nothing is simulated: if the feed is down the tape says so.

   Sessions clock: local time plus Tokyo / London / New York cash-session
   status, computed in each city's own time zone (so DST is handled).
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const POLL_MS = 10000;
  const MAX_SYMBOLS = 10;
  const ALWAYS = ['BTCUSDT', 'ETHUSDT'];
  const MAJORS = ['SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'HBARUSDT', 'SUIUSDT'];

  const tape  = document.getElementById('tape');
  const track = document.getElementById('tapeTrack');
  const tapeState = document.getElementById('tapeState');

  let active = false;
  let timer = 0;
  let symbols = [];
  const last = new Map();      // symbol -> last price shown (for the flash direction)
  let everLoaded = false;

  /* ── Symbols to show ───────────────────────────────────────── */
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function wantedSymbols() {
    const counts = new Map();
    for (const tr of state.trades) {
      const sym = norm(tr.symbol);
      if (/^[A-Z0-9]{2,20}USDT$/.test(sym)) counts.set(sym, (counts.get(sym) || 0) + 1);
    }
    const traded = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    return [...new Set([...ALWAYS, ...traded, ...MAJORS])].slice(0, MAX_SYMBOLS);
  }

  /* ── Formatting ────────────────────────────────────────────── */
  function px(v) {
    const a = Math.abs(v);
    const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function spark(values) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * 60).toFixed(1)},${(17 - (v - min) / span * 14).toFixed(1)}`);
    return `<polyline points="${pts.join(' ')}"/>`;
  }

  /* ── Tape DOM: two identical groups so the marquee loops seamlessly ── */
  function build(syms) {
    symbols = syms;
    const group = syms.map(sym => `
      <span class="tape-item" data-sym="${sym}">
        <span class="tape-sym">${sym.replace(/USDT$/, '')}</span>
        <span class="tape-px">—</span>
        <span class="tape-chg">—</span>
        <svg class="tape-spark" viewBox="0 0 60 19" preserveAspectRatio="none" aria-hidden="true"></svg>
      </span>`).join('');
    track.innerHTML = `<div class="tape-group">${group}</div><div class="tape-group" aria-hidden="true">${group}</div>`;
    track.style.setProperty('--tape-dur', `${Math.max(30, syms.length * 7)}s`);
  }

  function apply(items) {
    for (const it of items) {
      const prev = last.get(it.symbol);
      const dir = prev == null || it.price === prev ? '' : it.price > prev ? 'tick-up' : 'tick-down';
      last.set(it.symbol, it.price);
      const chg = it.change_pct;
      track.querySelectorAll(`.tape-item[data-sym="${it.symbol}"]`).forEach(node => {
        node.querySelector('.tape-px').textContent = px(it.price);
        const c = node.querySelector('.tape-chg');
        c.textContent = chg == null ? '—' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`;
        node.classList.toggle('is-up', chg > 0);
        node.classList.toggle('is-down', chg < 0);
        node.querySelector('.tape-spark').innerHTML = spark(it.spark);
        node.title = `${it.symbol} · 24h H ${px(it.high)} · L ${px(it.low)}`;
        if (dir) {
          node.classList.remove('tick-up', 'tick-down');
          void node.offsetWidth;          // restart the flash
          node.classList.add(dir);
        }
      });
    }
  }

  function setTapeState(key) {
    tapeState.hidden = !key;
    if (key) tapeState.textContent = t(key);
    tape.classList.toggle('is-offline', key === 'tape.offline');
  }

  /* ── Polling ───────────────────────────────────────────────── */
  async function poll() {
    clearTimeout(timer);
    if (!active) return;
    if (document.hidden) return;    // resumed by visibilitychange
    const want = wantedSymbols();
    if (want.join() !== symbols.join()) build(want);
    try {
      const data = await apiFetch(`/market/pulse?symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!active) return;
      apply(data.items || []);
      everLoaded = everLoaded || (data.items || []).length > 0;
      setTapeState(everLoaded ? '' : 'tape.offline');
    } catch (err) {
      if (!active) return;
      if (!everLoaded) setTapeState('tape.offline');
      console.warn('market pulse:', err.message);
    }
    timer = setTimeout(poll, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => { if (active && !document.hidden) poll(); });

  document.addEventListener('illustrade:login', () => {
    active = true;
    everLoaded = false;
    last.clear();
    tape.hidden = false;
    setTapeState('tape.connecting');
    build(wantedSymbols());
    poll();
  });

  document.addEventListener('illustrade:logout', () => {
    active = false;
    clearTimeout(timer);
    tape.hidden = true;
    track.innerHTML = '';
    symbols = [];
  });

  document.addEventListener('illustrade:lang', () => {
    if (!tapeState.hidden) setTapeState(tape.classList.contains('is-offline') ? 'tape.offline' : 'tape.connecting');
  });

  /* ════════════════════════════════════════════════════════════
     SESSIONS CLOCK
     ════════════════════════════════════════════════════════════ */
  const SESSIONS = [
    { key: 'tyo', name: 'Tokyo',    tz: 'Asia/Tokyo',       open: 9 * 60,       close: 15 * 60 },
    { key: 'ldn', name: 'London',   tz: 'Europe/London',    open: 8 * 60,       close: 16 * 60 + 30 },
    { key: 'nyc', name: 'New York', tz: 'America/New_York', open: 9 * 60 + 30,  close: 16 * 60 },
  ];
  const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  const fmtCache = new Map();

  /** Weekday (0 = Sun) and minute of day right now in a time zone. */
  function zoned(tz, now) {
    if (!fmtCache.has(tz)) {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    }
    const parts = Object.fromEntries(fmtCache.get(tz).formatToParts(now).map(p => [p.type, p.value]));
    return { dow: WEEKDAY[parts.weekday], min: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  /** {open, minsLeft, progress} or {open:false, minsToOpen} for one session. */
  function sessionStatus(s, now) {
    const { dow, min } = zoned(s.tz, now);
    const weekday = dow >= 1 && dow <= 5;
    if (weekday && min >= s.open && min < s.close) {
      return { open: true, minsLeft: s.close - min, progress: (min - s.open) / (s.close - s.open) };
    }
    // Minutes until the next weekday open
    let mins = (weekday && min < s.open) ? s.open - min : (24 * 60 - min) + s.open;
    let d = (weekday && min < s.open) ? dow : (dow + 1) % 7;
    while (d === 0 || d === 6) { mins += 24 * 60; d = (d + 1) % 7; }
    return { open: false, minsToOpen: mins };
  }

  const dur = (m) => (m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
    : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);

  const box = document.getElementById('sessions');
  box.innerHTML = `
    <span class="clock" id="sessClock"></span>
    ${SESSIONS.map(s => `<span class="sess" data-key="${s.key}"><i class="sess-dot"></i>${s.key.toUpperCase()}<i class="sess-bar"><b></b></i></span>`).join('')}`;
  const clock = document.getElementById('sessClock');

  function tickClock() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (now.getSeconds() % 15 && box.dataset.ready) return;   // sessions only need a refresh now and then
    box.dataset.ready = '1';
    for (const s of SESSIONS) {
      const st = sessionStatus(s, now);
      const node = box.querySelector(`.sess[data-key="${s.key}"]`);
      node.classList.toggle('is-open', st.open);
      node.querySelector('.sess-bar b').style.width = st.open ? `${(st.progress * 100).toFixed(1)}%` : '0';
      node.title = st.open
        ? `${s.name} · ${t('sess.open')} · ${t('sess.closesin')} ${dur(st.minsLeft)}`
        : `${s.name} · ${t('sess.closed')} · ${t('sess.opensin')} ${dur(st.minsToOpen)}`;
    }
  }
  tickClock();
  setInterval(tickClock, 1000);
  document.addEventListener('illustrade:lang', () => { delete box.dataset.ready; tickClock(); });
})();
