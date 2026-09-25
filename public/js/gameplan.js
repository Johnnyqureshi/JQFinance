/* ── Stock Intelligence ──────────────────────────────────────────────────────
   One server-owned stock verdict with concise supporting evidence.
   Broad-market context never appears as a competing stock direction. */
const gamePlan = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => n == null || !isFinite(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const dateLabel = value => {
    if (value == null) return 'Unavailable';
    const timestamp = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : String(value);
  };

  const REFRESH_MS = 60 * 1000;
  const SIGNIFICANT_MOVE_PCT = 1.5;
  let currentSym = null;
  let timer = null;
  let reqToken = 0;   // monotonic token — stale responses are discarded
  let planWatch = null;
  let smartMoneyRequestToken = 0;

  function setSafe(id, fn) { const el = $(id); if (el) fn(el); }

  function dot(state) {
    const cls = state === 'bull' ? 'gp-dot-bull' : state === 'bear' ? 'gp-dot-bear' : 'gp-dot-neut';
    return `<span class="gp-dot ${cls}"></span>`;
  }
  function trendDot(t) { return dot(t === 'BULLISH' ? 'bull' : t === 'BEARISH' ? 'bear' : 'neut'); }
  function setupClass(setup) {
    const s = String(setup || '').toUpperCase();
    if (s.includes('BULL') || s.includes('BREAKOUT')) return 'bull';
    if (s.includes('BEAR') || s === 'SELL' || s.includes('BREAKDOWN')) return 'bear';
    return 'neut';
  }

  function zoneVerdict(price, source) {
    const current = Number(price);
    const supports = (source?.support || [])
      .map(level => Number(level?.price ?? level))
      .filter(level => Number.isFinite(level) && level > 0 && level < current)
      .sort((a, b) => b - a);
    const resistances = (source?.resistance || [])
      .map(level => Number(level?.price ?? level))
      .filter(level => Number.isFinite(level) && level > current)
      .sort((a, b) => a - b);
    const support = supports[0];
    const resistance = resistances[0];
    const bias = Number(source?.bias?.price ?? source?.bias);

    if (!Number.isFinite(current) || current <= 0) return null;
    if (Number.isFinite(support) && Number.isFinite(resistance) && resistance > support) {
      const supportDistance = current - support;
      const resistanceDistance = resistance - current;
      const buy = supportDistance <= resistanceDistance;
      const range = resistance - support;
      const edgeStrength = Math.abs(resistanceDistance - supportDistance) / range;
      return {
        verdict: buy ? 'BUY' : 'SELL',
        direction: buy ? 'BULLISH' : 'BEARISH',
        confidence: Math.round(55 + Math.min(30, edgeStrength * 45)),
        reason: buy
          ? `Price is closer to validated support at $${fmt(support)} than resistance at $${fmt(resistance)}.`
          : `Price is closer to validated resistance at $${fmt(resistance)} than support at $${fmt(support)}.`,
      };
    }
    if (Number.isFinite(bias) && bias > 0) {
      const buy = current >= bias;
      const distancePct = Math.abs(current - bias) / bias * 100;
      return {
        verdict: buy ? 'BUY' : 'SELL',
        direction: buy ? 'BULLISH' : 'BEARISH',
        confidence: Math.round(55 + Math.min(25, distancePct * 5)),
        reason: `Price is ${buy ? 'above' : 'below'} the validated bias level at $${fmt(bias)}.`,
      };
    }
    return null;
  }

  function probBar(label, val, inverse) {
    if (val == null) return '';
    const cls = inverse ? (val >= 50 ? 'bear' : 'neut') : (val >= 60 ? 'bull' : val >= 40 ? 'neut' : 'bear');
    return `<div class="gp-prob-row">
      <span class="gp-prob-lbl">${esc(label)}</span>
      <div class="gp-prob-track"><div class="gp-prob-fill ${cls}" style="width:${val}%"></div></div>
      <span class="gp-prob-val">${val}%</span>
    </div>`;
  }

  function levelRows(levels) {
    const source = levels || {};
    const row = (l, type, label) => `<div class="gp-lvl-row ${type}">
      <span class="gp-lvl-price">${l?.price == null ? 'UNAVAILABLE' : '$' + fmt(l.price)}</span><span class="gp-lvl-label">${esc(label || l?.label || 'Level unavailable')}</span></div>`;
    const unavailable = (type, label) => row(null, `${type} unavailable`, label);
    const bias = source.bias
      ? row(source.bias, 'bias', 'Key bias level · bullish above · bearish below')
      : unavailable('bias', 'Key bias level unavailable · completed-session history required');
    const resistanceLevels = (source.resistance || []).slice(0, 2);
    const supportLevels = (source.support || []).slice(0, 2);
    const res = resistanceLevels.map((l, index) => row(
      l,
      `res${index === 1 ? ' next' : ''}`,
      index === 0 ? 'Resistance' : 'Next resistance after a break above',
    )).join('');
    const sup = supportLevels.map((l, index) => row(
      l,
      `sup${index === 1 ? ' next' : ''}`,
      index === 0 ? 'Support' : 'Next support after a break below',
    )).join('');
    return bias
      + (res || unavailable('res', 'Resistance unavailable · completed-session history required'))
      + (resistanceLevels.length > 1 || source.nextResistance
        ? ''
        : unavailable('res next', 'Next resistance if price breaks up · no additional qualified level'))
      + (sup || unavailable('sup', 'Support unavailable · completed-session history required'))
      + (supportLevels.length > 1 || source.nextSupport
        ? ''
        : unavailable('sup next', 'Next support if price breaks down · no additional qualified level'));
  }

  function gapRows(gaps) {
    const row = (position, gap) => {
      if (!gap) {
        return `<div class="gp-lvl-row gap ${position}"><span class="gp-lvl-price">NONE</span><span class="gp-lvl-label">No open gap ${position}</span></div>`;
      }
      const stats = gap.historicalFill || {};
      const fill = stats.fillRatePct == null
        ? 'fill estimate unavailable'
        : `${stats.fillRatePct}% historical ${stats.horizonSessions}-session fill rate · n=${stats.sampleSize}`;
      const location = position === 'current'
        ? `trading inside · ${fmt(gap.remainingFillPct)}% to full traversal`
        : `${fmt(gap.distancePct)}% away`;
      return `<div class="gp-lvl-row gap ${position}">
        <span class="gp-lvl-price">$${fmt(gap.zoneLow)}–$${fmt(gap.zoneHigh)}</span>
        <span class="gp-lvl-label">Gap ${position} · ${location} · ${fill}</span>
      </div>`;
    };
    return row('above', gaps?.above) + row('current', gaps?.current) + row('below', gaps?.below);
  }

  function decisionLevelsHtml(levels, gaps) {
    return `<section class="search-decision-levels-top" aria-label="Search support and resistance levels">
      <div class="gp-sec-title">Support &amp; resistance <span class="gp-sec-note">nearest and next decision points</span></div>
      <div class="gp-levels">${levelRows(levels)}</div>
      <div class="gp-sec-title">Open daily price gaps <span class="gp-sec-note">historical fill rates, not guarantees</span></div>
      <div class="gp-levels">${gapRows(gaps)}</div>
    </section>`;
  }

  function fibonacciHtml(fibonacci) {
    if (!fibonacci?.available) {
      return `<section class="gp-fibonacci unavailable">
        <div class="gp-fib-head"><div><span class="gp-sec-title">Fibonacci confluence</span><span class="gp-sec-note">No completed swing is available yet</span></div></div>
      </section>`;
    }
    const directionClass = setupClass(fibonacci.direction);
    const levels = (fibonacci.levels || []).map(level => `
      <div class="gp-fib-level ${Number(level.ratio) === Number(fibonacci.nearestLevel?.ratio) ? 'nearest' : ''}">
        <span>${fmt(level.ratio, 1)}%</span>
        <b>$${fmt(level.price)}</b>
        <small>${fmt(level.distancePct)}% away</small>
      </div>`).join('');
    const extensions = (fibonacci.extensions || []).map(level =>
      `<span><i>${fmt(level.ratio, 1)}%</i>$${fmt(level.price)}</span>`).join('');
    return `<section class="gp-fibonacci">
      <div class="gp-fib-head">
        <div>
          <span class="gp-sec-title">Fibonacci confluence</span>
          <span class="gp-sec-note">mathematical price map · never a standalone trade trigger</span>
        </div>
        <div class="gp-fib-bias ${directionClass}">${esc(fibonacci.direction)}<small>${esc(fibonacci.setup)}</small></div>
      </div>
      <div class="gp-fib-swing">
        <span><i>Swing low</i><b>$${fmt(fibonacci.swing?.low)}</b><small>${esc(fibonacci.swing?.lowDate || '')}</small></span>
        <span class="gp-fib-arrow">${fibonacci.swing?.direction === 'BULLISH' ? '↗' : '↘'}</span>
        <span><i>Swing high</i><b>$${fmt(fibonacci.swing?.high)}</b><small>${esc(fibonacci.swing?.highDate || '')}</small></span>
      </div>
      <div class="gp-fib-levels">${levels}</div>
      <div class="gp-fib-summary">
        <span><i>Nearest support</i><b>${fibonacci.nearestSupport ? '$' + fmt(fibonacci.nearestSupport.price) + ' · ' + fmt(fibonacci.nearestSupport.ratio, 1) + '%' : 'None inside swing'}</b></span>
        <span><i>Nearest resistance</i><b>${fibonacci.nearestResistance ? '$' + fmt(fibonacci.nearestResistance.price) + ' · ' + fmt(fibonacci.nearestResistance.ratio, 1) + '%' : 'None inside swing'}</b></span>
      </div>
      <div class="gp-fib-extensions"><strong>Extensions</strong>${extensions}</div>
      <p>${esc(fibonacci.methodology)}</p>
    </section>`;
  }

  function smartMoneyZoneHtml(zone, index) {
    const type = zone?.type === 'SUPPLY' ? 'supply' : 'demand';
    const timeframes = Array.isArray(zone?.timeframe) ? zone.timeframe : [zone?.timeframe].filter(Boolean);
    const factors = (zone?.factors || []).map(item => `<span>${esc(item)}</span>`).join('');
    const confidence = String(zone?.confidence || 'LOW').toLowerCase();
    return `<details class="sm-zone ${type}${index >= 3 ? ' sm-zone-extra' : ''}">
      <summary>
        <span class="sm-zone-type">${type === 'demand' ? 'BUYERS' : 'SELLERS'}</span>
        <b>$${fmt(zone?.low)}–$${fmt(zone?.high)}</b>
        <span class="sm-zone-score ${confidence}">${esc(zone?.confidence || 'LOW')} · ${zone?.score ?? 0}/100</span>
        <small>${esc(timeframes.join(' + ') || '—')} · ${esc(zone?.status || 'UNAVAILABLE')}</small>
      </summary>
      <div class="sm-zone-detail">
        <div><span>Midpoint</span><b>$${fmt(zone?.midpoint)}</b></div>
        <div><span>Origin</span><b>${esc(dateLabel(zone?.origin?.t))}</b></div>
        <div><span>Mitigation</span><b>${esc(zone?.mitigation || 'Unavailable')}</b></div>
        <div><span>Touches</span><b>${zone?.touches ?? '—'}</b></div>
        <div><span>Invalidation reference</span><b>${zone?.invalidation?.reference == null ? 'Unavailable' : '$' + fmt(zone.invalidation.reference)}</b></div>
        <div><span>Freshness</span><b>${esc(zone?.freshness || 'Unavailable')}</b></div>
      </div>
      ${factors ? `<div class="sm-factors">${factors}</div>` : ''}
      <p>${esc(zone?.invalidation?.rule || '')}</p>
    </details>`;
  }

  function smartMoneyHtml(data) {
    const timeframes = data?.availableTimeframes || ['1H', '4H', '1D', '1W', '1M'];
    const tfButtons = timeframes.map(tf =>
      `<button type="button" data-sm-timeframe="${esc(tf)}" class="${tf === data?.timeframe ? 'active' : ''}">${esc(tf)}</button>`).join('');
    if (!data?.available) {
      return `<section class="sm-map unavailable" id="smartMoneyMap">
        <div class="sm-head">
          <div><span class="gp-sec-title">Smart Money Map</span><span class="gp-sec-note">algorithmically detected potential demand and supply</span></div>
          <div class="sm-timeframes">${tfButtons}</div>
        </div>
        <div class="sm-unavailable"><strong>${esc(data?.status || 'UNAVAILABLE')}</strong><p>${esc(data?.reason || 'Completed OHLCV data is unavailable for this timeframe.')}</p></div>
        <p class="sm-disclaimer">No zone or confidence value is substituted when the required history is unavailable.</p>
      </section>`;
    }
    const demand = data.nearest?.demand;
    const supply = data.nearest?.supply;
    const zones = [...(data.demand || []), ...(data.supply || [])]
      .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity));
    const liquidityAbove = data.liquidity?.above?.[0];
    const liquidityBelow = data.liquidity?.below?.[0];
    const support = data.supportResistance?.support;
    const resistance = data.supportResistance?.resistance;
    const openFvgs = (data.fairValueGaps || []).filter(gap => gap.status !== 'FILLED');
    const latestSweep = data.liquiditySweeps?.[0];
    const confidence = Math.max(0, Math.min(100, Number(data.confidence) || 0));
    const rangePct = data.range?.positionPct == null ? null : Math.max(0, Math.min(100, Number(data.range.positionPct)));
    const biasCopy = data.bias === 'DEMAND-LED' ? 'Buyers have stronger nearby zones' : data.bias === 'SUPPLY-LED' ? 'Sellers have stronger nearby zones' : 'Neither side clearly leads';
    return `<section class="sm-map ${String(data.bias || '').toLowerCase()}" id="smartMoneyMap">
      <div class="sm-head">
        <div>
          <span class="gp-sec-title"><i class="sm-title-dot"></i>Smart Money Map</span>
          <span class="gp-sec-note">Potential buyer and seller areas · supporting context only</span>
        </div>
        <div class="sm-controls">
          <div class="sm-timeframes" aria-label="Smart Money timeframe">${tfButtons}</div>
          <button type="button" class="sm-recalculate" data-sm-recalculate title="Recalculate from completed bars">Recalculate</button>
        </div>
      </div>
      <div class="sm-beginner-guide">
        <div class="sm-guide-icon">?</div>
        <div><strong>How to read this</strong><p><b class="sm-key-buy">Green</b> marks possible buyer support. <b class="sm-key-sell">Red</b> marks possible seller resistance. Stronger color means more measured evidence—not a trade instruction.</p></div>
        <div class="sm-legend"><span><i class="sm-dot buy"></i>Demand = buyers</span><span><i class="sm-dot sell"></i>Supply = sellers</span></div>
      </div>
      <div class="sm-summary">
        <div class="sm-card-price"><span>Current price</span><b>$${fmt(data.currentPrice)}</b><small><em class="sm-status ${String(data.status).toLowerCase()}">${esc(data.status)}</em> · ${esc(data.timeframe)}</small></div>
        <div class="demand"><span>Demand <em>(buyers)</em></span><b>${demand ? '$' + fmt(demand.low) + '–$' + fmt(demand.high) : 'Unavailable'}</b><small>${demand ? demand.score + '/100 · ' + demand.status : 'No qualifying zone'}</small></div>
        <div class="supply"><span>Supply <em>(sellers)</em></span><b>${supply ? '$' + fmt(supply.low) + '–$' + fmt(supply.high) : 'Unavailable'}</b><small>${supply ? supply.score + '/100 · ' + supply.status : 'No qualifying zone'}</small></div>
        <div class="sm-card-range"><span>Where price sits</span><b>${rangePct == null ? 'Unavailable' : fmt(rangePct, 0) + '%'}</b><div class="sm-range-bar" aria-label="Price range position"><i style="width:${rangePct ?? 0}%"></i></div><small>${esc(data.range?.label || 'UNAVAILABLE')} of recent range</small></div>
        <div class="sm-card-bias"><span>Zone bias</span><b class="${data.bias === 'DEMAND-LED' ? 'bull' : data.bias === 'SUPPLY-LED' ? 'bear' : 'neut'}">${data.bias === 'DEMAND-LED' ? 'BUYER-LEANING' : data.bias === 'SUPPLY-LED' ? 'SELLER-LEANING' : 'BALANCED'}</b><small>${esc(biasCopy)}</small></div>
        <div class="sm-card-confidence"><span>Map confidence</span><b>${confidence}/100</b><div class="sm-confidence-bar" aria-label="Map confidence"><i style="width:${confidence}%"></i></div><small>${esc(data.dataQuality?.history)} history · context only</small></div>
      </div>
      <div class="sm-level-grid">
        <div><span>Major swing high</span><b>${data.structure?.swingHigh?.price == null ? 'Unavailable' : '$' + fmt(data.structure.swingHigh.price)}</b><small>${esc(data.structure?.swingHigh?.t || '')}</small></div>
        <div><span>Major swing low</span><b>${data.structure?.swingLow?.price == null ? 'Unavailable' : '$' + fmt(data.structure.swingLow.price)}</b><small>${esc(data.structure?.swingLow?.t || '')}</small></div>
        <div><span>Liquidity above</span><b>${liquidityAbove ? '$' + fmt(liquidityAbove.price) : 'Unavailable'}</b><small>${liquidityAbove ? liquidityAbove.touches + ' confirmed swing touches' : 'No equal-high cluster'}</small></div>
        <div><span>Liquidity below</span><b>${liquidityBelow ? '$' + fmt(liquidityBelow.price) : 'Unavailable'}</b><small>${liquidityBelow ? liquidityBelow.touches + ' confirmed swing touches' : 'No equal-low cluster'}</small></div>
        <div><span>Support</span><b>${support ? '$' + fmt(support.low) + (support.high !== support.low ? '–$' + fmt(support.high) : '') : 'Unavailable'}</b><small>${esc(support?.source || 'No qualifying support')}</small></div>
        <div><span>Resistance</span><b>${resistance ? '$' + fmt(resistance.low) + (resistance.high !== resistance.low ? '–$' + fmt(resistance.high) : '') : 'Unavailable'}</b><small>${esc(resistance?.source || 'No qualifying resistance')}</small></div>
        <div><span>Structure</span><b>${esc(data.structure?.state || 'UNAVAILABLE')}</b><small>Completed ${esc(data.timeframe)} bars</small></div>
        <div><span>ATR / RSI</span><b>${data.indicators?.atr == null ? 'Unavailable' : '$' + fmt(data.indicators.atr)} · ${data.indicators?.rsi14 == null ? 'RSI unavailable' : 'RSI ' + fmt(data.indicators.rsi14, 0)}</b><small>${data.dataQuality?.volumeAvailable ? 'Volume available' : 'Volume unavailable · score reduced'}</small></div>
        <div><span>Open FVGs</span><b>${openFvgs.length}</b><small>${openFvgs[0] ? esc(openFvgs[0].type) + ' $' + fmt(openFvgs[0].low) + '–$' + fmt(openFvgs[0].high) : 'No open imbalance detected'}</small></div>
        <div><span>Reclaim / sweep</span><b>${esc(data.reclaim?.direction || latestSweep?.side || 'NONE CONFIRMED')}</b><small>${esc(data.reclaim?.status || latestSweep?.status || 'No completed-bar reclaim or sweep')}</small></div>
      </div>
      <div class="sm-zones-head"><span>Primary potential zones</span><button type="button" data-sm-show-all>Show all zones</button></div>
      <div class="sm-zones">${zones.length ? zones.map(smartMoneyZoneHtml).join('') : '<div class="sm-unavailable"><strong>No primary zones qualified</strong><p>Low-confidence candidates remain hidden rather than being promoted.</p></div>'}</div>
      <p class="sm-method">${esc(data.methodology)}</p>
      <p class="sm-disclaimer">${esc(data.disclaimer)}</p>
    </section>`;
  }

  function bindSmartMoneyControls() {
    const wrap = $('gpSmartMoneyWrap');
    if (!wrap || !currentSym) return;
    const loadTimeframe = async (timeframe, force = false) => {
      const token = ++smartMoneyRequestToken;
      wrap.classList.add('loading');
      try {
        const params = new URLSearchParams({ timeframe });
        if (force) params.set('force', '1');
        const response = await fetch(`/api/smart-money/${encodeURIComponent(currentSym)}?${params}`, { credentials: 'same-origin' });
        const data = await response.json().catch(() => null);
        if (token !== smartMoneyRequestToken || !response.ok || !data?.ok) {
          if (token === smartMoneyRequestToken) throw new Error(data?.error || 'Smart Money data unavailable');
          return;
        }
        wrap.innerHTML = smartMoneyHtml(data);
        window.searchSmartMoney = data;
        if (typeof window.updateSearchSmartMoney === 'function') window.updateSearchSmartMoney(data);
        bindSmartMoneyControls();
      } catch (error) {
        if (token === smartMoneyRequestToken) {
          wrap.innerHTML = smartMoneyHtml({
            available: false, timeframe, status: 'UNAVAILABLE', reason: error.message,
            availableTimeframes: ['1H', '4H', '1D', '1W', '1M'],
          });
          bindSmartMoneyControls();
        }
      } finally {
        if (token === smartMoneyRequestToken) wrap.classList.remove('loading');
      }
    };
    wrap.querySelectorAll('[data-sm-timeframe]').forEach(button =>
      button.addEventListener('click', () => loadTimeframe(button.dataset.smTimeframe)));
    wrap.querySelector('[data-sm-recalculate]')?.addEventListener('click', () => {
      const active = wrap.querySelector('[data-sm-timeframe].active')?.dataset.smTimeframe || '1D';
      loadTimeframe(active, true);
    });
    wrap.querySelector('[data-sm-show-all]')?.addEventListener('click', event => {
      const map = $('smartMoneyMap');
      const show = !map?.classList.contains('show-all');
      map?.classList.toggle('show-all', show);
      event.currentTarget.textContent = show ? 'Show primary only' : 'Show all zones';
    });
  }

  function list(items, cls) {
    if (!Array.isArray(items) || !items.length) return '';
    return `<ul class="gp-list ${cls || ''}">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  }

  function searchSignalHtml(signal) {
    if (!signal) return '';
    const volume = signal.relativeVolume || {};
    const acceleration = signal.volumeAcceleration || {};
    const levels = signal.levels || {};
    const quality = signal.dataQuality || {};
    const display = value => value == null ? 'Unavailable' : value;
    const reasons = Array.isArray(signal.reasons) && signal.reasons.length
      ? signal.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')
      : '<li>No additional volume/price explanation available.</li>';
    const newsImpact = signal.newsImpact || {};
    const patternAnalysis = signal.patternAnalysis || {};
    const fibonacci = signal.fibonacci || {};
    const patterns = Array.isArray(patternAnalysis.patterns) ? patternAnalysis.patterns : [];
    const patternSummary = patterns.length
      ? patterns.slice(0, 3).map(pattern => `${pattern.name} (${pattern.timeframe})`).join(' · ')
      : 'No current bullish or bearish chart pattern detected';
    const newsDirection = newsImpact.appliedDirection === 'BULLISH' || newsImpact.appliedDirection === 'BEARISH'
      ? newsImpact.appliedDirection
      : 'NEUTRAL';
    const newsDetail = newsImpact.appliedDirection
      ? 'Directional headline evidence was corroborated by price and volume'
      : newsImpact.freshCatalystCount
        ? 'Recent headlines were not confirmed by matching price and volume'
        : 'No directional catalyst found in the last 24h';
    const trendBias = signal.entryQuality?.trendBias;
    const direction = signal.signal?.direction === 'BEARISH'
      ? 'BEARISH'
      : signal.signal?.direction === 'BULLISH' ? 'BULLISH'
        : trendBias === 'BULLISH' ? 'BULLISH'
          : trendBias === 'BEARISH' ? 'BEARISH' : 'NEUTRAL';
    const signalClass = direction === 'BEARISH' ? 'bear' : direction === 'BULLISH' ? 'bull' : 'neut';
    const structureText = direction === 'BULLISH'
      ? (signal.structure?.higherLows ? 'Higher lows are developing' : 'Price and volume favor buyers')
      : direction === 'BEARISH'
        ? (signal.structure?.lowerHighs ? 'Lower highs are developing' : 'Price and volume favor sellers')
        : 'Directional evidence is incomplete; no trade bias issued';
    const directionalVolume = direction === 'BULLISH'
      ? signal.bullishVolumeScore
      : direction === 'BEARISH' ? signal.bearishVolumeScore : null;
    const opposingVolume = direction === 'BULLISH'
      ? signal.bearishVolumeScore
      : direction === 'BEARISH' ? signal.bullishVolumeScore : null;
    const activeLevel = direction === 'BULLISH' ? levels.resistance : direction === 'BEARISH' ? levels.support : null;
    const levelText = activeLevel?.price == null
      ? 'No nearby decision level is available'
      : direction === 'BULLISH'
        ? `${activeLevel.broken ? 'Holding above' : 'Testing'} resistance at $${fmt(activeLevel.price)}`
        : direction === 'BEARISH'
          ? `${activeLevel.broken ? 'Trading below' : 'Testing'} support at $${fmt(activeLevel.price)}`
          : 'No directional level is active';
    const entry = signal.entryQuality || {};
    const audit = signal.confidenceBreakdown?.parts || {};
    const pct = value => value == null ? 'Unavailable' : `${value >= 0 ? '+' : ''}${fmt(value, 1)}%`;
    const auditItem = (label, value, note = '') => `<div class="gp-evidence-item"><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
    const signalAudit = `<div class="gp-evidence-reasons"><span>SIGNAL AUDIT · ${esc(signal.signal?.state || signal.signal?.label || 'NEUTRAL')}</span></div>
      <div class="gp-evidence-grid">
        ${auditItem('Trend', entry.trendBias || 'Unavailable', audit.trend == null ? 'Score unavailable' : `${fmt(audit.trend, 0)}/100`)}
        ${auditItem('Momentum', audit.momentum == null ? 'Unavailable' : `${fmt(audit.momentum, 0)}/100`, entry.rsi == null ? 'RSI unavailable' : `RSI ${fmt(entry.rsi, 1)}`)}
        ${auditItem('Volume', audit.volume == null ? 'Unavailable' : `${fmt(audit.volume, 0)}/100`, entry.exhaustionRisk ? 'Possible exhaustion volume' : 'Evaluated with entry location')}
        ${auditItem('Entry quality', entry.score == null ? 'Unavailable' : `${fmt(entry.score, 0)}/100`, entry.entryAllowed ? 'Immediate entry allowed' : 'Immediate entry not confirmed')}
        ${auditItem('Resistance distance', pct(entry.distanceToResistancePct))}
        ${auditItem('Support distance', pct(entry.distanceToSupportPct))}
        ${auditItem('20 SMA distance', pct(entry.distanceFromSma20Pct))}
        ${auditItem('50 SMA distance', pct(entry.distanceFromSma50Pct))}
        ${auditItem('200 SMA distance', pct(entry.distanceFromSma200Pct))}
        ${auditItem('Chase risk', entry.chaseRiskLabel || 'Unavailable', entry.chaseRisk == null ? '' : `${fmt(entry.chaseRisk, 0)}/100`)}
        ${auditItem('Breakout status', entry.breakoutState || 'Unavailable')}
        ${auditItem('Market context', quality.macroContextAvailable === false ? 'Unavailable' : signal.marketContext?.spy?.regime || 'Unavailable', quality.macroContextAvailable === false || audit.marketMacro == null ? 'Macro score unavailable' : `${fmt(audit.marketMacro, 0)}/100 macro component`)}
      </div>`;
    return `<section class="gp-evidence ${signalClass}">
      <div class="gp-evidence-head">
        <div>
          <span class="gp-sec-title">Evidence for ${direction}</span>
           <span class="gp-sec-note">${signal?.changeWindow === '24H' ? '24H crypto direction based on price, structure, and volume' : 'One stock direction based on price, structure, and volume'}</span>
        </div>
        <div class="gp-signal-strength">
          <span>Signal strength</span>
          <b>${signal.confidence == null || signal.signal?.stage === 'WAITING' ? '—' : `${signal.confidence}/100`}</b>
          <small>${esc(signal.signal?.stage || 'WATCH')}</small>
        </div>
      </div>
      <div class="gp-evidence-grid">
        <div class="gp-evidence-item">
          <span>Price structure</span>
          <b class="${signalClass}">${direction}</b>
          <small>${esc(structureText)}</small>
        </div>
        <div class="gp-evidence-item">
          <span>Volume evidence</span>
          <b class="${signalClass}">${display(directionalVolume)}/100 ${direction}</b>
          <small>Opposing volume ${display(opposingVolume)}/100</small>
        </div>
        <div class="gp-evidence-item">
          <span>${signal?.changeWindow === '24H' ? 'UTC RVOL' : 'Participation'}</span>
          <b>${volume.value == null ? 'Unavailable' : fmt(volume.value, 2) + '× RVOL'}</b>
          <small>${acceleration.percent == null ? 'Acceleration unavailable' : (acceleration.percent >= 0 ? '+' : '') + fmt(acceleration.percent, 1) + '% volume acceleration'}</small>
        </div>
        <div class="gp-evidence-item">
          <span>Key level</span>
          <b>${activeLevel?.price == null ? 'Unavailable' : '$' + fmt(activeLevel.price)}</b>
          <small>${esc(levelText)}</small>
        </div>
        <div class="gp-evidence-item">
          <span>News catalyst</span>
          <b class="${setupClass(newsDirection)}">${esc(newsDirection)}</b>
          <small>${esc(newsDetail)}</small>
        </div>
        <div class="gp-evidence-item">
          <span>Chart patterns</span>
          <b class="${setupClass(patternAnalysis.direction)}">${esc(patternAnalysis.direction || 'MIXED')}</b>
          <small>${esc(patternSummary)}</small>
        </div>
        <div class="gp-evidence-item">
          <span>Fibonacci confluence</span>
          <b class="${setupClass(fibonacci.direction)}">${esc(fibonacci.available ? fibonacci.direction : 'UNAVAILABLE')}</b>
          <small>${esc(fibonacci.available ? fibonacci.setup : fibonacci.reason || 'No completed swing available')}</small>
        </div>
      </div>
      ${signalAudit}
      ${quality.missing?.length ? `<div class="gp-engine-notrade">PROVISIONAL — confidence capped: ${quality.missing.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-evidence-reasons"><span>Evidence details</span><ul>${reasons}</ul></div>
    </section>`;
  }

  function volatilityValue(value, suffix = '', decimals = 2) {
    return value == null || !Number.isFinite(Number(value))
      ? 'UNAVAILABLE'
      : `${fmt(Number(value), decimals)}${suffix}`;
  }

  function volatilityMetric(label, value, suffix = '', decimals = 2, note = '') {
    const display = typeof value === 'string'
      ? (value || 'UNAVAILABLE')
      : volatilityValue(value, suffix, decimals);
    return `<div class="vol-intel-metric"><span>${esc(label)}</span><b>${esc(display)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  }

  function volatilityState(value) {
    return value == null || value === '' ? 'UNAVAILABLE' : String(value).toUpperCase();
  }

  function volatilityIntelligenceHtml(data) {
    if (!data?.enabled) return '';
    const market = data.market || {};
    const stock = data.stock || {};
    const modeled = data.modeled || {};
    const scores = data.scores || {};
    const adjustment = data.confidenceAdjustment || {};
    const quality = data.dataQuality || {};
    const vix = market.vix || {};
    const vvix = market.vvix || {};
    const term = market.termStructure || {};
    const futures = market.futuresCurve || {};
    const ivTerm = market.spxIvTermStructure || {};
    const gamma = market.gamma || {};
    const stale = String(data.status || '').toUpperCase().includes('STALE')
      || String(quality.status || '').toUpperCase().includes('STALE');
    const status = volatilityState(data.status || (data.available === false ? 'UNAVAILABLE' : 'AVAILABLE'));
    const freshness = data.generatedAt ? dateLabel(data.generatedAt) : 'UNAVAILABLE';
    const completeness = quality.completeness ?? quality.score ?? quality.coverage;
    const row = (label, value, suffix = '', decimals = 2, note = '') => volatilityMetric(label, value, suffix, decimals, note);
    const unavailableCopy = data.available === false
      ? 'UNAVAILABLE — volatility inputs were not available for this snapshot.'
      : stale
        ? 'STALE — values are shown for reference and should not be treated as current.'
        : 'Numerical volatility context only; it does not create or replace the Search verdict.';
    return `<section class="vol-intel ${stale ? 'is-stale' : ''} ${data.available === false ? 'is-unavailable' : ''}" aria-label="Volatility Intelligence">
      <div class="vol-intel-head">
        <div><span class="gp-sec-title">Volatility Intelligence</span><span class="gp-sec-note">market regime, implied risk, realized range, and confidence audit</span></div>
        <div class="vol-intel-status"><b>${esc(status)}</b><small>${esc(data.source || 'SOURCE UNAVAILABLE')}</small></div>
      </div>
      <div class="vol-intel-notice">${esc(unavailableCopy)}</div>
      <div class="vol-intel-meta"><span>Generated <b>${esc(freshness)}</b></span><span>Source <b>${esc(data.source || 'UNAVAILABLE')}</b></span><span>Source age <b>${quality.sourceAgeMs == null ? 'UNAVAILABLE' : `${Math.round(quality.sourceAgeMs / 60000)} min`}</b></span><span>Completeness <b>${completeness == null ? 'UNAVAILABLE' : volatilityValue(completeness, '%', 1)}</b></span></div>
      <div class="vol-intel-grid">
        <div class="vol-intel-block"><h4>Market volatility</h4><div class="vol-intel-metrics">
          ${row('VIX level', vix.level)}${row('VIX percentile · 252d', vix.percentile252, '%', 1)}${row('VIX 1d change', vix.change1d, '%', 2)}${row('Realized vol · 20d', vix.realizedVol20, '%', 2)}
          ${row('VVIX level', vvix.level)}${row('VVIX percentile', vvix.percentile, '%', 1)}
        </div></div>
        <div class="vol-intel-block"><h4>Curve &amp; positioning</h4><div class="vol-intel-metrics">
          ${row('Term structure', volatilityState(term.state), '', 2, `Score ${volatilityValue(term.score, '/100', 1)} · Spot to 3M ${volatilityValue(term.spotTo3mPct, '%', 2)}`)}
          ${row('Futures curve', volatilityState(futures.state), '', 2, `Score ${volatilityValue(futures.score, '/100', 1)}`)}
          ${row('SPX IV term structure', volatilityState(ivTerm.state), '', 2, `Slope ${volatilityValue(ivTerm.slope, '%', 2)}`)}
          ${row('Net gamma', gamma.netGamma, '', 2)}${row('Gamma flip', gamma.gammaFlip)}${row('Distance to flip', gamma.distanceToGammaFlipPercent, '%', 2)}
          ${row('Gamma regime', volatilityState(gamma.regime), '', 2, `Total absolute gamma ${volatilityValue(gamma.totalAbsoluteGamma)} · Assumption ${volatilityState(gamma.assumption)}`)}
        </div></div>
        <div class="vol-intel-block"><h4>Stock volatility</h4><div class="vol-intel-metrics">
          ${row('Realized vol · 20d', stock.realizedVol20, '%', 2)}${row('Realized vol · 30d', stock.realizedVol30, '%', 2)}${row('Realized vol · 60d', stock.realizedVol60, '%', 2)}
          ${row('ATR percentile', stock.atrPercentile, '%', 1)}${row('Beta', stock.beta)}${row('Correlation · SPY', stock.correlationSpy)}
          ${row('Relative vol score', stock.relativeVolatilityScore, '/100', 1)}${row('Current IV', stock.currentIv, '%', 2)}${row('IV rank', stock.ivRank, '%', 1)}${row('IV percentile', stock.ivPercentile, '%', 1)}
          ${row('Expected move', stock.expectedMove)}${row('Expected move', stock.expectedMovePercent, '%', 2)}${row('Expected range low', stock.expectedRangeLow)}${row('Expected range high', stock.expectedRangeHigh)}
        </div></div>
        <div class="vol-intel-block"><h4>Model &amp; confidence adjustment</h4><div class="vol-intel-metrics">
          ${row('Modeled volatility', modeled.volatility, '%', 2)}${row('Modeled percentile', modeled.percentile, '%', 1)}${row('Modeled trend', volatilityState(modeled.trend))}${row('Model confidence', modeled.confidence, '/100', 1)}
          ${row('Regime score', scores.regime, '/100', 1)}${row('Shock score', scores.shock, '/100', 1)}${row('Gamma score', scores.gamma, '/100', 1)}
          ${row('Technical score', adjustment.technicalScore, '/100', 1)}${row('Volatility score', adjustment.volatilityScore, '/100', 1)}${row('Gamma score', adjustment.gammaScore, '/100', 1)}
          ${row('Volatility points', adjustment.volatilityPoints, ' pts', 1)}${row('Gamma points', adjustment.gammaPoints, ' pts', 1)}${row('Final confidence', adjustment.finalConfidence, '/100', 1)}
        </div></div>
      </div>
      <div class="vol-intel-explain"><b>Gamma positioning inference</b><span>${esc(gamma.assumption || 'UNAVAILABLE — no gamma positioning assumption supplied.')}</span><small>Gamma fields describe the model’s inferred positioning; they are not observed order flow and are not a standalone trade instruction.</small></div>
    </section>`;
  }

  function tradeReferenceHtml(data) {
    const buy = data?.buy || null;
    const sell = data?.sell || null;
    const evidence = level => Array.isArray(level?.evidence) && level.evidence.length
      ? level.evidence.join(' + ')
      : level?.source || 'Calculated level';
    const considered = Array.isArray(data?.considered) ? data.considered : [];
    return `
      <section class="trade-reference" aria-label="Calculated buy and sell levels">
        <div class="trade-reference-head">
          <div>
            <span class="trade-reference-kicker">SEARCH TRADE PLAN</span>
            <strong>Calculated buy &amp; sell levels</strong>
          </div>
        </div>
        <div class="trade-reference-grid">
          <div class="trade-reference-level buy">
            <span class="trade-reference-label"><i></i>BUY AT</span>
            <strong>${buy?.price == null ? '—' : '$' + fmt(buy.price)}</strong>
            <small>${buy?.price == null ? 'Immediate support' : esc(evidence(buy))}</small>
            ${buy?.alignment ? `<em>${esc(buy.alignment)} LEVEL ALIGNMENT</em>` : ''}
          </div>
          <div class="trade-reference-level sell">
            <span class="trade-reference-label"><i></i>SELL AT</span>
            <strong>${sell?.price == null ? '—' : '$' + fmt(sell.price)}</strong>
            <small>${sell?.price == null ? 'Immediate resistance' : esc(evidence(sell))}</small>
            ${sell?.alignment ? `<em>${esc(sell.alignment)} LEVEL ALIGNMENT</em>` : ''}
          </div>
        </div>
        <div class="trade-reference-science">
          <span>CALCULATION INPUTS</span>
          <div>${considered.map(item => `<i>${esc(item)}</i>`).join('') || '<i>Completed-session support and resistance</i>'}</div>
        </div>
        <p class="trade-reference-note">${esc(data?.methodology || 'Buy At uses immediate support. Sell At uses immediate resistance. Additional evidence determines level alignment.')}</p>
      </section>`;
  }

  function proxyPrice(value) {
    return value == null || !Number.isFinite(Number(value)) ? 'Unavailable' : '$' + fmt(value);
  }

  function proxyStatusClass(value) {
    const state = String(value || '').toUpperCase();
    return state.includes('BULL') || state === 'CONFIRMED' || state === 'RISING' || state === 'HIGH'
      ? 'bull'
      : state.includes('BEAR') || state === 'DECLINING' || state === 'LOW'
        ? 'bear'
        : 'neut';
  }

  function proxyLevelRows(levels, emptyLabel) {
    if (!Array.isArray(levels) || !levels.length) {
      return `<div class="msp-empty">${esc(emptyLabel)}</div>`;
    }
    return levels.map(level => `
      <div class="msp-level-row">
        <b>${proxyPrice(level.price)}</b>
        <span>${esc(level.type || 'STRUCTURAL LEVEL')} · ${esc(level.label || 'Completed OHLCV')}</span>
        <small>${level.confirmations > 1 ? `${level.confirmations} confirmations · ` : ''}${esc(level.source || 'Completed OHLCV bars')}</small>
      </div>`).join('');
  }

  function marketStructureProxyHtml(data) {
    const proxy = data || {};
    const current = proxy.current || {};
    const indicators = proxy.indicators || {};
    const trend = proxy.trend || {};
    const activity = proxy.activity || {};
    const confirmation = activity.confirmation || {};
    const levels = proxy.levels || {};
    const conditions = proxy.conditions || {};
    const input = proxy.gamePlanInput || {};
    const concentration = proxy.volumeConcentration || {};
    const symbol = proxy.symbol || currentSym || '--';
    const available = proxy.available === true;
    const trendClass = proxyStatusClass(trend.regime);
    const inputClass = proxyStatusClass(input.bias);
    const checkHtml = (trend.checks || []).map(check =>
      `<span class="msp-check ${check.bullish ? 'bull' : 'bear'}"><i>${check.bullish ? '✓' : '↓'}</i>${esc(check.label)}</span>`).join('')
      || '<span class="msp-check neut"><i>·</i>Trend checks unavailable</span>';
    const condition = (label, item) => `<div class="msp-condition ${proxyStatusClass(item?.state)}">
      <span>${esc(label)}</span><b>${esc(item?.state || 'UNAVAILABLE')}</b>
      <small>${item?.trigger == null ? '' : `Trigger ${proxyPrice(item.trigger)} · `}${esc(item?.reason || 'Verified condition unavailable.')}</small>
    </div>`;
    const concentrationText = concentration.available
      ? `${proxyPrice(concentration.low)}–${proxyPrice(concentration.high)} · ${fmt(concentration.sharePct, 1)}% of observed volume`
      : 'Unavailable';
    if (!available) {
      return `<section class="market-structure-proxy unavailable" id="gpMarketStructureProxy" aria-label="Market structure proxy">
        <div class="msp-head"><div><span class="gp-sec-title">MARKET STRUCTURE &amp; LIQUIDITY PROXY</span><span class="gp-sec-note">${esc(symbol)} · verified OHLCV context</span></div><b>UNAVAILABLE</b></div>
        <p class="msp-notice">No verified current price and completed OHLCV history are available for this snapshot. No Level 2, wall, absorption, or executed-flow value is substituted.</p>
      </section>`;
    }
    return `<section class="market-structure-proxy ${trendClass}" id="gpMarketStructureProxy" aria-label="${esc(symbol)} market structure and liquidity proxy">
      <div class="msp-head">
        <div><span class="msp-kicker">${esc(symbol)} MARKET STRUCTURE &amp; LIQUIDITY PROXY</span><h3>Verified price, volume, and structural context</h3></div>
        <div class="msp-status"><b class="${trendClass}">${esc(trend.regime || 'MIXED')}</b><small>${esc(proxy.status || 'PARTIAL')} · ${proxy.dataQuality?.dailyBars ?? 0} daily bars</small></div>
      </div>
      <div class="msp-notice">Proxy only: this uses real quote/OHLCV observations and deterministic calculations. It does <strong>not</strong> observe Level 2, order-book walls, absorption, quote imbalance, or executed aggressor flow.</div>

      <div class="msp-grid msp-snapshot">
        <div class="msp-card"><span>Current price</span><b>${proxyPrice(current.price)}</b><small>${current.changePct == null ? 'Change unavailable' : `${current.changePct >= 0 ? '+' : ''}${fmt(current.changePct, 2)}%`} · ${esc(current.marketState || 'market state unavailable')}</small></div>
        <div class="msp-card"><span>Trend / regime</span><b class="${trendClass}">${esc(trend.regime || 'MIXED')}</b><small>${esc(trend.reason || 'Verified trend evidence unavailable.')}</small></div>
        <div class="msp-card"><span>Volume activity</span><b class="${proxyStatusClass(activity.state)}">${esc(activity.state || 'UNAVAILABLE')}</b><small>${activity.relativeVolume == null ? 'RVOL unavailable' : fmt(activity.relativeVolume, 2) + '× RVOL'} · ${esc(activity.label || '')}</small></div>
        <div class="msp-card"><span>Volume confirmation</span><b class="${proxyStatusClass(confirmation.direction)}">${esc(confirmation.state || 'UNAVAILABLE')}</b><small>${esc(confirmation.reason || 'Verified price/volume confirmation unavailable.')}</small></div>
      </div>

      <div class="msp-section-title">Verified indicator inputs <small>calculated from completed bars unless noted</small></div>
      <div class="msp-grid msp-indicators">
        <div class="msp-card"><span>20 SMA</span><b>${proxyPrice(indicators.sma20)}</b><small>${indicators.sma20 == null ? 'Insufficient history' : 'Daily close average'}</small></div>
        <div class="msp-card"><span>50 SMA</span><b>${proxyPrice(indicators.sma50)}</b><small>${indicators.sma50 == null ? 'Insufficient history' : 'Daily close average'}</small></div>
        <div class="msp-card"><span>200 SMA</span><b>${proxyPrice(indicators.sma200)}</b><small>${indicators.sma200 == null ? 'Insufficient history' : 'Daily close average'}</small></div>
        <div class="msp-card"><span>Session VWAP</span><b>${proxyPrice(indicators.vwap)}</b><small>${indicators.vwap == null ? 'Regular-session volume unavailable' : 'Observed session volume-weighted price'}</small></div>
        <div class="msp-card"><span>ATR(14)</span><b>${proxyPrice(indicators.atr)}</b><small>${indicators.atrPct == null ? 'ATR percentage unavailable' : fmt(indicators.atrPct, 2) + '% of price'}</small></div>
        <div class="msp-card"><span>Volume concentration</span><b>${esc(concentrationText)}</b><small>Approximate OHLCV volume-by-price, not a resting-liquidity map</small></div>
      </div>

      <div class="msp-section-title">Market structure</div>
      <div class="msp-structure">
        <div class="msp-structure-state"><span>Completed-bar structure</span><b class="${trendClass}">${esc(trend.structure || 'MIXED')}</b><small>${esc(trend.reason || 'Structure unavailable.')}</small><div class="msp-checks">${checkHtml}</div></div>
        <div class="msp-level-block support"><span>Structural support</span>${proxyLevelRows(levels.support, 'No verified structural support below price')}</div>
        <div class="msp-level-block resistance"><span>Structural resistance</span>${proxyLevelRows(levels.resistance, 'No verified structural resistance above price')}</div>
      </div>

      <div class="msp-section-title">Breakout / breakdown conditions <small>price crossing alone is not confirmation</small></div>
      <div class="msp-conditions">${condition('Upside breakout', conditions.breakout)}${condition('Downside breakdown', conditions.breakdown)}</div>

      <section class="msp-gameplan-input" id="gpGamePlanStructureInput" aria-label="Market structure input to game plan">
        <div class="msp-section-title"><span>MARKET STRUCTURE INPUT TO GAME PLAN</span><small>${esc(input.status || 'PROVISIONAL')} · decision support only</small></div>
        <div class="msp-input-head"><b class="${inputClass}">${esc(input.bias || 'NEUTRAL')}</b><span>${esc(input.reason || 'No verified directional input.')}</span></div>
        <div class="msp-input-grid">
          <div><span>Bullish condition</span><p>${esc(input.bullishCondition || 'Unavailable')}</p></div>
          <div><span>Bearish condition</span><p>${esc(input.bearishCondition || 'Unavailable')}</p></div>
          <div><span>Context invalidation</span><p>${esc(input.invalidation || 'Unavailable')}</p></div>
          <div><span>Next structural levels</span><p>Upside ${proxyPrice(input.nextLevels?.upside)} · downside ${proxyPrice(input.nextLevels?.downside)}</p></div>
        </div>
      </section>
      <p class="msp-method">${esc(proxy.methodology || '')}</p>
      <p class="msp-disclaimer">${esc(proxy.disclaimer || '')}</p>
    </section>`;
  }

  function moneyFlowNumber(value, suffix = '', decimals = 2) {
    return value == null || !Number.isFinite(Number(value))
      ? 'Data unavailable'
      : `${fmt(value, decimals)}${suffix}`;
  }

  function moneyFlowClass(value) {
    const state = String(value || '').toUpperCase();
    if (state.includes('INFLOW') || state === 'UP' || state === 'CONFIRMED' || state === 'AVAILABLE') return 'bull';
    if (state.includes('OUTFLOW') || state === 'DOWN' || state === 'NOT CONFIRMED') return 'bear';
    return 'neut';
  }

  function moneyFlowArrow(value) {
    const state = String(value || '').toUpperCase();
    return state === 'UP' ? '↑' : state === 'DOWN' ? '↓' : state === 'UNAVAILABLE' ? '—' : '→';
  }

  function moneyFlowSvg(data, period = '5D') {
    const series = data?.priceFlow?.periods?.[period] || data?.flowTrend?.[period];
    const points = Array.isArray(series?.points) ? series.points : [];
    const pricePoints = points
      .map((point, index) => point.priceNormalized == null ? null : [index, Number(point.priceNormalized)])
      .filter(Boolean);
    const flowPoints = points
      .map((point, index) => point.flowNormalized == null ? null : [index, Number(point.flowNormalized)])
      .filter(Boolean);
    if (!series?.available || pricePoints.length < 2 || flowPoints.length < 2) {
      return `<div class="mfm-chart-unavailable"><b>Data unavailable</b><span>${esc(series?.reason || 'A signed OHLCV participation series is not available for this period.')}</span></div>`;
    }
    const width = 360;
    const height = 112;
    const x = index => points.length <= 1 ? 0 : (index / (points.length - 1)) * width;
    const y = value => height - (Math.max(0, Math.min(100, value)) / 100) * height;
    const line = values => values.map(([index, value]) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const latest = points.at(-1);
    return `<div class="mfm-chart-wrap">
      <svg class="mfm-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Price and signed volume proxy over ${esc(period)}">
        <line x1="0" y1="${height * .25}" x2="${width}" y2="${height * .25}" />
        <line x1="0" y1="${height * .5}" x2="${width}" y2="${height * .5}" />
        <line x1="0" y1="${height * .75}" x2="${width}" y2="${height * .75}" />
        <polyline class="price" points="${line(pricePoints)}" />
        <polyline class="flow" points="${line(flowPoints)}" />
      </svg>
      <div class="mfm-chart-legend"><span class="price">Price</span><span class="flow">Signed volume proxy</span><small>Last close ${moneyFlowNumber(latest?.price, '', 2)} · flow ${latest?.flow == null ? 'Data unavailable' : fmt(latest.flow, 0)}</small></div>
    </div>`;
  }

  function moneyFlowTrendHtml(data, period = '5D') {
    return `<div class="mfm-trend" id="mfmTrendChart" data-period="${esc(period)}">
      <div class="mfm-chart-caption"><span>${esc(data?.flowTrend?.label || 'Observed participation trend')}</span><small>${esc(data?.flowTrend?.source || 'Source unavailable')}</small></div>
      ${moneyFlowSvg(data, period)}
    </div>`;
  }

  function moneyFlowPositioningHtml(data) {
    const positioning = data?.positioning || {};
    const metrics = Array.isArray(positioning.metrics) ? positioning.metrics : [];
    const positioningLabel = data?.assetType === 'CRYPTO'
      ? 'CRYPTO POSITIONING'
      : data?.instrumentType === 'ETF' ? 'ETF POSITIONING' : 'SHORT POSITIONING';
    return `<div class="mfm-panel mfm-positioning">
      <div class="mfm-panel-head"><span>${positioningLabel}</span><small>${esc(positioning.status || 'DATA UNAVAILABLE')}</small></div>
      <div class="mfm-position-grid">${metrics.map(metric => `
        <div><span>${esc(metric.label)}</span><b class="${moneyFlowClass(metric.direction)}">${metric.value == null ? 'Data unavailable' : moneyFlowNumber(metric.value, metric.unit === 'x' ? 'x' : metric.unit ? ` ${metric.unit}` : '', metric.unit === 'shares' ? 0 : 2)} ${metric.direction === 'UNAVAILABLE' ? '' : moneyFlowArrow(metric.direction)}</b></div>`).join('')}</div>
      <p class="mfm-source">${esc(positioning.note || 'Positioning data unavailable.')}</p>
      <small class="mfm-provenance">${esc(positioning.source || 'Source unavailable')}${positioning.asOf ? ` · ${esc(dateLabel(positioning.asOf))}` : ''}</small>
    </div>`;
  }

  function moneyFlowHtml(data) {
    const flow = data || {};
    const summary = flow.summary || {};
    const participation = flow.participation || {};
    const etfExposure = flow.etfExposure || {};
    const activity = Array.isArray(flow.etfActivity) ? flow.etfActivity : [];
    const score = summary.score;
    const scoreWidth = score == null ? 0 : Math.max(0, Math.min(100, Number(score)));
    const isCrypto = flow.assetType === 'CRYPTO';
    const isEtf = flow.instrumentType === 'ETF';
    const driver = flow.primaryDriver || {};
    const available = flow.available === true;
    const activityRows = activity.length
      ? activity.map(row => `<div class="mfm-etf-row">
          <span><b>${esc(row.symbol)}</b><small>${esc(row.label)}</small></span>
          <i class="${moneyFlowClass(row.changePct >= 0 ? 'UP' : 'DOWN')}">${row.changePct == null ? 'Data unavailable' : `${row.changePct >= 0 ? '+' : ''}${fmt(row.changePct, 2)}%`}</i>
          <small>${row.relativeVolume == null ? 'RVOL unavailable' : `${fmt(row.relativeVolume, 2)}x activity`}</small>
        </div>`).join('')
      : '<div class="mfm-empty">Market and sector ETF activity unavailable.</div>';
    const missing = Array.isArray(flow.dataQuality?.missing) ? flow.dataQuality.missing : [];
    const liquidation = flow.liquidation;
    return `<section class="money-flow-module ${isCrypto ? 'crypto' : isEtf ? 'etf' : 'equity'}" id="moneyFlowModule" aria-label="Money Flow">
      <div class="mfm-head">
        <div><span class="mfm-kicker">MONEY FLOW</span><h3>${esc(flow.symbol || currentSym || '--')} capital-flow context</h3></div>
        <div class="mfm-asset"><b>${esc(flow.instrumentType || flow.assetType || 'ASSET')}</b><small>${esc(flow.status || 'PARTIAL')} · ${esc(flow.source || 'SOURCE UNAVAILABLE')}</small></div>
      </div>
      <div class="mfm-notice">Verified data only. The score is an ${esc(summary.scoreLabel || 'data-limited participation proxy')}; it is not institutional flow, ETF net flow, a squeeze signal, or a trade instruction.</div>
      ${available ? `<div class="mfm-summary">
        <div class="mfm-summary-status"><span>Flow summary</span><b class="${moneyFlowClass(summary.status)}">${esc(summary.status || 'INSUFFICIENT DATA')}</b><small>${esc(summary.reason || '')}</small></div>
        <div class="mfm-gauge">
          <div class="mfm-gauge-track"><i style="width:${scoreWidth}%"></i><em style="left:${scoreWidth}%"></em></div>
          <div class="mfm-gauge-labels"><span>Outflow</span><strong>${score == null ? 'Data unavailable' : `Strength ${score}/100`}</strong><span>Inflow</span></div>
        </div>
      </div>` : '<div class="mfm-unavailable">Money Flow data unavailable for this symbol.</div>'}

      <div class="mfm-grid">
        <div class="mfm-panel mfm-etf">
          <div class="mfm-panel-head"><span>${esc(etfExposure.label || 'ETF FLOW EXPOSURE — ESTIMATED')}</span><small>${isEtf ? 'requires verified creations/redemptions feed' : 'requires net flow × verified weight'}</small></div>
          <div class="mfm-estimate-status"><b>${etfExposure.available ? 'ESTIMATED' : 'DATA UNAVAILABLE'}</b><span>${esc(etfExposure.reason || 'ETF net-flow inputs unavailable.')}</span></div>
          <div class="mfm-etf-activity-title">ETF activity context <small>price/volume only · not net flow</small></div>
          <div class="mfm-etf-rows">${activityRows}</div>
          <small class="mfm-provenance">${esc(etfExposure.source || 'ETF source unavailable')}</small>
        </div>
        <div class="mfm-panel mfm-volume">
          <div class="mfm-panel-head"><span>RELATIVE VOLUME</span><small>${esc(participation.source || 'SOURCE UNAVAILABLE')}</small></div>
          <div class="mfm-rvol-value">${participation.relativeVolume == null ? 'Data unavailable' : moneyFlowNumber(participation.relativeVolume, 'x', 2)}</div>
          <div class="mfm-rvol-track"><i style="width:${participation.relativeVolume == null ? 0 : Math.min(100, Number(participation.relativeVolume) / 3 * 100)}%"></i></div>
          <div class="mfm-rvol-labels"><span>Normal 1x</span><span>Elevated 1.5x</span><span>Strong 2x</span><span>Extreme 3x</span></div>
          <b class="mfm-confirmation ${participation.confirmation === 'CONFIRMED' ? 'bull' : participation.confirmation === 'NOT CONFIRMED' ? 'bear' : 'neut'}">${esc(participation.note || 'Data unavailable')}</b>
        </div>
      </div>

      <div class="mfm-grid">
        <div class="mfm-panel">
          <div class="mfm-panel-head"><span>FLOW TREND</span><div class="mfm-tabs">${['5D', '20D'].map(period => `<button type="button" data-moneyflow-period="${period}" class="${period === '5D' ? 'active' : ''}">${period}</button>`).join('')}</div></div>
          ${moneyFlowTrendHtml(flow, '5D')}
        </div>
        <div class="mfm-panel">
          <div class="mfm-panel-head"><span>PRICE VS MONEY FLOW</span><small>OHLCV proxy</small></div>
          ${moneyFlowSvg(flow, '5D')}
          <p class="mfm-source">${esc(flow.priceFlow?.note || 'Signed volume comparison unavailable.')}</p>
        </div>
      </div>

      ${moneyFlowPositioningHtml(flow)}
      ${isCrypto ? `<div class="mfm-panel mfm-liquidations">
        <div class="mfm-panel-head"><span>LIQUIDATIONS · CRYPTO ONLY</span><small>${esc(liquidation?.status || 'DATA UNAVAILABLE')}</small></div>
        <div class="mfm-liquidation-bars"><div><span>LONG</span><i></i><b>Data unavailable</b></div><div><span>SHORT</span><i></i><b>Data unavailable</b></div></div>
        <p class="mfm-source">${esc(liquidation?.driver || 'No verified liquidation feed is connected.')}</p>
      </div>` : ''}

      <div class="mfm-driver"><span>PRIMARY MOVE DRIVER</span><b class="${moneyFlowClass(driver.label)}">${esc(driver.label || 'INSUFFICIENT DATA')}</b><p>${esc(driver.reason || 'No supported driver classification is available.')}</p></div>
      ${missing.length ? `<div class="mfm-quality">Some data unavailable: ${missing.map(esc).join(' · ')}</div>` : ''}
      <div class="mfm-footer">${esc(flow.timestamps?.source || flow.source || 'Source unavailable')} · Generated ${esc(dateLabel(flow.generatedAt))} · ${esc(flow.disclaimer || '')}</div>
    </section>`;
  }

  function bindMoneyFlowControls() {
    const wrap = $('moneyFlowModule');
    const flow = window.searchMoneyFlow;
    if (!wrap || !flow) return;
    const chart = wrap.querySelector('#mfmTrendChart');
    wrap.querySelectorAll('[data-moneyflow-period]').forEach(button => {
      button.addEventListener('click', () => {
        wrap.querySelectorAll('[data-moneyflow-period]').forEach(item => item.classList.toggle('active', item === button));
        if (chart) {
          const period = button.dataset.moneyflowPeriod || '5D';
          chart.outerHTML = moneyFlowTrendHtml(flow, period);
        }
      });
    });
  }

  function confluenceHtml(confluence, searchSignal) {
    if (!confluence?.available) return '';
    const scores = confluence.scores || {};
    const states = confluence.states || {};
    const audit = confluence.audit || {};
    const quality = confluence.dataQuality || {};
    const cLevels = confluence.levels || {};
    const plan = confluence.tradePlan || {};
    const tf = confluence.timeframes || {};
    const displaySignal = searchSignal?.signal || confluence.signal || {};
    const fmtLevel = level => level?.price != null
      ? `$${fmt(level.price)} · ${esc(level.label || 'technical level')} (${fmt(level.distancePct, 1)}% away)`
      : 'Unavailable';
    const score = (label, value, inverse = false) => probBar(label, value, inverse);
    const statesHtml = [
      ['Trend', states.trend], ['Momentum', states.momentum], ['Volume', states.volume],
      ['Risk', states.risk], ['Relative strength', states.relativeStrength],
    ].map(([label, value]) => `<span class="gp-state"><i>${esc(label)}</i>${esc(value || 'UNAVAILABLE')}</span>`).join('');
    const timeframeHtml = Object.entries(tf).map(([key, value]) =>
      `<span class="gp-timeframe"><i>${esc(key.replace(/([A-Z])/g, ' $1'))}</i>${esc(value?.state || 'UNAVAILABLE')}</span>`
    ).join('');
    const factors = (audit.bullishFactors || []).map(f => `<li><b>+${esc(f.points)}</b> ${esc(f.reason)}</li>`).join('')
      || '<li>No independently bullish confirmations were available.</li>';
    const risks = (audit.bearishFactors || []).map(f => `<li><b>+${esc(f.points)}</b> ${esc(f.reason)}</li>`).join('')
      || '<li>No independently bearish confirmations were available.</li>';
    return `<section class="gp-confluence">
      <div class="gp-confluence-head">
        <div><span class="gp-sec-title">Technical confluence</span><span class="gp-sec-note">probability estimates, not guarantees</span></div>
        <div class="gp-confluence-signal">${esc(displaySignal.label || 'NO CLEAR EDGE')}<small>${esc(displaySignal.stage || 'WATCH')} · ${esc(displaySignal.direction || confluence.signal?.confluence || 'MIXED')}</small></div>
      </div>
      <div class="gp-confluence-scores">
        ${score('Bullish setup', scores.bullish)}
        ${score('Bearish setup', scores.bearish, true)}
        ${score('Bounce probability', scores.bounce)}
        ${score('Drawdown probability', scores.drawdown, true)}
        ${score('Setup quality', scores.setupQuality)}
      </div>
      <div class="gp-states">${statesHtml}</div>
      <div class="gp-critical-levels">
        <div><span>Critical support</span><b>${fmtLevel(cLevels.criticalSupport)}</b></div>
        <div><span>Critical resistance</span><b>${fmtLevel(cLevels.criticalResistance)}</b></div>
      </div>
      <div class="gp-timeframes"><span>Timeframe alignment</span>${timeframeHtml}</div>
      <div class="gp-setup-grid gp-deterministic-plan">
        <div><span>Entry zone</span><b>${plan.entryZone != null ? '$' + fmt(plan.entryZone) : 'Wait for a defined level'}</b></div>
        <div><span>Confirmation</span><b>${plan.confirmation != null ? '$' + fmt(plan.confirmation) : 'Volume + VWAP confirmation'}</b></div>
        <div><span>Invalidation</span><b>${plan.invalidation != null ? '$' + fmt(plan.invalidation) : 'Unavailable'}</b></div>
        <div><span>Target 1</span><b>${plan.target1 != null ? '$' + fmt(plan.target1) : 'Unavailable'}</b></div>
        <div><span>Target 2</span><b>${plan.target2 != null ? '$' + fmt(plan.target2) : 'Unavailable'}</b></div>
        <div><span>Risk / reward</span><b>${plan.riskReward != null ? plan.riskReward + 'R' : 'Unavailable'}</b></div>
      </div>
      <div class="gp-audit">
        <div><span class="gp-audit-title bull">Bullish factors</span><ul>${factors}</ul></div>
        <div><span class="gp-audit-title bear">Bearish factors</span><ul>${risks}</ul></div>
      </div>
      ${quality.entryEligible
        ? '<div class="gp-engine-ready">Complete multi-timeframe evidence available — this remains decision support, not a guarantee.</div>'
        : `<div class="gp-engine-notrade">AUTOMATED SETUP NOT ELIGIBLE — incomplete evidence: ${esc((quality.missingCriticalInputs || []).join(' · ') || 'required confirmation unavailable')}</div>`}
      ${(audit.notes || []).length ? `<div class="gp-engine-notes">${audit.notes.map(esc).join(' · ')}</div>` : ''}
      ${(audit.missingInputs || []).length ? `<div class="gp-engine-notes gp-warn-txt">Confidence reduced: missing ${audit.missingInputs.map(esc).join(' · ')}</div>` : ''}
    </section>`;
  }

  function render(d) {
    const c = $('gpContent');
    if (!c) return;

    if (!d?.ok) {
      setSafe('searchVerdictTop', el => el.style.display = 'none');
      setSafe('searchDecisionLevelsTop', el => {
        el.style.display = 'none';
        el.innerHTML = '';
      });
      setSafe('gpLoading', el => el.style.display = 'none');
      setSafe('gpError', el => {
        el.style.display = '';
        el.textContent = d?.unavailable ? 'REAL-TIME DATA UNAVAILABLE' : (d?.error || 'Game plan unavailable.');
      });
      c.style.display = 'none';
      setSafe('gpSetupBadge', el => el.style.display = 'none');
      return;
    }

    const {
      snapshot: s, indicators: ind, confidence, dataGaps, searchSignal,
      levels, displayLevels, gapAnalysis, analogs, probabilities, tradeLevels,
    } = d;
    const generatedAt = d.generatedAt;
    const snapshotPrice = Number(s?.price);
    const watchedLevels = [
      displayLevels?.bias,
      ...(displayLevels?.support || []),
      ...(displayLevels?.resistance || []),
      levels?.breakdown,
      d.confluence?.levels?.criticalSupport,
      d.confluence?.levels?.criticalResistance,
    ].map(level => Number(level?.price ?? level)).filter(price => Number.isFinite(price) && price > 0);
    planWatch = {
      symbol: currentSym,
      snapshotPrice,
      levels: [...new Set(watchedLevels)],
      refreshTriggered: false,
    };

    // Header badge — the deterministic engine's regime-adjusted signal is
    // authoritative. The zone heuristic is context only and never overrides it.
    const zone = zoneVerdict(snapshotPrice, displayLevels || levels);
    const verdict = searchSignal?.signal?.state
      || searchSignal?.signal?.label
      || 'UNAVAILABLE';
    const direction = searchSignal?.signal?.direction
      || searchSignal?.entryQuality?.trendBias
      || (verdict.includes('SELL') ? 'BEARISH' : verdict.includes('BUY') ? 'BULLISH' : 'NEUTRAL');
    const setup = verdict === 'UNAVAILABLE' ? verdict : `${verdict} · ${direction}`;
    const verdictClass = setupClass(setup);
    const verdictStage = searchSignal?.signal?.stage || (verdict === 'WAIT' ? 'WAITING' : 'PROVISIONAL');
    const verdictConfidence = Number(searchSignal?.confidence);
    const zoneNote = zone ? ` Zone context: ${zone.direction} — ${zone.reason}` : '';
    const signalReasons = Array.isArray(searchSignal?.reasons)
      ? searchSignal.reasons.filter(Boolean).slice(0, 2)
      : [];
    setSafe('searchVerdictTop', el => {
      el.style.display = '';
      el.className = `search-verdict-top ${verdictClass} ${verdictStage === 'CONFIRMED' ? 'confirmed' : 'provisional'}`;
    });
    setSafe('searchVerdictIcon', el => el.textContent = verdict === 'SELL' ? '↘' : verdict === 'BUY' ? '↗' : '•');
    setSafe('searchVerdictLabel', el => el.textContent = verdict);
    setSafe('searchVerdictStage', el => el.textContent = verdictStage);
    setSafe('searchVerdictSymbol', el => el.textContent = d.symbol || '--');
    setSafe('searchVerdictDirection', el => el.textContent = direction);
    setSafe('searchVerdictConfidence', el => el.textContent = `${Number.isFinite(verdictConfidence) ? verdictConfidence : '--'}%`);
    setSafe('searchVerdictMeter', el => {
      el.style.width = `${Number.isFinite(verdictConfidence) ? Math.max(0, Math.min(100, verdictConfidence)) : 0}%`;
    });
    setSafe('searchVerdictReason', el => {
      el.textContent = (signalReasons.length
        ? signalReasons.join(' · ')
        : 'Using all available verified Search evidence; missing inputs remain provisional.') + zoneNote;
    });
    setSafe('searchDecisionLevelsTop', el => {
      el.innerHTML = decisionLevelsHtml(displayLevels || levels, gapAnalysis);
      el.style.display = '';
    });
    setSafe('gpSetupBadge', el => {
      el.style.display = '';
      el.textContent = setup || '--';
      el.className = 'gp-setup-badge ' + setupClass(setup);
    });
    const ageMs = d.generatedAt ? Date.now() - Date.parse(d.generatedAt) : null;
    setSafe('gpUpdated', el => {
      const at = d.generatedAt ? new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      el.textContent = ageMs != null && ageMs > 90_000 ? `${at} · DATA STALE — CONFIDENCE REDUCED` : at;
    });

    const chgCls = (s.changePct ?? 0) >= 0 ? 'up' : 'down';
    const dayRangePct = Number(s.high) > Number(s.low)
      ? Math.max(0, Math.min(100, ((Number(s.price) - Number(s.low)) / (Number(s.high) - Number(s.low))) * 100))
      : null;
    const confParts = confidence?.parts || {};
    const confNotes = confidence?.partNotes || {};
    const confHtml = `<div class="gp-conf">
        <div class="gp-conf-overall">DATA COVERAGE <b>${confidence?.overall ?? '--'}/100</b></div>
        <div class="gp-conf-parts">${Object.entries(confParts).map(([k, v]) =>
          `<span class="gp-conf-part"${confNotes[k] ? ` title="${esc(confNotes[k])}"` : ''}><i>${esc(k)}</i>${v}${confNotes[k] ? `<em>${esc(confNotes[k])}</em>` : ''}</span>`).join('')}</div>
      </div>`;
    const analogHtml = analogs ? `<div class="gp-analog">
        <div class="gp-analog-title">Time-matched historical outcomes ${analogs.lowConfidence ? '· LOW CONFIDENCE' : ''}</div>
        <div class="gp-analog-stat">${esc(probabilities?.basis || '')}</div>
        <div class="gp-analog-stat">Closed +3% from that-time price: <b>${fmt(analogs.bounced3Pct, 0)}%</b> · Closed +5%: <b>${fmt(analogs.bounced5Pct, 0)}%</b> · Next session green: <b>${fmt(analogs.closedGreenNextPct, 0)}%</b></div>
        <div class="gp-analog-stat">Median max rebound through next session: <b>${fmt(analogs.medMaxReboundPct, 1)}%</b> · Worst further same-day downside: <b>${fmt(analogs.maxFurtherDownsidePct, 1)}%</b></div>
      </div>` : `<div class="gp-analog">
        <div class="gp-analog-title">Time-matched historical outcomes unavailable</div>
        <div class="gp-analog-stat">${esc(probabilities?.basis || '')}</div>
      </div>`;

    c.innerHTML = `
      <!-- Verdict strip -->
      <div class="gp-verdict-strip">
        <div class="gp-vcell"><span>Price</span><b>$${fmt(s.price)}</b></div>
         <div class="gp-vcell"><span>${s.changeWindow === '24H' ? '24H' : 'Day'}</span><b class="${chgCls}">${s.changePct != null ? (s.changePct >= 0 ? '+' : '') + fmt(s.changePct, 1) + '%' : '--'}</b></div>
        <div class="gp-vcell"><span>RSI 14</span><b>${fmt(ind.rsi14, 0)}</b></div>
        <div class="gp-vcell"><span>${s.changeWindow === '24H' ? 'UTC RVOL' : 'Rel Vol'}</span><b>${s.relVol != null ? fmt(s.relVol, 1) + 'x' : '--'}</b></div>
        <div class="gp-vcell"><span>${s.changeWindow === '24H' ? '24H VWAP' : 'vs VWAP'}</span><b>${ind.distVwapPct != null ? (ind.distVwapPct >= 0 ? '+' : '') + fmt(ind.distVwapPct, 1) + '%' : '--'}</b></div>
        <div class="gp-vcell"><span>${s.changeWindow === '24H' ? '24H range' : 'Day range'}</span><b>${dayRangePct == null ? '--' : fmt(dayRangePct, 0) + '%'}</b><small>${s.low != null && s.high != null ? '$' + fmt(s.low) + '–$' + fmt(s.high) : 'Unavailable'}</small></div>
      </div>

       ${tradeReferenceHtml(tradeLevels)}
       ${searchSignalHtml(searchSignal)}
       ${volatilityIntelligenceHtml(d.volatility)}

       ${marketStructureProxyHtml(d.marketStructureProxy)}
       ${moneyFlowHtml(d.moneyFlow)}

       <div id="gpSmartMoneyWrap">${smartMoneyHtml(d.smartMoney)}</div>

      ${fibonacciHtml(d.fibonacci)}

      ${confHtml}
      ${analogHtml}
      ${dataGaps?.length ? `<div class="gp-gaps">Missing data: ${dataGaps.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-disclaimer">Sources: ${esc(d.provenance?.quote?.provider || 'market feed')} quote as of ${esc(d.provenance?.quote?.asOf || generatedAt || '--')} · Yahoo chart bars · ${esc((d.provenance?.news || []).join(' + ') || 'no verified news')} · Not financial advice</div>`;

    setSafe('gpLoading', el => el.style.display = 'none');
    setSafe('gpError', el => el.style.display = 'none');
    c.style.display = '';
    window.searchSmartMoney = d.smartMoney || null;
    if (typeof window.updateSearchSmartMoney === 'function') window.updateSearchSmartMoney(d.smartMoney || null);
    window.searchMoneyFlow = d.moneyFlow || null;
    bindMoneyFlowControls();
    bindSmartMoneyControls();
  }

  async function refresh(force, suppliedAnalysis = null) {
    const sym = currentSym;
    if (!sym) return;
    const tok = ++reqToken;
    try {
      const payload = suppliedAnalysis || window.searchContext.load(sym, { force });
      if (tok !== reqToken || sym !== currentSym) return;  // superseded by a newer request/symbol
      const resolved = await payload;
      if (tok !== reqToken || sym !== currentSym) return;
      render(resolved);
    } catch {
      if (tok === reqToken && sym === currentSym) {
        render({ ok: false, error: 'Game plan request failed — will retry on next refresh.' });
      }
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, REFRESH_MS);
  }

  function load(sym, suppliedAnalysis = null) {
    sym = String(sym || '').toUpperCase();
    if (!sym) return;
    if (sym !== currentSym) planWatch = null;
    currentSym = sym;
    setSafe('gpPanel', el => el.style.display = '');
    setSafe('gpLoadSym', el => el.textContent = sym);
    setSafe('gpLoading', el => el.style.display = 'flex');
    setSafe('gpError', el => el.style.display = 'none');
    setSafe('gpContent', el => el.style.display = 'none');
    setSafe('searchDecisionLevelsTop', el => {
      el.style.display = 'none';
      el.innerHTML = '';
    });
    setSafe('gpSetupBadge', el => el.style.display = 'none');
    refresh(false, suppliedAnalysis);
    schedule();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('gpRefreshBtn');
    if (btn) btn.addEventListener('click', () => {
      setSafe('gpLoading', el => el.style.display = 'flex');
      setSafe('gpContent', el => el.style.display = 'none');
      setSafe('searchDecisionLevelsTop', el => {
        el.style.display = 'none';
        el.innerHTML = '';
      });
      const sharedRefresh = currentSym
        ? window.searchContext.load(currentSym, { force: true })
        : null;
      refresh(true, sharedRefresh);
      if (currentSym && typeof rtTrader !== 'undefined') {
        rtTrader.load(currentSym, sharedRefresh);
      }
    });
  });

  function onQuote(sym, latestPrice) {
    const symbol = String(sym || '').toUpperCase().trim();
    const price = Number(latestPrice);
    const watch = planWatch;
    if (!watch || watch.refreshTriggered || symbol !== currentSym || symbol !== watch.symbol
        || !Number.isFinite(price) || !(price > 0)
        || !Number.isFinite(watch.snapshotPrice) || !(watch.snapshotPrice > 0)) return;

    const movePct = Math.abs(price - watch.snapshotPrice) / watch.snapshotPrice * 100;
    const crossedLevel = watch.levels.some(level =>
      (watch.snapshotPrice < level && price >= level)
      || (watch.snapshotPrice > level && price <= level)
    );
    if (movePct < SIGNIFICANT_MOVE_PCT && !crossedLevel) return;

    // One early regeneration per rendered plan. The server independently
    // enforces its per-user/symbol force cooldown.
    watch.refreshTriggered = true;
    refresh(true);
  }

  return { load, onQuote };
})();
