/* ════════════════════════════════════════════════════════════
   INSIGHTS — client-side analytics drawn from the trades already loaded

   Everything here is computed from the trades of the selected period, so it
   needs no extra request:
     · hero stats (profit factor, expectancy, best / worst day)
     · edge panel (win-rate ring, payoff, long vs short, best / worst trade)
     · micro-charts inside the KPI cards
     · P&L calendar, symbol leaderboard, weekday × hour map, ROE histogram

   app.js calls Insights.render(allTrades, filteredTrades) after every load
   and every table-filter change. The calendar, hour map and histogram follow
   the table filters (like the main chart); the hero, edge panel and cards
   follow the period only (like the metric numbers from the backend).
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const DAY_MS = 86400000;
  const pnlOf = (tr) => Number(tr.pnl ?? 0);
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const money = (v) => formatCurrency(v);
  const moneyShort = (v) => {
    const a = Math.abs(v);
    const s = a >= 10000 ? `${(a / 1000).toFixed(1)}k` : a >= 1000 ? `${(a / 1000).toFixed(2)}k` : a.toFixed(2);
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}$${s}`;
  };
  /** Short enough for a calendar cell: +$8.40, +$243, +$1.2k */
  const moneyCell = (v) => {
    const a = Math.abs(v);
    const s = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 10 ? Math.round(a).toString() : a.toFixed(2);
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}$${s}`;
  };
  const chrono = (trades) => trades
    .filter(tr => tr.close_time || tr.open_time)
    .sort((a, b) => tradeTime(a) - tradeTime(b));

  let lastFiltered = null;   // stats of the filtered trades, for calendar clicks

  /* ── Shared floating tooltip for every [data-tip] element ──── */
  const tip = document.createElement('div');
  tip.className = 'ins-tip';
  tip.hidden = true;
  document.body.appendChild(tip);

  function placeTip(e) {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.innerHTML = target.dataset.tip;   // built from escaped parts below
    tip.hidden = false;
    placeTip(e);
  });
  document.addEventListener('mousemove', (e) => { if (!tip.hidden) placeTip(e); });
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);

  const tipHtml = (title, ...lines) =>
    escHtml(`<b>${escHtml(title)}</b>${lines.map(l => `<br>${escHtml(l)}`).join('')}`);

  /* ── Tiny SVG builders (viewBox 0 0 100 H, stretched to the box) ── */
  const VB_H = 30;

  function sparkSvg(values, { area = true, zero = true, tone } = {}) {
    if (values.length < 2) return '';
    const min = Math.min(...values, zero ? 0 : Infinity);
    const max = Math.max(...values, zero ? 0 : -Infinity);
    const span = max - min || 1;
    const y = (v) => (VB_H - 2) - ((v - min) / span) * (VB_H - 4);
    const x = (i) => (i / (values.length - 1)) * 100;
    const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
    const cls = tone || (values[values.length - 1] >= 0 ? 'viz-up' : 'viz-down');
    const z = zero && min < 0 && max > 0 ? `<line class="viz-zero" x1="0" x2="100" y1="${y(0).toFixed(2)}" y2="${y(0).toFixed(2)}"/>` : '';
    const fill = area ? `<path class="viz-area" d="${line}L100,${y(Math.max(min, Math.min(0, max))).toFixed(2)}L0,${y(Math.max(min, Math.min(0, max))).toFixed(2)}Z"/>` : '';
    return `<svg class="viz ${cls}" viewBox="0 0 100 ${VB_H}" preserveAspectRatio="none" aria-hidden="true">${z}${fill}<path class="viz-line" d="${line}"/></svg>`;
  }

  function barsSvg(values, { highlight = -1, signed = true } = {}) {
    if (!values.length) return '';
    const maxAbs = Math.max(...values.map(Math.abs), 1e-9);
    const hasNeg = signed && values.some(v => v < 0);
    const mid = hasNeg ? VB_H / 2 : VB_H - 1;
    const room = hasNeg ? VB_H / 2 - 1 : VB_H - 2;
    const w = 100 / values.length;
    const gap = Math.min(w * 0.28, 1.6);
    const rects = values.map((v, i) => {
      const h = Math.max(Math.abs(v) / maxAbs * room, v ? 1 : 0.6);
      const yTop = v >= 0 ? mid - h : mid;
      const cls = `${v >= 0 ? 'viz-bar-up' : 'viz-bar-down'}${i === highlight ? ' viz-bar-hi' : ''}${!signed ? ' viz-bar-neutral' : ''}`;
      return `<rect class="${cls}" x="${(i * w + gap / 2).toFixed(2)}" y="${yTop.toFixed(2)}" width="${(w - gap).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6"/>`;
    }).join('');
    return `<svg class="viz" viewBox="0 0 100 ${VB_H}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
  }

  /* ── Core statistics ───────────────────────────────────────── */
  function stats(trades) {
    const list = chrono(trades);
    const pnls = list.map(pnlOf);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const grossWin = sum(wins);
    const grossLoss = -sum(losses);

    const days = new Map();
    for (const tr of list) {
      const key = isoDay(tradeTime(tr));
      if (!days.has(key)) days.set(key, { pnl: 0, n: 0, ids: [] });
      const d = days.get(key);
      d.pnl += pnlOf(tr);
      d.n += 1;
      d.ids.push(tr.id);
    }
    const dayVals = [...days.entries()];
    const best = dayVals.reduce((b, d) => (!b || d[1].pnl > b[1].pnl ? d : b), null);
    const worst = dayVals.reduce((b, d) => (!b || d[1].pnl < b[1].pnl ? d : b), null);

    const side = (s) => {
      const arr = list.filter(tr => (tr.side || '').toLowerCase() === s);
      const p = arr.map(pnlOf);
      return { n: arr.length, pnl: sum(p), wins: p.filter(x => x > 0).length };
    };

    // Longest win / loss runs in the period
    let run = 0, bestRun = 0, worstRun = 0;
    for (const p of pnls) {
      if (p > 0) run = run > 0 ? run + 1 : 1;
      else if (p < 0) run = run < 0 ? run - 1 : -1;
      else run = 0;
      bestRun = Math.max(bestRun, run);
      worstRun = Math.min(worstRun, run);
    }

    let bestTrade = null, worstTrade = null;
    for (const tr of list) {
      if (!bestTrade || pnlOf(tr) > pnlOf(bestTrade)) bestTrade = tr;
      if (!worstTrade || pnlOf(tr) < pnlOf(worstTrade)) worstTrade = tr;
    }

    return {
      list, pnls, n: pnls.length,
      wins: wins.length, losses: losses.length,
      grossWin, grossLoss,
      pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
      expectancy: pnls.length ? sum(pnls) / pnls.length : null,
      avgWin: wins.length ? grossWin / wins.length : null,
      avgLoss: losses.length ? -grossLoss / losses.length : null,
      days, best, worst,
      long: side('long'), short: side('short'),
      bestRun, worstRun: -worstRun,
      bestTrade, worstTrade,
    };
  }

  /* ── Hero numbers ──────────────────────────────────────────── */
  function setTone(node, v) {
    node.classList.toggle('tone-up', v > 0);
    node.classList.toggle('tone-down', v < 0);
  }

  function renderHero(s) {
    const pf = el('heroPF');
    pf.textContent = s.pf == null ? '—' : s.pf === Infinity ? '∞' : s.pf.toFixed(2);
    pf.classList.toggle('tone-up', s.pf != null && s.pf >= 1);
    pf.classList.toggle('tone-down', s.pf != null && s.pf < 1);

    const ex = el('heroExp');
    ex.textContent = s.expectancy == null ? '—' : money(s.expectancy);
    setTone(ex, s.expectancy ?? 0);

    const dayTxt = (d) => (d ? `${moneyShort(d[1].pnl)}` : '—');
    const dayTip = (d) => (d ? parseDay(d[0]).toLocaleDateString(uiLocale(), { weekday: 'short', month: 'short', day: 'numeric' }) : '');
    const bd = el('heroBestDay');
    bd.textContent = dayTxt(s.best);
    bd.title = dayTip(s.best);
    setTone(bd, s.best ? s.best[1].pnl : 0);
    const wd = el('heroWorstDay');
    wd.textContent = dayTxt(s.worst);
    wd.title = dayTip(s.worst);
    setTone(wd, s.worst ? s.worst[1].pnl : 0);
  }

  /* ── Edge panel: ring + rows ───────────────────────────────── */
  const RING_C = 2 * Math.PI * 50;

  function renderEdge(s) {
    const m = state.metrics;
    const decided = s.wins + s.losses;
    const rate = m && m.total_trades ? Number(m.win_rate) : (decided ? s.wins / decided * 100 : null);
    const win = el('ringWin');
    const loss = el('ringLoss');
    const show = rate != null && s.n > 0;
    win.style.strokeDasharray = `${show ? (rate / 100) * RING_C : 0} ${RING_C}`;
    loss.style.strokeDasharray = `${show ? RING_C : 0} ${RING_C}`;

    const rows = [];
    if (!s.n) {
      el('edgeRows').innerHTML = `<div class="edge-empty">${escHtml(t('ins.noedge'))}</div>`;
      return;
    }

    // Payoff: average win vs average loss
    const aw = s.avgWin ?? 0;
    const al = Math.abs(s.avgLoss ?? 0);
    const top = Math.max(aw, al, 1e-9);
    const payoff = al > 0 ? (aw / al).toFixed(2) : (aw > 0 ? '∞' : '—');
    rows.push(`
      <div class="edge-row">
        <div class="edge-head"><span>${escHtml(t('ins.payoff'))}</span><b>${payoff}</b></div>
        <div class="duo">
          <div class="duo-line"><span class="duo-k">${escHtml(t('ins.avgwin'))}</span><span class="duo-bar"><i class="up" style="width:${(aw / top * 100).toFixed(1)}%"></i></span><span class="duo-v tone-up">${s.avgWin == null ? '—' : moneyShort(aw)}</span></div>
          <div class="duo-line"><span class="duo-k">${escHtml(t('ins.avgloss'))}</span><span class="duo-bar"><i class="down" style="width:${(al / top * 100).toFixed(1)}%"></i></span><span class="duo-v tone-down">${s.avgLoss == null ? '—' : moneyShort(-al)}</span></div>
        </div>
      </div>`);

    // Long vs short split
    const L = s.long, S = s.short;
    const both = L.n + S.n;
    if (both) {
      const lp = L.n / both * 100;
      const wr = (x) => (x.n ? `${Math.round(x.wins / x.n * 100)}%` : '—');
      rows.push(`
        <div class="edge-row">
          <div class="edge-head"><span>${escHtml(t('ins.longshort'))}</span><b>${L.n} · ${S.n}</b></div>
          <div class="split" data-tip="${tipHtml(t('ins.longshort'), `▲ ${t('filter.long')}: ${L.n} · ${money(L.pnl)} · ${wr(L)} ${t('ins.wr')}`, `▼ ${t('filter.short')}: ${S.n} · ${money(S.pnl)} · ${wr(S)} ${t('ins.wr')}`)}">
            <i class="split-long" style="width:${lp.toFixed(1)}%"></i><i class="split-short" style="width:${(100 - lp).toFixed(1)}%"></i>
          </div>
          <div class="split-legend">
            <span class="side-long">▲ ${moneyShort(L.pnl)} <em>${wr(L)}</em></span>
            <span class="side-short">▼ ${moneyShort(S.pnl)} <em>${wr(S)}</em></span>
          </div>
        </div>`);
    }

    // Best / worst trade + longest runs
    const tradeLine = (tr) => (tr ? `${escHtml((tr.symbol || '').split('/')[0])} ${moneyShort(pnlOf(tr))}` : '—');
    rows.push(`
      <div class="edge-grid">
        <div class="edge-cell"><span>${escHtml(t('ins.besttrade'))}</span><b class="tone-up">${tradeLine(s.bestTrade)}</b></div>
        <div class="edge-cell"><span>${escHtml(t('ins.worsttrade'))}</span><b class="${s.worstTrade && pnlOf(s.worstTrade) < 0 ? 'tone-down' : ''}">${tradeLine(s.worstTrade)}</b></div>
        <div class="edge-cell"><span>${escHtml(t('ins.bestrun'))}</span><b class="tone-up">${s.bestRun ? `W${s.bestRun}` : '—'}</b></div>
        <div class="edge-cell"><span>${escHtml(t('ins.worstrun'))}</span><b class="${s.worstRun ? 'tone-down' : ''}">${s.worstRun ? `L${s.worstRun}` : '—'}</b></div>
      </div>`);

    el('edgeRows').innerHTML = rows.join('');
  }

  /* ── Micro-charts inside the KPI cards ─────────────────────── */
  function bucketBy(list, keyOf) {
    const map = new Map();
    for (const tr of list) {
      const k = keyOf(tradeTime(tr));
      map.set(k, (map.get(k) || 0) + pnlOf(tr));
    }
    return [...map.values()];
  }

  function weekKey(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));   // Monday
    return isoDay(x);
  }

  function renderCardViz(s) {
    const set = (id, html) => { el(id).innerHTML = html; };
    const { list, pnls } = s;

    // Losses: how much of the gross flow is losses
    const gross = s.grossWin + s.grossLoss;
    set('vizLosses', gross > 0
      ? `<div class="meter" data-tip="${tipHtml(t('ins.grossflow'), `${t('ins.grosswin')} ${money(s.grossWin)}`, `${t('ins.grossloss')} ${money(-s.grossLoss)}`)}"><i class="meter-up" style="width:${(s.grossWin / gross * 100).toFixed(1)}%"></i><i class="meter-down" style="width:${(s.grossLoss / gross * 100).toFixed(1)}%"></i></div>`
      : '');

    // Drawdown: underwater curve
    let cum = 0, peak = 0;
    const under = pnls.map(p => { cum += p; peak = Math.max(peak, cum); return cum - peak; });
    set('vizDrawdown', under.some(v => v < 0) ? sparkSvg([0, ...under], { tone: 'viz-down' }) : '');

    // Max profit: every trade, the best one lit
    const bestIdx = pnls.indexOf(Math.max(...pnls));
    set('vizMaxProfit', pnls.length > 1 ? barsSvg(pnls.slice(-60), { highlight: bestIdx - Math.max(0, pnls.length - 60) }) : '');

    // R:R per trade when logged
    const rr = list.map(tr => _num(tr.risk_reward ?? tr.rr)).filter(v => v != null);
    set('vizRR', rr.length > 1 ? sparkSvg(rr, { area: false, zero: false, tone: 'viz-accent' }) : '');

    // Streak: the last results as dots, newest on the right
    const last = pnls.slice(-16);
    set('vizStreak', last.length
      ? `<div class="dots">${last.map(p => `<i class="${p > 0 ? 'dot-w' : p < 0 ? 'dot-l' : 'dot-0'}"></i>`).join('')}</div>`
      : '');

    // Trades per day
    const perDay = [...s.days.values()].map(d => d.n);
    set('vizTotal', perDay.length > 1 ? barsSvg(perDay.slice(-40), { signed: false }) : '');

    // ROE per trade
    const roe = list.map(tr => _num(tr.roe)).filter(v => v != null);
    set('vizRoe', roe.length > 1 ? barsSvg(roe.slice(-60)) : '');

    // Avg P&L: rolling 10-trade average
    const roll = pnls.map((_, i) => { const w = pnls.slice(Math.max(0, i - 9), i + 1); return sum(w) / w.length; });
    set('vizAvgPnl', roll.length > 1 ? sparkSvg(roll) : '');

    // Entries: how many trades used 1, 2, 3, 4+ entries
    const ent = [0, 0, 0, 0];
    list.forEach(tr => { const e = Number(tr.entries); if (e >= 1) ent[Math.min(e, 4) - 1]++; });
    set('vizEntries', sum(ent) ? histMini(ent, ['1', '2', '3', '4+']) : '');

    // Duration buckets
    const db = [0, 0, 0, 0, 0];
    list.forEach(tr => {
      const m = tr.duration_minutes ?? calcDurationMinutes(tr.open_time, tr.close_time);
      if (m == null) return;
      db[m < 60 ? 0 : m < 240 ? 1 : m < 1440 ? 2 : m < 4320 ? 3 : 4]++;
    });
    set('vizDuration', sum(db) ? histMini(db, ['<1h', '1-4h', '4-24h', '1-3d', '3d+']) : '');

    // Cadence: P&L per day / week / month
    const daily = [...s.days.values()].map(d => d.pnl);
    set('vizDaily', daily.length > 1 ? barsSvg(daily.slice(-45)) : '');
    const weekly = bucketBy(list, weekKey);
    set('vizWeekly', weekly.length > 1 ? barsSvg(weekly.slice(-26)) : '');
    const monthly = bucketBy(list, d => `${d.getFullYear()}-${d.getMonth()}`);
    set('vizMonthly', monthly.length > 1 ? barsSvg(monthly.slice(-24)) : '');
  }

  /** Small labelled histogram (counts) for the card footers. */
  function histMini(counts, labels) {
    const max = Math.max(...counts, 1);
    return `<div class="mini-hist">${counts.map((c, i) => `
      <div class="mh-col" data-tip="${tipHtml(labels[i], `${c} ${t(c === 1 ? 'unit.trade' : 'unit.trades')}`)}">
        <i style="height:${Math.max(c / max * 100, c ? 8 : 2)}%"></i><span>${escHtml(labels[i])}</span>
      </div>`).join('')}</div>`;
  }

  /* ── P&L calendar ──────────────────────────────────────────── */
  function level(v, maxAbs) {
    if (!v) return '0';
    const r = Math.abs(v) / maxAbs;
    const n = r > 0.66 ? 4 : r > 0.33 ? 3 : r > 0.12 ? 2 : 1;
    return (v > 0 ? 'w' : 'l') + n;
  }

  /**
   * Up to 7 weeks: a month-style grid (weeks as rows) with the day's P&L in
   * every cell. Longer: a compact heatmap (weeks as columns), at most a year.
   */
  function renderCalendar(s) {
    const box = el('calHeat');
    if (!s.n) {
      box.innerHTML = `<div class="ins-empty">${escHtml(t('ins.empty'))}</div>`;
      return;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let start = state.range.start ? parseDay(state.range.start) : parseDay(isoDay(tradeTime(s.list[0])));
    let end = state.range.end ? parseDay(state.range.end) : today;
    if (end > today) end = today;
    const maxSpan = 52 * 7 * DAY_MS;
    if (end - start > maxSpan) start = new Date(end.getTime() - maxSpan);
    const gridStart = new Date(start);
    gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));   // Monday

    // weeks[w][i] = { d, key, inRange, day }
    const weeks = [];
    for (const w = new Date(gridStart); w <= end; w.setDate(w.getDate() + 7)) {
      weeks.push(Array.from({ length: 7 }, (_, i) => {
        const d = new Date(w);
        d.setDate(d.getDate() + i);
        const key = isoDay(d);
        return { d, key, inRange: d >= start && d <= end, day: s.days.get(key) };
      }));
    }

    const maxAbs = Math.max(...[...s.days.values()].map(d => Math.abs(d.pnl)), 1e-9);
    const loc = uiLocale();
    const dayName = (d) => d.toLocaleDateString(loc, { weekday: 'short', month: 'short', day: 'numeric' });
    const cellTip = (c) => (c.day
      ? tipHtml(dayName(c.d), money(c.day.pnl), `${c.day.n} ${t(c.day.n === 1 ? 'unit.trade' : 'unit.trades')}`)
      : tipHtml(dayName(c.d), t('ins.notrades')));
    let green = 0, red = 0;
    for (const c of weeks.flat()) {
      if (!c.inRange || !c.day) continue;
      if (c.day.pnl > 0) green++; else if (c.day.pnl < 0) red++;
    }
    const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(loc, { weekday: 'short' }));

    let body;
    if (weeks.length <= 7) {
      box.className = 'cal cal-month';
      body = `
        <div class="calm-head">${dows.map(d => `<span>${escHtml(d)}</span>`).join('')}</div>
        ${weeks.map(week => `<div class="calm-week">${week.map(c => {
          if (!c.inRange) return '<i class="calm-cell cal-out"></i>';
          const lvl = c.day ? level(c.day.pnl, maxAbs) : 'none';
          return `<i class="calm-cell cal-${lvl}"${c.day ? ` data-day="${c.key}"` : ''} data-tip="${cellTip(c)}">
            <span class="calm-date">${c.d.getDate()}</span>
            ${c.day ? `<span class="calm-pnl">${escHtml(moneyCell(c.day.pnl))}</span><span class="calm-n">${c.day.n}</span>` : ''}
          </i>`;
        }).join('')}</div>`).join('')}`;
    } else {
      box.className = 'cal';
      const months = [];
      weeks.forEach((week, col) => week.forEach(c => {
        if (c.inRange && (c.d.getDate() === 1 || !months.length)) months.push({ col, label: c.d.toLocaleDateString(loc, { month: 'short' }) });
      }));
      const monthRow = months.filter((m, i) => i === 0 || m.col - months[i - 1].col >= 2)
        .map(m => `<span style="--c:${m.col}">${escHtml(m.label)}</span>`).join('');
      box.style.setProperty('--weeks', weeks.length);
      body = `
        <div class="cal-scroll"><div class="cal-inner">
          <div class="cal-months">${monthRow}</div>
          <div class="cal-body">
            <div class="cal-dows"><span>${escHtml(dows[0])}</span><span>${escHtml(dows[2])}</span><span>${escHtml(dows[4])}</span></div>
            <div class="cal-grid">${weeks.map(week => `<div class="cal-week">${week.map(c => {
              if (!c.inRange) return '<i class="cal-cell cal-out"></i>';
              return `<i class="cal-cell cal-${c.day ? level(c.day.pnl, maxAbs) : 'none'}"${c.day ? ` data-day="${c.key}"` : ''} data-tip="${cellTip(c)}"></i>`;
            }).join('')}</div>`).join('')}</div>
          </div>
        </div></div>`;
    }

    box.innerHTML = `${body}
      <div class="cal-foot">
        <span><b class="tone-up">${green}</b> ${escHtml(t('ins.greendays'))}</span>
        <span><b class="tone-down">${red}</b> ${escHtml(t('ins.reddays'))}</span>
        <span>${escHtml(t('ins.hitrate'))} <b>${green + red ? Math.round(green / (green + red) * 100) : 0}%</b></span>
      </div>`;
  }

  el('calHeat').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-day]');
    if (!cell) return;
    const day = lastFiltered?.days.get(cell.dataset.day);
    if (day) focusTrades(day.ids);
  });

  /* ── Symbol leaderboard ────────────────────────────────────── */
  function renderBoard(trades) {
    const box = el('symBoard');
    const by = new Map();
    for (const tr of trades) {
      const sym = (tr.symbol || '').toUpperCase();
      if (!sym) continue;
      if (!by.has(sym)) by.set(sym, { pnl: 0, n: 0, w: 0 });
      const b = by.get(sym);
      b.pnl += pnlOf(tr);
      b.n += 1;
      if (pnlOf(tr) > 0) b.w += 1;
    }
    if (!by.size) {
      box.innerHTML = `<div class="ins-empty">${escHtml(t('ins.empty'))}</div>`;
      return;
    }
    const rows = [...by.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
    const maxAbs = Math.max(...rows.map(r => Math.abs(r[1].pnl)), 1e-9);
    const active = state.tableFilter.symbols;
    box.innerHTML = rows.map(([sym, b], i) => `
      <button class="board-row${active.has(sym) ? ' is-active' : ''}${active.size && !active.has(sym) ? ' is-dim' : ''}" type="button" data-sym="${escHtml(sym)}" style="--i:${i}">
        <span class="board-rank">${i + 1}</span>
        ${symbolHtml(sym)}
        <span class="board-meta">${b.n} · ${Math.round(b.w / b.n * 100)}%</span>
        <span class="board-bar"><i class="${b.pnl >= 0 ? 'up' : 'down'}" style="width:${(Math.abs(b.pnl) / maxAbs * 100).toFixed(1)}%"></i></span>
        <span class="board-pnl ${b.pnl > 0 ? 'tone-up' : b.pnl < 0 ? 'tone-down' : ''}">${moneyShort(b.pnl)}</span>
      </button>`).join('');
  }

  el('symBoard').addEventListener('click', (e) => {
    const row = e.target.closest('.board-row');
    if (row) toggleSymbolFilter(row.dataset.sym);
  });

  /* ── Weekday × hour map ────────────────────────────────────── */
  function renderHourMap(s) {
    const box = el('hourHeat');
    if (!s.n) {
      box.innerHTML = `<div class="ins-empty">${escHtml(t('ins.empty'))}</div>`;
      return;
    }
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ pnl: 0, n: 0 })));
    for (const tr of s.list) {
      const d = tradeTime(tr);
      const c = grid[(d.getDay() + 6) % 7][d.getHours()];
      c.pnl += pnlOf(tr);
      c.n += 1;
    }
    const maxAbs = Math.max(...grid.flat().map(c => Math.abs(c.pnl)), 1e-9);
    const loc = uiLocale();
    const dow = (i) => new Date(2024, 0, 1 + i).toLocaleDateString(loc, { weekday: 'short' });
    let best = null;
    const rows = grid.map((row, r) => `
      <div class="hm-row">
        <span class="hm-dow">${escHtml(dow(r))}</span>
        ${row.map((c, h) => {
          if (c.n && (!best || c.pnl > best.pnl)) best = { ...c, r, h };
          const tipTxt = tipHtml(`${dow(r)} ${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`,
            c.n ? money(c.pnl) : t('ins.notrades'), ...(c.n ? [`${c.n} ${t(c.n === 1 ? 'unit.trade' : 'unit.trades')}`] : []));
          return `<i class="hm-cell cal-${c.n ? level(c.pnl, maxAbs) : 'none'}" data-tip="${tipTxt}"></i>`;
        }).join('')}
      </div>`).join('');
    const hours = [0, 6, 12, 18].map(h => `<span style="--h:${h}">${String(h).padStart(2, '0')}</span>`).join('');
    box.innerHTML = `
      <div class="hm">${rows}<div class="hm-hours"><span class="hm-dow"></span><div class="hm-hours-track">${hours}</div></div></div>
      <div class="cal-foot">${best && best.pnl > 0
        ? `<span>${escHtml(t('ins.sweetspot'))} <b class="tone-up">${escHtml(dow(best.r))} ${String(best.h).padStart(2, '0')}:00</b> · ${escHtml(money(best.pnl))}</span>`
        : `<span>${escHtml(t('ins.nosweetspot'))}</span>`}</div>`;
  }

  /* ── ROE histogram ─────────────────────────────────────────── */
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function renderHist(s) {
    const box = el('roeHist');
    const hint = el('roeHistHint');
    const roe = s.list.map(tr => _num(tr.roe)).filter(v => v != null);
    if (roe.length < 2) {
      box.innerHTML = `<div class="ins-empty">${escHtml(t('ins.empty'))}</div>`;
      hint.textContent = '';
      return;
    }
    const lo = Math.min(...roe);
    const hi = Math.max(...roe);
    const step = niceStep(Math.max((hi - lo) / 14, 0.1));
    const start = Math.floor(lo / step) * step;
    const nBins = Math.max(1, Math.ceil((hi - start) / step + 1e-9));
    const bins = Array.from({ length: nBins }, (_, i) => ({ from: start + i * step, n: 0 }));
    roe.forEach(v => { bins[Math.min(nBins - 1, Math.floor((v - start) / step))].n++; });
    const max = Math.max(...bins.map(b => b.n));
    const sorted = [...roe].sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const dec = step < 1 ? 1 : 0;
    hint.textContent = `${t('ins.median')} ${formatPercent(median, 1, true)}`;
    box.innerHTML = `
      <div class="hist-bars">${bins.map(b => {
        const mid = b.from + step / 2;
        const tone = mid > 0 ? 'up' : mid < 0 ? 'down' : 'flat';
        return `<div class="hist-col" data-tip="${tipHtml(`${b.from.toFixed(dec)}% … ${(b.from + step).toFixed(dec)}%`, `${b.n} ${t(b.n === 1 ? 'unit.trade' : 'unit.trades')}`)}">
          <i class="${tone}" style="height:${b.n ? Math.max(b.n / max * 100, 4) : 0}%"></i></div>`;
      }).join('')}</div>
      <div class="hist-axis"><span>${lo.toFixed(dec)}%</span><span>0%</span><span>${hi.toFixed(dec)}%</span></div>`;
    // Put the "0%" label under zero (or hide it when zero is out of range)
    const zeroLabel = box.querySelector('.hist-axis span:nth-child(2)');
    const zPos = (0 - start) / (nBins * step);
    if (zPos <= 0.04 || zPos >= 0.96) zeroLabel.hidden = true;
    else zeroLabel.style.left = `${(zPos * 100).toFixed(1)}%`;
  }

  /* ── Entry point ───────────────────────────────────────────── */

  function render(allTrades, filtered) {
    const all = stats(allTrades);
    lastFiltered = stats(filtered);
    renderHero(all);
    renderEdge(all);
    renderCardViz(all);
    renderCalendar(lastFiltered);
    renderBoard(applyTableFilters(allTrades, { ignoreSymbols: true }));
    renderHourMap(lastFiltered);
    renderHist(lastFiltered);
  }

  window.Insights = { render };
})();
