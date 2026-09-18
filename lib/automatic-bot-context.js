const CONTRACT_VERSION = 1;
const SOURCE_NAMES = ['news', 'sentiment', 'seasonality', 'federalReserve', 'macro', 'marketRegime', 'portfolioExposure'];

function finiteTime(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSource(name, source, now) {
  const maxAgeMs = Number(source?.maxAgeMs);
  const asOfMs = finiteTime(source?.asOf ?? source?.generatedAt);
  const hasData = source?.data !== undefined && source?.data !== null;
  const ageMs = asOfMs == null ? null : Math.max(0, now - asOfMs);
  const timestampValid = asOfMs != null && asOfMs <= now;
  const fresh = hasData && timestampValid && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs <= maxAgeMs;
  let status = 'fresh';
  let reason = null;
  if (!hasData) {
    status = 'unavailable';
    reason = source?.reason || `${name} context is unavailable.`;
  } else if (!timestampValid) {
    status = 'unavailable';
    reason = `${name} context has no valid observation time.`;
  } else if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    status = 'unavailable';
    reason = `${name} context has no valid freshness limit.`;
  } else if (!fresh) {
    status = 'stale';
    reason = `${name} context is older than its ${maxAgeMs}ms freshness limit.`;
  }
  return {
    status, fresh, asOf: asOfMs == null ? null : new Date(asOfMs).toISOString(),
    ageMs, maxAgeMs: Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : null,
    data: fresh ? source.data : null, reason,
  };
}

function buildAutomaticBotContext(rawSources = {}, { now = Date.now(), generation } = {}) {
  const generatedAt = new Date(now).toISOString();
  const sources = Object.fromEntries(SOURCE_NAMES.map(name => [
    name,
    normalizeSource(name, rawSources[name], now),
  ]));
  const staleSources = SOURCE_NAMES.filter(name => sources[name].status === 'stale');
  const missingSources = SOURCE_NAMES.filter(name => sources[name].status === 'unavailable');
  return {
    contract: 'automatic-bot-market-context',
    version: CONTRACT_VERSION,
    generation: generation || generatedAt,
    generatedAt,
    sources,
    freshness: {
      complete: staleSources.length === 0 && missingSources.length === 0,
      staleSources,
      missingSources,
    },
    strategyAuthority: 'advisory-only',
  };
}

function consumeAutomaticBotContext(context, policy = {}) {
  const requiredSources = Array.isArray(policy.requiredSources)
    ? [...new Set(policy.requiredSources.filter(name => SOURCE_NAMES.includes(name)))]
    : [];
  const blockers = requiredSources
    .filter(name => context?.sources?.[name]?.fresh !== true)
    .map(name => context?.sources?.[name]?.reason || `${name} context is not fresh.`);
  return {
    context,
    policy: { name: policy.name || 'advisory', requiredSources },
    entryAllowed: blockers.length === 0,
    blockers,
    preservesStrategyRules: true,
  };
}

module.exports = {
  CONTRACT_VERSION,
  SOURCE_NAMES,
  buildAutomaticBotContext,
  consumeAutomaticBotContext,
};