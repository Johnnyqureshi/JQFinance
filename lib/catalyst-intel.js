'use strict';

const CATALYST_TERMS = /\b(fda|pdufa|clinical|trial|phase\s*(?:1|2|3|i{1,3})|endpoint|efficacy|safety|biotech|pharma(?:ceutical)?|drug|therapy|ind\b|breakthrough|fast\s*track|orphan\s*drug|acqui(?:re|sition)|buyout|merger|partnership|licens(?:e|ing)|offering|dilution|warrant|convertible|shelf\s+registration|reverse\s+split|clinical\s+hold|complete\s+response\s+letter|delist|bankrupt)\b/i;

const RULES = [
  {
    category: 'Bankruptcy / Delisting',
    direction: 'VERY BEARISH',
    baseScore: 98,
    test: /\b(bankrupt(?:cy)?|chapter\s*(?:7|11)|delist(?:ed|ing)?|trading\s+suspension)\b/i,
    why: 'A bankruptcy, delisting, or trading-suspension event can permanently impair liquidity and equity value.',
  },
  {
    category: 'FDA Rejection',
    direction: 'VERY BEARISH',
    baseScore: 96,
    test: /\b(fda\b.{0,45}\b(reject(?:s|ed|ion)?|declin(?:e|ed)|not\s+approve)|complete\s+response\s+letter|crl\b)\b/i,
    why: 'An FDA rejection or Complete Response Letter can delay commercialization and create a new financing need.',
  },
  {
    category: 'Clinical Hold',
    direction: 'VERY BEARISH',
    baseScore: 95,
    test: /\b(clinical\s+hold|fda\b.{0,35}\bhold)\b/i,
    why: 'A clinical hold stops or restricts trial progress and can materially change the program timeline.',
  },
  {
    category: 'Clinical Failure / Safety',
    direction: 'VERY BEARISH',
    baseScore: 94,
    test: /\b(fail(?:s|ed|ure)?\b.{0,35}\b(endpoint|trial)|miss(?:es|ed)\b.{0,25}\bendpoint|negative\s+(?:trial|clinical)\s+(?:data|results?)|serious\s+(?:adverse|safety)|safety\s+signal|patient\s+death)\b/i,
    why: 'A failed endpoint or material safety issue can invalidate the clinical thesis.',
  },
  {
    category: 'FDA Approval',
    direction: 'VERY BULLISH',
    baseScore: 99,
    test: /\b(fda\b.{0,45}\b(approve(?:s|d|al)?|authoriz(?:e|ed|ation))|receives?\s+fda\s+approval)\b/i,
    why: 'FDA approval can unlock commercialization and materially change the company’s addressable value.',
  },
  {
    category: 'Acquisition / Buyout',
    direction: 'VERY BULLISH',
    baseScore: 97,
    test: /\b(acqui(?:re[sd]?|sition)|buyout|definitive\s+merger|takeover\s+(?:offer|agreement))\b/i,
    why: 'A confirmed acquisition or buyout can reprice the stock toward the announced transaction value.',
  },
  {
    category: 'Positive Phase 3',
    direction: 'VERY BULLISH',
    baseScore: 95,
    test: /\b(phase\s*(?:3|iii)\b.{0,65}\b(positive|met|achiev(?:e|ed)|success(?:ful)?|statistically\s+significant)|(?:positive|met|achiev(?:e|ed)|success(?:ful)?)\b.{0,65}\bphase\s*(?:3|iii))\b/i,
    why: 'Positive Phase 3 data is late-stage evidence that can materially improve approval probability.',
  },
  {
    category: 'Positive Phase 2',
    direction: 'VERY BULLISH',
    baseScore: 87,
    test: /\b(phase\s*(?:2|ii)\b.{0,65}\b(positive|met|achiev(?:e|ed)|success(?:ful)?|statistically\s+significant)|(?:positive|met|achiev(?:e|ed)|success(?:ful)?)\b.{0,65}\bphase\s*(?:2|ii))\b/i,
    why: 'Positive Phase 2 data can validate efficacy and support advancement into pivotal studies.',
  },
  {
    category: 'Breakthrough Therapy',
    direction: 'VERY BULLISH',
    baseScore: 86,
    test: /\bbreakthrough\s+therapy\b/i,
    why: 'Breakthrough Therapy designation can increase FDA interaction and accelerate development.',
  },
  {
    category: 'Major Partnership / License',
    direction: 'VERY BULLISH',
    baseScore: 85,
    test: /\b(major|strategic|exclusive|global)?\s*(?:pharma(?:ceutical)?\s+)?(?:partnership|collaboration|licens(?:e|ing)\s+agreement)\b/i,
    why: 'A credible partnership or licensing agreement can validate the asset and add non-dilutive capital.',
  },
  {
    category: 'Fast Track',
    direction: 'BULLISH',
    baseScore: 76,
    test: /\bfast\s+track\s+(?:designation|status)?\b/i,
    why: 'Fast Track designation can improve FDA access and speed parts of the review process.',
  },
  {
    category: 'FDA Application / PDUFA',
    direction: 'BULLISH',
    baseScore: 72,
    test: /\b(pdufa|fda\b.{0,45}\b(accept(?:s|ed|ance)|priority\s+review|advisory\s+committee|adcom)|nda\b.{0,25}\baccept|bla\b.{0,25}\baccept)\b/i,
    why: 'An accepted application, PDUFA milestone, or FDA meeting creates a defined regulatory catalyst.',
  },
  {
    category: 'Positive Interim Data',
    direction: 'BULLISH',
    baseScore: 72,
    test: /\b(positive|encouraging|promising)\b.{0,45}\b(interim|clinical|trial)\s+(?:data|results?)\b/i,
    why: 'Positive interim data can improve confidence before a complete study readout, but remains preliminary.',
  },
  {
    category: 'IND Clearance',
    direction: 'BULLISH',
    baseScore: 69,
    test: /\b(ind\b.{0,35}\b(clear(?:ed|ance)|allow(?:ed|ance)|effective)|investigational\s+new\s+drug\b.{0,35}\b(clear|allow|effective))\b/i,
    why: 'IND clearance allows a clinical program to begin or advance in the United States.',
  },
  {
    category: 'Orphan Drug',
    direction: 'BULLISH',
    baseScore: 64,
    test: /\borphan\s+drug\s+(?:designation|status)?\b/i,
    why: 'Orphan Drug designation may provide development incentives and potential market exclusivity.',
  },
  {
    category: 'Trial Enrollment / Readout',
    direction: 'BULLISH',
    baseScore: 54,
    test: /\b(trial\s+enrollment|enrollment\s+(?:complete|completed|completion)|topline\s+(?:data|results?)|data\s+readout|trial\s+readout)\b/i,
    why: 'Enrollment completion or a scheduled readout advances the timeline, but does not establish a positive outcome.',
  },
  {
    category: 'Offering / Dilution',
    direction: 'BEARISH',
    baseScore: 82,
    test: /\b(public\s+offering|registered\s+direct|at-the-market|atm\s+(?:facility|offering|agreement)|private\s+placement|pipe\s+financing|shelf\s+registration|warrant\s+exercise|convertible\s+(?:note|debt)|equity\s+line|share\s+issuance|prices?\s+offering)\b/i,
    why: 'New shares, warrants, or convertible financing can dilute holders and cap momentum.',
  },
  {
    category: 'Reverse Split / Listing Risk',
    direction: 'BEARISH',
    baseScore: 76,
    test: /\b(reverse\s+(?:stock\s+)?split|nasdaq\b.{0,40}\b(noncompliance|deficien(?:cy|t)|minimum\s+bid)|going\s+concern)\b/i,
    why: 'A reverse split, listing deficiency, or going-concern warning signals elevated capital and liquidity risk.',
  },
  {
    category: 'Clinical / Corporate Update',
    direction: 'NEUTRAL',
    baseScore: 38,
    test: CATALYST_TERMS,
    why: 'This is a potentially relevant biotech or financing update, but the headline alone does not prove a major valuation change.',
  },
];

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
}

