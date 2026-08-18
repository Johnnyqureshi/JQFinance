/* ── Momentum Trader — JQ Finance ─────────────────────────────────────────────
 *
 * Implements the full momentum trading pipeline, mirroring the Python module
 * structure:
 *   config.py      → MomentumConfig
 *   scanner.py     → MomentumScanner
 *   strategy.py    → MomentumStrategy
 *   risk.py        → RiskManager
 *   alpaca_client.py → AlpacaClient (wraps existing /api/alpaca/* endpoints)
 *   main.py        → MomentumBot  (orchestrates the full pipeline)
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmt = (n, d = 2) =>
    n == null || isNaN(n) ? '--'
      : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtDollar = n => (n == null ? '--' : '$' + fmt(n));
  const fmtVol = v => {
    if (!v && v !== 0) return '--';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(v);
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 1 — config.py
   * Central configuration: universe, indicator thresholds, risk parameters.
   * ════════════════════════════════════════════════════════════════════════════ */
  const MomentumConfig = {
    // Default scan universe — high-momentum names across sectors
    UNIVERSE: [
      'AAPL','MSFT','NVDA','AMD','META','GOOGL','AMZN','TSLA','NFLX','UBER',
      'COIN','PLTR','SOFI','MARA','RIOT','HOOD','RBLX','SHOP','SQ','PYPL',
      'ARM','SMCI','IONQ','LUNR','RDDT','APLS','CRWD','PANW','DDOG','SNOW',
      'NET','ZS','HIMS','TGTX','ACMR','SOUN','BBAI','KULR','CELH','GNRC',
      'ENPH','FSLR','BE','PLUG','QQQ','SPY','IWM','ARKK','SOXS','LABU'
    ],

    defaults: {
      rsiMin:         48,
      rsiMax:         73,
      minRelVol:      1.5,
      minPrice:       2,
      maxPrice:       500,
      riskPctPerTrade: 2.0,
      minRR:          2.0,
      atrMultiplier:  1.5,
      emaFast:        9,
      emaSlow:        21,
    },

    // Load saved config from localStorage, merging with defaults
    load() {
      try {
        const saved = JSON.parse(localStorage.getItem('mtConfig') || '{}');
        return { ...this.defaults, ...saved };
      } catch { return { ...this.defaults }; }
    },

    save(cfg) {
      try { localStorage.setItem('mtConfig', JSON.stringify(cfg)); } catch {}
    },
  };

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 2 — scanner.py
   * Fetches live quote data for the universe and filters by momentum criteria.
   * ════════════════════════════════════════════════════════════════════════════ */
  const MomentumScanner = {
    /**
     * Fetch scanner-batch data for the given symbols.
     * Returns raw results array from the server.
     */
    async fetchBatch(symbols) {
      const resp = await fetch('/api/scanner-batch', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ symbols }),
      });
      if (!resp.ok) throw new Error('Scanner fetch failed: HTTP ' + resp.status);
      const data = await resp.json();
      return data.results || [];
    },

    /**
     * Apply momentum pre-filters (price range, relVol, RSI window).
     * Mirrors the filter() method in scanner.py.
     */
    filter(results, cfg) {
      return results.filter(r => {
        if (r.price == null) return false;
        if (r.price < cfg.minPrice || r.price > cfg.maxPrice) return false;
        if (r.relVol != null && r.relVol < cfg.minRelVol) return false;
        if (r.rsi14 != null && (r.rsi14 < cfg.rsiMin || r.rsi14 > cfg.rsiMax)) return false;
        return true;
      });
    },

    /**
     * Calculate composite momentum score (0–100) for one row.
     * Mirrors calcMomentumScore() in scanner.py.
     *
     * Scoring breakdown (total 100 pts):
     *   RSI momentum zone  30 pts  — sweet spot 52-68 = max
     *   Relative Volume    25 pts  — 3×+ = max
     *   52-week proximity  20 pts  — within 5% of high = max
     *   Day change %       15 pts  — 3%+ = max
     *   ATR volatility     10 pts  — 2%+ ATR = max
     */
    calcScore(r) {
      let score = 0;

      // RSI component
      if (r.rsi14 != null) {
        const rsi = r.rsi14;
        if (rsi >= 52 && rsi <= 68)      score += 30;
        else if (rsi >= 48 && rsi < 52)  score += 20;
        else if (rsi > 68 && rsi <= 73)  score += 18;
        else if (rsi >= 44 && rsi < 48)  score += 8;
      }

      // Relative volume component
      if (r.relVol != null) {
        const rv = r.relVol;
        if (rv >= 3.0)       score += 25;
        else if (rv >= 2.0)  score += 20;
        else if (rv >= 1.5)  score += 13;
        else if (rv >= 1.2)  score += 6;
      }

      // 52-week proximity
      if (r.w52Dist != null) {
        const d = r.w52Dist; // negative = below high
        if (d >= -2)        score += 20;
        else if (d >= -5)   score += 15;
        else if (d >= -10)  score += 8;
        else if (d >= -20)  score += 3;
      }

      // Day change % momentum
      if (r.change != null) {
        const chg = r.change;
        if (chg >= 3)       score += 15;
        else if (chg >= 1.5) score += 10;
        else if (chg >= 0.5) score += 5;
        else if (chg < 0)   score -= 5;
      }

      // ATR volatility (higher ATR % = more room to move)
      if (r.atr14 != null && r.price) {
        const atrPct = (r.atr14 / r.price) * 100;
        if (atrPct >= 3)      score += 10;
        else if (atrPct >= 2) score += 7;
        else if (atrPct >= 1) score += 4;
      }

      return clamp(score, 0, 100);
    },

    /**
     * Full scan: fetch → filter → score → sort by score desc.
     * Mirrors the main scan() loop in scanner.py.
     */
    async scan(cfg) {
      const raw      = await this.fetchBatch(cfg.universe || MomentumConfig.UNIVERSE);
      const filtered = this.filter(raw, cfg);
      const scored   = filtered.map(r => ({ ...r, momentumScore: this.calcScore(r) }));
      return scored.sort((a, b) => b.momentumScore - a.momentumScore);
    },
  };

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 3 — strategy.py
   * Evaluates momentum signals and generates BUY / WATCH / AVOID decisions.
   * ════════════════════════════════════════════════════════════════════════════ */
  const MomentumStrategy = {
    /**
     * Derive a trade signal from a scored momentum row.
     * Mirrors getSignal() in strategy.py.
     */
    getSignal(row) {
      const score = row.momentumScore ?? 0;
      let signal, badge;
      if (score >= 70)      { signal = 'STRONG BUY'; badge = 'mt-signal-strong'; }
      else if (score >= 55) { signal = 'BUY';        badge = 'mt-signal-buy';    }
      else if (score >= 38) { signal = 'WATCH';      badge = 'mt-signal-watch';  }
      else                  { signal = 'AVOID';      badge = 'mt-signal-avoid';  }
      return { signal, badge, score };
    },

    /**
     * Generate a human-readable breakdown of each scoring component.
     * Mirrors scoreBreakdown() in strategy.py.
     */
    breakdown(row) {
      const items = [];

      // RSI
      if (row.rsi14 != null) {
        const rsi = row.rsi14;
        const ok  = rsi >= 48 && rsi <= 73;
        const hot = rsi >= 52 && rsi <= 68;
        items.push({
          label:  'RSI Momentum',
          value:  rsi.toFixed(1),
          note:   hot ? 'Optimal momentum zone' : ok ? 'Acceptable zone' : 'Outside range',
          status: hot ? 'good' : ok ? 'ok' : 'bad',
        });
      }

      // Relative Volume
      if (row.relVol != null) {
        const rv = row.relVol;
        items.push({
          label:  'Relative Volume',
          value:  rv.toFixed(2) + '×',
          note:   rv >= 3 ? 'Extreme surge' : rv >= 2 ? 'High volume' : rv >= 1.5 ? 'Above avg' : 'Low',
          status: rv >= 2 ? 'good' : rv >= 1.5 ? 'ok' : 'bad',
        });
      }

      // 52-week proximity
      if (row.w52Dist != null) {
        const d = row.w52Dist;
        items.push({
          label:  '52-Wk High Dist',
          value:  (d >= 0 ? '+' : '') + d.toFixed(1) + '%',
          note:   d >= -2 ? 'Near 52-wk high — momentum leader'
                : d >= -10 ? 'Within 10% of high'
                : 'Far from high — weak trend',
          status: d >= -5 ? 'good' : d >= -15 ? 'ok' : 'bad',
        });
      }

      // Day change
      if (row.change != null) {
        const c = row.change;
        items.push({
          label:  'Day Change',
          value:  (c >= 0 ? '+' : '') + c.toFixed(2) + '%',
          note:   c >= 3 ? 'Strong upward momentum'
                : c >= 1 ? 'Positive momentum'
                : c < 0  ? 'Negative — caution'
                : 'Flat',
          status: c >= 1.5 ? 'good' : c >= 0 ? 'ok' : 'bad',
        });
      }

      // ATR %
      if (row.atr14 != null && row.price) {
        const atrPct = (row.atr14 / row.price) * 100;
        items.push({
          label:  'ATR Volatility',
          value:  atrPct.toFixed(2) + '%',
          note:   atrPct >= 3 ? 'High volatility — wider stops needed'
                : atrPct >= 1.5 ? 'Good volatility for momentum'
                : 'Low volatility',
          status: atrPct >= 1.5 && atrPct <= 6 ? 'good' : atrPct > 0 ? 'ok' : 'bad',
        });
      }

      return items;
    },

    /**
     * Fetch and calculate EMA signal from historical daily bars.
     * Mirrors calcEMASignal() in strategy.py.
     */
    async getEMASignal(symbol, fastPeriod = 9, slowPeriod = 21) {
      try {
        const resp = await fetch(
          `/api/bars/${encodeURIComponent(symbol)}?timeframe=1Day&limit=60`,
          { credentials: 'include' }
        );
        if (!resp.ok) return null;
        const bars = await resp.json();
        if (!Array.isArray(bars) || bars.length < slowPeriod) return null;

        const closes = bars.map(b => b.c).filter(c => c != null);
        const emaFast = _calcEMA(closes, fastPeriod);
        const emaSlow = _calcEMA(closes, slowPeriod);
        if (emaFast == null || emaSlow == null) return null;

        const bullish = emaFast > emaSlow;
        const gap     = ((emaFast - emaSlow) / emaSlow) * 100;

        // Check recent crossover (last 3 bars)
        const prevFast = _calcEMA(closes.slice(0, -1), fastPeriod);
        const prevSlow = _calcEMA(closes.slice(0, -1), slowPeriod);
        const recentCross = prevFast != null && prevSlow != null
          && ((prevFast <= prevSlow && emaFast > emaSlow)   // golden cross
           || (prevFast >= prevSlow && emaFast < emaSlow)); // death cross

        return {
          emaFast:     +emaFast.toFixed(2),
          emaSlow:     +emaSlow.toFixed(2),
          fastLabel:   `EMA(${fastPeriod})`,
          slowLabel:   `EMA(${slowPeriod})`,
          bullish,
          gap:         +gap.toFixed(3),
          recentCross,
          signal:      bullish ? 'BULLISH' : 'BEARISH',
        };
      } catch { return null; }
    },
  };

  // Internal EMA helper (matches server-side calcEMA)
  function _calcEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  }

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 4 — risk.py
   * Position sizing, stop loss, take profit, and risk/reward validation.
   * ════════════════════════════════════════════════════════════════════════════ */
  const RiskManager = {
    /**
     * Calculate stop loss price using ATR multiple.
     * stop = entry − (atr × multiplier)  for long trades.
     * Mirrors calcStopLoss() in risk.py.
     */
    calcStopLoss(entry, atr, multiplier = 1.5, side = 'buy') {
      if (!entry || !atr) return null;
      return side === 'buy'
        ? +(entry - atr * multiplier).toFixed(2)
        : +(entry + atr * multiplier).toFixed(2);
    },

    /**
     * Calculate take profit to achieve target risk:reward ratio.
     * Mirrors calcTakeProfit() in risk.py.
     */
    calcTakeProfit(entry, stopLoss, rrRatio = 2.0, side = 'buy') {
      if (!entry || !stopLoss) return null;
      const risk = Math.abs(entry - stopLoss);
      return side === 'buy'
        ? +(entry + risk * rrRatio).toFixed(2)
        : +(entry - risk * rrRatio).toFixed(2);
    },

    /**
     * Calculate number of shares to risk exactly riskPct% of equity.
     * shares = (equity × riskPct%) / (entry − stopLoss)
     * Mirrors calcPositionSize() in risk.py.
     */
    calcPositionSize(equity, riskPct, entry, stopLoss) {
      if (!equity || !entry || !stopLoss) return null;
      const riskAmt   = equity * (riskPct / 100);
      const riskPerSh = Math.abs(entry - stopLoss);
      if (riskPerSh <= 0) return null;
      return Math.max(1, Math.floor(riskAmt / riskPerSh));
    },

    /**
     * Actual risk:reward ratio for given entry/stop/target.
     */
    calcRR(entry, stopLoss, takeProfit) {
      if (!entry || !stopLoss || !takeProfit) return null;
      const risk   = Math.abs(entry - stopLoss);
      const reward = Math.abs(takeProfit - entry);
      return risk > 0 ? +(reward / risk).toFixed(2) : null;
    },

    /**
     * Full trade validation — returns summary object.
     * Mirrors validateTrade() in risk.py.
     */
    validate(entry, stopLoss, takeProfit, equity, shares, minRR = 2.0) {
      const riskPerSh  = Math.abs(entry - stopLoss);
      const rewardPerSh = Math.abs(takeProfit - entry);
      const totalRisk  = riskPerSh * shares;
      const totalRew   = rewardPerSh * shares;
      const rr         = riskPerSh > 0 ? +(rewardPerSh / riskPerSh).toFixed(2) : 0;
      const riskPct    = equity > 0    ? +((totalRisk / equity) * 100).toFixed(2) : 0;
      const valid      = rr >= minRR && riskPct <= 5;
      return { valid, rr, riskPct, totalRisk, totalReward: totalRew, riskPerSh, rewardPerSh };
    },
  };

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 5 — alpaca_client.py
   * Thin wrapper around the existing /api/alpaca/* server endpoints.
   * ════════════════════════════════════════════════════════════════════════════ */
  const AlpacaClient = {
    connected: false,
    account:   null,
    mode:      'paper',

    async checkConnection() {
      try {
        const r = await fetch('/api/alpaca/credentials', { credentials: 'include' });
        if (!r.ok) { this.connected = false; return false; }
        const d = await r.json();
        this.connected = !!d.connected;
        this.mode      = d.mode || 'paper';
        if (this.connected) await this.loadAccount();
        return this.connected;
      } catch { this.connected = false; return false; }
    },

    async loadAccount() {
      try {
        const r = await fetch('/api/alpaca/account', { credentials: 'include' });
        if (r.ok) { this.account = await r.json(); }
      } catch {}
    },

    getEquity()  { return parseFloat(this.account?.equity     || 0); },
    getCash()    { return parseFloat(this.account?.cash       || 0); },
    getBP()      { return parseFloat(this.account?.buying_power || 0); },

    /**
     * Place a bracket market order: entry at market, SL + TP as bracket legs.
     * Mirrors place_order() in alpaca_client.py.
     */
    async placeOrder({ symbol, side, shares, stopPrice, takeProfitPrice }) {
      const body = {
        symbol,
        qty:           String(Math.max(1, Math.floor(shares))),
        side:          side.toLowerCase(),
        type:          'market',
        time_in_force: 'day',
        order_class:   'bracket',
        stop_loss:     { stop_price: String(stopPrice.toFixed(2)) },
        take_profit:   { limit_price: String(takeProfitPrice.toFixed(2)) },
      };
      const r = await fetch('/api/alpaca/order', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({
          symbol, side, amount: shares * stopPrice, // rough notional for existing endpoint
          tpPct: null, slPct: null, _rawBody: body, // pass-through intent
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || 'Order failed');
      }
      return r.json();
    },

    /**
     * Simple notional order without bracket (for quick entries).
     */
    async placeSimpleOrder(symbol, side, notional) {
      const r = await fetch('/api/alpaca/order', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ symbol, side, amount: notional }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || 'Order failed');
      }
      return r.json();
    },
  };

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 6 — main.py
   * MomentumBot: orchestrates the full pipeline scan → signal → risk → execute.
   * ════════════════════════════════════════════════════════════════════════════ */
  const MomentumBot = {
    running:     false,
    scanResults: [],
    selectedRow: null,
    emaSignal:   null,
    riskCalc:    null,
    log:         [],
    config:      null,
    countdownTimer: null,
    countdown:   0,
    REFRESH_SEC: 90,

    init() {
      this.config = MomentumConfig.load();
      this._bindEvents();
      this._renderConfigPanel();
      AlpacaClient.checkConnection().then(() => {
        this._renderStatus();
        this.run();
      });
    },

    /* ── Public pipeline entry — mirrors main.py's run() ─────────────────── */
    async run() {
      this.running = true;
      this._setScanStatus('scanning');
      try {
        const results = await MomentumScanner.scan(this.config);
        this.scanResults = results;
        this._renderScanTable(results);
        this._setScanStatus('done', results.length);
        this._startCountdown();
      } catch (err) {
        this._setScanStatus('error', 0, err.message);
      }
    },

    /* ── Config ──────────────────────────────────────────────────────────── */
    _renderConfigPanel() {
      const cfg = this.config;
      const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
      setVal('mtRsiMin',    cfg.rsiMin);
      setVal('mtRsiMax',    cfg.rsiMax);
      setVal('mtRelVol',    cfg.minRelVol);
      setVal('mtMinPrice',  cfg.minPrice);
      setVal('mtMaxPrice',  cfg.maxPrice);
      setVal('mtRiskPct',   cfg.riskPctPerTrade);
      setVal('mtMinRR',     cfg.minRR);
      setVal('mtAtrMult',   cfg.atrMultiplier);
    },

    _readConfig() {
      const n = id => { const v = parseFloat($(id)?.value); return isNaN(v) ? null : v; };
      return {
        ...this.config,
        rsiMin:          n('mtRsiMin')   ?? this.config.rsiMin,
        rsiMax:          n('mtRsiMax')   ?? this.config.rsiMax,
        minRelVol:       n('mtRelVol')   ?? this.config.minRelVol,
        minPrice:        n('mtMinPrice') ?? this.config.minPrice,
        maxPrice:        n('mtMaxPrice') ?? this.config.maxPrice,
        riskPctPerTrade: n('mtRiskPct')  ?? this.config.riskPctPerTrade,
        minRR:           n('mtMinRR')    ?? this.config.minRR,
        atrMultiplier:   n('mtAtrMult')  ?? this.config.atrMultiplier,
      };
    },

    /* ── Scan table rendering ────────────────────────────────────────────── */
    _renderScanTable(results) {
      const tbody = $('mtScanBody');
      if (!tbody) return;

      if (!results.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="mt-empty-row">No momentum stocks found — try relaxing filters</td></tr>`;
        return;
      }

      tbody.innerHTML = results.slice(0, 40).map((r, i) => {
        const sig = MomentumStrategy.getSignal(r);
        const chgUp = r.change > 0;
        return `<tr class="mt-scan-row ${i === 0 ? 'mt-scan-row--top' : ''}" data-sym="${r.sym}" data-idx="${i}">
          <td class="mt-sym-cell">
            <span class="mt-sym">${r.sym}</span>
            <span class="mt-sym-name">${(r.name || '').replace(/&/g, '&amp;').slice(0, 20)}</span>
          </td>
          <td class="mt-r">${fmtDollar(r.price)}</td>
          <td class="mt-r ${chgUp ? 'mt-up' : 'mt-dn'}">${r.change != null ? (chgUp ? '+' : '') + r.change.toFixed(2) + '%' : '--'}</td>
          <td class="mt-r">${r.relVol != null ? r.relVol.toFixed(2) + '×' : '--'}</td>
          <td class="mt-r">${r.rsi14 != null ? r.rsi14 : '--'}</td>
          <td class="mt-r">${r.w52Dist != null ? (r.w52Dist >= 0 ? '+' : '') + r.w52Dist.toFixed(1) + '%' : '--'}</td>
          <td class="mt-r">
            <div class="mt-score-bar-wrap">
              <div class="mt-score-bar" style="width:${r.momentumScore}%"></div>
              <span class="mt-score-num">${r.momentumScore}</span>
            </div>
          </td>
          <td><span class="mt-signal-badge ${sig.badge}">${sig.signal}</span></td>
        </tr>`;
      }).join('');

      // Row click → open detail panel
      tbody.querySelectorAll('.mt-scan-row').forEach(tr => {
        tr.addEventListener('click', () => {
          tbody.querySelectorAll('.mt-scan-row').forEach(r => r.classList.remove('mt-row-active'));
          tr.classList.add('mt-row-active');
          const idx = +tr.dataset.idx;
          this._openDetail(this.scanResults[idx]);
        });
      });

      // Auto-open top result
      if (results.length && !this.selectedRow) {
        tbody.querySelector('.mt-scan-row')?.click();
      }
    },

    /* ── Detail / signal panel ───────────────────────────────────────────── */
    async _openDetail(row) {
      this.selectedRow = row;
      this._renderSignalPanel(row);
      this._updateRiskPanel(row);

      // Fetch EMA signal asynchronously
      const emaEl = $('mtEmaSignal');
      if (emaEl) emaEl.innerHTML = `<span class="mt-loading-sm">Fetching EMA…</span>`;

      const ema = await MomentumStrategy.getEMASignal(
        row.sym, this.config.emaFast, this.config.emaSlow
      );
      this.emaSignal = ema;
      this._renderEMASignal(ema);
    },

    _renderSignalPanel(row) {
      const sig       = MomentumStrategy.getSignal(row);
      const breakdown = MomentumStrategy.breakdown(row);
      const panel     = $('mtDetailPanel');
      if (!panel) return;

      panel.style.display = '';

      // Header
      const symEl  = $('mtDetailSym');
      const sigEl  = $('mtDetailSig');
      const priceEl = $('mtDetailPrice');
      if (symEl)  symEl.textContent  = row.sym;
      if (priceEl) priceEl.textContent = fmtDollar(row.price);
      if (sigEl) {
        sigEl.textContent  = sig.signal;
        sigEl.className    = 'mt-detail-sig-badge ' + sig.badge;
      }

      // Score ring
      const scoreEl = $('mtScoreValue');
      const ringEl  = $('mtScoreRing');
      if (scoreEl) scoreEl.textContent = row.momentumScore;
      if (ringEl) {
        const pct = row.momentumScore / 100;
        const circumference = 2 * Math.PI * 28;
        ringEl.style.strokeDashoffset = circumference * (1 - pct);
        ringEl.style.stroke = row.momentumScore >= 70 ? '#1dd6a3'
          : row.momentumScore >= 55 ? '#4a90e2'
          : row.momentumScore >= 38 ? '#f5c842'
          : '#e84545';
      }

      // Breakdown items
      const listEl = $('mtBreakdownList');
      if (listEl) {
        listEl.innerHTML = breakdown.map(item => `
          <div class="mt-breakdown-item mt-bk-${item.status}">
            <div class="mt-bk-left">
              <span class="mt-bk-dot mt-bk-dot-${item.status}"></span>
              <span class="mt-bk-label">${item.label}</span>
            </div>
            <div class="mt-bk-right">
              <span class="mt-bk-value">${item.value}</span>
              <span class="mt-bk-note">${item.note}</span>
            </div>
          </div>`).join('');
      }
    },

    _renderEMASignal(ema) {
      const el = $('mtEmaSignal');
      if (!el) return;
      if (!ema) { el.innerHTML = `<span class="mt-na">EMA data unavailable</span>`; return; }
      el.innerHTML = `
        <div class="mt-ema-row">
          <span class="mt-ema-label">${ema.fastLabel}</span>
          <span class="mt-ema-val">${fmtDollar(ema.emaFast)}</span>
        </div>
        <div class="mt-ema-row">
          <span class="mt-ema-label">${ema.slowLabel}</span>
          <span class="mt-ema-val">${fmtDollar(ema.emaSlow)}</span>
        </div>
        <div class="mt-ema-row">
          <span class="mt-ema-label">Trend</span>
          <span class="mt-ema-val ${ema.bullish ? 'mt-up' : 'mt-dn'}">
            ${ema.bullish ? '▲' : '▼'} ${ema.signal}
            ${ema.recentCross ? '<span class="mt-cross-badge">' + (ema.bullish ? '✦ Golden Cross' : '✦ Death Cross') + '</span>' : ''}
          </span>
        </div>
        <div class="mt-ema-row">
          <span class="mt-ema-label">Gap</span>
          <span class="mt-ema-val">${ema.gap >= 0 ? '+' : ''}${ema.gap}%</span>
        </div>`;
    },

    /* ── Risk panel ──────────────────────────────────────────────────────── */
    _updateRiskPanel(row) {
      if (!row) return;
      const entry  = row.price;
      const atr    = row.atr14;
      const equity = AlpacaClient.getEquity() || 10000; // fallback for disconnected
      const cfg    = this.config;

      const stopLoss   = RiskManager.calcStopLoss(entry, atr, cfg.atrMultiplier);
      const takeProfit = RiskManager.calcTakeProfit(entry, stopLoss, cfg.minRR);
      const shares     = RiskManager.calcPositionSize(equity, cfg.riskPctPerTrade, entry, stopLoss);
      const rr         = RiskManager.calcRR(entry, stopLoss, takeProfit);
      const validation = shares ? RiskManager.validate(entry, stopLoss, takeProfit, equity, shares, cfg.minRR) : null;

      this.riskCalc = { entry, stopLoss, takeProfit, shares, rr, validation };

      const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
      set('mtRiskEntry',    fmtDollar(entry));
      set('mtRiskStop',     fmtDollar(stopLoss));
      set('mtRiskTP',       fmtDollar(takeProfit));
      set('mtRiskShares',   shares ?? '--');
      set('mtRiskRR',       rr != null ? rr.toFixed(2) + ':1' : '--');
      set('mtRiskAmt',      validation ? fmtDollar(validation.totalRisk) : '--');
      set('mtRiskReward',   validation ? fmtDollar(validation.totalReward) : '--');
      set('mtRiskPctUsed',  validation ? validation.riskPct + '% of equity' : '--');

      // Validity indicator
      const valEl = $('mtRiskValid');
      if (valEl && validation) {
        valEl.textContent = validation.valid ? '✓ Valid trade setup' : '✗ Does not meet risk rules';
        valEl.className   = 'mt-risk-valid ' + (validation.valid ? 'mt-valid-ok' : 'mt-valid-bad');
      }

      // Populate trade panel
      const symEl = $('mtTradeSymbol');
      if (symEl) symEl.textContent = row.sym;
      const priceEl = $('mtTradePriceDisplay');
      if (priceEl) priceEl.textContent = fmtDollar(entry);
    },

    /* ── Status / countdown ──────────────────────────────────────────────── */
    _setScanStatus(state, count = 0, err = '') {
      const el    = $('mtScanStatus');
      const cdEl  = $('mtCountdown');
      if (!el) return;
      if (state === 'scanning') {
        el.textContent = '⟳ Scanning ' + (this.config.universe || MomentumConfig.UNIVERSE).length + ' tickers…';
        if (cdEl) cdEl.textContent = '';
      } else if (state === 'done') {
        el.textContent = `✓ ${count} stock${count !== 1 ? 's' : ''} · Updated ${new Date().toLocaleTimeString()}`;
      } else if (state === 'error') {
        el.textContent = '✗ ' + (err || 'Scan failed');
      }
    },

    _startCountdown() {
      clearInterval(this.countdownTimer);
      this.countdown = this.REFRESH_SEC;
      const cdEl = $('mtCountdown');
      this.countdownTimer = setInterval(() => {
        this.countdown--;
        if (cdEl) cdEl.textContent = this.countdown + 's';
        if (this.countdown <= 0) {
          clearInterval(this.countdownTimer);
          this.run();
        }
      }, 1000);
    },

    _renderStatus() {
      const conn  = AlpacaClient.connected;
      const mode  = AlpacaClient.mode;
      const badge = $('mtModeBadge');
      const chips = $('mtAcctChips');
      if (badge) {
        badge.textContent = conn ? mode.toUpperCase() : 'DISCONNECTED';
        badge.className   = 'mt-mode-badge ' + (conn ? (mode === 'live' ? 'mt-badge-live' : 'mt-badge-paper') : 'mt-badge-disc');
      }
      if (chips) chips.style.display = conn ? '' : 'none';
      if (conn) {
        const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
        set('mtEquity', fmtDollar(AlpacaClient.getEquity()));
        set('mtCash',   fmtDollar(AlpacaClient.getCash()));
        set('mtBP',     fmtDollar(AlpacaClient.getBP()));
      }
    },

    /* ── Activity log ────────────────────────────────────────────────────── */
    addLog(sym, action, details, status = 'ok') {
      this.log.unshift({ sym, action, details, status, time: new Date().toLocaleTimeString() });
      if (this.log.length > 30) this.log.pop();
      this._renderLog();
    },

    _renderLog() {
      const tbody = $('mtLogBody');
      if (!tbody) return;
      if (!this.log.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="mt-empty-row">No activity yet</td></tr>`;
        return;
      }
      tbody.innerHTML = this.log.map(e => `<tr>
        <td class="mt-r">${e.time}</td>
        <td><strong>${e.sym}</strong></td>
        <td>${e.action}</td>
        <td>${e.details}</td>
        <td><span class="mt-log-status mt-log-${e.status}">${e.status === 'ok' ? '✓' : e.status === 'err' ? '✗' : '◎'}</span></td>
      </tr>`).join('');
    },

    /* ── Event binding ───────────────────────────────────────────────────── */
    _bindEvents() {
      // Refresh scan
      $('mtRefreshBtn')?.addEventListener('click', () => {
        this.config = this._readConfig();
        MomentumConfig.save(this.config);
        this.selectedRow = null;
        this.run();
      });

      // Apply config
      $('mtApplyConfig')?.addEventListener('click', () => {
        this.config = this._readConfig();
        MomentumConfig.save(this.config);
        this.selectedRow = null;
        this.addLog('CONFIG', 'Settings updated', `RSI ${this.config.rsiMin}–${this.config.rsiMax} · RelVol ≥${this.config.minRelVol}`, 'info');
        this.run();
      });

      // Reset config to defaults
      $('mtResetConfig')?.addEventListener('click', () => {
        this.config = { ...MomentumConfig.defaults };
        MomentumConfig.save(this.config);
        this._renderConfigPanel();
        this.addLog('CONFIG', 'Reset to defaults', '', 'info');
        this.run();
      });

      // Toggle config panel
      $('mtConfigToggle')?.addEventListener('click', () => {
        const body = $('mtConfigBody');
        if (!body) return;
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        $('mtConfigToggle').textContent = hidden ? '▲ Collapse' : '▼ Configure';
      });

      // Quick buy — places a simple notional order via Alpaca
      $('mtBuyBtn')?.addEventListener('click', async () => {
        const row = this.selectedRow;
        const rc  = this.riskCalc;
        if (!row || !rc?.shares) return this.addLog(row?.sym || '?', 'BUY', 'No valid risk calc', 'err');
        if (!AlpacaClient.connected) return this.addLog(row.sym, 'BUY', 'Not connected to Alpaca', 'err');
        const btn = $('mtBuyBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Placing…'; }
        try {
          await AlpacaClient.placeSimpleOrder(row.sym, 'buy', rc.shares * row.price);
          this.addLog(row.sym, 'BUY', `${rc.shares} shares @ ~${fmtDollar(row.price)}`, 'ok');
          this._showTradeSuccess(`BUY ${row.sym} — order placed`);
        } catch (err) {
          this.addLog(row.sym, 'BUY FAILED', err.message, 'err');
          this._showTradeError(err.message);
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '▲ BUY'; }
        }
      });

      // Short sell
      $('mtSellBtn')?.addEventListener('click', async () => {
        const row = this.selectedRow;
        const rc  = this.riskCalc;
        if (!row || !rc?.shares) return this.addLog(row?.sym || '?', 'SELL', 'No valid risk calc', 'err');
        if (!AlpacaClient.connected) return this.addLog(row.sym, 'SELL', 'Not connected to Alpaca', 'err');
        const btn = $('mtSellBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Placing…'; }
        try {
          await AlpacaClient.placeSimpleOrder(row.sym, 'sell', rc.shares * row.price);
          this.addLog(row.sym, 'SELL', `${rc.shares} shares @ ~${fmtDollar(row.price)}`, 'ok');
          this._showTradeSuccess(`SELL ${row.sym} — order placed`);
        } catch (err) {
          this.addLog(row.sym, 'SELL FAILED', err.message, 'err');
          this._showTradeError(err.message);
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '▼ SELL'; }
        }
      });

      // Clear log
      $('mtClearLog')?.addEventListener('click', () => {
        this.log = [];
        this._renderLog();
      });
    },

    _showTradeSuccess(msg) {
      const el = $('mtTradeMsg');
      if (!el) return;
      el.textContent  = msg;
      el.className    = 'mt-trade-msg mt-trade-ok';
      el.style.display = '';
      setTimeout(() => { el.style.display = 'none'; }, 4000);
    },
    _showTradeError(msg) {
      const el = $('mtTradeMsg');
      if (!el) return;
      el.textContent  = '✗ ' + msg;
      el.className    = 'mt-trade-msg mt-trade-err';
      el.style.display = '';
      setTimeout(() => { el.style.display = 'none'; }, 6000);
    },
  };

  /* ════════════════════════════════════════════════════════════════════════════
   * PUBLIC API — hooked into app.js navigation
   * ════════════════════════════════════════════════════════════════════════════ */
  let _initialized = false;

  window.momentumTrader = {
    open() {
      if (!_initialized) {
        _initialized = true;
        MomentumBot.init();
      } else {
        // Refresh connection status + re-render status bar
        AlpacaClient.checkConnection().then(() => MomentumBot._renderStatus());
      }
    },
    pause() {
      clearInterval(MomentumBot.countdownTimer);
    },
  };

}());
