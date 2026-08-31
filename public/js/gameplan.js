/* ── AI Trade Game Plan panel ────────────────────────────────────────────────
   Probability-based intraday game plan for the currently-open symbol.
   All numbers come from the server (deterministic math on real data);
   the AI narrative is rendered only when the server marks it available. */
const gamePlan = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => n == null || !isFinite(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  const REFRESH_MS = 3 * 60 * 1000;   // matches server cache window
  let currentSym = null;
  let timer = null;
  let reqToken = 0;   // monotonic token — stale responses are discarded

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
    if (!levels) return '';
    const row = (l, type) => `<div class="gp-lvl-row ${type}">
      <span class="gp-lvl-price">$${fmt(l.price)}</span><span class="gp-lvl-label">${esc(l.label)}</span></div>`;
    const res = [...(levels.resistance || [])].reverse().map(l => row(l, 'res')).join('');
    const sup = (levels.support || []).map(l => row(l, 'sup')).join('');
    const cur = `<div class="gp-lvl-row cur"><span class="gp-lvl-price">$${fmt(levels.currentPrice)}</span><span class="gp-lvl-label">CURRENT PRICE</span></div>`;
    const brk = levels.breakdown != null ? `<div class="gp-lvl-row brk"><span class="gp-lvl-price">$${fmt(levels.breakdown)}</span><span class="gp-lvl-label">Breakdown level</span></div>` : '';
    return res + cur + sup + brk;
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
    const score = (label, value, inverse = false) => probBar(label, value, inverse);
    const display = value => value == null ? 'Unavailable' : value;
    const reasons = Array.isArray(signal.reasons) && signal.reasons.length
      ? signal.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')
      : '<li>No additional volume/price explanation available.</li>';
    const resistance = levels.resistance;
    const signalClass = setupClass(signal.signal?.label);
    return `<section class="gp-volume-signal">
      <div class="gp-confluence-head">
        <div><span class="gp-sec-title">Live volume &amp; price signal</span><span class="gp-sec-note">search-page analysis only · participation is not direction</span></div>
        <div class="gp-confluence-signal ${signalClass}">${esc(signal.signal?.label || 'UNAVAILABLE')}<small>${esc(signal.signal?.stage || 'WATCH')} · confidence ${display(signal.confidence)}/100</small></div>
      </div>
      <div class="gp-confluence-scores">
        ${score('Pump pressure', signal.pumpPressure)}
        ${score('Breakout probability', signal.breakoutProbability)}
        ${score('Bullish volume', signal.bullishVolumeScore)}
        ${score('Bearish volume', signal.bearishVolumeScore, true)}
      </div>
      <div class="gp-volume-metrics">
        <div><span>Time-of-day RVOL</span><b>${volume.value == null ? 'Unavailable' : fmt(volume.value, 2) + '×'}</b><small>${volume.sampleSize || 0} historical sessions</small></div>
        <div><span>Volume acceleration</span><b>${acceleration.percent == null ? 'Unavailable' : (acceleration.percent >= 0 ? '+' : '') + fmt(acceleration.percent, 1) + '%'}</b><small>${acceleration.ratio == null ? 'Short-term rate unavailable' : '1m / 5m / 15m average'}</small></div>
        <div><span>Resistance</span><b>${resistance?.price == null ? 'Unavailable' : '$' + fmt(resistance.price)}</b><small>${resistance?.distancePct == null ? 'No active level' : (resistance.distancePct >= 0 ? fmt(resistance.distancePct, 2) + '% away' : fmt(Math.abs(resistance.distancePct), 2) + '% above')}</small></div>
        <div><span>Volume direction</span><b>${esc(signal.structure?.volumeDirection || 'UNAVAILABLE')}</b><small>${signal.structure?.higherLows ? 'Higher lows' : signal.structure?.lowerHighs ? 'Lower highs' : 'Structure mixed'}</small></div>
      </div>
      ${quality.missing?.length ? `<div class="gp-engine-notrade">NO TRADE — ${quality.missing.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-volume-reasons"><span class="gp-audit-title bull">Why this signal</span><ul>${reasons}</ul></div>
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
        : `<div class="gp-engine-notrade">NO TRADE — incomplete evidence: ${esc((quality.missingCriticalInputs || []).join(' · ') || 'required confirmation unavailable')}</div>`}
      ${(audit.notes || []).length ? `<div class="gp-engine-notes">${audit.notes.map(esc).join(' · ')}</div>` : ''}
      ${(audit.missingInputs || []).length ? `<div class="gp-engine-notes gp-warn-txt">Confidence reduced: missing ${audit.missingInputs.map(esc).join(' · ')}</div>` : ''}
    </section>`;
  }

  function render(d) {
    const c = $('gpContent');
    if (!c) return;

    if (!d?.ok) {
      setSafe('gpLoading', el => el.style.display = 'none');
      setSafe('gpError', el => {
        el.style.display = '';
        el.textContent = d?.unavailable ? 'REAL-TIME DATA UNAVAILABLE' : (d?.error || 'Game plan unavailable.');
      });
      c.style.display = 'none';
      setSafe('gpSetupBadge', el => el.style.display = 'none');
      return;
    }

    const { snapshot: s, indicators: ind, selloff, oversold, analogs, market, probabilities: p, confidence, ai, dataGaps, news, confluence, searchSignal } = d;

    // Header badge
    const setup = searchSignal?.signal?.label || (ai?.available ? ai.setup : oversold?.label);
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
    const analogHtml = analogs
      ? `<div class="gp-analog">
           <span class="gp-analog-title">Past sessions closing down ${analogs.threshold}%+ (end-of-day stats)</span>
           <span class="gp-analog-stat">Sample: <b>${analogs.sampleSize}</b>${analogs.lowConfidence ? ' · <b class="gp-warn-txt">LIMITED — LOW CONFIDENCE</b>' : ''}</span>
           <span class="gp-analog-stat">Bounced 3%+ same day: <b>${analogs.bounced3Pct}%</b> · 5%+: <b>${analogs.bounced5Pct}%</b></span>
           <span class="gp-analog-stat">Avg max rebound: <b>${fmt(analogs.avgMaxReboundPct, 1)}%</b> · Next day green: <b>${analogs.closedGreenNextPct}%</b> · Avg next-day: <b>${fmt(analogs.avgNextDayPct, 1)}%</b></span>
         </div>`
      : '';

    const knife = ai?.fallingKnifeWarning || ((selloff?.chg1d ?? 0) <= -5
      ? 'Do not assume this stock has bottomed simply because it is down sharply. Wait for evidence of stabilization (higher low, VWAP reclaim, buying volume).'
      : null);

    const scen = ai?.available && ai.scenarios ? `
      <div class="gp-scen-grid">
        <div class="gp-scen bull">${dot('bull')}<b>Bullish reversal</b><p>${esc(ai.scenarios.bullish?.plan)}</p>
          ${ai.scenarios.bullish?.trigger ? `<span class="gp-scen-sub">Trigger: ${esc(ai.scenarios.bullish.trigger)}</span>` : ''}
          ${ai.scenarios.bullish?.invalidation ? `<span class="gp-scen-sub">Invalid: ${esc(ai.scenarios.bullish.invalidation)}</span>` : ''}</div>
        <div class="gp-scen neut">${dot('neut')}<b>Range / chop</b><p>${esc(ai.scenarios.range?.plan)}</p></div>
        <div class="gp-scen bear">${dot('bear')}<b>Bearish continuation</b><p>${esc(ai.scenarios.bearish?.plan)}</p>
          ${ai.scenarios.bearish?.trigger ? `<span class="gp-scen-sub">Trigger: ${esc(ai.scenarios.bearish.trigger)}</span>` : ''}
          ${ai.scenarios.bearish?.invalidation ? `<span class="gp-scen-sub">Invalid: ${esc(ai.scenarios.bearish.invalidation)}</span>` : ''}</div>
      </div>` : '';

    const ts = ai?.available ? (ai.noTrade || !ai.tradeSetup
      ? `<div class="gp-notrade">NO TRADE — WAIT FOR CONFIRMATION.</div>`
      : `<div class="gp-setup-grid">
           <div><span>Entry zone</span><b>${esc(ai.tradeSetup.entryZone)}</b></div>
           <div><span>Confirmation</span><b>${esc(ai.tradeSetup.confirmationEntry)}</b></div>
           <div><span>Stop / invalidation</span><b>${esc(ai.tradeSetup.stop)}</b></div>
           <div><span>Target 1</span><b>${esc(ai.tradeSetup.target1)}</b></div>
           <div><span>Target 2</span><b>${esc(ai.tradeSetup.target2)}</b></div>
           <div><span>Target 3</span><b>${esc(ai.tradeSetup.target3)}</b></div>
           <div><span>Risk / reward</span><b>${esc(ai.tradeSetup.riskReward)}</b></div>
         </div>`) : '';

    const confParts = confidence?.parts || {};
    const confHtml = `<div class="gp-conf">
        <div class="gp-conf-overall">SETUP CONFIDENCE <b>${confidence?.overall ?? '--'}/100</b></div>
        <div class="gp-conf-parts">${Object.entries(confParts).map(([k, v]) =>
          `<span class="gp-conf-part"><i>${esc(k)}</i>${v}</span>`).join('')}</div>
      </div>`;

    c.innerHTML = `
      <!-- Verdict strip -->
      <div class="gp-verdict-strip">
        <div class="gp-vcell"><span>Price</span><b>$${fmt(s.price)}</b></div>
        <div class="gp-vcell"><span>Day</span><b class="${chgCls}">${s.changePct != null ? (s.changePct >= 0 ? '+' : '') + fmt(s.changePct, 1) + '%' : '--'}</b></div>
        <div class="gp-vcell"><span>RSI 14</span><b>${fmt(ind.rsi14, 0)}</b></div>
        <div class="gp-vcell"><span>Rel Vol</span><b>${s.relVol != null ? fmt(s.relVol, 1) + 'x' : '--'}</b></div>
        <div class="gp-vcell"><span>vs VWAP</span><b>${ind.distVwapPct != null ? (ind.distVwapPct >= 0 ? '+' : '') + fmt(ind.distVwapPct, 1) + '%' : '--'}</b></div>
        <div class="gp-vcell"><span>Market</span><b>${trendDot(market?.trend)}${esc(market?.trend || '--')}</b></div>
        <div class="gp-vcell"><span>Sector</span><b>${trendDot(market?.sectorTrend)}${market?.sectorEtf ? esc(market.sectorEtf) + ' ' : ''}${esc(market?.sectorTrend || 'N/A')}</b></div>
        <div class="gp-vcell"><span>Condition</span><b class="${setupClass(oversold?.label)}">${esc(oversold?.label || '--')}</b></div>
      </div>

      ${ai?.available ? `<div class="gp-ai-verdict">${esc(ai.verdict)}</div>`
        : `<div class="gp-ai-missing">AI narrative unavailable — ${esc(ai?.reason || 'not configured')}. Quantitative analysis below is live.</div>`}

      <div class="gp-cols">
        <div class="gp-col">
          <div class="gp-sec-title">Probabilities <span class="gp-sec-note">estimates, not guarantees</span></div>
          ${probBar('Relief bounce', p.reliefBounce)}
          ${probBar('Close green', p.closeGreen)}
          ${probBar('3%+ rebound off low', p.rebound3)}
          ${probBar('5%+ rebound off low', p.rebound5)}
          ${probBar('Another downside leg', p.downsideLeg, true)}
          <div class="gp-prob-basis">${esc(p.basis)}</div>
          ${analogHtml}
        </div>
        <div class="gp-col">
          <div class="gp-sec-title">Key levels</div>
          <div class="gp-levels">${levelRows(levels)}</div>
          ${selloff?.classification?.length ? `<div class="gp-tags">${selloff.classification.map(t => `<span class="gp-tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="gp-attrib">Move attribution: <b>${esc(market?.attribution || 'UNKNOWN')}</b>
            ${market?.spy != null ? ` · SPY ${market.spy >= 0 ? '+' : ''}${fmt(market.spy, 1)}%` : ''}
            ${market?.sectorChangePct != null ? ` · ${esc(market.sectorEtf)} ${market.sectorChangePct >= 0 ? '+' : ''}${fmt(market.sectorChangePct, 1)}%` : ''}</div>
          ${news?.length ? `<div class="gp-news">${news.slice(0, 3).map(n => `<div class="gp-news-row"><span>${esc(n.headline)}</span><i>${esc(n.source || '')}</i></div>`).join('')}</div>`
            : '<div class="gp-news-none">No major catalyst identified from available data.</div>'}
        </div>
      </div>

       ${searchSignalHtml(searchSignal)}
       ${confluenceHtml(confluence, searchSignal)}
      ${ai?.available && ai.why?.length ? `<div class="gp-sec-title">Why</div>${list(ai.why)}` : ''}
      ${scen}
      ${knife ? `<div class="gp-knife">⚠ ${esc(knife)}</div>` : ''}
      ${ai?.available ? `<div class="gp-sec-title">Trade setup</div>${ts}` : ''}
      <div class="gp-cols">
        ${ai?.available && ai.changeMind?.length ? `<div class="gp-col"><div class="gp-sec-title">What would change my mind?</div>${list(ai.changeMind)}</div>` : ''}
        ${ai?.available && ai.whyFail?.length ? `<div class="gp-col"><div class="gp-sec-title">Why this setup may fail</div>${list(ai.whyFail, 'gp-fail')}</div>` : ''}
      </div>
      ${confHtml}
      ${dataGaps?.length ? `<div class="gp-gaps">Missing data: ${dataGaps.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-disclaimer">Decision-support analysis from live market data · Probabilities are estimates · Not financial advice</div>`;

    setSafe('gpLoading', el => el.style.display = 'none');
    setSafe('gpError', el => el.style.display = 'none');
    c.style.display = '';
  }

  async function refresh(force) {
    const sym = currentSym;
    if (!sym) return;
    const tok = ++reqToken;
    try {
      const r = await fetch(`/api/gameplan/${sym}${force ? '?force=1' : ''}`, { credentials: 'same-origin' });
      if (tok !== reqToken || sym !== currentSym) return;  // superseded by a newer request/symbol
      if (r.status === 401) {
        render({ ok: false, error: 'Sign in to generate the AI game plan.' });
        return;
      }
      render(await r.json());
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

  function load(sym) {
    sym = String(sym || '').toUpperCase();
    if (!sym) return;
    currentSym = sym;
    setSafe('gpPanel', el => el.style.display = '');
    setSafe('gpLoadSym', el => el.textContent = sym);
    setSafe('gpLoading', el => el.style.display = 'flex');
    setSafe('gpError', el => el.style.display = 'none');
    setSafe('gpContent', el => el.style.display = 'none');
    setSafe('gpSetupBadge', el => el.style.display = 'none');
    refresh(false);
    schedule();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('gpRefreshBtn');
    if (btn) btn.addEventListener('click', () => {
      setSafe('gpLoading', el => el.style.display = 'flex');
      setSafe('gpContent', el => el.style.display = 'none');
      refresh(true);
    });
  });

  return { load };
})();