function normalizeHeadline(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/\b(inc|corp|corporation|company|ltd|plc|announces?|reports?|provides?|update)\b/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 18)
    .join(' ');
}

function classifyCatalyst(headline = '', summary = '') {
  const text = `${headline} ${summary}`.replace(/\s+/g, ' ').trim();
  if (!CATALYST_TERMS.test(text)) return null;
  const rule = RULES.find(r => r.test.test(text)) || RULES[RULES.length - 1];
  return {
    category: rule.category,
    direction: rule.direction,
    baseScore: rule.baseScore,
    why: rule.why,
  };
}

function detectDilution(text = '') {
  const value = String(text);
  const highRules = [
    ['ATM offering', /\bat-the-market|atm\s+(?:facility|offering|agreement)\b/i],
    ['Public offering', /\bpublic\s+offering|registered\s+direct|prices?\s+offering\b/i],
    ['Shelf registration', /\bshelf\s+registration|form\s+s-3\b/i],
    ['Warrant overhang', /\bwarrants?\b|pre-funded\s+warrants?\b/i],
    ['Convertible financing', /\bconvertible\s+(?:note|debt|security)|equity\s+line\b/i],
    ['PIPE / private placement', /\bpipe\s+financing|private\s+placement\b/i],
  ];
  const mediumRules = [
    ['Financing mentioned', /\bfinancing|capital\s+raise|raise[sd]?\s+(?:gross\s+)?proceeds\b/i],
    ['Reverse split', /\breverse\s+(?:stock\s+)?split\b/i],
    ['Going-concern risk', /\bgoing\s+concern\b/i],
  ];
  const high = highRules.filter(([, re]) => re.test(value)).map(([label]) => label);
  const medium = mediumRules.filter(([, re]) => re.test(value)).map(([label]) => label);
  return {
    level: high.length ? 'HIGH' : medium.length ? 'MEDIUM' : 'NONE FOUND',
    flags: [...high, ...medium],
  };
}

