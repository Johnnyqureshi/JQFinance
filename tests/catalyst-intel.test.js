/**
 * Deterministic tests for biotech catalyst classification, scoring, risk flags,
 * source quality, missing-data honesty, and duplicate merging.
 * Run with: node tests/catalyst-intel.test.js
 */
'use strict';

const assert = require('assert');
const {
  classifyCatalyst,
  detectDilution,
  sourceCredibility,
  isCanonicalSource,
  buildCatalystEvent,
  dedupeEvents,
} = require('../lib/catalyst-intel');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

const NOW = Date.parse('2026-08-20T15:00:00.000Z');
const strongMarket = {
  company: 'Example Bio Inc.',
  price: 4.72,
  changePct: 18.4,
  volume: 8_000_000,
  relVol: 6.2,
  marketCap: 140_000_000,
  float: 8_500_000,
  floatSource: 'floatShares',
};

console.log('\nCatalyst classification\n');

test('FDA approval is very bullish and scores at the top tier', () => {
  const result = classifyCatalyst('FDA approves Example Bio therapy');
  assert.strictEqual(result.category, 'FDA Approval');
  assert.strictEqual(result.direction, 'VERY BULLISH');
  assert(result.baseScore >= 95);
});

test('positive Phase 3 data is distinguished from a routine clinical update', () => {
  const result = classifyCatalyst('Example Bio reports positive Phase 3 results and meets primary endpoint');
  assert.strictEqual(result.category, 'Positive Phase 3');
  assert.strictEqual(result.direction, 'VERY BULLISH');
});

test('FDA rejection is very bearish', () => {
  const result = classifyCatalyst('FDA rejects Example Bio application with Complete Response Letter');
  assert.strictEqual(result.category, 'FDA Rejection');
  assert.strictEqual(result.direction, 'VERY BEARISH');
});

test('unrelated popular-stock headline is not treated as a catalyst', () => {
  assert.strictEqual(classifyCatalyst('Analysts discuss technology stocks before the open'), null);
});
test('classifies broader positive and negative market catalysts without assuming every headline is bullish', () => {
  assert.strictEqual(classifyCatalyst('Company raises full-year guidance after earnings beat').category, 'Earnings / Guidance Beat');
  assert.strictEqual(classifyCatalyst('Analyst downgrades shares and cuts price target').direction, 'BEARISH');
  assert.strictEqual(classifyCatalyst('Company wins major government contract').category, 'Major Contract / Award');
  assert.strictEqual(classifyCatalyst('SEC investigation and class action lawsuit announced').direction, 'BEARISH');
  assert.strictEqual(classifyCatalyst('Company reports earnings miss').direction, 'BEARISH');
  assert.strictEqual(classifyCatalyst('Company revenue misses estimates').direction, 'BEARISH');
  assert.strictEqual(classifyCatalyst('Company cuts outlook for the year').direction, 'BEARISH');
  assert.strictEqual(classifyCatalyst('Company withdraws forecast').direction, 'BEARISH');
  assert.strictEqual(classifyCatalyst('Company posts wider than expected loss').direction, 'BEARISH');
});

test('labels catalyst freshness using explicit 15-minute, 1-hour, 4-hour, and 24-hour buckets', () => {
  const market = { price:10, marketCap:100e6, relVol:2 };
  const make = hours => buildCatalystEvent({
    symbol:'ABCD', headline:'ABCD wins major government contract', source:'Reuters',
    url:'https://www.reuters.com/example', association:'provider',
    publishedAt:new Date(NOW - hours * 36e5).toISOString(),
  }, market, NOW);
  assert.strictEqual(make(.1).freshnessBucket, 'LAST_15_MINUTES');
  assert.strictEqual(make(.5).freshnessBucket, 'LAST_HOUR');
  assert.strictEqual(make(3).freshnessBucket, 'LAST_4_HOURS');
  assert.strictEqual(make(12).freshnessBucket, 'LAST_24_HOURS');
  assert.strictEqual(make(30).freshnessBucket, 'OLDER');
  assert.strictEqual(make(30).actionableFresh, false);
  assert(make(30).opportunityScore <= 35);
  assert(make(.1).opportunityScore > make(30).opportunityScore);
});

console.log('\nDilution and source quality\n');

test('registered direct offering receives HIGH dilution risk', () => {
  const dilution = detectDilution('Company prices a $25 million registered direct offering with pre-funded warrants');
  assert.strictEqual(dilution.level, 'HIGH');
  assert(dilution.flags.some(f => /offering/i.test(f)));
  assert(dilution.flags.some(f => /warrant/i.test(f)));
});

test('FDA and SEC links rank above generic aggregators', () => {
  const fda = sourceCredibility({ source: 'FDA', url: 'https://www.fda.gov/news-events/example' });
  const generic = sourceCredibility({ source: 'Unknown Blog', url: 'https://example.test/post' });
  assert(fda > generic);
  assert.strictEqual(fda, 100);
});

test('canonical source validation rejects lookalike and aggregator URLs', () => {
  assert.strictEqual(isCanonicalSource({ url: 'https://www.fda.gov/news-events/example' }), true);
  assert.strictEqual(isCanonicalSource({ url: 'https://fda.gov.evil.example/story' }), false);
  assert.strictEqual(isCanonicalSource({ source: 'Reuters', url: 'https://aggregator.example/reuters-story' }), false);
});

