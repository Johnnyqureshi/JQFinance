/* ── Stock Intelligence ──────────────────────────────────────────────────────
   One server-owned stock verdict with concise supporting evidence.
   Broad-market context never appears as a competing stock direction. */
const gamePlan = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => n == null || !isFinite(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  const REFRESH_MS = 60 * 1000;
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
    const bias = levels.bias ? row({ ...levels.bias, label: 'Key bias level · break/hold above = bullish · below = bearish' }, 'bias') : '';
    const res = (levels.resistance || []).slice(0, 1).map(l => row({ ...l, label: 'Resistance' }, 'res')).join('');
    const sup = (levels.support || []).slice(0, 1).map(l => row({ ...l, label: 'Support' }, 'sup')).join('');
    return bias + res + sup;
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
      </div>
      ${quality.missing?.length ? `<div class="gp-engine-notrade">PROVISIONAL — confidence capped: ${quality.missing.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-evidence-reasons"><span>Evidence details</span><ul>${reasons}</ul></div>
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
      setSafe('gpLoading', el => el.style.display = 'none');
      setSafe('gpError', el => {
        el.style.display = '';
        el.textContent = d?.unavailable ? 'REAL-TIME DATA UNAVAILABLE' : (d?.error || 'Game plan unavailable.');
      });
      c.style.display = 'none';
      setSafe('gpSetupBadge', el => el.style.display = 'none');
      return;
    }

    const { snapshot: s, indicators: ind, confidence, dataGaps, searchSignal, levels, displayLevels } = d;
    const generatedAt = d.generatedAt;

    // Header badge
    const verdict = searchSignal?.signal?.label || 'UNAVAILABLE';
    const direction = searchSignal?.signal?.direction || (verdict === 'SELL' ? 'BEARISH' : 'BULLISH');
    const setup = verdict === 'UNAVAILABLE' ? verdict : `${verdict} · ${direction}`;
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
    const confParts = confidence?.parts || {};
    const confHtml = `<div class="gp-conf">
        <div class="gp-conf-overall">DATA COVERAGE <b>${confidence?.overall ?? '--'}/100</b></div>
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
      </div>

      ${searchSignalHtml(searchSignal)}

      <div class="gp-cols">
        <div class="gp-col">
          <div class="gp-sec-title">Decision levels <span class="gp-sec-note">where the direction can strengthen or fail</span></div>
          <div class="gp-levels">${levelRows(displayLevels || levels)}</div>
        </div>
      </div>

      ${confHtml}
      ${dataGaps?.length ? `<div class="gp-gaps">Missing data: ${dataGaps.map(esc).join(' · ')}</div>` : ''}
      <div class="gp-disclaimer">Sources: ${esc(d.provenance?.quote?.provider || 'market feed')} quote as of ${esc(d.provenance?.quote?.asOf || generatedAt || '--')} · Yahoo chart bars · ${esc((d.provenance?.news || []).join(' + ') || 'no verified news')} · Not financial advice</div>`;

    setSafe('gpLoading', el => el.style.display = 'none');
    setSafe('gpError', el => el.style.display = 'none');
    c.style.display = '';
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
    currentSym = sym;
    setSafe('gpPanel', el => el.style.display = '');
    setSafe('gpLoadSym', el => el.textContent = sym);
    setSafe('gpLoading', el => el.style.display = 'flex');
    setSafe('gpError', el => el.style.display = 'none');
    setSafe('gpContent', el => el.style.display = 'none');
    setSafe('gpSetupBadge', el => el.style.display = 'none');
    refresh(false, suppliedAnalysis);
    schedule();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('gpRefreshBtn');
    if (btn) btn.addEventListener('click', () => {
      setSafe('gpLoading', el => el.style.display = 'flex');
      setSafe('gpContent', el => el.style.display = 'none');
      const sharedRefresh = currentSym
        ? window.searchContext.load(currentSym, { force: true })
        : null;
      refresh(true, sharedRefresh);
      if (currentSym && typeof rtTrader !== 'undefined') {
        rtTrader.load(currentSym, sharedRefresh);
      }
    });
  });

  return { load };
})();
