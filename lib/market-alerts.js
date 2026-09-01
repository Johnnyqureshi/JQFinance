'use strict';

const MARKET_TERMS = [
  /\bmarket(?:s)?\b/i,
  /\bstock(?:s)?\b/i,
  /\bequities\b/i,
  /\bfutures\b/i,
  /\bS&P\s*500\b/i,
  /\bNasdaq\b/i,
  /\bDow Jones\b/i,
  /\bTreasur(?:y|ies)\b/i,
  /\bbond yields?\b/i,
  /\binterest rates?\b/i,
  /\bFederal Reserve\b/i,
  /\b(?:Fed|FOMC)\b/i,
  /\binflation\b/i,
  /\bCPI\b/i,
  /\bjobs report\b/i,
  /\b(?:oil|crude|gasoline) prices?\b/i,
  /\bgold prices?\b/i,
  /\b(?:U\.S\. )?dollar\b/i,
  /\bforex\b/i,
  /\bBitcoin\b/i,
];

const IMPACT_TERMS = [
  /\bplunge[sd]?\b/i,
  /\bsurgeb?d?\b/i,
  /\brall(?:y|ied|ies|ying)\b/i,
  /\btumbl(?:e|ed|es|ing)\b/i,
  /\bcrash(?:ed|es|ing)?\b/i,
  /\bsell[-\s]?off\b/i,
  /\bsoar(?:ed|s|ing)?\b/i,
  /\bslump(?:ed|s|ing)?\b/i,
  /\bhighest\b/i,
  /\blowest\b/i,
  /\brecord\b/i,
  /\b(?:surprise|unexpected|emergency|shock|crisis)\b/i,
  /\b(?:cuts?|hikes?|raises?|holds?|keeps?)\b/i,
  /\b(?:ban|bans|banned|halt|halted|default|downgrade|downgrades)\b/i,
  /\b(?:war|invasion|missile|sanctions?|ceasefire)\b/i,
];

const MACRO_TERMS = [
  /\bFederal Reserve\b/i,
  /\b(?:Fed|FOMC)\b/i,
  /\binterest rates?\b/i,
  /\binflation\b/i,
  /\bCPI\b/i,
  /\bjobs report\b/i,
  /\bpayrolls?\b/i,
  /\bunemployment\b/i,
  /\bTreasur(?:y|ies)\b/i,
  /\bbond yields?\b/i,
  /\btariffs?\b/i,
  /\bsanctions?\b/i,
  /\bcentral bank\b/i,
  /\bgeopolitical\b/i,
];

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeMarketArticle(article, nowMs = Date.now()) {
  const headline = String(article?.headline || article?.title || '').replace(/\s+/g, ' ').trim();
  if (!headline || headline === '[Removed]') return null;

  const publishedAt = article?.publishedAt || article?.published_at || (
    Number.isFinite(Number(article?.providerPublishTime))
      ? new Date(Number(article.providerPublishTime) * 1000).toISOString()
      : null
  );
  const timestamp = publishedAt ? Date.parse(publishedAt) : NaN;
  if (!Number.isFinite(timestamp)) return null;
  const ageMs = nowMs - timestamp;
  if (ageMs < -15 * 60 * 1000 || ageMs > 6 * 60 * 60 * 1000) return null;

  const summary = String(article?.summary || article?.description || '').replace(/\s+/g, ' ').trim();
  const text = `${headline} ${summary}`;
  const marketMatches = MARKET_TERMS.filter(term => term.test(text)).length;
  const impactMatches = IMPACT_TERMS.filter(term => term.test(text)).length;
  const macroMatches = MACRO_TERMS.filter(term => term.test(text)).length;
  const score = marketMatches * 2 + impactMatches * 2 + macroMatches;

  // A market term plus an explicit impact/event term is the minimum bar.
  // Macro-only stories stay out of the band unless two separate macro signals
  // are present, which keeps ordinary economic explainers from being noisy.
  if (!((marketMatches > 0 && impactMatches > 0) || macroMatches >= 2)) return null;
  if (score < 4) return null;

  const sourceValue = typeof article?.source === 'object' ? article.source?.name : article?.source;
  const source = String(sourceValue || article?.publisher || '').trim();
  const url = safeUrl(article?.url || article?.link);
  const id = `${headline.toLowerCase()}|${timestamp}|${source.toLowerCase()}`;
  return {
    id,
    headline,
    summary,
    source: source || 'Market news',
    url,
    publishedAt: new Date(timestamp).toISOString(),
    score,
  };
}

function selectMarketAlerts(articles, { nowMs = Date.now(), limit = 5 } = {}) {
  const seen = new Set();
  return (Array.isArray(articles) ? articles : [])
    .map(article => normalizeMarketArticle(article, nowMs))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.score - a.score)
    .filter(article => {
      const key = article.headline.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
}

module.exports = {
  normalizeMarketArticle,
  selectMarketAlerts,
};