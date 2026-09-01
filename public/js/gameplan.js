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
    const direction = signal.signal?.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH';
    const signalClass = direction === 'BEARISH' ? 'bear' : 'bull';
    const structureText = direction === 'BULLISH'
      ? (signal.structure?.higherLows ? 'Higher lows are developing' : 'Price and volume favor buyers')
      : (signal.structure?.lowerHighs ? 'Lower highs are developing' : 'Price and volume favor sellers');
    const directionalVolume = direction === 'BULLISH'
      ? signal.bullishVolumeScore
      : signal.bearishVolumeScore;
    const opposingVolume = direction === 'BULLISH'
      ? signal.bearishVolumeScore
      : signal.bullishVolumeScore;
    const activeLevel = direction === 'BULLISH' ? levels.resistance : levels.support;
    const levelText = activeLevel?.price == null
      ? 'No nearby decision level is available'
      : direction === 'BULLISH'
        ? `${activeLevel.broken ? 'Holding above' : 'Testing'} resistance at $${fmt(activeLevel.price)}`
        : `${activeLevel.broken ? 'Trading below' : 'Testing'} support at $${fmt(activeLevel.price)}`;
    return `<section class="gp-evidence ${signalClass}">
      <div class="gp-evidence-head">
        <div>
          <span class="gp-sec-title">Evidence for ${direction}</span>
          <span class="gp-sec-note">One stock direction based on price, structure, and volume</span>
        </div>
        <div class="gp-signal-strength">
          <span>Signal strength</span>
          <b>${display(signal.confidence)}/100</b>
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
          <span>Participation</span>
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
      ${quality.missing?.length ? `<div class="gp-engine-notrade">PROVISIONAL — confidence capped: ${quality.missing.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-evidence-reasons"><span>Evidence details</span><ul>${reasons}</ul></div>
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

    // Header badge
    const verdict = searchSignal?.signal?.label || 'UNAVAILABLE';
    const direction = searchSignal?.signal?.direction
      || (verdict.includes('SELL') ? 'BEARISH' : verdict.includes('BUY') ? 'BULLISH' : 'NEUTRAL');
    const setup = verdict === 'UNAVAILABLE' ? verdict : `${verdict} · ${direction}`;
    const verdictClass = setupClass(setup);
    const verdictStage = searchSignal?.signal?.stage || 'PROVISIONAL';
    const verdictConfidence = Number(searchSignal?.confidence);
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
    setSafe('searchVerdictConfidence', el => el.textContent = `${searchSignal?.confidence ?? '--'}%`);
    setSafe('searchVerdictMeter', el => {
      el.style.width = `${Number.isFinite(verdictConfidence) ? Math.max(0, Math.min(100, verdictConfidence)) : 0}%`;
    });
    setSafe('searchVerdictReason', el => {
      el.textContent = signalReasons.length
        ? signalReasons.join(' · ')
        : 'Using all available verified Search evidence; missing inputs remain provisional.';
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
    const confHtml = `<div class="gp-conf">
        <div class="gp-conf-overall">DATA COVERAGE <b>${confidence?.overall ?? '--'}/100</b></div>
        <div class="gp-conf-parts">${Object.entries(confParts).map(([k, v]) =>
          `<span class="gp-conf-part"><i>${esc(k)}</i>${v}</span>`).join('')}</div>
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
        <div class="gp-vcell"><span>Day</span><b class="${chgCls}">${s.changePct != null ? (s.changePct >= 0 ? '+' : '') + fmt(s.changePct, 1) + '%' : '--'}</b></div>
        <div class="gp-vcell"><span>RSI 14</span><b>${fmt(ind.rsi14, 0)}</b></div>
        <div class="gp-vcell"><span>Rel Vol</span><b>${s.relVol != null ? fmt(s.relVol, 1) + 'x' : '--'}</b></div>
        <div class="gp-vcell"><span>vs VWAP</span><b>${ind.distVwapPct != null ? (ind.distVwapPct >= 0 ? '+' : '') + fmt(ind.distVwapPct, 1) + '%' : '--'}</b></div>
        <div class="gp-vcell"><span>Day range</span><b>${dayRangePct == null ? '--' : fmt(dayRangePct, 0) + '%'}</b><small>${s.low != null && s.high != null ? '$' + fmt(s.low) + '–$' + fmt(s.high) : 'Unavailable'}</small></div>
      </div>

       ${tradeReferenceHtml(tradeLevels)}
       ${searchSignalHtml(searchSignal)}

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
    bindSmartMoneyControls();
  }

  async function refresh(force, suppliedAnalysis = null) {
    const sym = currentSym;
    if (!sym) return;
    const tok = ++reqToken;
    try {
      const payload = suppliedAnalysis || window.searchContext.load(sym, { force });
      if (tok !== reqToken || sym !== currentSym) return;  // superseded by a newer request/symbol
      render(await payload);
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
        || !(price > 0) || !(watch.snapshotPrice > 0)) return;

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
