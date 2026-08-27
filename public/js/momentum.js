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
   const escapeHtml = value => String(value ?? '')
     .replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;')
     .replace(/'/g, '&#039;');
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
      'ENPH','FSLR','BE','PLUG','QQQ','SPY','IWM','ARKK','SOXS','LABU',
      // Additional stock/ETF symbols from the user's portfolio screenshots
      'OKLL','SKHL','AVS','SPCH','SNDC','MSTZ','RGTZ','RAM','APRE','CDTG',
      'INTW','HODU','TSLG','PATX','MUU','SNXX','SKHX','GLL','TSXD','TSLZ',
      'NVDQ','TSDD','CORD','DAMD','PLTD','SMCZ','QQQD','ORCZ','NVD','ORCU',
      'SOFX','KEEL','CIFG','AFRU','IRE','AMAU','NVDL','SMCX','PLTG','ADBG',
      'NOWL','VYX','UECG','NUVB','NVDY','TSLL','SATL','USAS','EXK','MTA',
      'BTG','DNN','CRML','TMQ','ASM','PLG','IAUX'
    ],

    defaults: {
      // Position size
      positionMode:    'pct',   // pct of equity or fixed dollar amount
      positionValue:   15,
      // Daily limits
      maxTradesPerDay: 5,
      maxDailyLoss:   500.00,
      // Broader discovery gates. Volume, price validity, fresh structural
      // confirmation, broker tradability, risk, and protected exits remain
      // mandatory at execution time.
      minPrice:       1.00,
      maxPrice:       100.00,
      minGainPercent: 2.0,
      minRelVol:      1.5,
      requireNewsCatalyst: false,
      maxFloat:       100_000_000,
      // Minimum absolute volume sanity check (independent of pillars)
      minVolume:      100000,
      minScore:       2,
      // Risk
      stopPercent:    5,        // 5% stop — backtest shows 2% is too tight for gap-up plays; avg intraday LOW is -6.6% from open
      takeProfitPercent: 10,    // broker-protected target above entry
      minRR:          2.0,      // validation floor for the risk preview
      // EMA trend
      emaFast:        9,
      emaSlow:        21,
      // Scanner universe: 'curated' | 'alpaca'
      universeMode:   'alpaca',   // verified Alpaca catalog: market-mover priority + rotating full coverage
    },

    // Load saved config from localStorage, merging with defaults
    load() {
      try {
        const saved = JSON.parse(localStorage.getItem('mtConfig') || '{}');
        // Older browser settings used an RSI exit rather than a broker-held
        // target. Retain every other user choice but move those settings to the
        // conservative default target used by the current protected bracket.
        if (saved.takeProfitPercent == null) {
          saved.takeProfitPercent = this.defaults.takeProfitPercent;
          delete saved.takeProfitRsi;
          try { localStorage.setItem('mtConfig', JSON.stringify(saved)); } catch {}
        }
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
      * Price $1–$100
      * Daily gain ≥ 2%
      * Relative volume ≥ 1.5× (configurable)
     * Pillar 4: News catalyst — checked AFTER Pass 2 in scan()
      * Float < 100M shares — if float is known, reject over-limit; if unknown, allow through
     */
    filter(results, cfg) {
      return results.filter(r => {
        if (r.price == null) return false;

        // Pillar 1: price range
        if (r.price < (cfg.minPrice ?? 3) || r.price > (cfg.maxPrice ?? 20)) return false;

        // Pillar 2: minimum gain
        if (cfg.minGainPercent != null && (r.change ?? 0) < cfg.minGainPercent) return false;

        // Pillar 3: relative volume
        if (cfg.minRelVol != null && (r.relVol ?? 0) < cfg.minRelVol) return false;

        // Absolute volume floor
        if (cfg.minVolume != null && (r.volume ?? 0) < cfg.minVolume) return false;

        // Pillar 5: float — only filter when float data is available AND over the limit
        // (null float = Yahoo didn't return it → allow through, don't penalise)
        const float = r.float ?? r.floatSh ?? null;
        if (cfg.maxFloat != null && float != null && float > cfg.maxFloat) return false;

        return true;
      });
    },

    /**
     * Score a stock against the 5 pillars. Max 7 points.
     *
     *   Pillar 2 — Momentum  gain ≥ 10%       → +2   "Strong momentum"
     *                        gain ≥ 30%       → +1   "Full profile: up 30% on the day"  (cumul: +3)
     *   Pillar 3 — RelVol    rvol ≥ 5×        → +1   "Relative volume ≥ 5×"
     *                        rvol ≥ 10×       → +1   "Extreme volume surge ≥ 10×"  (cumul: +2)
     *   Pillar 4 — News      hasNewsCatalyst  → +1   "News catalyst confirmed"
     *   Pillar 5 — Float     float < 5M       → +1   "Low float (< 5M shares)"
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
      const float = r.float ?? r.floatSh ?? null;

        // ── MOMENTUM ─────────────────────────────────────────────────────────
        if (gain >= 2)  { score += 1; reasons.push('Positive momentum (≥ 2%)'); }
        if (gain >= 10) { score += 1; reasons.push('Strong momentum (≥ 10%)'); }
      if (gain >= 30) { score += 1; reasons.push('Full profile: already up 30% on the day'); }

        // ── VOLUME ───────────────────────────────────────────────────────────
        if (rvol >= 1.5) { score += 1; reasons.push('Relative volume ≥ 1.5×'); }
        if (rvol >= 5)  { score += 1; reasons.push('Relative volume ≥ 5×'); }
      if (rvol >= 10) { score += 1; reasons.push('Extreme volume surge ≥ 10×'); }

      // ── PILLAR 4: NEWS CATALYST (set by scan() Pass 2) ───────────────────
      if (r.hasNewsCatalyst) { score += 1; reasons.push('News catalyst confirmed'); }

      // ── PILLAR 5: FLOAT (profile: < 5M shares available to trade) ─────────
      if (float != null && float < 5_000_000) { score += 1; reasons.push('Low float (< 5M shares)'); }

      return { score, reasons, qualified: score >= minScore };
    },

    /**
     * Fetch liquid market-mover candidates from the server. When an account is
     * connected, the server intersects them with Alpaca's active/tradable
     * stock-and-ETF catalog before this browser scans them.
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
      // Resolve universe: broker-verified market movers OR static curated list
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

      // ── Pass 2: news catalyst check via /api/momentum/news/:sym ──────────
      // Uses the dedicated 24h-filtered news endpoint with per-symbol caching.
      // Fetched in parallel only for stocks near/above the score threshold.
      // A confirmed headline sets hasNewsCatalyst = true and adds +1 to score.
      const candidates = scored.filter(r => r.momentumScore >= Math.max(0, minScore - 1));
      if (candidates.length > 0) {
        try {
          const newsResults = await Promise.allSettled(
            candidates.map(r =>
              fetch(`/api/momentum/news/${encodeURIComponent(r.sym)}`, { credentials: 'include' })
                .then(res => res.ok ? res.json() : { hasCatalyst: false, articles: [] })
                .catch(() => ({ hasCatalyst: false, articles: [] }))
            )
          );
          newsResults.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value?.hasCatalyst) {
              const stock = candidates[i];
              stock.hasNewsCatalyst = true;
              stock.newsHeadline    = result.value.headline || null;
              // Re-score with news flag set on the row
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
       else if (score >= 2) { signal = 'BUY';        badge = 'mt-signal-buy';    }
       else if (score >= 1) { signal = 'WATCH';      badge = 'mt-signal-watch';  }
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
      const float = row.float ?? row.floatSh ?? null;
      const floatM = float != null ? (float / 1_000_000).toFixed(2) + 'M' : null;

      // ── 5 PILLARS — show pass/fail + points earned ────────────────────────
      return [
        {
          label:  '① Price $1 – $100',
          value:  price ? '$' + price.toFixed(2) : '--',
          note:   price >= 1 && price <= 100 ? '✓ Default range passed' : '✗ Outside $1–$100',
          status: price >= 1 && price <= 100 ? 'good' : 'bad',
          pillar: true,
        },
        {
          label:  '② Daily Gain ≥ 2% (10% / 30% add quality points)',
          value:  gain != null ? (gain >= 0 ? '+' : '') + gain.toFixed(2) + '%' : '--',
          note:   gain >= 30 ? '+3 pts: full profile — up 30% on the day' : gain >= 10 ? '+2 pts: strong momentum' : gain >= 2 ? '+1 pt: positive momentum' : '✗ Needs ≥ 2%',
          status: gain >= 30 ? 'good' : gain >= 2 ? 'ok' : 'bad',
          pillar: true,
        },
        {
          label:  '③ Relative Volume ≥ 1.5×',
          value:  rvol ? rvol.toFixed(2) + '×' : '--',
          note:   rvol >= 10 ? '+3 pts: extreme surge' : rvol >= 5 ? '+2 pts: strong participation' : rvol >= 1.5 ? '+1 pt: active participation' : '✗ Needs ≥ 1.5×',
          status: rvol >= 5 ? 'good' : rvol >= 1.5 ? 'ok' : 'bad',
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
          label:  '⑤ Float < 5M ideal · 100M max (supply)',
          value:  floatM ?? 'Unknown',
          note:   float == null
            ? 'Float data unavailable (Yahoo)'
            : float < 5_000_000  ? '+1 pt: low supply (< 5M) ✓'
            : float < 100_000_000 ? 'Passes ceiling but no low-float point'
            : '✗ Float too high (> 100M)',
          status: float == null ? 'ok' : float < 5_000_000 ? 'good' : float < 100_000_000 ? 'ok' : 'bad',
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

  // The scanner exposes these as quick, client-side views of the earned
  // criteria.  Match both the current descriptive reason text and the shorter
  // reason labels used by older scan payloads.
  const SCAN_CRITERIA = [
    {
      key: 'strong-momentum',
      label: 'Strong momentum',
      matches: row => (row.scoreReasons || []).some(reason =>
        reason.includes('Strong momentum') || reason.includes('+10%')
      ),
    },
    {
      key: 'very-strong-momentum',
      label: 'Very strong momentum',
      matches: row => (row.scoreReasons || []).some(reason =>
        reason.includes('Very strong momentum') ||
        reason.includes('Full profile') ||
        reason.includes('+20%') ||
        reason.includes('30%')
      ),
    },
    {
      key: 'rel-vol-2',
      label: 'Rel Vol >2×',
      matches: row => {
        const reasons = row.scoreReasons || [];
        return (row.relVol ?? 0) > 2 || reasons.some(reason =>
          reason.includes('> 2×') || reason.includes('≥ 2×')
        );
      },
    },
    {
      key: 'rel-vol-5',
      label: 'Rel Vol >5×',
      matches: row => {
        const reasons = row.scoreReasons || [];
        return (row.relVol ?? 0) >= 5 || reasons.some(reason =>
          reason.includes('> 5×') ||
          reason.includes('≥ 5×') ||
          reason.includes('10×')
        );
      },
    },
    {
      key: 'price-range',
      label: 'Price range',
      matches: (row, config) => {
        const minPrice = config?.minPrice ?? MomentumConfig.defaults.minPrice;
        const maxPrice = config?.maxPrice ?? MomentumConfig.defaults.maxPrice;
        const reasons = row.scoreReasons || [];
        return (
          (row.price ?? 0) >= minPrice &&
          (row.price ?? 0) <= maxPrice
        ) || reasons.some(reason =>
          reason.includes('price range') || reason.includes('Price range')
        );
      },
    },
  ];

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
        const r = await fetch('/api/alpaca/credentials?connection=momentum', { credentials: 'include' });
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
        const r = await fetch('/api/alpaca/account?connection=momentum', { credentials: 'include' });
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
          body: JSON.stringify({ mode, connection: 'momentum' }),
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
      const r = await fetch('/api/momentum/order', {
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
      const r = await fetch('/api/momentum/order', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify({ symbol, side, amount: notional, connection: 'momentum' }),
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

    /** Fetch news catalyst data for the last 24 hours from /api/momentum/news/:sym */
    async fetchNews(sym) {
      try {
        const r = await fetch(`/api/momentum/news/${encodeURIComponent(sym)}`, { credentials: 'include' });
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
      const up30      = (row.change ?? 0) >= 30;
      const up10      = (row.change ?? 0) >= 10;
      const priceOk   = (row.price ?? 0) >= 3.00 && (row.price ?? 0) <= 20.00;
      const float     = row.float ?? row.floatSh ?? null;
      const floatOk   = float != null ? float < 5_000_000 : null; // null = unknown
      const floatStr  = float != null ? (float / 1_000_000).toFixed(2) + 'M shares' : 'Unknown (Yahoo)';
      return [
        {
          label: '① Demand: 5× Relative Volume (5× above avg volume today)',
          met:   relVol5x,
          note:  row.relVol != null ? `${row.relVol.toFixed(1)}× avg` : '--',
        },
        {
          label: '② Demand: Already up 30% on the day',
          met:   up30,
          note:  row.change != null
            ? `+${row.change.toFixed(1)}%` + (up30 ? '' : up10 ? ' (momentum present, not full profile)' : '')
            : '--',
        },
        {
          label: '③ Demand: News event moving the stock higher',
          met:   row.hasNewsCatalyst ?? null,
          note:  row.hasNewsCatalyst
            ? (row.newsHeadline?.slice(0, 50) || 'Confirmed')
            : 'No headline found',
        },
        {
          label: '④ Demand: Price between $3.00 – $20.00',
          met:   priceOk,
          note:  `$${row.price?.toFixed(2) ?? '--'}`,
        },
        {
          label: '⑤ Supply: Less than 5M shares available to trade',
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
    tradeJournal:   [],
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
    // Criterion quick-filter for the scanner table; null means all rows.
    _activeScanFilter: null,
    // ── Automation state ─────────────────────────────────────────────────────
    botEnabled:    false,          // true when auto-trading is running
    botPositions:  new Map(),      // sym → { entry, slPct, tpPct, shares, ts }
    _activeTrades: new Set(),      // symbols with pending/live bot orders (prevents double-entry)
    posMonitorId:  null,           // setInterval handle for position polling
    _flattenInProgress: false,     // blocks new automated orders while the kill switch settles
    _autoTradePromise: null,       // active auto-entry cycle, awaited before flattening
    _rsiExitPromise: null,         // active RSI exit cycle, awaited before flattening

    init() {
      this.config = MomentumConfig.load();
      this._bindEvents();
      this._renderConfigPanel();
      this._resetDailyIfNeeded();
      this._loadValidationReport();
      this._loadBotTrades().then(() => {
        // Recovery monitor only reconciles saved bot trades; it does not open
        // new positions until the user explicitly starts automation.
        if (this.botPositions.size) this._startPositionMonitor();
      });
      this._loadServerSettings().finally(() => AlpacaClient.checkConnection().then(() => {
        this._renderStatus();
        this._renderBotStatus();
        this.run();
      }));
    },

    async _loadServerSettings() {
      try {
        const response = await fetch('/api/momentum/settings', { credentials: 'include', cache: 'no-store' });
        if (!response.ok) return;
        const settings = await response.json();
        if (settings?.config) {
          this.config = { ...MomentumConfig.defaults, ...settings.config };
          MomentumConfig.save(this.config);
        }
        this.botEnabled = settings?.enabled === true;
        this._renderConfigPanel();
        this._renderBotStatus();
      } catch (error) {
        console.warn('[Momentum] Could not load server settings:', error.message);
      }
    },

    async _saveServerSettings() {
      const response = await fetch('/api/momentum/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: this.botEnabled, config: this.config }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Settings request failed (${response.status})`);
      this.config = { ...MomentumConfig.defaults, ...(data.config || this.config) };
      this.botEnabled = data.enabled === true;
      MomentumConfig.save(this.config);
    },

    async _loadValidationReport() {
      const status = $('mtValidationStatus');
      const note = $('mtValidationNote');
      if (!status || !note) return;
      try {
        const [response, shadowResponse] = await Promise.all([
          fetch('/api/momentum/strategy-validation', { cache: 'no-store' }),
          fetch('/api/momentum/paper-comparison', { cache: 'no-store' }),
        ]);
        if (!response.ok) throw new Error(`Report request failed (${response.status})`);
        const report = await response.json();
        const shadow = shadowResponse.ok ? await shadowResponse.json() : null;
        if (!report.available) {
          status.textContent = 'NOT RUN';
          status.className = 'mt-validation-status mt-validation-status--missing';
          note.textContent = 'No historical walk-forward report exists yet. Live trading remains unchanged.';
          return;
        }

        const metrics = report.testMetrics || {};
        const positive = Number(metrics.netExpectancy) > 0;
        status.textContent = !report.sampleAdequate
          ? 'INSUFFICIENT SAMPLE'
          : report.promotionStatus === 'PROMOTED_TO_PAPER'
            ? 'PAPER CANDIDATE'
            : 'NO PROMOTION';
        status.className = `mt-validation-status ${
          report.strategyEvaluable
            ? 'mt-validation-status--candidate'
            : 'mt-validation-status--blocked'
        }`;
        const shadowLabel = shadow?.available
          ? `${shadow.pairedDecisions || 0} paired live shadow decisions recorded`
          : 'live shadow evidence unavailable';
        note.textContent = report.strategyEvaluable
          ? `${report.selectedName} passed the configured validation checks. It remains paper-only.`
          : `No strategy change is evaluable or promoted. ${shadowLabel}; selected result remains ${report.selectedName}.`;

        const trades = $('mtValidationTrades');
        const winRate = $('mtValidationWinRate');
        const expectancy = $('mtValidationExpectancy');
        const profitFactor = $('mtValidationProfitFactor');
        const shadowPairs = $('mtValidationShadowPairs');
        if (trades) trades.textContent = String(metrics.n ?? 0);
        if (winRate) winRate.textContent = `${((Number(metrics.winRate) || 0) * 100).toFixed(1)}%`;
        if (expectancy) {
          expectancy.textContent = `${positive ? '+' : ''}$${(Number(metrics.netExpectancy) || 0).toFixed(2)}`;
          expectancy.className = positive ? 'mt-validation-positive' : 'mt-validation-negative';
        }
        if (profitFactor) profitFactor.textContent = Number.isFinite(Number(metrics.profitFactor))
          ? Number(metrics.profitFactor).toFixed(2)
          : String(metrics.profitFactor ?? '—');
        if (shadowPairs) shadowPairs.textContent = String(shadow?.pairedDecisions ?? 0);

        const caveats = $('mtValidationCaveats');
        if (caveats) {
          const failures = (report.failedChecks || []).join(', ') || 'none';
          const shadowCaveat = shadow?.caveat ? ` ${shadow.caveat}` : '';
          caveats.textContent = `${report.provider} ${report.feed}; ${report.receivedSymbols} symbols, ${report.barCount.toLocaleString()} bars. Failed checks: ${failures}. ${report.primaryCaveat}${shadowCaveat}`;
        }
      } catch (error) {
        status.textContent = 'UNAVAILABLE';
        status.className = 'mt-validation-status mt-validation-status--missing';
        note.textContent = 'The validation report could not be loaded. Live trading remains unchanged.';
      }
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
        // The browser renders the scanner only. The server scheduler is the
        // sole execution owner, so closing this page cannot suspend entries or
        // exits and an open tab cannot create a second execution path.
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
      setVal('mtTpPct',         cfg.takeProfitPercent);
      setVal('mtMinRR',         cfg.minRR);
      setVal('tsPositionValue', cfg.positionValue);
      const positionMode = cfg.positionMode === 'fixed' ? 'fixed' : 'pct';
      $('tsBtnPct')?.classList.toggle('active', positionMode === 'pct');
      $('tsBtnFixed')?.classList.toggle('active', positionMode === 'fixed');
      const prefix = $('tsInputPrefix');
      if (prefix) prefix.textContent = positionMode === 'pct' ? '%' : '$';
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
        positionMode:         this._getPosMode(),
        positionValue:        n('tsPositionValue') ?? this.config.positionValue,
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
        takeProfitPercent:   n('mtTpPct')        ?? this.config.takeProfitPercent,
        minRR:               n('mtMinRR')        ?? this.config.minRR,
        universeMode:        uni,
      };
    },

    /* ── Scan table rendering ────────────────────────────────────────────── */
    _renderScanTable(results) {
      const tbody = $('mtScanBody');
      if (!tbody) return;

      const allResults = Array.isArray(results) ? results : [];
      const criterion = SCAN_CRITERIA.find(c => c.key === this._activeScanFilter);
      const visibleResults = criterion
        ? allResults.filter(row => criterion.matches(row, this.config))
        : allResults;

      // Keep the filter state visually in sync on initial render and refreshes.
      $('mtScanFilters')?.querySelectorAll('.mt-scan-filter').forEach(btn => {
        const active = btn.dataset.scanFilter === this._activeScanFilter;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });

      if (!visibleResults.length) {
        const emptyText = criterion
          ? `No stocks earned the “${criterion.label}” criterion`
          : 'No momentum stocks found — try relaxing filters';
        tbody.innerHTML = `<tr><td colspan="7" class="mt-empty-row">${emptyText}</td></tr>`;
        return;
      }

      const rowsToRender = visibleResults.slice(0, 40);
      tbody.innerHTML = rowsToRender.map((r, i) => {
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
        </tr>
        <tr class="mt-criteria-row" data-sym="${r.sym}" data-idx="${i}">
          <td colspan="7">
            <div class="mt-criteria-expanded">
              <span class="mt-criteria-expanded-label">Earned criteria</span>
              <div class="mt-criteria-expanded-pills">${tooltipContent}</div>
            </div>
          </td>
        </tr>`;
      }).join('');

      const isTouchDevice = () =>
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        window.matchMedia?.('(hover: none), (pointer: coarse)').matches;

      // Row click → open detail panel
      tbody.querySelectorAll('.mt-scan-row').forEach(tr => {
        const scoreCell = tr.querySelector('.mt-score-td');
        const criteriaRow = tr.nextElementSibling;

        scoreCell?.addEventListener('click', event => {
          if (!isTouchDevice()) return;
          event.stopPropagation();
          const isExpanded = tr.classList.toggle('mt-score-expanded');
          criteriaRow?.classList.toggle('mt-criteria-row--open', isExpanded);
          scoreCell.setAttribute('aria-expanded', String(isExpanded));
        });

        tr.addEventListener('click', () => {
          tbody.querySelectorAll('.mt-scan-row').forEach(r => r.classList.remove('mt-row-active'));
          tr.classList.add('mt-row-active');
          const row = this.scanResults.find(result => result.sym === tr.dataset.sym);
          if (!row) return;
          this._openDetail(row);
          // On stacked mobile layout (body is single column), scroll detail panel into view
          if (window.innerWidth <= 1100) {
            const panel = $('mtDetailPanel');
            if (panel) setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
          }
        });
      });

      // Auto-open top result
      if (rowsToRender.length && !this.selectedRow) {
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

      const [ema, analysis, gamePlan] = await Promise.all([
        MomentumStrategy.getEMASignal(row.sym, this.config.emaFast, this.config.emaSlow),
        MomentumAnalysis.fetch(row.sym),
        fetch(`/api/gameplan/${encodeURIComponent(row.sym)}`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      this.emaSignal    = ema;
      this.tradeAnalysis = analysis;

      this._renderEMASignal(ema);
      this._renderIntradayIndicators(analysis);
      this._renderPriceAction(gamePlan?.confluence?.priceAction || analysis?.priceAction || null);
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

    _renderPriceAction(setup) {
      const el = $('mtPriceAction');
      if (!el) return;
      if (!setup) {
        el.innerHTML = '<span class="mt-na">Price-action evidence unavailable — no trade signal is inferred.</span>';
        return;
      }
      const eligible = setup.eligible === true;
      const evidence = setup.evidence || {};
      const reasons = Array.isArray(setup.reasons) ? setup.reasons : [];
      const statusClass = eligible ? 'mt-up' : 'mt-dn';
      const status = escapeHtml(setup.status || 'NO TRADE');
      const type = escapeHtml(setup.setup?.label || 'No confirmed long setup');
      const detail = setup.thesis
        ? escapeHtml(setup.thesis)
        : reasons.length
          ? escapeHtml(reasons.slice(0, 2).join(' · '))
          : 'Waiting for structural confirmation.';
      el.innerHTML = `
        <div class="mt-ema-row">
          <span class="mt-ema-label">Verdict</span>
          <span class="mt-ema-val ${statusClass}">${status}</span>
        </div>
        <div class="mt-ema-row">
          <span class="mt-ema-label">Pattern</span>
          <span class="mt-ema-val">${type}</span>
        </div>
        <div class="mt-ema-row">
          <span class="mt-ema-label">VWAP / volume</span>
          <span class="mt-ema-val">${evidence.vwap != null ? `$${fmt(evidence.vwap, 3)}` : '—'} · ${evidence.volumeRatio != null ? `${fmt(evidence.volumeRatio, 2)}×` : '—'}</span>
        </div>
        <div class="mt-ema-row">
          <span class="mt-ema-label">Invalidation / target</span>
          <span class="mt-ema-val">${setup.invalidation != null ? `$${fmt(setup.invalidation)}` : '—'} / ${setup.target != null ? `$${fmt(setup.target)}` : '—'}${setup.riskReward != null ? ` · ${fmt(setup.riskReward, 2)}R` : ''}</span>
        </div>
        <div class="mt-intra-note">${detail}</div>`;
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

      const takeProfitPct = Number(cfg.takeProfitPercent);
      const takeProfit = Number.isFinite(takeProfitPct) && takeProfitPct > 0
        ? +(entry * (1 + takeProfitPct / 100)).toFixed(2)
        : null;

      // Match the preview to the position-size control used by automated orders.
      const positionValue = Number(cfg.positionValue);
      const baseAmount = cfg.positionMode === 'fixed'
        ? positionValue
        : equity * (positionValue / 100);
      const exposure = baseAmount * this._getLeverage();
      const shares = Number.isFinite(exposure) && exposure > 0 ? Math.floor(exposure / entry) : 0;

      const rr         = RiskManager.calcRR(entry, stopLoss, takeProfit);
      const validation = shares ? RiskManager.validate(entry, stopLoss, takeProfit, equity, shares, cfg.minRR) : null;

      this.riskCalc = { entry, stopLoss, takeProfit, shares, rr, validation };

      const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
      const stopLbl = cfg.stopPercent ? `${cfg.stopPercent}% stop` : 'ATR stop';
      set('mtRiskEntry',   fmtDollar(entry));
      set('mtRiskStop',    stopLoss != null ? fmtDollar(stopLoss) + ` (${stopLbl})` : '--');
      set('mtRiskTP',      fmtDollar(takeProfit));
      set('mtRiskShares',  shares > 0 ? `${shares} (${cfg.positionMode === 'fixed' ? 'fixed $' : '% equity'})` : '--');
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
          el.textContent = `⟳ Scanning liquid candidates — ${done} / ${total} tickers…`;
        } else if (isFullMarket) {
          el.textContent = '⟳ Fetching live market data…';
        } else {
          const n = MomentumConfig.UNIVERSE.length;
          el.textContent = `⟳ Scanning ${n} tickers…`;
        }
        if (cdEl) cdEl.textContent = '';
      } else if (state === 'done') {
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        if (meta?.count) {
          const gainersN = (meta.gainers?.length || 0) + (meta.smallCap?.length || 0);
          const coverage = meta.coverage;
          const brokerCount = Number(coverage?.availableAtBroker);
          const rotation = coverage?.rotation;
          const scope = Number.isFinite(brokerCount)
            ? `${meta.count} scanned / ${brokerCount.toLocaleString()} Alpaca catalog snapshot${rotation ? ` · catalog batch ${rotation.batch}/${rotation.totalBatches}` : ''}`
            : `${meta.count} scanned (broker verification unavailable)`;
          const source = meta.candidateSource || 'market-mover candidates';
          el.textContent = `✓ ${count} hit${count !== 1 ? 's' : ''} · ${scope} · ${gainersN} gainers · ${source} · ${time}`;
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
      const dot     = $('atConnDot');
      const text    = $('atConnText');
      const button  = $('atConnBtn');

      // The Momentum page reuses the shared header controls. Those controls
      // must reflect Momentum's isolated broker account, not the optional
      // manual-trading connection maintained by alpacatrader.js.
      if (conn) {
        if (dot) dot.className = 'at-conn-dot dot-green';
        if (text) text.textContent = `Connected · ${mode.toUpperCase()}`;
        if (button) button.textContent = 'Account Settings';
      } else {
        if (dot) dot.className = 'at-conn-dot dot-red';
        if (text) text.textContent = 'Not connected';
        if (button) button.textContent = 'Connect Alpaca';
      }

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
        set('mtAccountId', `Verified broker account: ${AlpacaClient.account?.id || AlpacaClient.account?.account_number || '--'}`);
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

    /* ── Persistent bot journal + activity log ───────────────────────────── */
    _formatJournalTime(timestamp) {
      if (!timestamp) return '—';
      const normalized = String(timestamp).includes('T')
        ? timestamp
        : String(timestamp).replace(' ', 'T') + 'Z';
      const date = new Date(normalized);
      return Number.isNaN(date.getTime())
        ? String(timestamp)
        : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    _formatPnl(value) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return '—';
      return `${amount >= 0 ? '+' : '−'}$${Math.abs(amount).toFixed(2)}`;
    },

    _journalEvents(trades) {
      return (Array.isArray(trades) ? trades : []).filter(trade =>
        trade.status === 'open' || trade.status === 'closed'
      ).flatMap(trade => {
        const entry = {
          id: `trade-${trade.id}-entry`,
          sym: trade.symbol,
          action: '✓ AUTO-BUY',
          details: `${fmt(trade.shares, 4)} sh @ ${fmtDollar(trade.entry_price)} · ${(trade.mode || 'paper').toUpperCase()}`,
          status: 'ok',
          time: this._formatJournalTime(trade.timestamp),
          sortTime: new Date(String(trade.timestamp).replace(' ', 'T') + 'Z').getTime() || 0,
        };
        if (trade.status !== 'closed' || trade.exit_price == null) return [entry];
        const exitTime = trade.closed_at || trade.timestamp;
        return [
          entry,
          {
            id: `trade-${trade.id}-exit`,
            sym: trade.symbol,
            action: '✓ AUTO-EXIT',
            details: `${fmt(trade.shares, 4)} sh @ ${fmtDollar(trade.exit_price)} · P&L ${this._formatPnl(trade.pnl)}${trade.exit_reason ? ` · ${escapeHtml(trade.exit_reason)}` : ''}`,
            status: Number(trade.pnl) < 0 ? 'err' : 'ok',
            time: this._formatJournalTime(exitTime),
            sortTime: new Date(String(exitTime).replace(' ', 'T') + 'Z').getTime() || 0,
          },
        ];
      }).sort((a, b) => b.sortTime - a.sortTime).slice(0, 100);
    },

    _renderPerformance(performance) {
      const renderPeriod = (prefix, stats = {}) => {
        const set = (id, value, tone = '') => {
          const el = $(id);
          if (!el) return;
          el.textContent = value;
          el.className = `mt-performance-value${tone ? ` ${tone}` : ''}`;
        };
        const total = Number(stats.totalTrades || 0);
        const winRate = Number(stats.winRate || 0);
        const gain = stats.averageGain;
        const loss = stats.averageLoss;
        const pnl = Number(stats.totalRealizedPnl || 0);
        set(`mtPerf${prefix}Total`, String(total));
        set(`mtPerf${prefix}WinRate`, total ? `${winRate.toFixed(1)}%` : '—', total && winRate >= 50 ? 'mt-up' : '');
        set(`mtPerf${prefix}Gain`, gain == null ? '—' : this._formatPnl(gain), Number(gain) > 0 ? 'mt-up' : '');
        set(`mtPerf${prefix}Loss`, loss == null ? '—' : this._formatPnl(loss), Number(loss) < 0 ? 'mt-dn' : '');
        set(`mtPerf${prefix}Pnl`, total ? this._formatPnl(pnl) : '—', total ? (pnl >= 0 ? 'mt-up' : 'mt-dn') : '');
      };
      renderPeriod('Today', performance?.today);
      renderPeriod('All', performance?.allTime);
    },

    _hydrateOpenBotPositions(trades) {
      (Array.isArray(trades) ? trades : []).filter(trade => trade.status === 'open').forEach(trade => {
        const entry = Number(trade.entry_price);
        const shares = Number(trade.shares);
        if (!trade.symbol || !Number.isFinite(entry) || !Number.isFinite(shares)) return;
        const stopPx = Number(trade.stop_price);
        const entryOrderId = trade.entry_order_id || null;
        const usesClientOrderId = String(entryOrderId || '').startsWith('mt-');
        this.botPositions.set(trade.symbol, {
          tradeId: trade.id,
          entryOrderId,
          brokerOrderId: entryOrderId && !usesClientOrderId ? entryOrderId : null,
          // Each rehydrated entry is reconciled once before it can be treated
          // as an exited position. This catches delayed/rejected submissions.
          submissionPending: Boolean(entryOrderId),
          pendingExit: trade.pending_exit_order_id ? {
            clientOrderId: trade.pending_exit_order_id,
            reason: trade.pending_exit_reason || 'Broker exit submitted',
          } : null,
          entry,
          shares,
          stopPx: trade.stop_price != null && Number.isFinite(stopPx) && stopPx > 0 ? stopPx : null,
          slPct: trade.stop_price != null && Number.isFinite(stopPx) && stopPx > 0
            ? +((entry - stopPx) / entry * 100).toFixed(2)
            : null,
          tpPct: Number(trade.take_profit_pct) || null,
          // Only older entries lack a broker-held percentage target. Keep their
          // existing RSI exit behavior during recovery without applying it to
          // new bracket-protected positions.
          tpRsi: Number(trade.take_profit_pct) > 0
            ? null
            : (Number(trade.take_profit_rsi) || 75),
          lastPrice: entry,
          entrySynced: false,
          ts: new Date(String(trade.timestamp).replace(' ', 'T') + 'Z').getTime() || Date.now(),
        });
        this._activeTrades.add(trade.symbol);
      });
    },

    async _loadBotTrades() {
      try {
        const response = await fetch('/api/bot-trades?limit=100&strategy=momentum', { credentials: 'include' });
        if (!response.ok) return;
        const data = await response.json();
        this.tradeJournal = Array.isArray(data.trades) ? data.trades : [];
        this._hydrateOpenBotPositions(this.tradeJournal);
        this.log = this._journalEvents(this.tradeJournal);
        this._renderLog();
        this._renderPerformance(data.performance);
      } catch (error) {
        console.warn('[Momentum] Could not load bot trade journal:', error.message);
      }
    },

    async _persistBotTrade(payload) {
      try {
        const response = await fetch('/api/bot-trades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ ...payload, connection: 'momentum' }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Journal request failed (${response.status})`);
        }
        const data = await response.json();
        if (data.trade?.id) {
          const index = this.tradeJournal.findIndex(trade => trade.id === data.trade.id);
          if (index >= 0) this.tradeJournal.splice(index, 1, data.trade);
          else this.tradeJournal.unshift(data.trade);
          const info = this.botPositions.get(data.trade.symbol);
          if (info) {
            info.tradeId = data.trade.id;
            info.entryOrderId = data.trade.entry_order_id || info.entryOrderId || null;
          }
        }
        this._renderPerformance(data.performance);
        return data.trade;
      } catch (error) {
        console.warn('[Momentum] Could not persist bot trade:', error.message);
        return null;
      }
    },

    async _syncOpenTradeFromPosition(sym, info, position) {
      if (!info.tradeId) return;
      const entryPrice = Number(position.avg_entry_price);
      const shares = Number(position.qty);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(shares) || shares <= 0) return;
      const changed = !info.entrySynced ||
        Math.abs(Number(info.entry) - entryPrice) > 0.000001 ||
        Math.abs(Number(info.shares) - shares) > 0.000001;
      if (!changed) return;
      const trade = await this._persistBotTrade({
        action: 'sync-entry',
        tradeId: info.tradeId,
        symbol: sym,
        entryPrice,
        shares,
      });
      if (trade) {
        info.entry = entryPrice;
        info.shares = shares;
        info.entrySynced = true;
      }
    },

    async _getFilledExitOrder(sym, info, orderId = null, clientOrderId = null) {
      const endpoint = orderId
          ? `/api/alpaca/order/${encodeURIComponent(orderId)}?connection=momentum`
        : clientOrderId
          ? `/api/alpaca/order/by-client/${encodeURIComponent(clientOrderId)}?connection=momentum`
        : info.brokerOrderId
          ? `/api/alpaca/order/${encodeURIComponent(info.brokerOrderId)}?connection=momentum`
          : info.entryOrderId
            ? `/api/alpaca/order/by-client/${encodeURIComponent(info.entryOrderId)}?connection=momentum`
            : null;
      if (!endpoint) return null;
      try {
        const response = await fetch(endpoint, { credentials: 'include' });
        if (!response.ok) return null;
        const order = await response.json();
        const orders = [order, ...(Array.isArray(order.legs) ? order.legs : [])];
        const filledExit = orders.find(candidate =>
          candidate?.side === 'sell' &&
          String(candidate.status || '').toLowerCase() === 'filled' &&
          Number(candidate.filled_avg_price) > 0 &&
          Number(candidate.filled_qty) > 0
        );
        if (!filledExit) return null;
        const filledEntry = orders.find(candidate =>
          candidate?.side === 'buy' &&
          String(candidate.status || '').toLowerCase() === 'filled' &&
          Number(candidate.filled_avg_price) > 0 &&
          Number(candidate.filled_qty) > 0
        );
        return {
          exitPrice: Number(filledExit.filled_avg_price),
          shares: Number(filledExit.filled_qty),
          entryPrice: filledEntry ? Number(filledEntry.filled_avg_price) : null,
          entryShares: filledEntry ? Number(filledEntry.filled_qty) : null,
          reason: info.pendingExit?.reason ||
            (['stop', 'stop_limit'].includes(filledExit.type) ? 'Stop-loss order filled' : 'Broker exit order filled'),
        };
      } catch (_) {
        return null;
      }
    },

    async _reconcilePendingSubmission(sym, info) {
      if (!info.submissionPending || !info.entryOrderId) return false;
      try {
        const usesClientOrderId = String(info.entryOrderId).startsWith('mt-');
        const endpoint = usesClientOrderId
          ? `/api/alpaca/order/by-client/${encodeURIComponent(info.entryOrderId)}?connection=momentum`
          : `/api/alpaca/order/${encodeURIComponent(info.entryOrderId)}?connection=momentum`;
        const response = await fetch(
          endpoint,
          { credentials: 'include' }
        );
        if (!response.ok) return false;
        const order = await response.json();
        const status = String(order.status || '').toLowerCase();
        if (['canceled', 'rejected', 'expired'].includes(status)) {
          const trade = await this._persistBotTrade({
            action: 'void',
            tradeId: info.tradeId,
            symbol: sym,
            reason: `Broker entry ${status}`,
          });
          if (!trade) return false;
          this.botPositions.delete(sym);
          this._activeTrades.delete(sym);
          this.addLog(sym, '✗ AUTO-BUY', `Broker entry ${status}`, 'err');
          return false;
        }
        info.brokerOrderId = order.id || null;
        if (status !== 'filled') return false;
        const entryPrice = Number(order.filled_avg_price);
        const shares = Number(order.filled_qty);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(shares) || shares <= 0) {
          return false;
        }
        const trade = await this._persistBotTrade({
          action: 'sync-entry',
          tradeId: info.tradeId,
          symbol: sym,
          entryPrice,
          shares,
        });
        if (!trade) return false;
        info.entry = entryPrice;
        info.shares = shares;
        info.entrySynced = true;
        info.submissionPending = false;
        this.addLog(sym, 'AUTO-BUY CONFIRMED', 'Broker filled the saved client order; waiting for position data', 'info');
        return true;
      } catch (_) {
        return false;
      }
    },

    async _finalizeBotExit(sym, info, exit) {
      const exitPrice = Number(exit?.exitPrice);
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) return false;
      const actualShares = Number(exit?.shares);
      if (Number.isFinite(actualShares) && actualShares > 0) info.shares = actualShares;
      const trade = await this._persistBotTrade({
        action: 'exit',
        tradeId: info.tradeId,
        symbol: sym,
        exitPrice,
        entryPrice: Number.isFinite(Number(exit?.entryPrice)) ? Number(exit.entryPrice) : undefined,
        shares: Number.isFinite(actualShares) && actualShares > 0 ? actualShares : undefined,
        exitReason: exit.reason || 'Broker exit order filled',
      });
      if (!trade) return false;

      const pnl = Number(trade.pnl);
      this.addLog(sym, '✓ AUTO-EXIT',
        `${fmt(trade.shares, 4)} sh @ ${fmtDollar(trade.exit_price)} · P&L ${this._formatPnl(pnl)} · ${trade.exit_reason || 'Broker exit order filled'}`,
        pnl < 0 ? 'err' : 'ok');
      this.botPositions.delete(sym);
      this._activeTrades.delete(sym);
      this._setExitCooldown(sym);
      if (!this.botEnabled && !this.botPositions.size) this._stopPositionMonitor();
      return true;
    },

    async _reconcilePendingExits() {
      for (const [sym, info] of this.botPositions) {
        if (!info.pendingExit?.orderId && !info.pendingExit?.clientOrderId) continue;
        const exit = await this._getFilledExitOrder(
          sym, info, info.pendingExit.orderId, info.pendingExit.clientOrderId
        );
        if (exit) {
          await this._finalizeBotExit(sym, info, exit);
          continue;
        }
        try {
          const endpoint = info.pendingExit.orderId
            ? `/api/alpaca/order/${encodeURIComponent(info.pendingExit.orderId)}?connection=momentum`
            : `/api/alpaca/order/by-client/${encodeURIComponent(info.pendingExit.clientOrderId)}?connection=momentum`;
          const response = await fetch(endpoint, { credentials: 'include' });
          if (!response.ok) continue;
          const order = await response.json();
          const status = String(order.status || '').toLowerCase();
          if (['canceled', 'rejected', 'expired'].includes(status)) {
            const cleared = await this._persistBotTrade({
              action: 'clear-exit',
              tradeId: info.tradeId,
              symbol: sym,
            });
            if (!cleared) continue;
            this.addLog(sym, 'EXIT NOT FILLED', `Broker marked exit ${status}; position remains monitored`, 'err');
            delete info.pendingExit;
            info._exiting = false;
          }
        } catch (_) {}
      }
    },

    addLog(sym, action, details, status = 'ok') {
      this.log.unshift({ sym, action, details, status, time: new Date().toLocaleTimeString() });
      if (this.log.length > 100) this.log.pop();
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
    _newJournalOrderId() {
      const suffix = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return `mt-${suffix}`.slice(0, 48);
    },

    // ── Market-hours helper (mirrors server isMarketOpen) ─────────────────
    _isMarketOpen() {
      // US equity market: Mon–Fri 9:35 AM – 3:50 PM ET
      const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const day  = et.getDay();
      const mins = et.getHours() * 60 + et.getMinutes();
      return day >= 1 && day <= 5 && mins >= 575 && mins < 950;
    },

    // ── Pre-trade safety gate ───────────────────────────────────────────────
    // For each candidate (best score first): fetch intraday analysis + candle
    // patterns, then reject if the stock shows dump indicators or a strong
    // bearish reversal pattern. Returns the first safe candidate or null.
    async _pickSafeCandidate(candidates) {
      for (const row of candidates) {
        const [analysis, patResp, gamePlan] = await Promise.all([
          MomentumAnalysis.fetch(row.sym),
          fetch(`/api/patterns/${row.sym}`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`/api/gameplan/${encodeURIComponent(row.sym)}?force=1`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        // FAIL CLOSED: if safety/confluence data is unavailable, we cannot verify
        // the setup — skip this candidate rather than trading blind.
        if ((!analysis && !patResp?.ok) || !gamePlan?.confluence?.available) {
          this.addLog(row.sym, 'SKIP', 'Safety analysis unavailable — cannot verify dump/pattern status', 'warn');
          continue;
        }
        const confluence = gamePlan.confluence;
        const priceAction = confluence.priceAction;
        const tcScores = confluence.scores || {};
        const tcSignal = confluence.signal || {};
        const dataQuality = confluence.dataQuality || {};
        const generatedAt = Date.parse(gamePlan.generatedAt || '');
        const freshEnough = Number.isFinite(generatedAt) && Date.now() - generatedAt <= 90_000;
        const atResistance = confluence.levels?.criticalResistance?.distancePct != null
          && confluence.levels.criticalResistance.distancePct <= 0.6;
        const hasBreakoutVolume = confluence.states?.volume === 'BUYING VOLUME SPIKE';
        const entryConfirmed = tcSignal.stage === 'CONFIRMED' && tcSignal.confluence === 'HIGH CONFLUENCE';
        if (!entryConfirmed
          || !dataQuality.entryEligible
          || !dataQuality.fresh
          || !freshEnough
          || (tcScores.bullish ?? 0) < 68
          || (tcScores.drawdown ?? 100) >= (tcScores.bullish ?? 0)
          || confluence.states?.risk === 'ELEVATED'
          || confluence.tradePlan?.invalidation == null
          || (atResistance && !hasBreakoutVolume)) {
          this.addLog(row.sym, 'SKIP',
            `Technical confluence: ${tcSignal.label || 'NO CLEAR EDGE'} · Bull ${tcScores.bullish ?? '--'} / Drawdown ${tcScores.drawdown ?? '--'} · ${confluence.states?.risk || 'risk unavailable'}`,
            'warn');
          continue;
        }
        if (!priceAction?.eligible || priceAction.direction !== 'LONG_ONLY') {
          this.addLog(row.sym, 'SKIP',
            `Price action: ${priceAction?.status || 'NO TRADE'} · ${(priceAction?.reasons || ['required setup evidence unavailable']).slice(0, 2).join(' · ')}`,
            'warn');
          continue;
        }

        // 1. Dump-indicator gate (same flags shown in the "Indicators for a Dump" tab)
        const flags  = MomentumAnalysis.dumpFlags(row, null, analysis);
        const active = flags.filter(f => f.active === true);
        // High-volume red candle or large topping tail alone is disqualifying;
        // otherwise require 2+ simultaneous dump flags to block.
        const hardFlag = active.find(f =>
          f.label === 'High volume red candle' || f.label === 'Large topping tail');
        if (hardFlag || active.length >= 2) {
          const why = (hardFlag ? [hardFlag] : active).map(f => f.label).join(', ');
          this.addLog(row.sym, 'SKIP', `Dump indicator(s): ${why}`, 'warn');
          continue;
        }

        // 2. Bearish candlestick pattern gate (strength ≥2 = confirmed reversal)
        const patterns = patResp?.ok ? (patResp.patterns || []) : [];
        const bearish  = patterns.find(p => p.type === 'BEARISH' && p.strength >= 2);
        if (bearish) {
          this.addLog(row.sym, 'SKIP', `Bearish pattern: ${bearish.name}`, 'warn');
          continue;
        }

        return { ...row, technicalConfluence: confluence, priceAction }; // passed all safety checks
      }
      return null;
    },

    // ── Main auto-trade method — called after every scan when bot is ON ────
    async _autoTrade(results) {
      // BUG FIX: null guard — results could be undefined if scan throws
      if (!results?.length) return;
      if (!this.botEnabled || this._flattenInProgress || !AlpacaClient.connected) return;

      // Concurrency mutex — prevent overlapping auto-trade cycles (manual refresh,
      // timer scan, or config change could each trigger a cycle in flight)
      if (this._autoTradeBusy) return;
      this._autoTradeBusy = true;
      const cycle = this._autoTradeInner(results);
      this._autoTradePromise = cycle;
      try {
        await cycle;
      } finally {
        this._autoTradeBusy = false;
        if (this._autoTradePromise === cycle) this._autoTradePromise = null;
      }
    },

    async _autoTradeInner(results) {
      if (!this.botEnabled || this._flattenInProgress) return;

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
        const r = await fetch('/api/alpaca/positions?connection=momentum', { credentials: 'include' });
        if (r.ok) {
          const pos = await r.json();
          (Array.isArray(pos) ? pos : []).forEach(p => heldSyms.add(p.symbol));
        }
      } catch (_) {}

      // Find BUY candidates: signal BUY or STRONG BUY, not already held, not bot-pending
      // BUG FIX: was `=== 'BUY'` which excluded STRONG BUY (score ≥5) — the best setups!
      const candidates = results.filter(r => {
        const sig = MomentumStrategy.getSignal(r);
        return (sig.signal === 'BUY' || sig.signal === 'STRONG BUY')
          && !heldSyms.has(r.sym)
          && !this._activeTrades.has(r.sym)
          // Re-entry cooldown: don't buy back a stock we just exited (RSI-overbought
          // or stopped out) — rotate to the next candidate instead of churning
          && !(this._exitCooldown?.get(r.sym) > Date.now());
      });

      if (!candidates.length) return; // nothing qualifies this cycle

      // ── Pre-trade safety gate: dump indicators + bearish candlestick patterns ──
      // Enforces what the "Indicators for a Dump" checklist promises: skip any
      // candidate that is topping (dump flags) or printing a strong bearish pattern.
      const row = await this._pickSafeCandidate(candidates.slice(0, 3));
      if (!row) return; // every candidate failed the safety gate this cycle
      if (!this.botEnabled || this._flattenInProgress) return;
      const cfg   = this.config;
      const entry = row.price;

      // ── Calculate stop loss % ────────────────────────────────────────────
      let slPct = (cfg.stopPercent != null && cfg.stopPercent > 0) ? cfg.stopPercent : null;
      const structuralInvalidation = Number(row.priceAction?.invalidation);
      const structuralSlPct = Number.isFinite(structuralInvalidation) && structuralInvalidation > 0 && structuralInvalidation < entry
        ? +((entry - structuralInvalidation) / entry * 100).toFixed(2)
        : null;
      // A compatible setup supplies a structural invalidation. Preserve a
      // tighter user-configured stop, but never loosen protection below that
      // setup failure point or replace it with an arbitrary wider stop.
      if (structuralSlPct != null) slPct = slPct ? Math.min(slPct, structuralSlPct) : structuralSlPct;
      if (!slPct && row.atr14 != null) {
        const stopPrice = RiskManager.calcStopLoss(entry, row.atr14, 1.5);
        if (stopPrice) slPct = +((entry - stopPrice) / entry * 100).toFixed(2);
      }
      if (!slPct) {
        this.addLog(row.sym, 'SKIP', 'No stop loss configured — set Stop Loss % in settings', 'warn');
        return;
      }
      const tpPct = Number(cfg.takeProfitPercent);
      if (!Number.isFinite(tpPct) || tpPct <= 0) {
        this.addLog(row.sym, 'SKIP', 'No take-profit target configured — set Take Profit % in settings', 'warn');
        return;
      }

      // ── Calculate position size from execution settings ──────────────────
      // BUG FIX: the server multiplies `amount` by `leverage` itself — sending a
      // pre-leveraged amount doubled the leverage. Send the BASE amount only.
      const equity     = AlpacaClient.getEquity();
      if (!equity || equity <= 0) {
        this.addLog(row.sym, 'SKIP', 'Account equity unknown — cannot size position safely', 'warn');
        return;
      }
      const leverage   = this._getLeverage();
      const posMode    = this._getPosMode();
      const posVal     = this._getPosValue();
      const baseAmount = posMode === 'fixed' ? posVal : equity * (posVal / 100);
      const notional   = baseAmount * leverage; // true final exposure (leverage applied ONCE)

      // ── Risk validation (RiskManager rule: never risk >5% of equity per trade) ──
      const worstCaseRisk = notional * (slPct / 100);
      const riskPct       = (worstCaseRisk / equity) * 100;
      if (riskPct > 5) {
        this.addLog(row.sym, 'SKIP',
          `Risk ${riskPct.toFixed(1)}% of equity exceeds 5% cap — reduce position size or stop %`, 'warn');
        return;
      }

      // Lock this symbol to prevent duplicate orders while request is in flight
      if (!this.botEnabled || this._flattenInProgress) return;
      this._activeTrades.add(row.sym);
        this.addLog(row.sym, '→ AUTO-BUY',
          `$${notional.toFixed(0)} · ${row.priceAction?.setup?.label || 'long setup'} · SL ${slPct}% · TP ${tpPct}% · Confluence ${row.technicalConfluence?.scores?.bullish ?? '--'}/100 · ${AlpacaClient.mode.toUpperCase()}`, 'info');

      let journalTrade = null;
      let journalOrderId = null;
      try {
        // Write the durable journal entry before submitting a broker order. If
        // SQLite is unavailable, fail closed rather than place an untracked buy.
        journalOrderId = this._newJournalOrderId();
        const estimatedShares = Math.floor(notional / entry);
        const estimatedStopPx = +(entry * (1 - slPct / 100)).toFixed(2);
        journalTrade = await this._persistBotTrade({
          action: 'buy',
          symbol: row.sym,
          entryPrice: entry,
          shares: estimatedShares,
          stopPrice: estimatedStopPx,
          takeProfitPct: tpPct,
          entryOrderId: journalOrderId,
          mode: AlpacaClient.mode,
        });
        if (!journalTrade) {
          this.addLog(row.sym, 'AUTO-BUY BLOCKED', 'Trade journal is unavailable; broker order was not submitted', 'err');
          this._activeTrades.delete(row.sym);
          return;
        }
        this.botPositions.set(row.sym, {
          tradeId: journalTrade.id,
          entry: entry,
          slPct,
          tpPct,
          shares: estimatedShares,
          stopPx: estimatedStopPx,
          lastPrice: entry,
          entryOrderId: journalOrderId,
          entrySynced: false,
          ts: Date.now(),
        });

        // A flatten request may have arrived while the durable journal entry was
        // being written. Never submit a new broker order after the kill switch.
        if (!this.botEnabled || this._flattenInProgress) {
          await this._persistBotTrade({
            action: 'void',
            tradeId: journalTrade.id,
            symbol: row.sym,
            reason: 'Flatten all initiated before broker order submission',
          });
          this.botPositions.delete(row.sym);
          this._activeTrades.delete(row.sym);
          return;
        }

        // Broker-held bracket: both take profit and stop loss remain active even
        // if the browser disconnects or the user signs out.
        const resp = await fetch('/api/momentum/order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            symbol: row.sym, side: 'buy', amount: baseAmount, tpPct, slPct, leverage,
            clientOrderId: journalOrderId,
          }),
        });
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}));
          const error = new Error(e.error || 'Order failed');
          // A 4xx response is a definitive rejection from this application.
          // Network failures and 5xx responses are ambiguous: Alpaca may have
          // accepted the client_order_id even though this browser missed it.
          error.definitive = resp.status >= 400 && resp.status < 500;
          throw error;
        }
        const result     = await resp.json();
        const entryPrice = Number(result.price) || entry;
        const shares     = result.shares ? parseFloat(result.shares) : Math.floor(notional / entryPrice);
        const stopPx     = +(entryPrice * (1 - slPct / 100)).toFixed(2);
        const riskAmt    = Math.abs(entryPrice - stopPx) * shares;

        // Update daily counters
        this.dailyTrades++;
        this.dailyLossAmt += riskAmt; // worst-case risk
        this._renderDailyLimits();

        this.addLog(row.sym, '✓ AUTO-BUY',
          `${shares} sh @ $${entryPrice.toFixed(2)} · stop $${stopPx} · target $${(entryPrice * (1 + tpPct / 100)).toFixed(2)}`, 'ok');
        const info = this.botPositions.get(row.sym);
        if (info) {
          info.entry = entryPrice;
          info.shares = shares;
          info.stopPx = stopPx;
          info.tpPct = tpPct;
          info.brokerOrderId = result.order?.id || null;
          // Alpaca can acknowledge a market entry before it fills. Reconcile
          // this parent order until it is filled or terminal before treating a
          // missing position as an exit.
          info.submissionPending = true;
        }
        // Note: _activeTrades keeps row.sym locked until position closes (avoids re-entry while in trade)
      } catch (err) {
        const info = this.botPositions.get(row.sym);
        if (journalTrade?.id && err.definitive) {
          await this._persistBotTrade({
            action: 'void',
            tradeId: journalTrade.id,
            symbol: row.sym,
            reason: `Broker entry rejected: ${err.message}`,
          });
          if (info) this.botPositions.delete(row.sym);
          this.addLog(row.sym, '✗ AUTO-BUY', err.message, 'err');
          this._activeTrades.delete(row.sym); // unlock after a definitive rejection
        } else if (journalTrade?.id && info) {
          info.submissionPending = true;
          this.addLog(row.sym, 'AUTO-BUY PENDING',
            'Broker response was interrupted; reconciling the saved client order before any retry', 'info');
        } else {
          this.addLog(row.sym, '✗ AUTO-BUY', err.message, 'err');
          this._activeTrades.delete(row.sym);
        }
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
      // In-flight mutex — overlapping polls could each submit an RSI-exit sell
      if (this._pollBusy) return;
      this._pollBusy = true;
      try {
        const r = await fetch('/api/alpaca/positions?connection=momentum', { credentials: 'include' });
        if (!r.ok) return;
        const positions = await r.json();
        this._renderPositionsPanel(Array.isArray(positions) ? positions : []);

        // Keep the latest broker price while a bot position is open so a stop-loss
        // closure detected on the next poll has a defensible exit value.
        const positionsBySymbol = new Map((positions || []).map(position => [position.symbol, position]));
        for (const [sym, info] of this.botPositions) {
          if (info.submissionPending) {
            await this._reconcilePendingSubmission(sym, info);
            continue;
          }
          const position = positionsBySymbol.get(sym);
          if (!position) continue;
          const currentPrice = Number(position.current_price);
          if (Number.isFinite(currentPrice) && currentPrice > 0) info.lastPrice = currentPrice;
          const pnl = Number(position.unrealized_pl);
          if (Number.isFinite(pnl)) info.lastPnl = pnl;
          await this._syncOpenTradeFromPosition(sym, info, position);
        }

        // A submitted RSI exit is not realized until Alpaca reports a fill.
        await this._reconcilePendingExits();

        // Detect stop-loss exits: bot-tracked symbol disappeared from open positions
        const heldSet = new Set((positions || []).map(p => p.symbol));
        for (const [sym, info] of this.botPositions) {
          if (info.submissionPending) continue;
          if (!heldSet.has(sym)) {
            const exit = await this._getFilledExitOrder(sym, info);
            if (exit) {
              await this._finalizeBotExit(sym, info, exit);
            } else if (!info._missingExitLogged) {
              info._missingExitLogged = true;
              this.addLog(sym, 'EXIT PENDING', 'Position closed; waiting for Alpaca fill confirmation before recording P&L', 'info');
            }
          }
        }

        // ── RSI take-profit exit: sell when intraday RSI(14) ≥ configured level ──
        if (this.botEnabled && !this._flattenInProgress && this._isMarketOpen()) {
          const exitCycle = this._checkRsiExits(positions || []);
          this._rsiExitPromise = exitCycle;
          try {
            await exitCycle;
          } finally {
            if (this._rsiExitPromise === exitCycle) this._rsiExitPromise = null;
          }
        }
      } catch (_) {}
      finally { this._pollBusy = false; }
    },

    // 15-min re-entry cooldown after any exit — prevents buy-back churn
    _setExitCooldown(sym) {
      if (!this._exitCooldown) this._exitCooldown = new Map();
      this._exitCooldown.set(sym, Date.now() + 15 * 60 * 1000);
    },

    // Sell any bot position whose intraday RSI has reached its take-profit level
    async _checkRsiExits(positions) {
      for (const [sym, info] of this.botPositions) {
        if (!this.botEnabled || this._flattenInProgress) return;
        if (info._exiting || info.pendingExit) continue;
        const pos = positions.find(p => p.symbol === sym);
        if (!pos) continue;
        const analysis = await MomentumAnalysis.fetch(sym);
        if (!this.botEnabled || this._flattenInProgress) return;
        const rsi = analysis?.rsi14;
        if (!(info.tpRsi > 0) || rsi == null || rsi < info.tpRsi) continue;
        info._exiting = true; // prevent duplicate sells while request is in flight
        try {
          const qty      = parseFloat(pos.qty || 0);
          const price    = parseFloat(pos.current_price || info.entry);
          const notional = qty * price * 1.05; // buffer — server caps sells at held qty
          const reason = `RSI take-profit (${rsi} ≥ ${info.tpRsi})`;
          const exitClientOrderId = this._newJournalOrderId();
          const pending = await this._persistBotTrade({
            action: 'submit-exit',
            tradeId: info.tradeId,
            symbol: sym,
            exitOrderId: exitClientOrderId,
            exitReason: reason,
          });
          if (!pending) throw new Error('Trade journal is unavailable; exit order was not submitted');
          info.pendingExit = { clientOrderId: exitClientOrderId, reason };
          const r = await fetch('/api/momentum/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              symbol: sym, side: 'sell', amount: notional, clientOrderId: exitClientOrderId, connection: 'momentum',
            }),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            const error = new Error(e.error || 'Sell failed');
            error.definitive = r.status >= 400 && r.status < 500;
            throw error;
          }
          const result = await r.json();
          const orderId = result.order?.id;
          if (!orderId) throw new Error('Broker did not return an exit order ID');
          info.pendingExit = {
            orderId,
            clientOrderId: exitClientOrderId,
            reason,
          };
          this.addLog(sym, 'AUTO-EXIT SUBMITTED',
            `RSI ${rsi} ≥ ${info.tpRsi} — waiting for broker fill confirmation`, 'info');
        } catch (err) {
          if (err.definitive && info.pendingExit?.clientOrderId) {
            const cleared = await this._persistBotTrade({
              action: 'clear-exit',
              tradeId: info.tradeId,
              symbol: sym,
            });
            if (cleared) delete info.pendingExit;
          }
          info._exiting = Boolean(info.pendingExit);
          this.addLog(sym, info.pendingExit ? 'AUTO-EXIT PENDING' : '✗ TAKE PROFIT',
            info.pendingExit
              ? 'Broker response was interrupted; reconciling the saved exit order'
              : err.message,
            info.pendingExit ? 'info' : 'err');
        }
      }
    },

    _renderPositionsPanel(positions) {
      const el = $('atPositionsBody');
      if (!el) return;
      const count = Array.isArray(positions) ? positions.length : 0;
      const countEl = $('atPosCount');
      if (countEl) countEl.textContent = String(count);
      this._setFlattenButtonState(count);
      if (!positions.length) {
        el.innerHTML = '<div class="at-empty">No open positions</div>';
        return;
      }
      el.innerHTML = positions.map(p => {
        const plPct  = parseFloat(p.unrealized_plpc || 0) * 100;
        const pl     = parseFloat(p.unrealized_pl   || 0);
        const curr   = parseFloat(p.current_price   || 0);
        const avg    = parseFloat(p.avg_entry_price  || 0);
        const isBot  = this.botPositions.has(p.symbol);
        const bInfo  = isBot ? this.botPositions.get(p.symbol) : null;
          const meta = bInfo
            ? `SL ${bInfo.slPct}% · ${bInfo.tpPct ? `TP ${bInfo.tpPct}%` : `TP RSI ${bInfo.tpRsi ?? 75}`}`
            : '—';
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

    _setFlattenButtonState(positionCount) {
      const btn = $('atCloseAllPos');
      if (!btn) return;
      btn.disabled = this._flattenInProgress || positionCount === 0;
      if (this._flattenInProgress) {
        btn.dataset.flattening = 'true';
        btn.textContent = 'FLATTENING…';
      } else {
        delete btn.dataset.flattening;
        btn.textContent = 'FLATTEN ALL';
      }
    },

    async _flattenAllPositions() {
      if (this._flattenInProgress) return;

      let positions;
      try {
        const response = await fetch('/api/alpaca/positions?connection=momentum', { credentials: 'include' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Could not load positions (${response.status})`);
        positions = Array.isArray(data) ? data : [];
      } catch (error) {
        this.addLog('BOT', 'FLATTEN ALL FAILED', error.message, 'err');
        alert(`Could not load open positions: ${error.message}`);
        return;
      }

      this._renderPositionsPanel(positions);
      const count = positions.length;
      if (!count) return;

      const noun = count === 1 ? 'position' : 'positions';
      if (!confirm(`Close all ${count} ${noun}? This stops the bot and submits market-close orders immediately.`)) return;

      const botWasRunning = this.botEnabled;
      this._flattenInProgress = true;
      this.botEnabled = false;
      this._renderBotStatus();
      this._stopPositionMonitor();
      this._setFlattenButtonState(count);

      let flattenVerified = false;
      try {
        const response = await fetch('/api/alpaca/positions?connection=momentum', {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          const details = data.details || {};
          const unresolved = [
            ...(details.openOrderIds || []).map(id => `order ${id}`),
            ...(details.remainingOpenOrderIds || []).map(id => `order ${id}`),
            ...(details.remainingPositionSymbols || []).map(symbol => `position ${symbol}`),
          ];
          const suffix = unresolved.length ? ` Remaining: ${unresolved.join(', ')}.` : '';
          throw new Error(`${data.error || `Could not close positions (${response.status})`}${suffix}`);
        }

        flattenVerified = true;
        this.addLog(
          'BOT',
          '⚠ FLATTEN ALL',
          `${botWasRunning ? 'Bot stopped; ' : ''}${count} ${noun} closed and no open orders remain`,
          'warn'
        );
      } catch (error) {
        this.addLog(
          'BOT',
          'FLATTEN ALL FAILED',
          `Bot stopped; positions were not closed: ${error.message}`,
          'err'
        );
        alert(`Could not close all positions: ${error.message}`);
      } finally {
        this._flattenInProgress = false;
        if (this.botPositions.size) this._startPositionMonitor();
        else this._pollPositions();
        this._setFlattenButtonState(flattenVerified ? 0 : count);
      }
    },

    // ── Bot toggle — enable/disable auto-trading ──────────────────────────
    async _toggleBot() {
      if (!this.botEnabled) {
        // Starting automation must honor the values the trader can currently
        // see, even when they did not separately press Apply Settings.
        this.config = this._readConfig();
      }
      this.botEnabled = !this.botEnabled;
      try {
        await this._saveServerSettings();
      } catch (error) {
        this.botEnabled = !this.botEnabled;
        this.addLog('BOT', 'Settings not saved', error.message, 'err');
        this._renderBotStatus();
        return;
      }
      this._renderBotStatus();
      if (this.botEnabled) {
        this.addLog('BOT', '▶ Auto-trading ON',
          `Server-owned ${AlpacaClient.mode.toUpperCase()} cycle · broker-held bracket exits · continues when this page closes`, 'ok');
        this._startPositionMonitor();
        this.run(); // trigger an immediate scan + trade cycle
      } else {
        this.addLog('BOT', '⏹ Auto-trading OFF', 'Manual mode — open positions remain, Alpaca brackets still active', 'info');
        if (!this.botPositions.size) this._stopPositionMonitor();
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
        this._saveServerSettings().catch(error => this.addLog('CONFIG', 'Settings not saved', error.message, 'err'));
        this.selectedRow = null;
        this.run();
      });

      // Scanner criteria filters are local views over the latest scan results.
      $('mtScanFilters')?.addEventListener('click', event => {
        const button = event.target.closest('.mt-scan-filter');
        if (!button) return;
        const nextFilter = button.dataset.scanFilter;
        this._activeScanFilter = this._activeScanFilter === nextFilter ? null : nextFilter;
        this._renderScanTable(this.scanResults);
      });

      // Apply config
      $('mtApplyConfig')?.addEventListener('click', () => {
        this.config = this._readConfig();
        MomentumConfig.save(this.config);
        this._saveServerSettings().catch(error => this.addLog('CONFIG', 'Settings not saved', error.message, 'err'));
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
        this._saveServerSettings().catch(error => this.addLog('CONFIG', 'Settings not saved', error.message, 'err'));
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

      // Position sizing is part of the saved bot configuration, not a
      // temporary display preference. Update the prefix and active mode
      // immediately; Apply Settings persists it before the next scan.
      [$('tsBtnPct'), $('tsBtnFixed')].forEach(button => button?.addEventListener('click', () => {
        const fixed = button.id === 'tsBtnFixed';
        $('tsBtnPct')?.classList.toggle('active', !fixed);
        $('tsBtnFixed')?.classList.toggle('active', fixed);
        const prefix = $('tsInputPrefix');
        if (prefix) prefix.textContent = fixed ? '$' : '%';
      }));

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


      // Bot ON/OFF toggle
      $('mtBotToggle')?.addEventListener('click', () => { this._toggleBot(); });
      $('atCloseAllPos')?.addEventListener('click', () => this._flattenAllPositions());

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
      window.addEventListener('alpaca-connection-changed', event => {
        if (event.detail?.connection && event.detail.connection !== 'momentum') return;
        AlpacaClient.checkConnection().then(() => this._renderStatus());
      });
      $('atConnBtn')?.addEventListener('click', event => {
        event.stopImmediatePropagation();
        window.alpacaTrader?.openConnectModal?.('momentum');
      }, true);
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
