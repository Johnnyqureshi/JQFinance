/* Search-only macro and prediction-market intelligence. */
window.searchIntelligence = (() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
  const number = value => (value == null || value === '')
    ? null
    : (Number.isFinite(Number(value)) ? Number(value) : null);
  const fmt = (value, digits = 2) => number(value) == null
    ? '—'
    : Number(value).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  const compact = value => {
    const n = number(value);
    if (n == null) return 'Unavailable';
    if (Math.abs(n) >= 1e9) return `${fmt(n / 1e9, 1)}B`;
    if (Math.abs(n) >= 1e6) return `${fmt(n / 1e6, 1)}M`;
    if (Math.abs(n) >= 1e3) return `${fmt(n / 1e3, 1)}K`;
    return fmt(n, 0);
  };
  const stateClass = value => {
    const upper = String(value || '').toUpperCase();
    if (upper === 'BULLISH' || upper === 'LIVE') return 'bull';
    if (upper === 'BEARISH' || upper === 'UNAVAILABLE') return 'bear';
    return 'neutral';
  };
  const relativeTime = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Timestamp unavailable';
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60000));
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return `Updated ${minutes}m ago`;
    return `Updated ${Math.floor(minutes / 60)}h ago`;
  };
  const list = values => Array.isArray(values) && values.length
    ? `<ul>${values.map(value => `<li>${esc(value)}</li>`).join('')}</ul>`
    : '<p class="mi-muted">No supported items were returned.</p>';

  let requestToken = 0;

  function showLoading(query) {
    const panel = $('searchIntelPanel');
    if (!panel) return;
    panel.style.display = '';
    $('searchIntelContent').replaceChildren();
    $('searchIntelError').style.display = 'none';
    const loading = $('searchIntelLoading');
    loading.style.display = 'flex';
    loading.querySelector('strong').textContent = `Building intelligence for “${query}”`;
  }

  function marketCard(market) {
    const yes = number(market.yesProbability);
    const no = number(market.noProbability);
    const change = number(market.probabilityChange);
    return `<article class="mi-market-card">
      <div class="mi-market-top">
        <div>
          <span class="mi-source">KALSHI · MARKET-IMPLIED PROBABILITY</span>
          <h4>${esc(market.title)}</h4>
        </div>
        <span class="mi-status ${stateClass(market.status === 'ACTIVE' ? 'LIVE' : market.status)}">${esc(market.status)}</span>
      </div>
      <div class="mi-probability">
        <div class="mi-probability-number">${yes == null ? '—' : `${fmt(yes, 0)}%`}<small>${esc(market.yesLabel || 'Yes')}</small></div>
        <div class="mi-probability-bars">
          <div><span>${esc(market.yesLabel || 'Yes')}</span><i><b class="yes" style="width:${yes ?? 0}%"></b></i><strong>${yes == null ? '—' : `${fmt(yes, 0)}%`}</strong></div>
          <div><span>${esc(market.noLabel || 'No')}</span><i><b class="no" style="width:${no ?? 0}%"></b></i><strong>${no == null ? '—' : `${fmt(no, 0)}%`}</strong></div>
        </div>
      </div>
      <div class="mi-market-metrics">
        <span><i>Current price</i><b>${market.lastPrice == null ? 'Unavailable' : `${fmt(market.lastPrice, 1)}¢`}</b></span>
        <span><i>24h volume</i><b>${compact(market.volume24h)}</b></span>
        <span><i>Open interest</i><b>${compact(market.openInterest)}</b></span>
        <span><i>Probability change</i><b class="${change == null ? '' : change >= 0 ? 'up' : 'down'}">${change == null ? 'Unavailable' : `${change >= 0 ? '+' : ''}${fmt(change, 1)} pts`}</b></span>
      </div>
      <div class="mi-market-foot">
        <span>Closes ${market.closeTime ? new Date(market.closeTime).toLocaleString() : 'date unavailable'}</span>
        <span>${relativeTime(market.updatedAt)}</span>
      </div>
    </article>`;
  }

  function predictionMarkets(data) {
    const markets = Array.isArray(data.predictionMarkets) ? data.predictionMarkets : [];
    return `<section class="mi-section">
      <div class="mi-section-head">
        <div><span class="mi-kicker">PREDICTION MARKETS</span><h3>Market-implied expectations</h3></div>
        <span class="mi-source-pill">Official Kalshi API</span>
      </div>
      ${markets.length
        ? `<div class="mi-market-grid">${markets.map(marketCard).join('')}</div>`
        : `<div class="mi-empty"><strong>${esc(data.predictionMarketMessage || 'No directly relevant Kalshi market available')}</strong><p>No probability is substituted or fabricated when a matching contract is unavailable.</p></div>`}
      <p class="mi-caveat">Prediction-market participants currently price these outcomes at the displayed levels. Probabilities are not guarantees.</p>
    </section>`;
  }

  function macroEnvironment(data) {
    const indicators = Object.values(data.macroIndicators || {}).filter(Boolean);
    const pressure = Array.isArray(data.macroPressure) ? data.macroPressure : [];
    return `<section class="mi-section">
      <div class="mi-section-head">
        <div><span class="mi-kicker">MACRO ENVIRONMENT</span><h3>Cross-asset conditions</h3></div>
        <span class="mi-source-pill">Yahoo Finance</span>
      </div>
      <div class="mi-indicator-grid">
        ${indicators.length ? indicators.map(item => `<div class="mi-indicator">
          <span>${esc(item.name)}</span>
          <b>${fmt(item.price, item.price >= 1000 ? 0 : 2)}</b>
          <strong class="${number(item.changePct) >= 0 ? 'up' : 'down'}">${item.changePct == null ? 'Unavailable' : `${item.changePct >= 0 ? '+' : ''}${fmt(item.changePct, 2)}%`}</strong>
          <small>${relativeTime(item.updatedAt)} · ${esc(item.source)}</small>
        </div>`).join('') : '<div class="mi-empty">Macro data temporarily unavailable</div>'}
      </div>
      <div class="mi-pressure-grid">
        ${pressure.map(item => `<div class="mi-pressure ${stateClass(item.state)}">
          <span>${esc(item.label)}</span><b>${esc(item.state)}</b><small>${esc(item.detail)}</small>
        </div>`).join('')}
      </div>
    </section>`;
  }

  function fedOutlook(data) {
    const fed = data.fedOutlook || {};
    if (!data.classification?.topics?.some(topic => topic.id === 'fed') && !fed.available) return '';
    const markets = Array.isArray(fed.markets) ? fed.markets : [];
    return `<section class="mi-section mi-fed">
      <div class="mi-section-head"><div><span class="mi-kicker">FED OUTLOOK</span><h3>Rates intelligence</h3></div></div>
      <div class="mi-fed-facts">
        <div><span>Current target rate</span><b>${fed.currentRate || 'Unavailable from connected sources'}</b></div>
        <div><span>Next meeting</span><b>${fed.nextMeeting || 'Unavailable from connected sources'}</b></div>
        <div><span>Relevant contracts</span><b>${markets.length}</b></div>
      </div>
      <p>${esc(fed.note || '')}</p>
    </section>`;
  }

  function divergence(data) {
    if (!data.divergence?.detected) {
      return `<section class="mi-section mi-divergence quiet">
        <div class="mi-section-head"><div><span class="mi-kicker">DIVERGENCE DETECTION</span><h3>No measured divergence available</h3></div></div>
        <p>A divergence is shown only when both prediction probability change and asset price change are available and materially disagree.</p>
      </section>`;
    }
    const item = data.divergence;
    return `<section class="mi-section mi-divergence active">
      <div class="mi-section-head"><div><span class="mi-kicker">DIVERGENCE DETECTED</span><h3>Expectations and price action disagree</h3></div></div>
      <div class="mi-divergence-stats">
        <span><i>Probability move</i><b>${item.probabilityChange >= 0 ? '+' : ''}${fmt(item.probabilityChange, 1)} pts</b></span>
        <span><i>${esc(data.asset?.symbol || 'Asset')}</i><b>${item.assetChangePct >= 0 ? '+' : ''}${fmt(item.assetChangePct, 2)}%</b></span>
      </div>
      <p>${esc(item.interpretation)}</p><small>${esc(item.caveat)}</small>
    </section>`;
  }

  function geopolitical(data) {
    const risk = data.geopoliticalRisk;
    if (!risk) return '';
    return `<section class="mi-section">
      <div class="mi-section-head"><div><span class="mi-kicker">GEOPOLITICAL RISK MONITOR</span><h3>Observable market stress indicators</h3></div></div>
      <div class="mi-inference-label">${esc(risk.label)}</div>
      <div class="mi-indicator-grid">${(risk.indicators || []).map(item => `<div class="mi-indicator">
        <span>${esc(item.name)}</span><b>${fmt(item.price, 2)}</b>
        <strong class="${item.changePct >= 0 ? 'up' : 'down'}">${item.changePct >= 0 ? '+' : ''}${fmt(item.changePct, 2)}%</strong>
        <small>${esc(item.source)} · ${relativeTime(item.updatedAt)}</small>
      </div>`).join('')}</div>
    </section>`;
  }

  function news(data) {
    const source = data.news || {};
    const items = Array.isArray(source.items) ? source.items : [];
    return `<section class="mi-section">
      <div class="mi-section-head"><div><span class="mi-kicker">NEWS & CATALYSTS</span><h3>Recent query-linked headlines</h3></div><span class="mi-source-pill">${esc(source.source || 'Source unavailable')}</span></div>
      ${items.length ? `<div class="mi-news-list">${items.map(item => `<a ${item.url ? `href="${esc(item.url)}" target="_blank" rel="noopener"` : ''}>
        <strong>${esc(item.headline)}</strong><span>${esc(item.source)} · ${relativeTime(item.publishedAt)}</span>
      </a>`).join('')}</div>` : `<div class="mi-empty">${source.status === 'live' ? 'No headlines tagged to this query right now' : 'News data temporarily unavailable'}</div>`}
    </section>`;
  }

  function interpretation(data) {
    const ai = data.interpretation || {};
    // When AI is not configured at all, the section is hidden rather than
    // rendered as a permanently empty "not configured" panel.
    if (!ai.available && ai.configured === false) return '';
    return `<section class="mi-section mi-interpretation">
      <div class="mi-section-head"><div><span class="mi-kicker">AI MARKET INTERPRETATION</span><h3>What this could mean</h3></div><span class="mi-source-pill">Uses listed facts only</span></div>
      ${ai.available ? `
        <p class="mi-ai-summary">${esc(ai.summary)}</p>
        <div class="mi-ai-grid">
          <div><span>Potential beneficiaries</span>${list(ai.potentialBeneficiaries)}</div>
          <div><span>Potential pressure</span>${list(ai.potentialPressure)}</div>
          <div><span>Risk factors</span>${list(ai.riskFactors)}</div>
        </div>
        <small>${esc(ai.caveat)} · ${relativeTime(ai.updatedAt)}</small>`
        : `<div class="mi-empty"><strong>AI interpretation temporarily unavailable</strong><p>${esc(ai.reason || 'No interpretation was returned.')} The sourced data above remains available.</p></div>`}
    </section>`;
  }

  function sources(data) {
    const entries = Object.values(data.sources || {});
    return `<section class="mi-section mi-sources">
      <div class="mi-section-head"><div><span class="mi-kicker">SOURCES & DATA STATUS</span><h3>Provenance</h3></div></div>
      <div class="mi-source-grid">${entries.map(item => `<div>
        <span>${esc(item.source)}</span><b class="${stateClass(item.status)}">${esc(item.status)}</b><small>${relativeTime(item.updatedAt)}</small>
      </div>`).join('')}</div>
      <p class="mi-caveat">${esc(data.disclaimer)}</p>
    </section>`;
  }

  function render(data) {
    $('searchIntelLoading').style.display = 'none';
    const content = $('searchIntelContent');
    const type = data.classification?.type === 'MACRO' ? 'MACRO / EVENT SEARCH' : 'ASSET + MACRO SEARCH';
    content.innerHTML = `<header class="mi-header">
      <div><span class="mi-kicker">${type}</span><h2>${esc(data.query)}</h2><p>Prediction markets, macro conditions, catalysts, and measured cross-market implications.</p></div>
      <span>${relativeTime(data.generatedAt)}</span>
    </header>
    ${data.asset ? `<section class="mi-asset-strip">
      <div><span>Asset</span><b>${esc(data.asset.symbol)}</b><small>${esc(data.asset.name)}</small></div>
      <div><span>Price</span><b>${data.asset.price == null ? 'Unavailable' : `$${fmt(data.asset.price)}`}</b><small>${esc(data.asset.source)}</small></div>
      <div><span>Session move</span><b class="${number(data.asset.changePct) >= 0 ? 'up' : 'down'}">${data.asset.changePct == null ? 'Unavailable' : `${data.asset.changePct >= 0 ? '+' : ''}${fmt(data.asset.changePct, 2)}%`}</b><small>${relativeTime(data.asset.updatedAt)}</small></div>
      <div><span>Sector</span><b>${esc(data.asset.sector || 'Unavailable')}</b><small>No value is inferred when missing</small></div>
    </section>` : ''}
    ${predictionMarkets(data)}
    ${fedOutlook(data)}
    ${macroEnvironment(data)}
    ${geopolitical(data)}
    ${divergence(data)}
    ${news(data)}
    ${interpretation(data)}
    ${sources(data)}`;
  }

  async function load(query, { symbol = '' } = {}) {
    const clean = String(query || '').trim();
    if (!clean) return;
    const token = ++requestToken;
    showLoading(clean);
    try {
      const params = new URLSearchParams({ q: clean });
      if (symbol) params.set('symbol', symbol);
      const response = await fetch(`/api/search-intelligence?${params}`, { credentials: 'same-origin' });
      const data = await response.json().catch(() => null);
      if (token !== requestToken) return;
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'Market intelligence unavailable');
      render(data);
    } catch (error) {
      if (token !== requestToken) return;
      $('searchIntelLoading').style.display = 'none';
      const target = $('searchIntelError');
      target.style.display = '';
      target.textContent = `${error.message}. Primary Search data remains available.`;
    }
  }

  function hide() {
    requestToken += 1;
    const panel = $('searchIntelPanel');
    if (panel) panel.style.display = 'none';
  }

  return { hide, load };
})();