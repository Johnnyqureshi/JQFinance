---
name: API data sources audit
description: All external data sources, their primary/fallback chain, and live status as of Aug 2026
---

## Data source map

| Feature | Primary | Fallback | Key required | Status |
|---|---|---|---|---|
| Stock quotes | Alpaca snapshots | Yahoo Finance yf.quote | ALPACA_API_KEY | ✓ Live |
| Scanner batch | Yahoo Finance yf.quote | none | none | ✓ Live |
| News | NewsAPI | FMP → Yahoo search | NEWS_KEY / FMP_KEY | ✓ Live |
| Historical bars | Yahoo Finance chart API | none | none | ✓ Live |
| Analyst ratings | FMP | none | FMP_KEY | ✓ Live |
| Economic calendar | FMP economic-calendar | ECO_CALENDAR_2026 hardcoded | FMP_KEY | ✓ Live (FMP) |
| Earnings calendar | FMP earning-calendar | none | FMP_KEY | ✓ Live |
| SPY-Gate options | yf.options('SPY') chain OI | none | none | ✓ Live |
| Crypto prices | Alpaca snapshots | Yahoo yf.quote | ALPACA_API_KEY | ✓ Live |
| WSB/Reddit trending | ApeWisdom (no key) | none | none | ✓ Live |
| Futures | Yahoo Finance | none | none | ✓ Live |
| AI agent chat | AIML_API_KEY | none | AIML_API_KEY | ✓ Live |
| Voice assistant | ElevenLabs SDK | none | ELEVENLABS_AGENT_ID + KEY | ✗ OFFLINE — keys missing |

## Critical notes

- `FMP_API_KEY` is 32 chars and SET — analyst, earnings, news fallback, economic calendar all work
- `NEWSAPI_KEY` is 32 chars and SET — primary news source
- `ELEVENLABS_AGENT_ID` and `ELEVENLABS_API_KEY` are MISSING — voice chat shows error in UI
- Yahoo Finance `floatShares` field is unreliable — frequently null; treat as optional everywhere
- ECO_CALENDAR_2026 hardcoded fallback covers Aug–Dec 2026 with accurate macro dates
- No mock/fake/random market data anywhere in the codebase — confirmed by full audit

**Why:** Knowing the exact source chain prevents hunting for the wrong API when a feature goes dark.
