/* Verified Macro Context: presentation only; the server is the sole score authority. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let payload = null, loading = false, initialized = false, timer = null, lastChecked = null;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const num = (value, suffix = '') => value == null || value === '' || !Number.isFinite(Number(value)) ? 'Unavailable' : `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
  const time = value => {
    // Provider observation dates are calendar labels, not UTC-midnight instants.
    // Preserve them verbatim everywhere; only actual timestamps get localized.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value;
    const d = new Date(value);
    return value && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : 'Unavailable';
  };
  const official = value => {
    try {
      const u = new URL(value);
      const host = u.hostname.toLowerCase();
      return u.protocol === 'https:' && (host.endsWith('.gov') || ['treasury.gov','federalreserve.gov','bls.gov'].includes(host)) ? u.href : null;
    } catch { return null; }
  };
  const link = (url, label) => { const safe = official(url); return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label || 'Official source')}</a>` : '<span class="macro-muted">Official link unavailable</span>'; };
  const status = input => input && input.status || 'unavailable';
  const source = input => `<div class="macro-source">${link(input.url, input.source || 'Official source')}<span>Observed ${esc(time(input.asOf))} · Retrieved ${esc(time(input.fetchedAt))}</span></div>`;
  const inputCard = (name, input, body) => {
    const available = status(input) === 'available' && input && input.data;
    return `<article class="macro-input macro-${esc(status(input))}">
      <div class="macro-input-head"><strong>${esc(name)}</strong><span>${esc(status(input))}</span></div>${available ? `${body}${source(input)}` : `<p>${esc(input && input.reason || 'Data unavailable.')}</p>`}</article>`;
  };
  function render() {
    const root = $('macroContent'); const checked = $('macroChecked'); if (!root) return;
    if (checked) checked.textContent = lastChecked ? `Last checked ${time(lastChecked)}` : 'Not checked yet';
    if (!payload) { root.innerHTML = `<div class="macro-empty"><strong>Macro context unavailable</strong><span>Use refresh to request the verified context feed.</span></div>`; return; }
    const inputs = payload.inputs || {}, score = payload.score || {}, treasury = inputs.treasury, fed = inputs.fed, inflation = inputs.inflation, employment = inputs.employment, geo = inputs.geopolitical;
    const scoreAvailable = score.value != null && Number.isFinite(Number(score.value));
    const components = Array.isArray(score.components) ? score.components.map(c => `<li><b>${esc(c.label || c.key || 'Component')}</b><span>${c.points == null ? 'Unavailable' : `${esc(c.points)}/${esc(c.maxPoints)}`}</span><p>${esc(c.explanation || 'Explanation unavailable.')}</p></li>`).join('') : '';
    const t = treasury && treasury.data, f = fed && fed.data, i = inflation && inflation.data, e = employment && employment.data;
    const yieldBody = t ? `<div class="macro-yields"><span>2Y <b>${num(t.twoYear, '%')}</b><em>${num(t.changesBps && t.changesBps.twoYear, ' bp')}</em></span><span>10Y <b>${num(t.tenYear, '%')}</b><em>${num(t.changesBps && t.changesBps.tenYear, ' bp')}</em></span><span>30Y <b>${num(t.thirtyYear, '%')}</b><em>${num(t.changesBps && t.changesBps.thirtyYear, ' bp')}</em></span></div><p class="macro-detail">2s10s: <b>${num(t.curve2s10sBps, ' bp')}</b> · change: <b>${num(t.curveChangeBps, ' bp')}</b>${t.previous ? ` · prior observation ${esc(time(t.previous.asOf))}` : ''}</p>` : '';
    const fedBody = f ? `<p class="macro-policy">${f.policy ? `Target range <b>${num(f.policy.lower, '%')}–${num(f.policy.upper, '%')}</b> · as of ${esc(time(f.policy.asOf))} ${link(f.policy.url, 'policy statement')}` : 'Policy range unavailable.'}</p><p class="macro-calendar-note">${f.calendarUnavailable ? esc(f.calendarUnavailable) : `Schedule retrieved ${esc(time(f.calendarVerifiedAt))}`}</p><ul class="macro-events">${Array.isArray(f.events) && f.events.length ? f.events.map(x => `<li><span>${esc(time(x.date, true))}</span>${link(x.url, x.title || 'Federal Reserve event')}</li>`).join('') : '<li>No verified next events supplied.</li>'}</ul>` : '';
    const sector = Array.isArray(payload.sectorImpacts) ? payload.sectorImpacts.map(x => `<li><b>${esc(x.sector || 'Sector')}</b><span>${esc(x.context || 'Context unavailable.')}</span></li>`).join('') : '';
    root.innerHTML = `<div class="macro-disclaimer">CONTEXT ONLY <span>Execution impact: ${esc(payload.executionImpact || 'none')}</span></div>
      <div class="macro-score"><div class="macro-score-value ${scoreAvailable ? '' : 'macro-unavailable'}"><small>MEASURED MACRO RISK</small><strong>${scoreAvailable ? `${esc(score.value)}<i>/100</i>` : 'Unavailable'}</strong><span>${esc(score.regime || 'Regime unavailable')}</span></div><div class="macro-score-copy"><p>${esc(score.methodology || 'Methodology unavailable.')}</p><p>${esc(score.coverage || 'Coverage unavailable.')}</p>${components ? `<ol class="macro-components">${components}</ol>` : ''}</div></div>
      <div class="macro-input-grid">
        ${inputCard('Treasury observations', treasury, yieldBody)}
        ${inputCard('Federal Reserve', fed, fedBody)}
        ${inputCard('Inflation', inflation, i ? `<p class="macro-stat"><b>${num(i.cpiYoY, '%')}</b> CPI year over year <span>${esc(i.period || '')}</span></p>` : '')}
        ${inputCard('Employment', employment, e ? `<p class="macro-stat"><b>${num(e.unemploymentRate, '%')}</b> unemployment <span>${esc(e.period || '')}</span><b>${num(e.payrollChangeThousands, 'K')}</b> payroll change</p>` : '')}
        ${inputCard('Geopolitical coverage', geo, `<p>${esc(geo && geo.reason || 'Geopolitical input is unavailable. No inferred geopolitical assessment is displayed.')}</p>`)}
      </div>
      <div class="macro-bottom"><div><h3>Heuristic sector context</h3><p>Not predictions or trade signals.</p><ul class="macro-sectors">${sector || '<li>Sector context unavailable.</li>'}</ul></div><div><h3>Coverage notes</h3><ul class="macro-notes">${(Array.isArray(payload.limitations) ? payload.limitations : []).concat(Array.isArray(score.contradictions) ? score.contradictions : []).map(x => `<li>${esc(x)}</li>`).join('') || '<li>No additional notes supplied.</li>'}</ul></div></div>`;
  }
  function canFetch() { return document.visibilityState === 'visible' && $('page-scanner')?.classList.contains('active'); }
  async function refresh() {
    if (loading || !canFetch()) return; loading = true; const button = $('macroRefresh'); if (button) { button.disabled = true; button.textContent = 'Refreshing…'; }
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(25000) : undefined;
      const res = await fetch('/api/verified-macro-context', { credentials:'include', signal });
      if (res.status === 401 || res.status === 403) throw new Error('Sign in required to view verified macro context.');
      if (!res.ok) throw new Error('Verified macro context is currently unavailable.');
      const data = await res.json();
      if (!data || data.contextOnly !== true) throw new Error('Context feed returned an invalid response.');
      payload = data; lastChecked = data.generatedAt || new Date().toISOString(); render();
    } catch (err) {
      lastChecked = new Date().toISOString();
      if (payload) {
        const reason = 'Refresh failed: ' + (err.message || 'unavailable');
        const names = ['treasury', 'fed', 'inflation', 'employment', 'geopolitical'];
        const staleInputs = Object.fromEntries(names.map(key => [key, { ...(payload.inputs || {})[key], status:'stale', data:null, reason }]));
        const staleComponents = Array.isArray(payload.score && payload.score.components) ? payload.score.components.map(component => ({ ...component, points:null })) : [];
        payload = { ...payload, inputs:staleInputs, score:{ ...(payload.score || {}), value:null, components:staleComponents }, sectorImpacts:[], limitations:[...(payload.limitations || []), reason] };
      }
      else payload = { inputs:{ geopolitical:{ status:'unavailable', reason:err.message || 'Unavailable' } }, score:{ value:null, regime:'Unavailable', methodology:'No cached verified macro response.', coverage:'Unavailable', components:[], contradictions:[] }, sectorImpacts:[], limitations:[err.message || 'Unable to load macro context.'], executionImpact:'none' };
      render();
    } finally { loading = false; if (button) { button.disabled = false; button.textContent = 'Refresh context'; } }
  }
  function startTimer() { clearInterval(timer); timer = setInterval(() => { if (canFetch()) refresh(); }, 300000); }
  function init() { if (initialized) return; initialized = true; $('macroRefresh')?.addEventListener('click', refresh); render(); }
  function resume() { init(); refresh(); startTimer(); }
  function pause() { clearInterval(timer); timer = null; }
  window.macroContext = { init, refresh, resume, pause };
}());