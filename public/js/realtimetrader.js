// ── StockPulse — Realtime Trader Console (Intraday) ───────────────────────────

const rtTrader = (() => {
  const REFRESH_SECS = 60;
  let cdTimer    = null;
  let countdown  = 0;
  let currentSym = null;

  const $ = id => document.getElementById(id);
  const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtV = v => !v ? '--' : v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v);

  // ── VWAP (Volume Weighted Average Price) ────────────────────────────────────
  function calcVWAP(bars) {
    let sumTP = 0, sumV = 0;
    for (const b of bars) {
      if (b.v == null || b.h == null || b.l == null || b.c == null || b.v <= 0) continue;
      const tp = (b.h + b.l + b.c) / 3;
      sumTP += tp * b.v;
      sumV  += b.v;
    }
    return sumV > 0 ? sumTP / sumV : null;
  }

  // ── Intraday RSI (Wilder, 14-period on 5-min closes) ────────────────────────
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      d >= 0 ? gains += d : losses += Math.abs(d);
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgG = (avgG * (period - 1) + (d >= 0 ? d : 0)) / period;
      avgL = (avgL * (period - 1) + (d <  0 ? Math.abs(d) : 0)) / period;
    }
    if (!avgL) return 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  // ── Intraday Support & Resistance (pivot highs/lows from today's 5-min bars) ─
  function calcSR(bars, price) {
    if (bars.length < 3 || !price) return { support: null, resistance: null };
    const suppArr = [], resArr = [];
    for (let i = 1; i < bars.length - 1; i++) {
      if (bars[i].h > bars[i-1].h && bars[i].h > bars[i+1].h) resArr.push(bars[i].h);
      if (bars[i].l < bars[i-1].l && bars[i].l < bars[i+1].l) suppArr.push(bars[i].l);
    }
    const nearest = (arr, above) => {
      const filtered = above ? arr.filter(v => v > price) : arr.filter(v => v < price);
      if (!filtered.length) return null;
      return above
        ? Math.min(...filtered)
        : Math.max(...filtered);
    };
    return {
      support:    nearest(suppArr, false),
      resistance: nearest(resArr,  true),
    };
  }

  // ── Volume momentum ─────────────────────────────────────────────────────────
  function calcVolData(bars) {
    const vols   = bars.map(b => b.v || 0).filter(v => v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const lastVol = bars.length ? (bars[bars.length - 1].v || 0) : 0;
    return { avgVol, lastVol, surge: avgVol > 0 && lastVol / avgVol > 1.5 };
  }

  // ── Price momentum: net bullish bars in last 5 candles ──────────────────────
  function calcMomentum(bars) {
    if (bars.length < 3) return 0;
    const last = bars.slice(-Math.min(5, bars.length));
    const up   = last.filter(b => b.c > b.o).length;
    const down = last.filter(b => b.c < b.o).length;
    return up - down;
  }

  // ── Signal engine ───────────────────────────────────────────────────────────
  function computeSignal(rsi, price, vwap, volData, momentum, sr) {
    const aboveVwap  = vwap != null && price > vwap;
    const belowVwap  = vwap != null && price < vwap;

    let signal = 'HOLD', confidence = 50, reasons = [];

    if (rsi !== null && rsi < 40 && aboveVwap && momentum >= 2) {
      signal = 'BUY'; confidence = 78;
      reasons = ['RSI deeply oversold (< 40)', 'Price trading above VWAP', 'Strong bullish bar sequence'];
    } else if (rsi !== null && rsi < 45 && aboveVwap && volData.surge) {
      signal = 'BUY'; confidence = 70;
      reasons = ['RSI below 45 with recovery signal', 'Price above VWAP', 'Volume surge confirms move'];
    } else if (sr.support && price <= sr.support * 1.005 && aboveVwap && momentum >= 1) {
      signal = 'BUY'; confidence = 63;
      reasons = ['Price bouncing off intraday support', 'Price above VWAP', 'Bullish momentum at demand zone'];
    } else if (rsi !== null && rsi > 70 && belowVwap) {
      signal = 'SELL'; confidence = 76;
      reasons = ['RSI overbought (> 70)', 'Price below VWAP — bearish bias', 'Overbought + below equilibrium'];
    } else if (rsi !== null && rsi > 65 && momentum <= -2) {
      signal = 'SELL'; confidence = 70;
      reasons = ['RSI elevated above 65', 'Strong bearish bar sequence', 'Momentum divergence'];
    } else if (sr.resistance && price >= sr.resistance * 0.995 && belowVwap) {
      signal = 'SELL'; confidence = 62;
      reasons = ['Price pressing into intraday resistance', 'Price below VWAP', 'Supply zone + bearish bias'];
    } else {
      if (aboveVwap && momentum > 0) {
        confidence = 57;
        reasons = ['Price above VWAP — mild bullish bias', 'RSI in neutral range', 'Monitor for breakout confirmation'];
      } else if (belowVwap && momentum < 0) {
        confidence = 52;
        reasons = ['Price below VWAP — mild bearish bias', 'RSI neutral', 'No strong entry signal yet'];
      } else {
        confidence = 50;
        reasons = ['Price near VWAP equilibrium', 'RSI neutral, no extreme reads', 'Await directional breakout'];
      }
    }

    return { signal, confidence, reasons };
  }

  // ── Countdown timer ─────────────────────────────────────────────────────────
  function startCountdown(onDone) {
    clearInterval(cdTimer);
    countdown = REFRESH_SECS;
    const el = $('rtCdSecs');
    const update = () => { if (el) el.textContent = countdown; };
    update();
    cdTimer = setInterval(() => {
      countdown--;
      update();
      if (countdown <= 0) { clearInterval(cdTimer); if (onDone) onDone(); }
    }, 1000);
  }

  // ── Render results ──────────────────────────────────────────────────────────
  function render(sym, bars, price) {
    const closes  = bars.map(b => b.c);
    const vwap    = calcVWAP(bars);
    const rsi     = calcRSI(closes);
    const sr      = calcSR(bars, price);
    const volData = calcVolData(bars);
    const momentum = calcMomentum(bars);
    const { signal, confidence, reasons } = computeSignal(rsi, price, vwap, volData, momentum, sr);

    // Verdict
    const vb = $('rtVerdict');
    ['buy', 'hold', 'sell'].forEach(c => vb.classList.remove(c));
    vb.classList.add(signal.toLowerCase());
    vb.textContent = signal;
    $('rtConf').textContent   = confidence + '% confidence';
    $('rtSym').textContent    = sym;
    $('rtReason').textContent = reasons.join(' · ');

    // VWAP
    if (vwap != null) {
      const diff    = ((price - vwap) / vwap * 100);
      const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '% vs price';
      $('rtVwap').textContent    = '$' + fmt(vwap);
      $('rtVwapSub').textContent = diffStr;
      $('rtVwapSub').className   = 'rt-m-sub ' + (price > vwap ? 'up' : 'down');
    } else {
      $('rtVwap').textContent    = '--';
      $('rtVwapSub').textContent = 'No data';
      $('rtVwapSub').className   = 'rt-m-sub';
    }

    // RSI
    const rsiZone = rsi === null ? '--'
      : rsi < 30 ? 'Oversold' : rsi < 45 ? 'Low' : rsi > 70 ? 'Overbought' : rsi > 60 ? 'High' : 'Neutral';
    const rsiCls  = rsi === null ? '' : rsi < 45 ? 'up' : rsi > 65 ? 'down' : 'neut';
    $('rtRsi').textContent      = rsi !== null ? fmt(rsi, 1) : '--';
    $('rtRsiZone').textContent  = rsiZone;
    $('rtRsiZone').className    = 'rt-m-sub ' + rsiCls;

    // Volume
    const volSurge = volData.surge;
    $('rtVol').textContent    = fmtV(volData.lastVol);
    $('rtVolSub').textContent = volSurge
      ? 'Surge vs avg ' + fmtV(Math.round(volData.avgVol))
      : (volData.avgVol ? 'Avg ' + fmtV(Math.round(volData.avgVol)) : '--');
    $('rtVolSub').className   = 'rt-m-sub ' + (volSurge ? 'up' : '');

    // Sentiment (momentum-based)
    const sentLabel = momentum >= 3 ? 'Strong Bull'
      : momentum === 2 ? 'Bullish' : momentum === 1 ? 'Mild Bull'
      : momentum === -1 ? 'Mild Bear' : momentum === -2 ? 'Bearish'
      : momentum <= -3 ? 'Strong Bear' : 'Neutral';
    const sentCls   = momentum > 0 ? 'up' : momentum < 0 ? 'down' : 'neut';
    const momDesc   = momentum > 0 ? momentum + ' bull bars'
      : momentum < 0 ? Math.abs(momentum) + ' bear bars' : 'Mixed';
    $('rtSent').textContent    = sentLabel;
    $('rtSentSub').textContent = 'Last 5 · ' + momDesc;
    $('rtSentSub').className   = 'rt-m-sub ' + sentCls;

    // Support
    if (sr.support != null) {
      const pct = ((price - sr.support) / price * 100).toFixed(2);
      $('rtSupport').textContent    = '$' + fmt(sr.support);
      $('rtSupportSub').textContent = pct + '% below';
      $('rtSupportSub').className   = 'rt-m-sub';
    } else {
      $('rtSupport').textContent    = '--';
      $('rtSupportSub').textContent = 'No level';
      $('rtSupportSub').className   = 'rt-m-sub';
    }

    // Resistance
    if (sr.resistance != null) {
      const pct = ((sr.resistance - price) / price * 100).toFixed(2);
      $('rtResistance').textContent    = '$' + fmt(sr.resistance);
      $('rtResistanceSub').textContent = pct + '% above';
      $('rtResistanceSub').className   = 'rt-m-sub';
    } else {
      $('rtResistance').textContent    = '--';
      $('rtResistanceSub').textContent = 'No level';
      $('rtResistanceSub').className   = 'rt-m-sub';
    }

    // Timestamp
    $('rtUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    $('rtLoading').style.display = 'none';
    $('rtError').style.display   = 'none';
    $('rtResults').style.display = 'grid';

    startCountdown(() => analyze(sym));
  }

  // ── Analyze ─────────────────────────────────────────────────────────────────
  async function analyze(sym) {
    sym = sym.toUpperCase().trim();
    if (!sym) return;
    currentSym = sym;

    $('rtLoading').style.display = 'flex';
    $('rtError').style.display   = 'none';
    $('rtResults').style.display = 'none';
    const ls = $('rtLoadSym'); if (ls) ls.textContent = sym;
    clearInterval(cdTimer);

    try {
      const [quoteRes, intradayRes] = await Promise.all([
        fetch(`/api/quote/${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/intraday/${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      const price = quoteRes?.price ?? intradayRes?.price ?? null;
      const bars  = intradayRes?.bars || [];

      if (!price)       throw new Error('Unable to fetch quote for ' + sym);
      if (bars.length < 5) throw new Error('Insufficient intraday data for ' + sym + ' (market may be closed)');

      $('rtInput').value = sym;
      render(sym, bars, price);
    } catch (e) {
      $('rtLoading').style.display = 'none';
      $('rtError').style.display   = 'flex';
      const em = $('rtErrMsg'); if (em) em.textContent = e.message || 'Failed to analyze. Please try again.';
    }
  }

  // ── Public: load from main search ───────────────────────────────────────────
  function load(sym) {
    analyze(sym);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    $('rtRefreshBtn')?.addEventListener('click', () => {
      if (currentSym) analyze(currentSym);
    });

    const input = $('rtInput');
    const drop  = $('rtDrop');
    if (!input) return;

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = input.value.trim();
        if (v) { if (drop) drop.style.display = 'none'; analyze(v); }
      }
    });

    let searchTimer;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (!q) { if (drop) drop.style.display = 'none'; return; }
      searchTimer = setTimeout(async () => {
        try {
          const res   = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
          const items = await res.json();
          if (!drop) return;
          if (!items.length) { drop.style.display = 'none'; return; }
          drop.replaceChildren();
          items.forEach(it => {
            const d    = document.createElement('div');
            d.className = 'drop-item';
            const sym  = document.createElement('span');
            sym.className   = 'drop-sym';
            sym.textContent = it.symbol;
            const name = document.createElement('span');
            name.className   = 'drop-name';
            name.textContent = it.name;
            d.append(sym, name);
            d.addEventListener('mousedown', () => {
              input.value        = it.symbol;
              drop.style.display = 'none';
              analyze(it.symbol);
            });
            drop.appendChild(d);
          });
          drop.style.display = 'block';
        } catch {}
      }, 280);
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { if (drop) drop.style.display = 'none'; }, 200);
    });
  }

  return { init, load, analyze };
})();

document.addEventListener('DOMContentLoaded', () => rtTrader.init());
