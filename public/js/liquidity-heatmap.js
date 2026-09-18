/* Truthful top-of-book visualization for the liquidity.v1 contract.
   This module never invents depth rows, walls, or intensity. */
(function () {
  const root = () => document.getElementById('liquidityHeatmap');
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const num = (value, digits = 2) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
  const money = value => value == null || !Number.isFinite(Number(value)) ? '—' : '$' + num(value);
  const date = value => {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? esc(value) : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const tone = state => state === 'BULLISH_PRESSURE' ? 'bull' : state === 'BEARISH_PRESSURE' ? 'bear' : 'neutral';
  const stateLabel = state => state === 'BULLISH_PRESSURE' ? 'BULLISH PRESSURE' : state === 'BEARISH_PRESSURE' ? 'BEARISH PRESSURE' : 'NEUTRAL / MIXED';

  function componentRows(score) {
    const components = Array.isArray(score?.components) ? score.components : [];
    if (!components.length) return '<div class="lh-empty">Score components unavailable.</div>';
    return components.map(item => `<div class="lh-score-row">
      <span>${esc(item.label || item.key || 'Component')}</span>
      <b>${item.score == null ? 'UNAVAILABLE' : `${num(item.score, 2)} / ${num(item.max, 2)}`}</b>
      <small>${esc(item.reason || 'No explanation supplied.')}</small>
    </div>`).join('');
  }

  function timeline(history) {
    if (!Array.isArray(history) || !history.length) return '<div class="lh-empty">No valid real-snapshot history available.</div>';
    return history.slice(-8).map(point => `<span class="lh-timeline-point ${tone(point.state)}" title="${esc(point.at || '')}">
      <i></i><b>${date(point.at)}</b><small>${stateLabel(point.state)}</small>
    </span>`).join('');
  }

  function render(data, symbol) {
    const el = root();
    if (!el) return;
    const d = data || {};
    const state = d.state || d.liquiditySummary?.state || 'NEUTRAL_MIXED';
    const unavailable = d.available === false || !d.topOfBook;
    const book = d.topOfBook || {};
    const imbalance = d.imbalance || {};
    const tech = d.technicalContext || {};
    const spread = d.spread || {};
    const maxSide = Math.max(Number(imbalance.bidNotional) || 0, Number(imbalance.askNotional) || 0, 1);
    const bidWidth = Math.max(4, (Number(imbalance.bidNotional) || 0) / maxSide * 100);
    const askWidth = Math.max(4, (Number(imbalance.askNotional) || 0) / maxSide * 100);
    const score = d.score || {};
    const totalScore = score.total == null ? 'UNAVAILABLE'
      : `${num(score.total, 2)} / ${num(score.max, 2)}`;
    const why = d.summary || (state === 'BULLISH_PRESSURE' ? 'Bid-side evidence leads in this snapshot.' : state === 'BEARISH_PRESSURE' ? 'Ask-side evidence leads in this snapshot.' : 'Available evidence is mixed or incomplete.');
    el.hidden = false;
    el.innerHTML = `<div class="lh-head">
      <div><span class="lh-kicker">${esc(symbol || '')} · MARKET STRUCTURE</span><h2>🔥 Liquidity &amp; Direction Heatmap <small>liquidity.v1</small></h2></div>
      <div class="lh-provenance"><b>${esc(d.provider || d.provenance?.quote || 'PROVIDER UNAVAILABLE')}</b><span>${d.provenance?.quoteTimestamp ? `Quote ${date(d.provenance.quoteTimestamp)}` : 'Provenance unavailable'}</span></div>
    </div>
    ${unavailable ? `<div class="lh-unavailable" role="status"><strong>UNAVAILABLE</strong><p>Heatmap data unavailable from current market-data provider.</p><small>${esc((d.warnings || [d.summary]).filter(Boolean).join(' '))}</small></div>` : `
      <div class="lh-state ${tone(state)}" role="status"><strong>${stateLabel(state)}</strong><span>${esc(why)} No prediction claim is made.</span></div>
      <div class="lh-topline"><span>Current quote midpoint <b>${money(d.currentPrice)}</b></span><span>Price source <b>validated top-of-book</b></span><span>Spread <b>${money(spread.absolute)} · ${num(spread.percent, 4)}%</b></span><span>Snapshot <b>${date(book.timestamp)}</b></span></div>
      <div class="lh-book" aria-label="Real top-of-book bid and ask concentrations">
        <div class="lh-side bid"><div class="lh-side-head"><b>BID</b><span>${money(book.bid)} · ${num(book.bidSize, 0)} shares</span></div><div class="lh-bar"><i style="width:${bidWidth}%"></i></div><small>Notional ${money(imbalance.bidNotional)}</small></div>
         <div class="lh-mid"><span>IEX TOP OF BOOK</span><b>${num(imbalance.percent, 2)}%</b><small>bid quote-size notional imbalance</small></div>
        <div class="lh-side ask"><div class="lh-side-head"><b>ASK</b><span>${money(book.ask)} · ${num(book.askSize, 0)} shares</span></div><div class="lh-bar"><i style="width:${askWidth}%"></i></div><small>Notional ${money(imbalance.askNotional)}</small></div>
      </div>
      <div class="lh-grid">
        <div class="lh-card"><h3>Latest trade</h3><b>${d.recentTrade ? money(d.recentTrade.price) : 'UNAVAILABLE'}</b><span>${d.recentTrade ? `${num(d.recentTrade.size, 0)} shares · ${date(d.recentTrade.timestamp)}` : 'Executed trade is unavailable or stale.'}</span></div>
        <div class="lh-card"><h3>Technical context</h3><b>${tech.support == null ? 'Support —' : `S ${money(tech.support)}`} · ${tech.resistance == null ? 'Resistance —' : `R ${money(tech.resistance)}`}</b><span>Relative volume ${tech.relativeVolume == null ? 'unavailable' : num(tech.relativeVolume, 2) + '×'}</span></div>
        <div class="lh-card"><h3>Top quote-size change</h3><b>${esc(String(d.shift?.direction || 'UNAVAILABLE').replaceAll('_', ' '))}</b><span>${d.shift?.available ? `Bid size ${num(d.shift.bidLiquidityChangePct, 1)}% · Ask size ${num(d.shift.askLiquidityChangePct, 1)}%` : esc(d.shift?.reason || 'Fewer than two valid real snapshots.')}</span></div>
      </div>
      <div class="lh-columns"><div><h3>Transparent score · ${totalScore}</h3><small class="lh-threshold">Bullish ≥ ${num(score.bullishThreshold, 1)} · Bearish ≤ ${num(score.bearishThreshold, 1)} · technical direction required</small><div class="lh-score">${componentRows(score)}</div></div><div><h3>Direction timeline · real snapshots</h3><div class="lh-timeline">${timeline(d.history)}</div></div></div>`}
    <div class="lh-limitations"><b>Important limits</b><span>Top-of-book is not Level 2 and cannot prove a wall.</span><span>Walls: ${esc(d.walls?.reason || 'UNAVAILABLE')}</span><span>Absorption: ${esc(d.absorption?.reason || 'UNAVAILABLE')}</span><span>Level 2: ${esc(d.level2?.reason || 'UNAVAILABLE')}</span>${(d.warnings || []).map(w => `<span>Warning: ${esc(w)}</span>`).join('')}</div>`;
  }

  window.liquidityHeatmap = { render };
  document.addEventListener('pageChanged', event => {
    if (event.detail?.page !== 'home' && root()) root().hidden = true;
  });
}());