function sourceCredibility(article = {}) {
  const source = String(article.source || '').toLowerCase();
  const host = sourceHost(article.url);
  if (hostMatches(host, ['fda.gov'])) return 100;
  if (hostMatches(host, ['sec.gov'])) return 98;
  if (hostMatches(host, ['reuters.com', 'apnews.com', 'bloomberg.com'])) return 94;
  if (hostMatches(host, ['businesswire.com', 'prnewswire.com', 'globenewswire.com'])) return 90;
  if (/food and drug administration/.test(source)) return 82;
  if (/securities and exchange commission/.test(source)) return 80;
  if (/reuters|associated press|bloomberg/.test(source)) return 82;
  if (/businesswire|business wire|prnewswire|pr newswire|globenewswire|globe newswire/.test(source)) return 80;
  if (/investor|company press release/.test(source)) return 76;
  if (/yahoo|marketwatch|benzinga|seeking alpha|financial modeling prep/.test(source)) return 70;
  return article.source ? 62 : 42;
}

function sourceHost(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function hostMatches(host, domains) {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function isCanonicalSource(article = {}) {
  const host = sourceHost(article.url);
  return hostMatches(host, [
    'fda.gov',
    'sec.gov',
    'reuters.com',
    'apnews.com',
    'bloomberg.com',
    'businesswire.com',
    'prnewswire.com',
    'globenewswire.com',
  ]);
}

function scoreExplosiveness(market = {}, catalystScore = 0, dilutionRisk = 'NONE FOUND') {
  let score = catalystScore * 0.32;
  const marketCap = Number(market.marketCap);
  const float = Number(market.float);
  const relVol = Number(market.relVol);
  const change = Number(market.changePct);

  if (Number.isFinite(float) && float > 0) {
    score += float < 10e6 ? 24 : float < 30e6 ? 18 : float < 50e6 ? 12 : float < 100e6 ? 5 : 0;
  }
  if (Number.isFinite(marketCap) && marketCap > 0) {
    score += marketCap < 100e6 ? 18 : marketCap < 500e6 ? 13 : marketCap <= 1e9 ? 7 : 0;
  }
  if (Number.isFinite(relVol) && relVol > 0) {
    score += relVol >= 5 ? 20 : relVol >= 2 ? 13 : relVol >= 1 ? 6 : 0;
  }
  if (Number.isFinite(change)) {
    score += Math.abs(change) >= 20 ? 10 : Math.abs(change) >= 10 ? 7 : Math.abs(change) >= 5 ? 4 : 0;
  }
  if (dilutionRisk === 'HIGH') score -= 18;
  else if (dilutionRisk === 'MEDIUM') score -= 8;
  return clamp(score);
}

function buildCatalystEvent(article, market = {}, now = Date.now()) {
  const classification = classifyCatalyst(article.headline, article.summary);
  if (!classification || !article.symbol) return null;

  const publishedMs = article.publishedAt ? new Date(article.publishedAt).getTime() : NaN;
  const ageHours = Number.isFinite(publishedMs) ? Math.max(0, (now - publishedMs) / 36e5) : null;
  const sourceScore = sourceCredibility(article);
  const dilution = detectDilution(`${article.headline || ''} ${article.summary || ''}`);
  const association = article.association || 'unknown';

  let catalystScore = classification.baseScore;
  if (ageHours != null) {
    if (ageHours <= 2) catalystScore += 3;
    else if (ageHours <= 12) catalystScore += 2;
    else if (ageHours > 48) catalystScore -= 8;
  } else catalystScore -= 8;
  if (sourceScore >= 88) catalystScore += 3;
  if (sourceScore < 60) catalystScore -= 8;
  if (market.marketCap != null && market.marketCap <= 500e6) catalystScore += 2;
  catalystScore = clamp(catalystScore);

  let confidence = 28 + sourceScore * 0.35;
  if (['provider', 'exchange', 'cash-tag'].includes(association)) confidence += 14;
  else if (association === 'symbol-search') confidence += 7;
  if (ageHours != null) confidence += 8;
  if (market.price != null && market.marketCap != null) confidence += 8;
  if (article.url) confidence += 4;
  confidence = clamp(confidence);

  const verified = isCanonicalSource(article)
    && !!article.url
    && ageHours != null
    && ['provider', 'exchange', 'cash-tag'].includes(association);

  const riskFlags = [...dilution.flags];
  if (market.float == null) riskFlags.push('Float unavailable');
  if (market.marketCap == null) riskFlags.push('Market cap unavailable');
  if (market.relVol == null) riskFlags.push('Relative volume unavailable');
  if (!verified) riskFlags.push('Single-source / association unverified');

  const explosivenessScore = scoreExplosiveness(market, catalystScore, dilution.level);
  const technical = clamp(
    (Math.min(Math.abs(Number(market.changePct) || 0), 25) / 25) * 55
      + (Math.min(Number(market.relVol) || 0, 5) / 5) * 45
  );
  let opportunityScore = catalystScore * 0.38
    + explosivenessScore * 0.30
    + confidence * 0.17
    + technical * 0.15;
  if (classification.direction.includes('BEARISH')) opportunityScore -= 28;
  if (dilution.level === 'HIGH') opportunityScore -= 12;
  opportunityScore = clamp(opportunityScore);

  const moveContext = market.relVol != null
    ? ` Price action is running at ${Number(market.relVol).toFixed(1)}× relative volume.`
    : ' Relative-volume confirmation is unavailable.';

  return {
    symbol: String(article.symbol).toUpperCase(),
    company: market.company || article.company || String(article.symbol).toUpperCase(),
    price: market.price ?? null,
    changePct: market.changePct ?? null,
    volume: market.volume ?? null,
    relVol: market.relVol ?? null,
    marketCap: market.marketCap ?? null,
    float: market.float ?? null,
    floatSource: market.floatSource ?? null,
    headline: article.headline,
    url: article.url || null,
    source: article.source || 'Source unavailable',
    publishedAt: ageHours != null ? new Date(publishedMs).toISOString() : null,
    category: classification.category,
    direction: classification.direction,
    catalystScore,
    explosivenessScore,
    confidence,
    dilutionRisk: dilution.level,
    riskFlags: [...new Set(riskFlags)],
    whyItMatters: classification.why + moveContext,
    verified,
    opportunityScore,
    duplicateCount: 1,
    views: [
      ...([
        'FDA Approval',
        'FDA Rejection',
        'Clinical Hold',
        'Clinical Failure / Safety',
        'Positive Phase 3',
        'Positive Phase 2',
        'Breakthrough Therapy',
        'Fast Track',
        'FDA Application / PDUFA',
        'Positive Interim Data',
        'IND Clearance',
        'Orphan Drug',
        'Trial Enrollment / Readout',
      ].includes(classification.category) ? ['fda'] : []),
      ...(classification.direction.includes('BEARISH') || dilution.level !== 'NONE FOUND' ? ['risk'] : []),
    ],
    sourceScore,
  };
}

function tokenSimilarity(a, b) {
  const aa = new Set(normalizeHeadline(a).split(' ').filter(Boolean));
  const bb = new Set(normalizeHeadline(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection++;
  return intersection / new Set([...aa, ...bb]).size;
}

function dedupeEvents(events = []) {
  const out = [];
  for (const event of events.filter(Boolean)) {
    const duplicate = out.find(existing =>
      existing.symbol === event.symbol
      && (normalizeHeadline(existing.headline) === normalizeHeadline(event.headline)
        || tokenSimilarity(existing.headline, event.headline) >= 0.68)
    );
    if (!duplicate) {
      out.push({ ...event });
      continue;
    }
    duplicate.duplicateCount = (duplicate.duplicateCount || 1) + 1;
    duplicate.confidence = clamp(Math.max(duplicate.confidence, event.confidence) + 3);
    duplicate.verified = duplicate.verified || event.verified;
    if ((event.sourceScore || 0) > (duplicate.sourceScore || 0)) {
      const count = duplicate.duplicateCount;
      Object.assign(duplicate, event, { duplicateCount: count, confidence: duplicate.confidence });
    }
  }
  return out;
}

module.exports = {
  CATALYST_TERMS,
  clamp,
  normalizeHeadline,
  classifyCatalyst,
  detectDilution,
  sourceCredibility,
  isCanonicalSource,
  scoreExplosiveness,
  buildCatalystEvent,
  dedupeEvents,
};