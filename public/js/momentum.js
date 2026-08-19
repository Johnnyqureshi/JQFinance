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
      // Position size
      manualShares:   null,     // null = user enters; number = fixed shares
      // Daily limits
      maxTradesPerDay: 5,
      maxDailyLoss:   500.00,
      // ── 5 PILLARS (hard filters — all must pass) ─────────────────────────
      // Pillar 1: Price $2–$20 (low-priced volatile small-caps)
      minPrice:       2.00,
      maxPrice:       20.00,
      // Pillar 2: Daily gain ≥ 10% (intraday momentum already present)
      minGainPercent: 10.0,
      // Pillar 3: Relative volume ≥ 5× (heavy market participation)
      minRelVol:      5.0,
      // Pillar 4: News catalyst required (breaking headline confirms the move)
      requireNewsCatalyst: true,
      // Pillar 5: Float < 10M shares (low supply → explosive moves possible)
      maxFloat:       10_000_000,
      // Minimum absolute volume sanity check (independent of pillars)
      minVolume:      100000,
      // Score threshold: max 7 — all 5 pillars = 6 pts, rvol≥10× adds 1 bonus
      minScore:       4,
      // Risk
      stopPercent:    5,        // 5% stop — backtest shows 2% is too tight for gap-up plays; avg intraday LOW is -6.6% from open
      minRR:          2.0,      // 2:1 R:R → TP = 10% with 5% SL; backtest win rate 43.5% vs 33.3% break-even needed
      // EMA trend
      emaFast:        9,
      emaSlow:        21,
      // Scanner universe: 'curated' | 'alpaca'
      universeMode:   'alpaca',   // default to live Alpaca top-100 most-actives
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
    async fetchBatch(symbols, onProgress) {
      // Split into chunks of 50 and run up to 3 chunks in parallel
      const CHUNK = 50, CONCURRENCY = 3;
      const chunks = [];
      for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));

      const results = [];
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const wave = chunks.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(wave.map(chunk =>
          fetch('/api/scanner-batch', {
            method:      'POST',
            headers:     { 'Content-Type': 'application/json' },
            credentials: 'include',
            body:        JSON.stringify({ symbols: chunk }),
          }).then(r => r.ok ? r.json() : { results: [] })
            .then(d => d.results || [])
        ));
        for (const r of settled) {
          if (r.status === 'fulfilled') results.push(...r.value);
          else console.warn('[Scanner] Batch chunk failed:', r.reason?.message || r.reason);
        }
        if (onProgress) {
          const done = Math.min(symbols.length, (i + CONCURRENCY) * CHUNK);
          onProgress(done, symbols.length);
        }
      }
      return results;
    },

    /**
     * Apply momentum pre-filters — the 5 pillars as hard gates.
     * Mirrors the filter() method in scanner.py.
     *
     * Pillar 1: Price $2–$20
     * Pillar 2: Daily gain ≥ 10%
     * Pillar 3: Relative volume ≥ 5× (configurable)
     * Pillar 4: News catalyst — checked AFTER Pass 2 in scan()
     * Pillar 5: Float < 10M shares — if floatSh is known, reject over-limit; if unknown, allow through
     */
    filter(results, cfg) {
      return results.filter(r => {
        if (r.price == null) return false;

        // Pillar 1: price range
        if (r.price < (cfg.minPrice ?? 2) || r.price > (cfg.maxPrice ?? 20)) return false;

        // Pillar 2: minimum gain
        if (cfg.minGainPercent != null && (r.change ?? 0) < cfg.minGainPercent) return false;

        // Pillar 3: relative volume
        if (cfg.minRelVol != null && (r.relVol ?? 0) < cfg.minRelVol) return false;

        // Absolute volume floor
        if (cfg.minVolume != null && (r.volume ?? 0) < cfg.minVolume) return false;

        // Pillar 5: float — only filter when float data is available AND over the limit
        // (null floatSh = Yahoo didn't return it → allow through, don't penalise)
        if (cfg.maxFloat != null && r.floatSh != null && r.floatSh > cfg.maxFloat) return false;

        return true;
      });
    },

    /**
     * Score a stock against the 5 pillars. Max 7 points.
     *
     *   Pillar 2 — Momentum  gain ≥ 10%       → +2   "Strong momentum"
     *                        gain ≥ 20%       → +1   "Very strong momentum"  (cumul: +3)
     *   Pillar 3 — RelVol    rvol ≥ 5×        → +1   "Relative volume ≥ 5×"
     *                        rvol ≥ 10×       → +1   "Extreme volume surge ≥ 10×"  (cumul: +2)
     *   Pillar 4 — News      hasNewsCatalyst  → +1   "News catalyst confirmed"
     *   Pillar 5 — Float     float < 10M      → +1   "Low float (< 10M shares)"
     *
     * Pillars 1 (price $2–$20) and the ≥10%/≥5x/news requirements are
     * enforced as hard filters in filter() / scan(). Score differentiates
     * quality among stocks that already passed all pillars.
     *
     * Returns { score, reasons, qualified }.
     */
    calcScore(r, minScore = 0) {
      let score   = 0;
      const reasons = [];

      const gain  = r.change  ?? 0;
      const rvol  = r.relVol  ?? 0;
      const float = r.floatSh ?? null;

      // ── PILLAR 2: MOMENTUM ────────────────────────────────────────────────
      if (gain >= 10) { score += 2; reasons.push('Strong momentum (≥ 10%)'); }
      if (gain >= 20) { score += 1; reasons.push('Very strong momentum (≥ 20%)'); }

      // ── PILLAR 3: RELATIVE VOLUME ─────────────────────────────────────────
      if (rvol >= 5)  { score += 1; reasons.push('Relative volume ≥ 5×'); }
      if (rvol >= 10) { score += 1; reasons.push('Extreme volume surge ≥ 10×'); }

      // ── PILLAR 4: NEWS CATALYST (set by scan() Pass 2) ───────────────────
      if (r.hasNewsCatalyst) { score += 1; reasons.push('News catalyst confirmed'); }

      // ── PILLAR 5: FLOAT ───────────────────────────────────────────────────
      if (float != null && float < 10_000_000) { score += 1; reasons.push('Low float (< 10M shares)'); }

      return { score, reasons, qualified: score >= minScore };
    },

    /**
     * Fetch the live full-market universe from the server.
     * Returns { symbols, gainers, highVolume, source, count } or null on failure.
     */
    async fetchAlpacaUniverse() {
      try {
        const resp = await fetch('/api/momentum/universe', { credentials: 'include' });
        if (!resp.ok) return null;
        const d = await resp.json();
        if (!d.symbols?.length) return null;
        // Attach metadata so the scan loop can show progress labels
        return d;
      } catch { return null; }
    },

    /**
     * Full scan: resolve universe → fetch → filter → score → MIN_SCORE filter → sort.
     * Mirrors the main scan() loop in scanner.py.
     */
    // Metadata from the last universe fetch — used by the status display
    _lastUniverseMeta: null,

    async scan(cfg, onProgress) {
      // Resolve universe: live full-market feed OR static curated list
      let universe = MomentumConfig.UNIVERSE;
      this._lastUniverseMeta = null;
      if (cfg.universeMode === 'alpaca') {
        const uni = await this.fetchAlpacaUniverse();
        if (uni?.symbols?.length) {
          universe = uni.symbols;
          this._lastUniverseMeta = uni;
        }
      }

      const raw = await this.fetchBatch(universe, onProgress);
      const filtered = this.filter(raw, cfg);
      const minScore = cfg.minScore ?? 0;

      // ── Pass 1: base score (no news) — fast, synchronous ─────────────────
      const scored = filtered.map(r => {
        const result = this.calcScore(r, minScore);
        return { ...r, momentumScore: result.score, scoreReasons: result.reasons, scoreQualified: result.qualified };
      });

      // ── Pass 2: news catalyst check on base-qualifying stocks ─────────────
      // Fetch news in parallel only for stocks that clear the base threshold.
      // A confirmed headline adds +1 and can lift a borderline stock above minScore.
      const candidates = scored.filter(r => r.momentumScore >= Math.max(0, minScore - 1));
      if (candidates.length > 0) {
        try {
          const newsResults = await Promise.allSettled(
            candidates.map(r =>
              fetch(`/api/news/${encodeURIComponent(r.sym)}`, { credentials: 'include' })
                .then(res => res.ok ? res.json() : { news: [] })
                .catch(() => ({ news: [] }))
            )
          );
          newsResults.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value?.news?.length > 0) {
              const stock = candidates[i];
              stock.hasNewsCatalyst  = true;
              stock.newsHeadline     = result.value.news[0]?.title || null;
              // Re-score with news flag set
              const rescored = this.calcScore(stock, minScore);
              stock.momentumScore  = rescored.score;
              stock.scoreReasons   = rescored.reasons;
              stock.scoreQualified = rescored.qualified;
            }
          });
        } catch (_) { /* news fetch failing must never break the scan */ }
      }

      // ── Pillar 4: News catalyst hard filter (if enabled) ─────────────────
      // Applied after Pass 2 so we only reject stocks we actually checked.
      // If ALL news fetches failed (API down), skip this filter to avoid
      // silently returning zero results.
      const anyNewsFound = scored.some(r => r.hasNewsCatalyst);
      const applyNewsFilter = cfg.requireNewsCatalyst && anyNewsFound;
      const withNewsFilter = applyNewsFilter
        ? scored.filter(r => r.hasNewsCatalyst)
        : scored;

      // Apply MIN_SCORE filter
      const passing = withNewsFilter.filter(r => r.scoreQualified);

      return passing.sort((a, b) => b.momentumScore - a.momentumScore);
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
    /**
     * Signal from score (0–6 scale).
     * 5–6 = STRONG BUY · 3–4 = BUY · 2 = WATCH · 0–1 = AVOID
     */
    getSignal(row) {
      const score = row.momentumScore ?? 0;
      let signal, badge;
      if (score >= 5)      { signal = 'STRONG BUY'; badge = 'mt-signal-strong'; }
      else if (score >= 3) { signal = 'BUY';        badge = 'mt-signal-buy';    }
      else if (score >= 2) { signal = 'WATCH';      badge = 'mt-signal-watch';  }
      else                 { signal = 'AVOID';      badge = 'mt-signal-avoid';  }
      return { signal, badge, score };
    },

    /**
     * Breakdown from the scored reasons array (from calculate_score / calcScore).
     * Mirrors scoreBreakdown() in strategy.py.
     *
     * Rows with scoreReasons show each earned criterion.
     * Rows without it (legacy) fall back to raw field values.
     */
    breakdown(row) {
      const gain  = row.change  ?? 0;
      const rvol  = row.relVol  ?? 0;
      const price = row.price   ?? 0;
      const float = row.floatSh ?? null;
      const floatM = float != null ? (float / 1_000_000).toFixed(2) + 'M' : null;

      // ── 5 PILLARS — show pass/fail + points earned ────────────────────────
      return [
        {
          label:  '① Price $2 – $20',
          value:  price ? '$' + price.toFixed(2) : '--',
          note:   price >= 2 && price <= 20 ? '✓ Hard filter passed' : '✗ Outside $2–$20',
          status: price >= 2 && price <= 20 ? 'good' : 'bad',
          pillar: true,
        },
        {
          label:  '② Daily Gain ≥ 10%',
          value:  gain != null ? (gain >= 0 ? '+' : '') + gain.toFixed(2) + '%' : '--',
          note:   gain >= 20 ? '+2 pts + bonus: very strong' : gain >= 10 ? '+2 pts: strong momentum' : '✗ Needs ≥ 10%',
          status: gain >= 20 ? 'good' : gain >= 10 ? 'ok' : 'bad',
          pillar: true,
        },
        {
          label:  '③ Relative Volume ≥ 5×',
          value:  rvol ? rvol.toFixed(2) + '×' : '--',
          note:   rvol >= 10 ? '+1 pt + bonus: extreme surge ≥ 10×' : rvol >= 5 ? '+1 pt: ≥ 5× confirmed' : '✗ Needs ≥ 5×',
          status: rvol >= 10 ? 'good' : rvol >= 5 ? 'ok' : 'bad',
          pillar: true,
        },
        {
          label:  '④ News Catalyst',
          value:  row.hasNewsCatalyst ? '✓ Found' : row.newsHeadline === undefined ? '—' : 'None',
          note:   row.hasNewsCatalyst
            ? (row.newsHeadline ? row.newsHeadline.slice(0, 60) + '…' : '+1 pt: catalyst confirmed')
            : 'Required — no headline detected',
          status: row.hasNewsCatalyst ? 'good' : 'bad',
          pillar: true,
        },
        {
          label:  '⑤ Float < 10M shares',
          value:  floatM ?? 'Unknown',
          note:   float == null
            ? 'Float data unavailable (Yahoo)'
            : float < 5_000_000  ? '+1 pt: very low float (< 5M) ✓'
            : float < 10_000_000 ? '+1 pt: low float (< 10M) ✓'
            : '✗ Float too high (> 10M)',
          status: float == null ? 'ok' : float < 10_000_000 ? 'good' : 'bad',
          pillar: true,
        },
      ];
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
    connected:      false,
    account:        null,
    accountError:   null,   // set when creds exist but account fetch fails
    mode:           'paper',
    paperConnected: false,
    liveConnected:  false,

    async checkConnection() {
      try {
        const r = await fetch('/api/alpaca/credentials', { credentials: 'include' });
        if (!r.ok) { this.connected = false; return false; }
        const d = await r.json();
        this.mode           = d.mode || 'paper';
        this.paperConnected = !!d.paperConnected;
        this.liveConnected  = !!d.liveConnected;
        this.connected      = !!d.connected;
        if (this.connected) await this.loadAccount();
        return this.connected;
      } catch { this.connected = false; return false; }
    },

    async loadAccount() {
      try {
        const r = await fetch('/api/alpaca/account', { credentials: 'include' });
        if (r.ok) {
          this.account      = await r.json();
          this.accountError = null;
          return true;
        }
        const err         = await r.json().catch(() => ({}));
        this.account      = null;
        this.accountError = err.error || `Account fetch failed (HTTP ${r.status})`;
        return false;
      } catch (e) {
        this.account      = null;
        this.accountError = e.message || 'Network error fetching account';
        return false;
      }
    },

    // Switch between paper and live — requires that mode's creds to be saved first
    async switchMode(mode) {
      try {
        const r = await fetch('/api/alpaca/switch-mode', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        if (!r.ok) {
          const e    = await r.json().catch(() => ({}));
          this.accountError = e.error || `Cannot switch to ${mode} — save ${mode} API keys first`;
          return false;
        }
        this.mode         = mode;
        this.accountError = null;
        await this.loadAccount();
        return true;
      } catch (e) {
        this.accountError = e.message;
        return false;
      }
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
   * MODULE 5b — Trade Methods (Warrior Trading framework)
   * Three checklists derived from the slides:
   *   IMG_8901 → profileChecks()  — "The Current Profile" (demand/supply filter)
   *   IMG_8899 → dipChecks()      — "Indicators for a Dip" (want all these)
   *   IMG_8898 → dumpFlags()      — "Indicators for a Dump" (want none of these)
   * ════════════════════════════════════════════════════════════════════════════ */
  const MomentumAnalysis = {

    /** Fetch intraday analysis (MACD, candle patterns, 50%-of-move) from server */
    async fetch(sym) {
      try {
        const r = await fetch(`/api/momentum/analysis/${sym}`, { credentials: 'include' });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    },

    /**
     * IMG_8901 — "The Current Profile"
     * Indicators of High Demand / Low Supply.
     * Returns array of { label, met (true/false/null), note }.
     * met=null means "manual check required" (no API data available).
     */
    profileChecks(row) {
      const relVol5x  = (row.relVol ?? 0) >= 5;
      const up10      = (row.change ?? 0) >= 10;
      const priceOk   = (row.price ?? 0) >= 2.00 && (row.price ?? 0) <= 20.00;
      const float     = row.floatSh ?? null;
      const floatOk   = float != null ? float < 10_000_000 : null; // null = unknown
      const floatStr  = float != null ? (float / 1_000_000).toFixed(2) + 'M shares' : 'Unknown (Yahoo)';
      return [
        {
          label: '① Price $2–$20 (volatile small-caps)',
          met:   priceOk,
          note:  `$${row.price?.toFixed(2) ?? '--'}`,
        },
        {
          label: '② Gain ≥ 10% (intraday momentum)',
          met:   up10,
          note:  row.change != null ? `+${row.change.toFixed(1)}%` : '--',
        },
        {
          label: '③ Rel Vol ≥ 5× (market participation)',
          met:   relVol5x,
          note:  row.relVol != null ? `${row.relVol.toFixed(1)}× avg` : '--',
        },
        {
          label: '④ News catalyst (headline confirmed)',
          met:   row.hasNewsCatalyst ?? null,
          note:  row.hasNewsCatalyst
            ? (row.newsHeadline?.slice(0, 50) || 'Confirmed')
            : 'No headline found',
        },
        {
          label: '⑤ Float < 10M shares (low supply)',
          met:   floatOk,
          note:  floatStr,
        },
      ];
    },

    /**
     * IMG_8899 — "Indicators for a Dip"
     * You WANT to see all of these on a pullback before entry.
     * met=true → favorable condition is present.
     */
    dipChecks(row, ema, analysis, rankInScan) {
      // 1. Light volume on red candles
      const isRed      = row.change < 0;
      const lightVolRed = isRed ? (row.relVol ?? 99) < 2 : true;

      // 2. No topping tail — prefer bottoming tail
      const ttScore  = analysis?.lastCandle?.toppingTailScore;
      const btScore  = analysis?.lastCandle?.bottomingTailScore;
      const noTopping = ttScore != null ? ttScore < 0.35 : null;

      // 3. Stock is "obvious" — top 3 leading gainers by change%
      const isTop3 = rankInScan != null ? rankInScan <= 2 : null;

      // 4. Holding 9-EMA — prefer intraday EMA9 from data.py, fall back to daily EMA
      const intradayAboveEma9 = analysis?.priceAboveEma9 ?? null;
      const holds9ema = intradayAboveEma9 !== null ? intradayAboveEma9 : (ema?.bullish ?? null);
      const ema9note  = analysis?.ema9  != null
        ? `EMA9 (1min) $${analysis.ema9.toFixed(3)}  EMA20 $${analysis.ema20?.toFixed(3) ?? '--'}`
        : ema ? `EMA9 (daily) $${ema.emaFast?.toFixed(3) ?? '--'}` : 'Loading…';

      // 4b. Price above VWAP (data.py)
      const aboveVwap = analysis?.priceAboveVwap ?? null;

      // 5. MACD still positive
      const macdPos = analysis?.macd?.positive ?? null;

      // 6. No large sell orders on L2 — Level 2 data not available
      // 7. Holding ≥ 50% of intraday move
      const pct     = analysis?.pctOfMove;
      const holds50 = pct != null ? pct >= 50 : null;

      return [
        {
          label: 'Light volume on red candles',
          met:   lightVolRed,
          note:  isRed ? `RelVol ${row.relVol?.toFixed(1) ?? '--'}×` : 'Green day ✓',
        },
        {
          label: 'No topping tail (bottoming preferred)',
          met:   noTopping,
          note:  ttScore != null
            ? `Top tail ${(ttScore * 100).toFixed(0)}%  Bot tail ${((btScore ?? 0) * 100).toFixed(0)}%`
            : 'Loading…',
        },
        {
          label: 'Stock is "obvious" — Top 3 gainers',
          met:   isTop3,
          note:  rankInScan != null ? `Rank #${rankInScan + 1} by score` : '--',
        },
        {
          label: 'Price above VWAP',
          met:   aboveVwap,
          note:  analysis?.vwap != null ? `VWAP $${analysis.vwap.toFixed(3)}` : 'Loading…',
        },
        {
          label: 'Holding 9-EMA on pullback',
          met:   holds9ema,
          note:  ema9note,
        },
        {
          label: 'MACD still positive',
          met:   macdPos,
          note:  analysis?.macd
            ? `MACD ${analysis.macd.value?.toFixed(4)}  Hist ${analysis.macd.histogram?.toFixed(4)}`
            : 'Loading…',
        },
        {
          label: 'No large sell orders on Level 2',
          met:   null,
          note:  'Manual check required',
        },
        {
          label: 'Holding ≥ 50% of intraday move',
          met:   holds50,
          note:  pct != null
            ? `${pct.toFixed(0)}% of range  (open $${analysis.dailyOpen?.toFixed(2)} → high $${analysis.dailyHigh?.toFixed(2)})`
            : 'Loading…',
        },
      ];
    },

    /**
     * IMG_8898 — "Indicators for a Dump"
     * These are RED FLAGS — a stock showing these is likely topping.
     * active=true → bearish flag is present (bad for bulls).
     * active=false → flag NOT present (good — reduces dump risk).
     */
    dumpFlags(row, ema, analysis) {
      // 1. High volume red candle
      const highVolRed = row.change < 0 && (row.relVol ?? 0) >= 2;

      // 2. Large topping tail
      const ttScore   = analysis?.lastCandle?.toppingTailScore;
      const largeTail = ttScore != null ? ttScore >= 0.40 : null;

      // 3. Stock is not "obvious" — low rank / not a top gainer
      // (We display this as a manual signal since we rank differently)

      // 4. Breaks below 9-EMA — prefer intraday (data.py), fall back to daily EMA
      const intradayBelowEma9 = analysis?.priceAboveEma9 != null ? !analysis.priceAboveEma9 : null;
      const below9ema = intradayBelowEma9 !== null ? intradayBelowEma9 : (ema ? !ema.bullish : null);
      const ema9dumpNote = analysis?.ema9 != null
        ? `Price $${row.price?.toFixed(2)} vs EMA9 (1min) $${analysis.ema9.toFixed(3)}`
        : ema ? `Price $${row.price?.toFixed(2)} vs EMA9 (daily) $${ema.emaFast?.toFixed(3)}` : 'Loading…';

      // 4b. Price below VWAP — bearish intraday bias
      const belowVwap = analysis?.priceAboveVwap != null ? !analysis.priceAboveVwap : null;

      // 5. MACD crosses negative on pullback
      const macdNeg = analysis?.macd != null ? !analysis.macd.positive : null;

      // 6. Large sell orders on L2 — not available, manual check
      return [
        {
          label:  'High volume red candle',
          active: highVolRed,
          note:   `Chg ${row.change?.toFixed(1) ?? '--'}%  RelVol ${row.relVol?.toFixed(1) ?? '--'}×`,
        },
        {
          label:  'Large topping tail',
          active: largeTail,
          note:   ttScore != null ? `${(ttScore * 100).toFixed(0)}% of candle range` : 'Loading…',
        },
        {
          label:  'Price below VWAP',
          active: belowVwap,
          note:   analysis?.vwap != null ? `VWAP $${analysis.vwap.toFixed(3)}` : 'Loading…',
        },
        {
          label:  'Stock not "obvious" (not top gainer)',
          active: null,
          note:   'Compare to sector leaders manually',
        },
        {
          label:  'Breaks below 9-EMA on pullback',
          active: below9ema,
          note:   ema9dumpNote,
        },
        {
          label:  'MACD crosses negative on pullback',
          active: macdNeg,
          note:   analysis?.macd
            ? `MACD ${analysis.macd.value?.toFixed(4)}  ${analysis.macd.positive ? '▲ positive' : '▼ negative'}`
            : 'Loading…',
        },
        {
          label:  'Large sell orders on Level 2',
          active: null,
          note:   'Manual check required',
        },
      ];
    },
  };

  /* ════════════════════════════════════════════════════════════════════════════
   * MODULE 6 — main.py
   * MomentumBot: orchestrates the full pipeline scan → signal → risk → execute.
   * ════════════════════════════════════════════════════════════════════════════ */
  const MomentumBot = {
    running:       false,
    scanResults:   [],
    selectedRow:   null,
    emaSignal:     null,
    tradeAnalysis: null,   // intraday MACD + candle analysis from /api/momentum/analysis/:sym
    riskCalc:      null,
    log:           [],
    config:        null,
    countdownTimer: null,
    countdown:     0,
    REFRESH_SEC:   90,
    // Daily limit tracking (resets at midnight)
    dailyTrades:  0,
    dailyLossAmt: 0,
    dailyDate:    '',
    // Active trade-methods tab
    _tmTab:       'dip',
    // ── Automation state ─────────────────────────────────────────────────────
    botEnabled:    false,          // true when auto-trading is running
    botPositions:  new Map(),      // sym → { entry, slPct, tpPct, shares, ts }
    _activeTrades: new Set(),      // symbols with pending/live bot orders (prevents double-entry)
    posMonitorId:  null,           // setInterval handle for position polling

    init() {
      this.config = MomentumConfig.load();
      this._bindEvents();
      this._renderConfigPanel();
      this._resetDailyIfNeeded();
      AlpacaClient.checkConnection().then(() => {
        this._renderStatus();
        this._renderBotStatus();
        this.run();
      });
    },

    /* ── Public pipeline entry — mirrors main.py's run() ─────────────────── */
    async run() {
      this.running = true;
      this._setScanStatus('scanning');
      try {
        const results = await MomentumScanner.scan(this.config, (done, total) => {
          this._setScanStatus('scanning', 0, '', done, total);
        });
        this.scanResults = results;
        this._renderScanTable(results);
        const meta = MomentumScanner._lastUniverseMeta;
        this._setScanStatus('done', results.length, '', 0, meta?.count || 0, meta);
        this._startCountdown();
        if (this.botEnabled) this._autoTrade(results).catch(() => {});
      } catch (err) {
        this._setScanStatus('error', 0, err.message);
      }
    },

    /* ── Config ──────────────────────────────────────────────────────────── */
    _renderConfigPanel() {
      const cfg = this.config;
      const setVal = (id, v) => {
        const el = $(id);
        if (!el) return;
        el.value = (v == null || v === '') ? '' : v;
      };
      setVal('mtManualShares',  cfg.manualShares);
      setVal('mtMaxTrades',     cfg.maxTradesPerDay);
      setVal('mtMaxDailyLoss',  cfg.maxDailyLoss);
      setVal('mtMinPrice',      cfg.minPrice);
      setVal('mtMaxPrice',      cfg.maxPrice);
      setVal('mtMinGain',       cfg.minGainPercent);
      setVal('mtRelVol',        cfg.minRelVol);
      setVal('mtMinVolume',     cfg.minVolume);
      setVal('mtMinScore',      cfg.minScore);
      setVal('mtMaxFloat',      cfg.maxFloat != null ? cfg.maxFloat / 1_000_000 : '');
      setVal('mtStopPct',       cfg.stopPercent);
      setVal('mtMinRR',         cfg.minRR);
      // News required toggle
      const newsChk = $('mtRequireNews');
      if (newsChk) newsChk.checked = cfg.requireNewsCatalyst ?? true;
      // Universe radio
      const radio = document.querySelector(`input[name="mtUniverse"][value="${cfg.universeMode || 'curated'}"]`);
      if (radio) radio.checked = true;
    },

    _readConfig() {
      const n = id => { const v = parseFloat($(id)?.value); return isNaN(v) ? null : v; };
      const uni = document.querySelector('input[name="mtUniverse"]:checked')?.value || 'curated';
      const rawFloat = n('mtMaxFloat');  // stored in millions in UI; convert to raw count
      return {
        ...this.config,
        manualShares:        n('mtManualShares'),
        maxTradesPerDay:     n('mtMaxTrades')    ?? this.config.maxTradesPerDay,
        maxDailyLoss:        n('mtMaxDailyLoss') ?? this.config.maxDailyLoss,
        minPrice:            n('mtMinPrice')     ?? this.config.minPrice,
        maxPrice:            n('mtMaxPrice')     ?? this.config.maxPrice,
        minGainPercent:      n('mtMinGain')      ?? this.config.minGainPercent,
        minRelVol:           n('mtRelVol')       ?? this.config.minRelVol,
        minVolume:           n('mtMinVolume')    ?? this.config.minVolume,
        minScore:            n('mtMinScore')     ?? this.config.minScore,
        maxFloat:            rawFloat != null ? rawFloat * 1_000_000 : this.config.maxFloat,
        requireNewsCatalyst: $('mtRequireNews')?.checked ?? this.config.requireNewsCatalyst,
        stopPercent:         n('mtStopPct'),
        minRR:               n('mtMinRR')        ?? this.config.minRR,
        universeMode:        uni,
      };
    },

    /* ── Scan table rendering ────────────────────────────────────────────── */
    _renderScanTable(results) {
      const tbody = $('mtScanBody');
      if (!tbody) return;

      if (!results.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="mt-empty-row">No momentum stocks found — try relaxing filters</td></tr>`;
        return;
      }

      tbody.innerHTML = results.slice(0, 40).map((r, i) => {
        const sig        = MomentumStrategy.getSignal(r);
        const chgUp      = r.change > 0;
        const hasBonus   = (r.change ?? 0) >= 20 || (r.relVol ?? 0) >= 5;
        const hasNews    = !!r.hasNewsCatalyst;
        const scoreReasons = r.scoreReasons || [];
        const tooltipContent = scoreReasons.length
          ? scoreReasons.map(reason => {
              const isBonus = reason.includes('+20%') || reason.includes('> 5×') || reason.includes('catalyst');
              return `<span class="mt-crit-pill${isBonus ? ' mt-crit-bonus' : ''}">✓ ${reason}</span>`;
            }).join('')
          : '<span class="mt-crit-empty">—</span>';

        const MAX_SCORE_ROW = 7; // 6 base + 1 news bonus
        const scorePct = Math.min(100, (r.momentumScore / MAX_SCORE_ROW * 100)).toFixed(0);

        return `<tr class="mt-scan-row ${i === 0 ? 'mt-scan-row--top' : ''}" data-sym="${r.sym}" data-idx="${i}">
          <td class="mt-sym-cell">
            <span class="mt-sym">${r.sym}</span>
            <span class="mt-sym-name">${(r.name || '').replace(/&/g, '&amp;').slice(0, 18)}</span>
            ${hasNews ? '<span class="mt-news-badge" title="News catalyst detected">📰</span>' : ''}
          </td>
          <td class="mt-r">${fmtDollar(r.price)}</td>
          <td class="mt-r ${chgUp ? 'mt-up' : 'mt-dn'}">${r.change != null ? (chgUp ? '+' : '') + r.change.toFixed(2) + '%' : '--'}</td>
          <td class="mt-r">${r.relVol != null ? r.relVol.toFixed(2) + '×' : '--'}</td>
          <td class="mt-r">${fmtVol(r.volume)}</td>
          <td class="mt-r mt-score-td">
            <div class="mt-score-cell-wrap">
              <div class="mt-score-bar-wrap">
                <div class="mt-score-bar" style="width:${scorePct}%"></div>
                <span class="mt-score-num">${r.momentumScore}/7</span>
                ${hasBonus ? '<span class="mt-bonus-badge">★</span>' : ''}
                ${hasNews  ? '<span class="mt-bonus-badge mt-news-star" title="News +1">📰</span>' : ''}
              </div>
              <div class="mt-criteria-tooltip">${tooltipContent}</div>
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
          // On stacked mobile layout (body is single column), scroll detail panel into view
          if (window.innerWidth <= 1100) {
            const panel = $('mtDetailPanel');
            if (panel) setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
          }
        });
      });

      // Auto-open top result
      if (results.length && !this.selectedRow) {
        tbody.querySelector('.mt-scan-row')?.click();
      }
    },

    /* ── Detail / signal panel ───────────────────────────────────────────── */
    async _openDetail(row) {
      this.selectedRow  = row;
      this.tradeAnalysis = null;
      this._renderSignalPanel(row);
      this._updateRiskPanel(row);

      // Show trade methods panel immediately with what we have (nulls = loading)
      this._renderTradeMethodPanel(row, null, null);

      // Fetch EMA + intraday analysis in parallel
      const emaEl = $('mtEmaSignal');
      if (emaEl) emaEl.innerHTML = `<span class="mt-loading-sm">Fetching EMA…</span>`;

      const [ema, analysis] = await Promise.all([
        MomentumStrategy.getEMASignal(row.sym, this.config.emaFast, this.config.emaSlow),
        MomentumAnalysis.fetch(row.sym),
      ]);

      this.emaSignal    = ema;
      this.tradeAnalysis = analysis;

      this._renderEMASignal(ema);
      this._renderIntradayIndicators(analysis);
      this._renderCandlePatterns(row.sym);
      // Re-render trade methods now that we have full data
      this._renderTradeMethodPanel(row, ema, analysis);
    },

    /* ── Trade Methods panel (Warrior Trading framework) ─────────────────── */
    _renderTradeMethodPanel(row, ema, analysis) {
      const panel = $('mtTradeMethodPanel');
      if (!panel) return;
      panel.style.display = '';

      // Determine rank of this row within scan results
      const rankInScan = this.scanResults.findIndex(r => r.sym === row.sym);

      const tab = this._tmTab || 'dip';

      const renderChecklist = (items) => items.map(item => {
        const met  = item.met;
        const cls  = met === true ? 'mt-chk-pass'
                   : met === false ? 'mt-chk-fail'
                   : 'mt-chk-na';
        const icon = met === true  ? '✓'
                   : met === false ? '✗'
                   : '—';
        return `<div class="mt-chk-item ${cls}">
          <span class="mt-chk-icon">${icon}</span>
          <div class="mt-chk-body">
            <span class="mt-chk-label">${item.label}</span>
            <span class="mt-chk-note">${item.note || ''}</span>
          </div>
        </div>`;
      }).join('');

      const renderDumpFlags = (flags) => flags.map(f => {
        const active = f.active;
        const cls    = active === true  ? 'mt-chk-dump-active'
                     : active === false ? 'mt-chk-dump-clear'
                     : 'mt-chk-na';
        const icon   = active === true  ? '⚠'
                     : active === false ? '✓'
                     : '—';
        return `<div class="mt-chk-item ${cls}">
          <span class="mt-chk-icon">${icon}</span>
          <div class="mt-chk-body">
            <span class="mt-chk-label">${f.label}</span>
            <span class="mt-chk-note">${f.note || ''}</span>
          </div>
        </div>`;
      }).join('');

      // Score summaries for tab badges
      const profile = MomentumAnalysis.profileChecks(row);
      const dip     = MomentumAnalysis.dipChecks(row, ema, analysis, rankInScan);
      const dump    = MomentumAnalysis.dumpFlags(row, ema, analysis);

      const metCount  = arr => arr.filter(x => x.met === true || x.active === false).length;
      const flagCount = arr => arr.filter(x => x.active === true).length;

      const dipScore     = dip.filter(x => x.met === true).length;
      const dumpRisk     = dump.filter(x => x.active === true).length;
      const profileScore = profile.filter(x => x.met === true).length;

      const dipBadge     = `<span class="mt-tab-badge mt-tab-badge-green">${dipScore}/${dip.length}</span>`;
      const dumpBadge    = dumpRisk > 0
        ? `<span class="mt-tab-badge mt-tab-badge-red">${dumpRisk} flag${dumpRisk > 1 ? 's' : ''}</span>`
        : `<span class="mt-tab-badge mt-tab-badge-green">Clear</span>`;
      const profBadge    = `<span class="mt-tab-badge mt-tab-badge-teal">${profileScore}/${profile.length}</span>`;

      let bodyHtml = '';
      if (tab === 'dip') {
        bodyHtml = `
          <div class="mt-chk-header">Check all before entering a pullback dip</div>
          ${renderChecklist(dip)}
          <div class="mt-chk-footer">When in doubt — check the 5min chart</div>`;
      } else if (tab === 'dump') {
        bodyHtml = `
          <div class="mt-chk-header">Dump Risk — avoid entry if any flag is active</div>
          ${renderDumpFlags(dump)}`;
      } else {
        bodyHtml = `
          <div class="mt-chk-header">High Demand / Low Supply profile (Warrior Trading)</div>
          ${renderChecklist(profile)}`;
      }

      panel.innerHTML = `
        <div class="mt-panel-head">
          <span class="mt-panel-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            Trade Methods
          </span>
          <span class="mt-panel-sub">Warrior Trading framework</span>
        </div>
        <div class="mt-tm-tabs">
          <button class="mt-tm-tab ${tab === 'dip' ? 'mt-tm-active' : ''}" data-tmtab="dip">Dip Buy ${dipBadge}</button>
          <button class="mt-tm-tab ${tab === 'dump' ? 'mt-tm-active' : ''}" data-tmtab="dump">Dump Risk ${dumpBadge}</button>
          <button class="mt-tm-tab ${tab === 'profile' ? 'mt-tm-active' : ''}" data-tmtab="profile">Profile ${profBadge}</button>
        </div>
        <div class="mt-tm-body">${bodyHtml}</div>`;

      // Bind tab clicks
      panel.querySelectorAll('.mt-tm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          this._tmTab = btn.dataset.tmtab;
          this._renderTradeMethodPanel(this.selectedRow, this.emaSignal, this.tradeAnalysis);
        });
      });
    },

    /* ── Intraday Indicators panel (data.py indicators) ─────────────────── */
    /* ── Candlestick Patterns panel ─────────────────────────────────────── */
    async _renderCandlePatterns(sym) {
      const section = $('mtCandleSection');
      const listEl  = $('mtPatternsList');
      if (!section || !listEl) return;

      section.style.display = '';
      listEl.innerHTML = '<span class="mt-na">Detecting patterns…</span>';

      try {
        const r = await fetch(`/api/patterns/${sym}`);
        const data = r.ok ? await r.json() : null;
        const patterns = data?.patterns || [];

        if (!patterns.length) {
          listEl.innerHTML = '<span class="mt-na">No significant patterns detected on daily bars</span>';
          return;
        }

        listEl.innerHTML = patterns.map(p => {
          const cls  = p.type === 'BULLISH' ? 'cp-bull' : p.type === 'BEARISH' ? 'cp-bear' : 'cp-neutral';
          const arrow = p.type === 'BULLISH' ? '▲' : p.type === 'BEARISH' ? '▼' : '●';
          const dots  = '●'.repeat(p.strength) + '○'.repeat(3 - p.strength);
          const [shortDesc, longDesc] = p.desc.split(' — ');
          return `<div class="cp-row ${cls}">
            <div class="cp-row-top">
              <span class="cp-badge ${cls}">${arrow}</span>
              <span class="cp-name">${p.name}</span>
              <span class="cp-strength">${dots}</span>
            </div>
            <div class="cp-desc">${longDesc || shortDesc}</div>
          </div>`;
        }).join('');
      } catch (_) {
        listEl.innerHTML = '<span class="mt-na">Pattern data unavailable</span>';
      }
    },

    _renderIntradayIndicators(analysis) {
      const el = $('mtIntradayIndicators');
      if (!el) return;

      if (!analysis || analysis.error) {
        el.innerHTML = `<span class="mt-na">${analysis?.error || 'No intraday data — market may be closed'}</span>`;
        return;
      }

      const a = analysis;
      const price = a.lastClose;

      // Helper: direction badge
      const dir = (above, upLabel = 'Above', dnLabel = 'Below') =>
        above === true  ? `<span class="mt-intra-tag mt-intra-bull">${upLabel}</span>` :
        above === false ? `<span class="mt-intra-tag mt-intra-bear">${dnLabel}</span>` :
                          `<span class="mt-intra-tag mt-intra-na">—</span>`;

      const rows = [
        {
          label: 'VWAP',
          value: a.vwap != null ? `$${a.vwap.toFixed(3)}` : '--',
          tag:   dir(a.priceAboveVwap, 'Price above', 'Price below'),
          note:  a.vwap != null ? `Δ ${((price - a.vwap) >= 0 ? '+' : '')}${(price - a.vwap).toFixed(3)}` : '',
        },
        {
          label: 'EMA 9 (1-min)',
          value: a.ema9 != null ? `$${a.ema9.toFixed(3)}` : '--',
          tag:   dir(a.priceAboveEma9, 'Holding', 'Below'),
          note:  a.ema9 != null ? `Δ ${((price - a.ema9) >= 0 ? '+' : '')}${(price - a.ema9).toFixed(3)}` : '',
        },
        {
          label: 'EMA 20 (1-min)',
          value: a.ema20 != null ? `$${a.ema20.toFixed(3)}` : '--',
          tag:   dir(a.priceAboveEma20, 'Above', 'Below'),
          note:  a.ema20 != null ? `Δ ${((price - a.ema20) >= 0 ? '+' : '')}${(price - a.ema20).toFixed(3)}` : '',
        },
        {
          label: '20-Bar High (1-min)',
          value: a.high20 != null ? `$${a.high20.toFixed(3)}` : '--',
          tag:   a.breakingHigh20
            ? `<span class="mt-intra-tag mt-intra-break">🚀 BREAKOUT</span>`
            : dir(false, '', 'Below high'),
          note:  a.high20 != null
            ? (a.breakingHigh20 ? `Price $${price.toFixed(3)} cleared $${a.high20.toFixed(3)}` : `Need $${a.high20.toFixed(3)} to break`)
            : '',
        },
        {
          label: 'RelVol (1-min bar)',
          value: a.relVolIntraday != null ? `${a.relVolIntraday}×` : '--',
          tag:   a.relVolIntraday != null
            ? (a.relVolIntraday >= 2
                ? `<span class="mt-intra-tag mt-intra-bull">High</span>`
                : a.relVolIntraday >= 1
                  ? `<span class="mt-intra-tag mt-intra-na">Normal</span>`
                  : `<span class="mt-intra-tag mt-intra-bear">Low</span>`)
            : '',
          note: `vs 20-bar avg`,
        },
        {
          label: '% of Intraday Move',
          value: a.pctOfMove != null ? `${a.pctOfMove.toFixed(0)}%` : '--',
          tag:   a.pctOfMove != null
            ? (a.pctOfMove >= 50
                ? `<span class="mt-intra-tag mt-intra-bull">≥ 50% held</span>`
                : `<span class="mt-intra-tag mt-intra-bear">< 50% held</span>`)
            : '',
          note:  a.dailyOpen != null && a.dailyHigh != null
            ? `Open $${a.dailyOpen.toFixed(2)} → High $${a.dailyHigh.toFixed(2)}`
            : '',
        },
      ];

      el.innerHTML = rows.map(r => `
        <div class="mt-intra-row">
          <span class="mt-intra-label">${r.label}</span>
          <span class="mt-intra-val">${r.value}</span>
          ${r.tag}
          <span class="mt-intra-note">${r.note}</span>
        </div>`).join('');

      // Update sub-label with bar count
      const subEl = $('mtIntradaySub');
      if (subEl) subEl.textContent = `data.py · 1-min bars · ${a.bars} bars loaded`;
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

      // Score ring (0–6 scale)
      const MAX_SCORE   = 7; // 6 base + 1 news catalyst bonus
      const scoreEl = $('mtScoreValue');
      const scoreLblEl = $('mtScoreLbl');
      const ringEl  = $('mtScoreRing');
      if (scoreEl) scoreEl.textContent = row.momentumScore;
      if (scoreLblEl) scoreLblEl.textContent = `/ ${MAX_SCORE}`;
      if (ringEl) {
        const pct = row.momentumScore / MAX_SCORE;
        const circumference = 2 * Math.PI * 28;
        ringEl.style.strokeDashoffset = circumference * (1 - pct);
        ringEl.style.stroke = row.momentumScore >= 5 ? '#1dd6a3'
          : row.momentumScore >= 3 ? '#4a90e2'
          : row.momentumScore >= 2 ? '#f5c842'
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
      const cfg    = this.config;
      const equity = AlpacaClient.getEquity() || 10000;

      // Stop loss: prefer DEFAULT_STOP_PERCENT; fall back to ATR-based
      let stopLoss;
      if (cfg.stopPercent != null && cfg.stopPercent > 0) {
        stopLoss = +(entry * (1 - cfg.stopPercent / 100)).toFixed(2);
      } else {
        stopLoss = RiskManager.calcStopLoss(entry, row.atr14, 1.5);
      }

      const takeProfit = RiskManager.calcTakeProfit(entry, stopLoss, cfg.minRR);

      // Shares: manual entry overrides auto-sizing
      const manualShares = cfg.manualShares;
      const autoShares   = RiskManager.calcPositionSize(equity, 2.0, entry, stopLoss);
      const shares       = (manualShares != null && manualShares > 0) ? manualShares : autoShares;

      const rr         = RiskManager.calcRR(entry, stopLoss, takeProfit);
      const validation = shares ? RiskManager.validate(entry, stopLoss, takeProfit, equity, shares, cfg.minRR) : null;

      this.riskCalc = { entry, stopLoss, takeProfit, shares, rr, validation };

      const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
      const stopLbl = cfg.stopPercent ? `${cfg.stopPercent}% stop` : 'ATR stop';
      set('mtRiskEntry',   fmtDollar(entry));
      set('mtRiskStop',    stopLoss != null ? fmtDollar(stopLoss) + ` (${stopLbl})` : '--');
      set('mtRiskTP',      fmtDollar(takeProfit));
      set('mtRiskShares',  shares != null ? shares + (manualShares ? ' (manual)' : ' (auto)') : '--');
      set('mtRiskRR',      rr != null ? rr.toFixed(2) + ':1' : '--');
      set('mtRiskAmt',     validation ? fmtDollar(validation.totalRisk) : '--');
      set('mtRiskReward',  validation ? fmtDollar(validation.totalReward) : '--');
      set('mtRiskPctUsed', validation ? validation.riskPct + '% of equity' : '--');

      const valEl = $('mtRiskValid');
      if (valEl) {
        if (validation) {
          valEl.textContent = validation.valid ? '✓ Valid trade setup' : '✗ Does not meet risk rules';
          valEl.className   = 'mt-risk-valid ' + (validation.valid ? 'mt-valid-ok' : 'mt-valid-bad');
        } else {
          valEl.textContent = 'Select a stock to calculate risk';
          valEl.className   = 'mt-risk-valid';
        }
      }

      const symEl = $('mtTradeSymbol');
      if (symEl) symEl.textContent = row.sym;
      const priceEl = $('mtTradePriceDisplay');
      if (priceEl) priceEl.textContent = fmtDollar(entry);
    },

    /* ── Status / countdown ──────────────────────────────────────────────── */
    _setScanStatus(state, count = 0, err = '', done = 0, total = 0, meta = null) {
      const el   = $('mtScanStatus');
      const cdEl = $('mtCountdown');
      if (!el) return;
      if (state === 'scanning') {
        const isFullMarket = this.config?.universeMode === 'alpaca';
        if (isFullMarket && total > 0) {
          el.textContent = `⟳ Full market scan — ${done} / ${total} tickers…`;
        } else if (isFullMarket) {
          el.textContent = '⟳ Fetching live market data…';
        } else {
          const n = MomentumConfig.UNIVERSE.length;
          el.textContent = `⟳ Scanning ${n} tickers…`;
        }
        if (cdEl) cdEl.textContent = '';
      } else if (state === 'done') {
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        if ((meta?.source === 'yf-full-market' || meta?.source === 'alpaca-full-market') && meta.count) {
          const gainersN = (meta.gainers?.length || 0) + (meta.smallCap?.length || 0);
          el.textContent = `✓ ${count} hit${count !== 1 ? 's' : ''} from ${meta.count} live tickers · ${gainersN} gainers scanned · ${time}`;
        } else if (meta?.source === 'curated-fallback') {
          el.textContent = `✓ ${count} stock${count !== 1 ? 's' : ''} · Curated list · ${time}`;
        } else {
          el.textContent = `✓ ${count} stock${count !== 1 ? 's' : ''} · ${time}`;
        }
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
      const conn    = AlpacaClient.connected;
      const hasAcct = conn && !!AlpacaClient.account;
      const hasErr  = conn && !!AlpacaClient.accountError;
      const mode    = AlpacaClient.mode;
      const badge   = $('mtModeBadge');
      const chips   = $('mtAcctChips');
      const errEl   = $('mtAcctError');
      const sw      = $('mtModeSwitcher');

      // ── Mode badge ──────────────────────────────────────────────────────────
      if (badge) {
        if (hasAcct) {
          badge.textContent = mode.toUpperCase();
          badge.className   = 'mt-mode-badge ' + (mode === 'live' ? 'mt-badge-live' : 'mt-badge-paper');
        } else if (hasErr) {
          badge.textContent = '⚠ KEY ERROR';
          badge.className   = 'mt-mode-badge mt-badge-warn';
        } else {
          badge.textContent = 'DISCONNECTED';
          badge.className   = 'mt-mode-badge mt-badge-disc';
        }
      }

      // ── Account chips (only when data is actually loaded) ───────────────────
      if (chips) chips.style.display = hasAcct ? '' : 'none';
      if (hasAcct) {
        const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
        set('mtEquity', fmtDollar(AlpacaClient.getEquity()));
        set('mtCash',   fmtDollar(AlpacaClient.getCash()));
        set('mtBP',     fmtDollar(AlpacaClient.getBP()));
      }

      // ── Account error notice ────────────────────────────────────────────────
      if (errEl) {
        errEl.style.display = hasErr ? '' : 'none';
        if (hasErr) errEl.textContent = '⚠ ' + AlpacaClient.accountError;
      }

      // ── Paper / Live mode-switcher pills ────────────────────────────────────
      if (sw) {
        const show = AlpacaClient.paperConnected || AlpacaClient.liveConnected;
        sw.style.display = show ? '' : 'none';
        const pBtn = $('mtSwitchPaper');
        const lBtn = $('mtSwitchLive');
        if (pBtn) {
          pBtn.disabled  = !AlpacaClient.paperConnected || mode === 'paper';
          pBtn.className = 'mt-mode-pill' + (mode === 'paper' ? ' mt-mode-pill--active' : '');
          pBtn.title     = AlpacaClient.paperConnected ? 'Switch to Paper' : 'No paper keys saved';
        }
        if (lBtn) {
          lBtn.disabled  = !AlpacaClient.liveConnected || mode === 'live';
          lBtn.className = 'mt-mode-pill' + (mode === 'live' ? ' mt-mode-pill--active' : '');
          lBtn.title     = AlpacaClient.liveConnected ? 'Switch to Live' : 'Save live keys first';
        }
      }
    },

    /* ── Daily limits ────────────────────────────────────────────────────── */
    _resetDailyIfNeeded() {
      const today = new Date().toDateString();
      if (this.dailyDate !== today) {
        this.dailyDate    = today;
        this.dailyTrades  = 0;
        this.dailyLossAmt = 0;
        this._renderDailyLimits();
      }
    },

    _renderDailyLimits() {
      const el = $('mtDailyLimits');
      if (!el) return;
      const cfg          = this.config;
      const tradesLeft   = Math.max(0, cfg.maxTradesPerDay - this.dailyTrades);
      const lossLeft     = Math.max(0, cfg.maxDailyLoss - this.dailyLossAmt);
      const tradeLimitHit = this.dailyTrades >= cfg.maxTradesPerDay;
      const lossLimitHit  = this.dailyLossAmt >= cfg.maxDailyLoss;
      el.innerHTML = `
        <span class="mt-dl-item ${tradeLimitHit ? 'mt-dl-hit' : ''}">
          📊 Trades today: <strong>${this.dailyTrades}/${cfg.maxTradesPerDay}</strong>
          ${tradeLimitHit ? '· <span class="mt-dl-warn">LIMIT REACHED</span>' : `· ${tradesLeft} left`}
        </span>
        <span class="mt-dl-item ${lossLimitHit ? 'mt-dl-hit' : ''}">
          🛑 Daily loss: <strong>${fmtDollar(this.dailyLossAmt)}</strong> / ${fmtDollar(cfg.maxDailyLoss)}
          ${lossLimitHit ? '· <span class="mt-dl-warn">LIMIT REACHED</span>' : `· ${fmtDollar(lossLeft)} remaining`}
        </span>
      `;
    },

    _checkDailyLimits() {
      this._resetDailyIfNeeded();
      const cfg = this.config;
      if (this.dailyTrades >= cfg.maxTradesPerDay) {
        return `Daily trade limit reached (${cfg.maxTradesPerDay} trades)`;
      }
      if (this.dailyLossAmt >= cfg.maxDailyLoss) {
        return `Daily loss limit reached ($${cfg.maxDailyLoss})`;
      }
      return null; // null = OK to trade
    },

    _recordTrade(sym, side, shares, entryPrice, stopPrice) {
      this.dailyTrades++;
      // Estimate potential loss for tracking (worst-case: full stop hit)
      const riskAmt = stopPrice ? Math.abs(entryPrice - stopPrice) * shares : 0;
      this.dailyLossAmt += riskAmt;
      this._renderDailyLimits();
      this.addLog(sym, side.toUpperCase(),
        `${shares} shares @ ~${fmtDollar(entryPrice)} · stop ${fmtDollar(stopPrice)}`, 'ok');
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

    /* ══════════════════════════════════════════════════════════════════════
     * AUTOMATION ENGINE
     * ══════════════════════════════════════════════════════════════════════ */

    // ── Read execution settings from the live DOM (set by trade-settings UI) ─
    _getLeverage() {
      const btn = document.querySelector('#tsLevGroup .ts-lev-btn.active');
      return btn ? Math.max(1, parseFloat(btn.dataset.lev) || 1) : 1;
    },
    _getPosMode()  { return $('tsBtnPct')?.classList.contains('active') ? 'pct' : 'fixed'; },
    _getPosValue() { return parseFloat($('tsPositionValue')?.value) || 15; },

    // ── Market-hours helper (mirrors server isMarketOpen) ─────────────────
    _isMarketOpen() {
      // US equity market: Mon–Fri 9:35 AM – 3:50 PM ET
      const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day  = et.getDay();
      const mins = et.getHours() * 60 + et.getMinutes();
      return day >= 1 && day <= 5 && mins >= 575 && mins < 950;
    },

    // ── Main auto-trade method — called after every scan when bot is ON ────
    async _autoTrade(results) {
      // BUG FIX: null guard — results could be undefined if scan throws
      if (!results?.length) return;
      if (!this.botEnabled || !AlpacaClient.connected) return;

      // BUG FIX: market-hours guard — never attempt equity orders when market is closed
      if (!this._isMarketOpen()) {
        this.addLog('BOT', 'Market Closed', 'Auto-trading skipped — US equity market is closed (9:35 AM–3:50 PM ET)', 'warn');
        return;
      }

      // Check daily limits first
      const limitMsg = this._checkDailyLimits();
      if (limitMsg) {
        this.addLog('BOT', 'Halted', limitMsg, 'warn');
        return;
      }

      // Fetch current open positions (avoid doubling into the same symbol)
      let heldSyms = new Set();
      try {
        const r = await fetch('/api/alpaca/positions', { credentials: 'include' });
        if (r.ok) {
          const pos = await r.json();
          (Array.isArray(pos) ? pos : []).forEach(p => heldSyms.add(p.symbol));
        }
      } catch (_) {}

      // Find BUY candidates: signal=BUY, not already held, not already bot-pending
      const candidates = results.filter(r => {
        const sig = MomentumStrategy.getSignal(r);
        return sig.signal === 'BUY'
          && !heldSyms.has(r.sym)
          && !this._activeTrades.has(r.sym);
      });

      if (!candidates.length) return; // nothing qualifies this cycle

      // Trade the single top-ranked candidate (highest score wins)
      const row   = candidates[0];
      const cfg   = this.config;
      const entry = row.price;

      // ── Calculate stop loss % ────────────────────────────────────────────
      let slPct = (cfg.stopPercent != null && cfg.stopPercent > 0) ? cfg.stopPercent : null;
      if (!slPct && row.atr14 != null) {
        const stopPrice = RiskManager.calcStopLoss(entry, row.atr14, 1.5);
        if (stopPrice) slPct = +((entry - stopPrice) / entry * 100).toFixed(2);
      }
      if (!slPct) {
        this.addLog(row.sym, 'SKIP', 'No stop loss configured — set Stop Loss % in settings', 'warn');
        return;
      }
      const tpPct = +(slPct * cfg.minRR).toFixed(2);

      // ── Calculate notional from execution settings ────────────────────────
      const equity   = AlpacaClient.getEquity() || 10000;
      const leverage = this._getLeverage();
      const posMode  = this._getPosMode();
      const posVal   = this._getPosValue();
      const notional = posMode === 'fixed'
        ? posVal * leverage
        : equity * (posVal / 100) * leverage;

      // Lock this symbol to prevent duplicate orders while request is in flight
      this._activeTrades.add(row.sym);
      this.addLog(row.sym, '→ AUTO-BUY',
        `Bracket $${notional.toFixed(0)} · SL ${slPct}% · TP ${tpPct}% · ${AlpacaClient.mode.toUpperCase()}`, 'info');

      try {
        const resp = await fetch('/api/alpaca/order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ symbol: row.sym, side: 'buy', amount: notional, slPct, tpPct, leverage }),
        });
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}));
          throw new Error(e.error || 'Order failed');
        }
        const result   = await resp.json();
        const shares   = result.shares ? parseInt(result.shares) : Math.floor(notional / entry);
        const stopPx   = +(entry * (1 - slPct / 100)).toFixed(2);
        const tpPx     = +(entry * (1 + tpPct / 100)).toFixed(2);
        const riskAmt  = Math.abs(entry - stopPx) * shares;

        // Update daily counters
        this.dailyTrades++;
        this.dailyLossAmt += riskAmt; // worst-case risk
        this._renderDailyLimits();

        this.addLog(row.sym, '✓ AUTO-BUY',
          `${shares} sh @ $${entry.toFixed(2)} · stop $${stopPx} · target $${tpPx}`, 'ok');
        this.botPositions.set(row.sym, { entry, slPct, tpPct, shares, ts: Date.now() });
        // Note: _activeTrades keeps row.sym locked until position closes (avoids re-entry while in trade)
      } catch (err) {
        this.addLog(row.sym, '✗ AUTO-BUY', err.message, 'err');
        this._activeTrades.delete(row.sym); // unlock on failure so next scan can retry
      }
    },

    // ── Position monitor — polls every 20 s to show P&L and detect exits ──
    _startPositionMonitor() {
      this._stopPositionMonitor();
      this._pollPositions(); // immediate first check
      this.posMonitorId = setInterval(() => this._pollPositions(), 20000);
    },

    _stopPositionMonitor() {
      if (this.posMonitorId) { clearInterval(this.posMonitorId); this.posMonitorId = null; }
    },

    async _pollPositions() {
      if (!AlpacaClient.connected) return;
      try {
        const r = await fetch('/api/alpaca/positions', { credentials: 'include' });
        if (!r.ok) return;
        const positions = await r.json();
        this._renderPositionsPanel(Array.isArray(positions) ? positions : []);

        // Detect bracket exits: bot-tracked symbol disappeared from open positions
        const heldSet = new Set((positions || []).map(p => p.symbol));
        for (const [sym] of this.botPositions) {
          if (!heldSet.has(sym)) {
            this.addLog(sym, '✓ AUTO-EXIT', 'Bracket order closed position automatically', 'ok');
            this.botPositions.delete(sym);
            this._activeTrades.delete(sym); // unlock for re-entry
          }
        }
      } catch (_) {}
    },

    _renderPositionsPanel(positions) {
      const el = $('atPositionsBody');
      if (!el) return;
      if (!positions.length) {
        el.innerHTML = `<tr><td colspan="7" class="mt-empty-row">No open positions</td></tr>`;
        return;
      }
      el.innerHTML = positions.map(p => {
        const plPct  = parseFloat(p.unrealized_plpc || 0) * 100;
        const pl     = parseFloat(p.unrealized_pl   || 0);
        const curr   = parseFloat(p.current_price   || 0);
        const avg    = parseFloat(p.avg_entry_price  || 0);
        const isBot  = this.botPositions.has(p.symbol);
        const bInfo  = isBot ? this.botPositions.get(p.symbol) : null;
        const meta   = bInfo ? `SL ${bInfo.slPct}% · TP ${bInfo.tpPct}%` : '—';
        return `<tr>
          <td style="font-weight:700">${isBot ? '<span title="Bot-managed">🤖</span> ' : ''}${p.symbol}</td>
          <td class="mt-r">${p.qty}</td>
          <td class="mt-r">$${avg.toFixed(2)}</td>
          <td class="mt-r">$${curr.toFixed(2)}</td>
          <td class="mt-r ${plPct >= 0 ? 'mt-up' : 'mt-dn'}" style="font-weight:600">${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%</td>
          <td class="mt-r ${pl >= 0 ? 'mt-up' : 'mt-dn'}">$${pl >= 0 ? '' : ''}${pl.toFixed(2)}</td>
          <td class="mt-r" style="font-size:.68rem;color:var(--t3)">${meta}</td>
        </tr>`;
      }).join('');
    },

    // ── Bot toggle — enable/disable auto-trading ──────────────────────────
    _toggleBot() {
      if (!this.botEnabled && !AlpacaClient.connected) {
        this.addLog('BOT', 'Cannot start', 'Connect your Alpaca account first', 'err');
        return;
      }
      this.botEnabled = !this.botEnabled;
      this._renderBotStatus();
      if (this.botEnabled) {
        this.addLog('BOT', '▶ Auto-trading ON',
          `${AlpacaClient.mode.toUpperCase()} account · bracket orders · scan every ${this.REFRESH_SEC}s`, 'ok');
        this._startPositionMonitor();
        this.run(); // trigger an immediate scan + trade cycle
      } else {
        this.addLog('BOT', '⏹ Auto-trading OFF', 'Manual mode — open positions remain, Alpaca brackets still active', 'info');
        this._stopPositionMonitor();
      }
    },

    _renderBotStatus() {
      const btn    = $('mtBotToggle');
      const status = $('mtBotStatus');
      const bar    = $('mtBotBar');
      const dot    = $('mtBotDot');    // BUG FIX: dot was never updated
      if (!btn) return;
      if (this.botEnabled) {
        btn.textContent = '⏹ STOP BOT';
        btn.className   = 'mt-bot-toggle mt-bot-toggle--on';
        if (status) status.textContent =
          `AUTO-TRADING · ${AlpacaClient.mode.toUpperCase()} account · position monitor every 20s`;
        if (bar) bar.className = 'mt-bot-bar mt-bot-bar--on';
        if (dot) { dot.style.background = '#22c55e'; dot.title = 'Bot active'; }
      } else {
        btn.textContent = '▶ START BOT';
        btn.className   = 'mt-bot-toggle mt-bot-toggle--off';
        if (status) status.textContent =
          AlpacaClient.connected
            ? 'Connected · click START BOT to enable automated trading'
            : 'Connect Alpaca account to enable automated trading';
        if (bar) bar.className = 'mt-bot-bar';
        if (dot) { dot.style.background = ''; dot.title = 'Bot inactive'; }
      }
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
        const c = this.config;
        this.addLog('CONFIG', 'Settings updated',
          `$${c.minPrice}–$${c.maxPrice} · Gain≥${c.minGainPercent}% · RelVol≥${c.minRelVol} · Vol≥${fmtVol(c.minVolume)} · Score≥${c.minScore}/7`, 'info');
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

      // Quick buy — checks daily limits, uses manual or auto shares
      $('mtBuyBtn')?.addEventListener('click', async () => {
        const row   = this.selectedRow;
        const rc    = this.riskCalc;
        const limitMsg = this._checkDailyLimits();
        if (limitMsg) return this._showTradeError(limitMsg);
        if (!row || !rc?.shares) return this.addLog(row?.sym || '?', 'BUY', 'No valid risk calc — set stop % or ATR', 'err');
        if (!AlpacaClient.connected) return this.addLog(row.sym, 'BUY', 'Not connected to Alpaca', 'err');
        const btn = $('mtBuyBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Placing…'; }
        try {
          await AlpacaClient.placeSimpleOrder(row.sym, 'buy', rc.shares * row.price);
          this._recordTrade(row.sym, 'buy', rc.shares, row.price, rc.stopLoss);
          this._showTradeSuccess(`BUY ${row.sym} — ${rc.shares} shares placed`);
        } catch (err) {
          this.addLog(row.sym, 'BUY FAILED', err.message, 'err');
          this._showTradeError(err.message);
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '▲ BUY'; }
        }
      });

      // Short sell — checks daily limits, uses manual or auto shares
      $('mtSellBtn')?.addEventListener('click', async () => {
        const row   = this.selectedRow;
        const rc    = this.riskCalc;
        const limitMsg = this._checkDailyLimits();
        if (limitMsg) return this._showTradeError(limitMsg);
        if (!row || !rc?.shares) return this.addLog(row?.sym || '?', 'SELL', 'No valid risk calc — set stop % or ATR', 'err');
        if (!AlpacaClient.connected) return this.addLog(row.sym, 'SELL', 'Not connected to Alpaca', 'err');
        const btn = $('mtSellBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Placing…'; }
        try {
          await AlpacaClient.placeSimpleOrder(row.sym, 'sell', rc.shares * row.price);
          this._recordTrade(row.sym, 'sell', rc.shares, row.price, rc.stopLoss);
          this._showTradeSuccess(`SELL ${row.sym} — ${rc.shares} shares placed`);
        } catch (err) {
          this.addLog(row.sym, 'SELL FAILED', err.message, 'err');
          this._showTradeError(err.message);
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '▼ SELL'; }
        }
      });

      // Bot ON/OFF toggle
      $('mtBotToggle')?.addEventListener('click', () => this._toggleBot());

      // Clear log
      $('mtClearLog')?.addEventListener('click', () => {
        this.log = [];
        this._renderLog();
      });

      // Paper / Live mode-switcher pills
      $('mtSwitchPaper')?.addEventListener('click', async () => {
        if (AlpacaClient.mode === 'paper') return;
        $('mtSwitchPaper').textContent = 'Switching…';
        const ok = await AlpacaClient.switchMode('paper');
        $('mtSwitchPaper').textContent = 'PAPER';
        this._renderStatus();
        if (ok) this.addLog('BOT', 'Switched to PAPER', 'Paper trading account active', 'info');
        else    this.addLog('BOT', 'Switch failed', AlpacaClient.accountError || 'Could not switch to paper', 'err');
      });
      $('mtSwitchLive')?.addEventListener('click', async () => {
        if (AlpacaClient.mode === 'live') return;
        $('mtSwitchLive').textContent = 'Switching…';
        const ok = await AlpacaClient.switchMode('live');
        $('mtSwitchLive').textContent = 'LIVE';
        this._renderStatus();
        if (ok) this.addLog('BOT', 'Switched to LIVE', '⚠ Live account active — real money trades', 'warn');
        else    this.addLog('BOT', 'Switch failed', AlpacaClient.accountError || 'Save live API keys first', 'err');
      });

      // Re-check connection whenever alpacatrader.js saves or disconnects credentials
      window.addEventListener('alpaca-connection-changed', () => {
        AlpacaClient.checkConnection().then(() => this._renderStatus());
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