test('IND, Fast Track, Breakthrough, and Orphan events carry the FDA view tag', () => {
  const headlines = [
    'ABCD reports IND clearance for lead program',
    'ABCD receives Fast Track designation',
    'ABCD receives Breakthrough Therapy designation',
    'ABCD receives Orphan Drug designation',
  ];
  for (const headline of headlines) {
    const event = buildCatalystEvent({
      symbol: 'ABCD',
      headline,
      source: 'Business Wire',
      url: 'https://www.businesswire.com/news/example',
      publishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      association: 'provider',
    }, strongMarket, NOW);
    assert(event.views.includes('fda'), `missing fda tag for: ${headline}`);
  }
});

test('bearish and dilution events carry the risk view tag', () => {
  const event = buildCatalystEvent({
    symbol: 'ABCD',
    headline: 'ABCD prices registered direct offering with warrants',
    source: 'Business Wire',
    url: 'https://www.businesswire.com/news/example',
    publishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    association: 'provider',
  }, strongMarket, NOW);
  assert(event.views.includes('risk'));
});

console.log('\nEvent construction and score bounds\n');

test('source-linked FDA event includes all bounded scores', () => {
  const event = buildCatalystEvent({
    symbol: 'ABCD',
    headline: 'FDA approves ABCD novel therapy',
    summary: 'The FDA approved the treatment.',
    source: 'U.S. Food and Drug Administration',
    url: 'https://www.fda.gov/news-events/abcd',
    publishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    association: 'exchange',
  }, strongMarket, NOW);
  assert(event.verified);
  for (const key of ['catalystScore', 'explosivenessScore', 'confidence', 'opportunityScore']) {
    assert(event[key] >= 0 && event[key] <= 100, `${key} out of bounds: ${event[key]}`);
  }
  assert.strictEqual(event.float, strongMarket.float);
  assert(event.whyItMatters.length > 20);
});

test('missing market values are declared, not fabricated', () => {
  const event = buildCatalystEvent({
    symbol: 'EFGH',
    headline: 'EFGH receives FDA Fast Track designation',
    source: 'Company press release',
    url: 'https://example.test/release',
    publishedAt: null,
    association: 'symbol-search',
  }, { company: 'EFGH Bio', price: 3.5 }, NOW);
  assert.strictEqual(event.float, null);
  assert.strictEqual(event.marketCap, null);
  assert.strictEqual(event.relVol, null);
  assert.strictEqual(event.publishedAt, null);
  assert.strictEqual(event.verified, false);
  assert(event.riskFlags.includes('Float unavailable'));
  assert(event.riskFlags.includes('Market cap unavailable'));
  assert(event.riskFlags.includes('Relative volume unavailable'));
});

test('dilution materially lowers opportunity versus strong FDA approval', () => {
  const common = {
    symbol: 'IJKL',
    source: 'Business Wire',
    url: 'https://businesswire.com/example',
    publishedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    association: 'provider',
  };
  const approval = buildCatalystEvent({ ...common, headline: 'FDA approves IJKL therapy' }, strongMarket, NOW);
  const offering = buildCatalystEvent({ ...common, headline: 'IJKL prices registered direct offering with warrants' }, strongMarket, NOW);
  assert.strictEqual(offering.dilutionRisk, 'HIGH');
  assert(offering.opportunityScore < approval.opportunityScore);
  assert(offering.explosivenessScore < approval.explosivenessScore);
});

console.log('\nDuplicate handling\n');

test('syndicated versions merge and retain the stronger source', () => {
  const baseArticle = {
    symbol: 'MNOP',
    headline: 'MNOP reports positive Phase 2 results in pivotal study',
    publishedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
    association: 'provider',
  };
  const generic = buildCatalystEvent({
    ...baseArticle,
    source: 'Unknown Blog',
    url: 'https://example.test/story',
  }, strongMarket, NOW);
  const wire = buildCatalystEvent({
    ...baseArticle,
    headline: 'MNOP reports positive Phase 2 results from pivotal study',
    source: 'Business Wire',
    url: 'https://businesswire.com/story',
  }, strongMarket, NOW);
  const merged = dedupeEvents([generic, wire]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].duplicateCount, 2);
  assert.strictEqual(merged[0].source, 'Business Wire');
});

test('exact duplicates retain the canonical URL regardless of provider order', () => {
  const article = {
    symbol: 'QRST',
    headline: 'QRST receives FDA Fast Track designation for lead therapy',
    publishedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    association: 'provider',
  };
  const aggregator = buildCatalystEvent({
    ...article,
    source: 'Newswire Aggregator',
    url: 'https://aggregator.example/story',
  }, strongMarket, NOW);
  const canonical = buildCatalystEvent({
    ...article,
    source: 'Business Wire',
    url: 'https://www.businesswire.com/news/example',
    publishedAt: new Date(NOW - 4 * 60 * 60 * 1000).toISOString(),
  }, strongMarket, NOW);
  for (const input of [[aggregator, canonical], [canonical, aggregator]]) {
    const merged = dedupeEvents(input);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].duplicateCount, 2);
    assert.strictEqual(merged[0].source, 'Business Wire');
    assert.strictEqual(merged[0].url, 'https://www.businesswire.com/news/example');
  }
});

console.log(`\n${'─'.repeat(52)}\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);