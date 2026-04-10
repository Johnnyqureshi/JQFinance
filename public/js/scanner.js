// ── Johnny Qureshi Finance — Stock Scanner ──────────────────────────────────────
// API CONFIG — swap in live keys here
// const CFG = {
//   alphaVantage: 'YOUR_KEY', // https://www.alphavantage.co
//   polygon:      'YOUR_KEY', // https://polygon.io
//   finviz:       'YOUR_KEY', // https://finviz.com/elite
// };
// Currently uses the site's Yahoo Finance proxy — no key required.

const scanner = (() => {

  // ── Stock Universe ──────────────────────────────────────────────────────────
  const UNIVERSE = [
    // ── Large Cap Tech ────────────────────────────────────────────────────────
    {sym:'AAPL',  name:'Apple',              sector:'Technology',  mcap:'Large', float:15200},
    {sym:'MSFT',  name:'Microsoft',          sector:'Technology',  mcap:'Large', float:7400},
    {sym:'NVDA',  name:'NVIDIA',             sector:'Technology',  mcap:'Large', float:24200},
    {sym:'GOOGL', name:'Alphabet',           sector:'Technology',  mcap:'Large', float:12000},
    {sym:'META',  name:'Meta Platforms',     sector:'Technology',  mcap:'Large', float:2550},
    {sym:'AMZN',  name:'Amazon',             sector:'Technology',  mcap:'Large', float:10500},
    {sym:'AMD',   name:'AMD',                sector:'Technology',  mcap:'Large', float:1620},
    {sym:'INTC',  name:'Intel',              sector:'Technology',  mcap:'Large', float:4310},
    {sym:'ORCL',  name:'Oracle',             sector:'Technology',  mcap:'Large', float:2720},
    {sym:'CRM',   name:'Salesforce',         sector:'Technology',  mcap:'Large', float:960},
    {sym:'NFLX',  name:'Netflix',            sector:'Technology',  mcap:'Large', float:430},
    {sym:'ADBE',  name:'Adobe',              sector:'Technology',  mcap:'Large', float:440},
    {sym:'CRWD',  name:'CrowdStrike',        sector:'Technology',  mcap:'Large', float:240},
    {sym:'ARM',   name:'ARM Holdings',       sector:'Technology',  mcap:'Large', float:840},
    {sym:'AVGO',  name:'Broadcom',           sector:'Technology',  mcap:'Large', float:4200},
    {sym:'QCOM',  name:'Qualcomm',           sector:'Technology',  mcap:'Large', float:1680},
    {sym:'TXN',   name:'Texas Instruments',  sector:'Technology',  mcap:'Large', float:910},
    {sym:'MU',    name:'Micron',             sector:'Technology',  mcap:'Large', float:1110},
    {sym:'AMAT',  name:'Applied Materials',  sector:'Technology',  mcap:'Large', float:860},
    {sym:'KLAC',  name:'KLA Corporation',    sector:'Technology',  mcap:'Large', float:143},
    {sym:'NOW',   name:'ServiceNow',         sector:'Technology',  mcap:'Large', float:205},
    {sym:'SNOW',  name:'Snowflake',          sector:'Technology',  mcap:'Large', float:325},
    // ── Mid/Small Tech & Growth ───────────────────────────────────────────────
    {sym:'SMCI',  name:'Super Micro',        sector:'Technology',  mcap:'Mid',   float:530},
    {sym:'PLTR',  name:'Palantir',           sector:'Technology',  mcap:'Mid',   float:2100},
    {sym:'DDOG',  name:'Datadog',            sector:'Technology',  mcap:'Mid',   float:320},
    {sym:'NET',   name:'Cloudflare',         sector:'Technology',  mcap:'Mid',   float:330},
    {sym:'RBLX',  name:'Roblox',             sector:'Technology',  mcap:'Mid',   float:640},
    {sym:'ABNB',  name:'Airbnb',             sector:'Technology',  mcap:'Mid',   float:630},
    {sym:'DASH',  name:'DoorDash',           sector:'Technology',  mcap:'Mid',   float:420},
    {sym:'UBER',  name:'Uber',               sector:'Technology',  mcap:'Mid',   float:2090},
    {sym:'SNAP',  name:'Snap',               sector:'Technology',  mcap:'Mid',   float:1630},
    {sym:'PINS',  name:'Pinterest',          sector:'Technology',  mcap:'Mid',   float:1370},
    {sym:'U',     name:'Unity Software',     sector:'Technology',  mcap:'Small', float:360},
    {sym:'IONQ',  name:'IonQ',               sector:'Technology',  mcap:'Small', float:130},
    {sym:'PATH',  name:'UiPath',             sector:'Technology',  mcap:'Mid',   float:540},
    {sym:'AI',    name:'C3.ai',              sector:'Technology',  mcap:'Small', float:195},
    {sym:'BBAI',  name:'BigBear.ai',         sector:'Technology',  mcap:'Small', float:180},
    {sym:'SOUN',  name:'SoundHound AI',      sector:'Technology',  mcap:'Small', float:410},
    {sym:'RXRX',  name:'Recursion Pharma',   sector:'Technology',  mcap:'Small', float:290},
    // ── Finance ───────────────────────────────────────────────────────────────
    {sym:'JPM',   name:'JPMorgan',           sector:'Finance',     mcap:'Large', float:2870},
    {sym:'BAC',   name:'Bank of America',    sector:'Finance',     mcap:'Large', float:7900},
    {sym:'GS',    name:'Goldman Sachs',      sector:'Finance',     mcap:'Large', float:325},
    {sym:'MS',    name:'Morgan Stanley',     sector:'Finance',     mcap:'Large', float:1630},
    {sym:'V',     name:'Visa',               sector:'Finance',     mcap:'Large', float:2080},
    {sym:'MA',    name:'Mastercard',         sector:'Finance',     mcap:'Large', float:930},
    {sym:'WFC',   name:'Wells Fargo',        sector:'Finance',     mcap:'Large', float:3380},
    {sym:'C',     name:'Citigroup',          sector:'Finance',     mcap:'Large', float:1910},
    {sym:'AXP',   name:'American Express',   sector:'Finance',     mcap:'Large', float:735},
    {sym:'COIN',  name:'Coinbase',           sector:'Finance',     mcap:'Mid',   float:235},
    {sym:'HOOD',  name:'Robinhood',          sector:'Finance',     mcap:'Small', float:420},
    {sym:'SOFI',  name:'SoFi Technologies',  sector:'Finance',     mcap:'Small', float:980},
    {sym:'NU',    name:'Nu Holdings',        sector:'Finance',     mcap:'Mid',   float:4620},
    // ── Healthcare / Biotech ──────────────────────────────────────────────────
    {sym:'JNJ',   name:'Johnson & Johnson',  sector:'Healthcare',  mcap:'Large', float:2400},
    {sym:'PFE',   name:'Pfizer',             sector:'Healthcare',  mcap:'Large', float:5680},
    {sym:'ABBV',  name:'AbbVie',             sector:'Healthcare',  mcap:'Large', float:1760},
    {sym:'MRK',   name:'Merck',              sector:'Healthcare',  mcap:'Large', float:2540},
    {sym:'UNH',   name:'UnitedHealth',       sector:'Healthcare',  mcap:'Large', float:920},
    {sym:'LLY',   name:'Eli Lilly',          sector:'Healthcare',  mcap:'Large', float:950},
    {sym:'AMGN',  name:'Amgen',              sector:'Healthcare',  mcap:'Large', float:534},
    {sym:'MRNA',  name:'Moderna',            sector:'Healthcare',  mcap:'Mid',   float:380},
    {sym:'BNTX',  name:'BioNTech',           sector:'Healthcare',  mcap:'Mid',   float:195},
    {sym:'NVAX',  name:'Novavax',            sector:'Healthcare',  mcap:'Small', float:145},
    {sym:'ACHR',  name:'Archer Aviation',    sector:'Healthcare',  mcap:'Small', float:380},
    // ── Energy ────────────────────────────────────────────────────────────────
    {sym:'XOM',   name:'ExxonMobil',         sector:'Energy',      mcap:'Large', float:3980},
    {sym:'CVX',   name:'Chevron',            sector:'Energy',      mcap:'Large', float:1870},
    {sym:'SLB',   name:'SLB',                sector:'Energy',      mcap:'Mid',   float:1400},
    {sym:'OXY',   name:'Occidental',         sector:'Energy',      mcap:'Mid',   float:914},
    {sym:'MPC',   name:'Marathon Petroleum', sector:'Energy',      mcap:'Mid',   float:390},
    // ── Consumer ─────────────────────────────────────────────────────────────
    {sym:'WMT',   name:'Walmart',            sector:'Consumer',    mcap:'Large', float:8050},
    {sym:'COST',  name:'Costco',             sector:'Consumer',    mcap:'Large', float:442},
    {sym:'SBUX',  name:'Starbucks',          sector:'Consumer',    mcap:'Mid',   float:1130},
    {sym:'NKE',   name:'Nike',               sector:'Consumer',    mcap:'Large', float:1530},
    {sym:'MCD',   name:"McDonald's",         sector:'Consumer',    mcap:'Large', float:727},
    {sym:'DIS',   name:'Walt Disney',        sector:'Consumer',    mcap:'Large', float:1830},
    {sym:'SPOT',  name:'Spotify',            sector:'Consumer',    mcap:'Mid',   float:192},
    // ── EV / Auto ─────────────────────────────────────────────────────────────
    {sym:'TSLA',  name:'Tesla',              sector:'EV / Auto',   mcap:'Large', float:3190},
    {sym:'RIVN',  name:'Rivian',             sector:'EV / Auto',   mcap:'Small', float:950},
    {sym:'LCID',  name:'Lucid',              sector:'EV / Auto',   mcap:'Small', float:2200},
    {sym:'GM',    name:'General Motors',     sector:'EV / Auto',   mcap:'Large', float:1430},
    {sym:'F',     name:'Ford',               sector:'EV / Auto',   mcap:'Large', float:3970},
    // ── Crypto / Mining ───────────────────────────────────────────────────────
    {sym:'MARA',  name:'MARA Holdings',      sector:'Crypto',      mcap:'Small', float:360},
    {sym:'RIOT',  name:'Riot Platforms',     sector:'Crypto',      mcap:'Small', float:290},
    {sym:'CLSK',  name:'CleanSpark',         sector:'Crypto',      mcap:'Small', float:170},
    {sym:'HIVE',  name:'HIVE Digital',       sector:'Crypto',      mcap:'Small', float:195},
    {sym:'CIFR',  name:'Cipher Mining',      sector:'Crypto',      mcap:'Small', float:310},
    {sym:'HUT',   name:'Hut 8',              sector:'Crypto',      mcap:'Small', float:220},
    {sym:'IREN',  name:'Iris Energy',        sector:'Crypto',      mcap:'Small', float:175},
    {sym:'BTBT',  name:'Bit Brother',        sector:'Crypto',      mcap:'Small', float:390},
    // ── Volatility Products ───────────────────────────────────────────────────
    {sym:'UVIX',  name:'2x Long VIX Futures (ProShares)', sector:'Volatility', mcap:'Small', float:42},
    {sym:'UVXY',  name:'1.5x Long VIX Futures',           sector:'Volatility', mcap:'Small', float:180},
    {sym:'SVXY',  name:'0.5x Short VIX Futures',          sector:'Volatility', mcap:'Small', float:45},
    {sym:'VXX',   name:'S&P 500 VIX Short-Term Futures',  sector:'Volatility', mcap:'Mid',   float:620},
    {sym:'VIXY',  name:'ProShares VIX Short-Term',        sector:'Volatility', mcap:'Small', float:75},
    {sym:'VIXM',  name:'ProShares VIX Mid-Term',          sector:'Volatility', mcap:'Small', float:28},
    {sym:'TVIX',  name:'Daily 2x VIX Short-Term',         sector:'Volatility', mcap:'Small', float:30},
    // ── Leveraged Bull ETFs (3x / 2x) ────────────────────────────────────────
    {sym:'TQQQ',  name:'3x Nasdaq-100 Bull (ProShares)',  sector:'Lev ETF (Bull)', mcap:'Large', float:4200},
    {sym:'UPRO',  name:'3x S&P 500 Bull (ProShares)',     sector:'Lev ETF (Bull)', mcap:'Large', float:2100},
    {sym:'UDOW',  name:'3x Dow Jones Bull (ProShares)',   sector:'Lev ETF (Bull)', mcap:'Mid',   float:480},
    {sym:'TNA',   name:'3x Small Cap Bull (Direxion)',    sector:'Lev ETF (Bull)', mcap:'Mid',   float:920},
    {sym:'SOXL',  name:'3x Semis Bull (Direxion)',        sector:'Lev ETF (Bull)', mcap:'Large', float:3100},
    {sym:'TECL',  name:'3x Tech Bull (Direxion)',         sector:'Lev ETF (Bull)', mcap:'Mid',   float:780},
    {sym:'LABU',  name:'3x Biotech Bull (Direxion)',      sector:'Lev ETF (Bull)', mcap:'Mid',   float:620},
    {sym:'FNGU',  name:'3x FANG+ Bull (MicroSectors)',    sector:'Lev ETF (Bull)', mcap:'Mid',   float:290},
    {sym:'ERX',   name:'2x Energy Bull (Direxion)',       sector:'Lev ETF (Bull)', mcap:'Small', float:310},
    {sym:'UCO',   name:'2x Crude Oil Bull (ProShares)',   sector:'Lev ETF (Bull)', mcap:'Small', float:230},
    {sym:'NUGT',  name:'2x Gold Miners Bull (Direxion)',  sector:'Lev ETF (Bull)', mcap:'Small', float:185},
    {sym:'BOIL',  name:'2x Natural Gas Bull (ProShares)', sector:'Lev ETF (Bull)', mcap:'Small', float:145},
    {sym:'DPST',  name:'3x Regional Banks Bull (Direxion)',sector:'Lev ETF (Bull)',mcap:'Small', float:195},
    {sym:'NAIL',  name:'3x Home Construction Bull',       sector:'Lev ETF (Bull)', mcap:'Small', float:125},
    {sym:'WEBL',  name:'3x Internet Bull (Direxion)',     sector:'Lev ETF (Bull)', mcap:'Small', float:210},
    {sym:'CURE',  name:'3x Healthcare Bull (Direxion)',   sector:'Lev ETF (Bull)', mcap:'Small', float:110},
    {sym:'HIBL',  name:'3x High Beta Bull (Direxion)',    sector:'Lev ETF (Bull)', mcap:'Small', float:80},
    {sym:'BULZ',  name:'3x MicroSectors FANG+ Bull',      sector:'Lev ETF (Bull)', mcap:'Small', float:65},
    // ── Leveraged Inverse ETFs (3x / 2x) ─────────────────────────────────────
    {sym:'SQQQ',  name:'3x Nasdaq-100 Bear (ProShares)',  sector:'Lev ETF (Bear)', mcap:'Large', float:3600},
    {sym:'SPXU',  name:'3x S&P 500 Bear (ProShares)',     sector:'Lev ETF (Bear)', mcap:'Mid',   float:890},
    {sym:'SDOW',  name:'3x Dow Jones Bear (ProShares)',   sector:'Lev ETF (Bear)', mcap:'Mid',   float:370},
    {sym:'TZA',   name:'3x Small Cap Bear (Direxion)',    sector:'Lev ETF (Bear)', mcap:'Mid',   float:710},
    {sym:'SOXS',  name:'3x Semis Bear (Direxion)',        sector:'Lev ETF (Bear)', mcap:'Mid',   float:1200},
    {sym:'TECS',  name:'3x Tech Bear (Direxion)',         sector:'Lev ETF (Bear)', mcap:'Small', float:430},
    {sym:'LABD',  name:'3x Biotech Bear (Direxion)',      sector:'Lev ETF (Bear)', mcap:'Small', float:290},
    {sym:'FNGD',  name:'3x FANG+ Bear (MicroSectors)',    sector:'Lev ETF (Bear)', mcap:'Small', float:175},
    {sym:'ERY',   name:'2x Energy Bear (Direxion)',       sector:'Lev ETF (Bear)', mcap:'Small', float:150},
    {sym:'SCO',   name:'2x Crude Oil Bear (ProShares)',   sector:'Lev ETF (Bear)', mcap:'Small', float:135},
    {sym:'DUST',  name:'2x Gold Miners Bear (Direxion)',  sector:'Lev ETF (Bear)', mcap:'Small', float:120},
    {sym:'KOLD',  name:'2x Natural Gas Bear (ProShares)', sector:'Lev ETF (Bear)', mcap:'Small', float:110},
    {sym:'FAZ',   name:'3x Financials Bear (Direxion)',   sector:'Lev ETF (Bear)', mcap:'Small', float:270},
    {sym:'DRV',   name:'3x Real Estate Bear (Direxion)',  sector:'Lev ETF (Bear)', mcap:'Small', float:90},
    {sym:'WEBS',  name:'3x Internet Bear (Direxion)',     sector:'Lev ETF (Bear)', mcap:'Small', float:85},
    {sym:'HIBS',  name:'3x High Beta Bear (Direxion)',    sector:'Lev ETF (Bear)', mcap:'Small', float:60},
    {sym:'BERZ',  name:'3x MicroSectors FANG+ Bear',      sector:'Lev ETF (Bear)', mcap:'Small', float:55},
    {sym:'SMCL',  name:'2x Small Cap Bear (ProShares)',   sector:'Lev ETF (Bear)', mcap:'Small', float:40},
    // ── Crypto Spot (24/7 — Yahoo Finance format) ─────────────────────────────
    {sym:'BTC-USD',  name:'Bitcoin',       sector:'Crypto', mcap:'Large', float:0},
    {sym:'ETH-USD',  name:'Ethereum',      sector:'Crypto', mcap:'Large', float:0},
    {sym:'BNB-USD',  name:'BNB',           sector:'Crypto', mcap:'Large', float:0},
    {sym:'SOL-USD',  name:'Solana',        sector:'Crypto', mcap:'Large', float:0},
    {sym:'XRP-USD',  name:'XRP',           sector:'Crypto', mcap:'Large', float:0},
    {sym:'DOGE-USD', name:'Dogecoin',      sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'ADA-USD',  name:'Cardano',       sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'AVAX-USD', name:'Avalanche',     sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'LINK-USD', name:'Chainlink',     sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'DOT-USD',  name:'Polkadot',      sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'LTC-USD',  name:'Litecoin',      sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'UNI-USD',  name:'Uniswap',       sector:'Crypto', mcap:'Small', float:0},
    {sym:'ATOM-USD', name:'Cosmos',        sector:'Crypto', mcap:'Small', float:0},
    {sym:'SHIB-USD', name:'Shiba Inu',     sector:'Crypto', mcap:'Small', float:0},
    {sym:'PEPE-USD', name:'Pepe',          sector:'Crypto', mcap:'Small', float:0},
    {sym:'SUI-USD',  name:'Sui',           sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'TON-USD',  name:'Toncoin',       sector:'Crypto', mcap:'Mid',   float:0},
    {sym:'NEAR-USD', name:'NEAR Protocol', sector:'Crypto', mcap:'Small', float:0},
    {sym:'APT-USD',  name:'Aptos',         sector:'Crypto', mcap:'Small', float:0},
    {sym:'ARB-USD',  name:'Arbitrum',      sector:'Crypto', mcap:'Small', float:0},
    {sym:'OP-USD',   name:'Optimism',      sector:'Crypto', mcap:'Small', float:0},
  ].filter((v, i, a) => a.findIndex(x => x.sym === v.sym) === i); // dedupe

  const SECTORS = ['', ...new Set(UNIVERSE.map(u => u.sector))].sort((a, b) => a.localeCompare(b));

  // ── State ───────────────────────────────────────────────────────────────────
  let sortCol      = 'chgPct';
  let sortDir      = -1;
  let lastResults  = [];
  let activePreset = 'all';
  let _inited      = false;
  let _refreshTimer   = null;
  let _refreshSecs    = 0;
  let _refreshInterval = 0;
  let _scWatchlist = [];

  const $ = id => document.getElementById(id);
  const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d});
  const fmtV = v => !v ? '--' : v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v);
  const esc  = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ── Filter state ────────────────────────────────────────────────────────────
  const filters = {
    mcap: new Set(['Large','Mid','Small','Micro']),
    sector: '',
    minPx: 0, maxPx: 9999,
    minVol: 0,
    minChgPct: -999,
    minRSI: 0, maxRSI: 100,
    minRelVol: 0,
  };

  // ── Presets ─────────────────────────────────────────────────────────────────
  const PRESETS = {
    all:        { mcap:['Large','Mid','Small','Micro'], sector:'',              minChgPct:-999, minVol:0,   minRSI:0,  maxRSI:100, minRelVol:0 },
    momentum:   { mcap:['Large','Mid','Small','Micro'], sector:'',              minChgPct:5,    minVol:1e6, minRSI:0,  maxRSI:100, minRelVol:0 },
    oversold:   { mcap:['Large','Mid','Small','Micro'], sector:'',              minChgPct:0,    minVol:0,   minRSI:0,  maxRSI:32,  minRelVol:0 },
    highvol:    { mcap:['Large','Mid','Small','Micro'], sector:'',              minChgPct:-999, minVol:5e5, minRSI:0,  maxRSI:100, minRelVol:3 },
    smallcap:   { mcap:['Small','Micro'],               sector:'',              minChgPct:4,    minVol:0,   minRSI:0,  maxRSI:100, minRelVol:0 },
    levbull:    { mcap:['Large','Mid','Small','Micro'], sector:'Lev ETF (Bull)',minChgPct:-999, minVol:0,   minRSI:0,  maxRSI:100, minRelVol:0 },
    levbear:    { mcap:['Large','Mid','Small','Micro'], sector:'Lev ETF (Bear)',minChgPct:-999, minVol:0,   minRSI:0,  maxRSI:100, minRelVol:0 },
    volatility: { mcap:['Large','Mid','Small','Micro'], sector:'Volatility',    minChgPct:-999, minVol:0,   minRSI:0,  maxRSI:100, minRelVol:0 },
    crypto:     { mcap:['Large','Mid','Small','Micro'], sector:'Crypto',        minChgPct:-999, minVol:0,   minRSI:0,  maxRSI:100, minRelVol:0 },
  };

  // ── RSI (Wilder, 14-period) ─────────────────────────────────────────────────
  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i-1];
      d >= 0 ? gains += d : losses += Math.abs(d);
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      avgG = (avgG*(period-1) + (d >= 0 ? d : 0)) / period;
      avgL = (avgL*(period-1) + (d <  0 ? Math.abs(d) : 0)) / period;
    }
    if (!avgL) return 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  // ── Data fetchers ───────────────────────────────────────────────────────────
  // To swap in Alpha Vantage or Polygon, replace these two functions.

  async function fetchSnaps(syms) {
    // Yahoo Finance via backend proxy — fetched in chunks of 40 to avoid rate limits
    const CHUNK = 40;
    const merged = {};
    for (let i = 0; i < syms.length; i += CHUNK) {
      const batch = syms.slice(i, i + CHUNK);
      try {
        const r = await fetch(`/api/snapshots?symbols=${batch.join(',')}`);
        if (r.ok) Object.assign(merged, await r.json());
      } catch { /* continue with partial results */ }
    }
    return merged;
  }

  async function fetchRSI(sym) {
    // Uses /api/intraday (5-min bars) for intraday RSI
    // Alpha Vantage swap: GET /query?function=RSI&symbol=${sym}&interval=5min&time_period=14&series_type=close&apikey=${CFG.alphaVantage}
    try {
      const r = await fetch(`/api/intraday/${sym}`);
      if (!r.ok) return null;
      const d = await r.json();
      const bars = d.bars || [];
      if (bars.length < 15) return null;
      return calcRSI(bars.map(b => b.c));
    } catch { return null; }
  }

  function pct(snap) {
    if (!snap?.price || !snap?.previousClose) return 0;
    return (snap.price - snap.previousClose) / snap.previousClose * 100;
  }

  // ── Scan ─────────────────────────────────────────────────────────────────────
  async function runScan() {
    setLoading(true);
    _scWatchlist = (typeof state !== 'undefined' && state.watchlist) ? state.watchlist : [];

    const syms  = UNIVERSE.map(u => u.sym);
    const snaps = await fetchSnaps(syms);

    const p = PRESETS[activePreset] || {};

    const candidates = UNIVERSE.filter(u => {
      const s = snaps[u.sym];
      if (!s?.price) return false;
      const px  = s.price;
      const chg = pct(s);
      const vol = s.volume || 0;
      const avg = s.avgVolume || 1;
      const rv  = avg > 0 ? vol / avg : 0;
      if (px  < filters.minPx || px > filters.maxPx) return false;
      if (vol < filters.minVol) return false;
      if (chg < filters.minChgPct) return false;
      if (filters.minRelVol > 0 && rv < filters.minRelVol) return false;
      if (!filters.mcap.has(u.mcap)) return false;
      if (filters.sector && u.sector !== filters.sector) return false;
      return true;
    });

    // Sort by |% change| desc, take top 25 for RSI fetch
    candidates.sort((a, b) => Math.abs(pct(snaps[b.sym])) - Math.abs(pct(snaps[a.sym])));
    const top = candidates.slice(0, 25);

    // Fetch RSI in parallel (capped at 25)
    const rsiMap = {};
    await Promise.all(top.map(async u => { rsiMap[u.sym] = await fetchRSI(u.sym); }));

    // Apply RSI filter
    const passed = top.filter(u => {
      const r = rsiMap[u.sym];
      if (r === null) return filters.minRSI === 0 && filters.maxRSI === 100; // include if no RSI when unfiltered
      return r >= filters.minRSI && r <= filters.maxRSI;
    });

    lastResults = passed.map(u => {
      const s   = snaps[u.sym] || {};
      const px  = s.price || 0;
      const pv  = s.previousClose || 0;
      const vol = s.volume || 0;
      const avg = s.avgVolume || 1;
      return {
        sym:     u.sym,   name:   u.name,
        sector:  u.sector, mcap:  u.mcap,  float: u.float,
        price:   px,
        chg:     px - pv,
        chgPct:  pct(s),
        volume:  vol,
        avgVol:  avg,
        relVol:  avg > 0 ? vol / avg : 0,
        rsi:     rsiMap[u.sym],
        dayHigh: s.dayHigh || null,
        dayLow:  s.dayLow  || null,
        open:    s.open    || null,
        watched: _scWatchlist.includes(u.sym),
      };
    });

    renderTable();
    setLoading(false);

    const ce = $('scCount');
    if (ce) ce.textContent = `${lastResults.length} result${lastResults.length !== 1 ? 's' : ''}`;
    const ue = $('scUpdated');
    if (ue) ue.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }

  // ── Table render ─────────────────────────────────────────────────────────────
  function renderTable() {
    const body = $('scBody');
    if (!body) return;

    const rows = [...lastResults].sort((a, b) => {
      let av = a[sortCol] ?? -Infinity;
      let bv = b[sortCol] ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="9" class="sc-empty">No stocks match — try adjusting filters or run a preset scan</td></tr>`;
      return;
    }

    body.innerHTML = rows.map(r => {
      const chgCls  = r.chgPct >= 0 ? 'up' : 'down';
      const rsiCls  = r.rsi === null ? '' : r.rsi < 30 ? 'sc-oversold' : r.rsi > 70 ? 'sc-overbought' : '';
      const rsiStr  = r.rsi !== null ? fmt(r.rsi, 1) : '--';
      const floatLbl = r.float >= 1000 ? (r.float/1000).toFixed(1)+'B' : r.float+'M';
      const rvCls   = r.relVol >= 3 ? 'sc-surge' : '';
      const mcapLbl = r.mcap[0];
      return `<tr class="sc-row ${rsiCls}" data-sym="${esc(r.sym)}">
        <td class="sc-td sc-td-star"><button class="sc-star${r.watched?' on':''}" data-sym="${esc(r.sym)}" title="Watchlist">★</button></td>
        <td class="sc-td sc-td-sym"><span class="sc-sym">${esc(r.sym)}</span></td>
        <td class="sc-td sc-td-name sc-mono-sm">${esc(r.name)}</td>
        <td class="sc-td sc-td-num">$${fmt(r.price)}</td>
        <td class="sc-td sc-td-num ${chgCls}">${r.chgPct>=0?'+':''}${fmt(r.chgPct)}%</td>
        <td class="sc-td sc-td-num">${fmtV(r.volume)}</td>
        <td class="sc-td sc-td-num ${rvCls}">${fmt(r.relVol,1)}x</td>
        <td class="sc-td sc-td-num">${rsiStr}</td>
        <td class="sc-td sc-td-cap"><span class="sc-cap-badge sc-cap-${r.mcap.toLowerCase()}">${mcapLbl}</span></td>
      </tr>`;
    }).join('');

    body.querySelectorAll('.sc-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.sc-star')) return;
        openDetail(row.dataset.sym);
      });
    });
    body.querySelectorAll('.sc-star').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); toggleWatch(btn.dataset.sym, btn); });
    });
  }

  // ── Sort ─────────────────────────────────────────────────────────────────────
  function setSort(col) {
    sortDir = sortCol === col ? sortDir * -1 : -1;
    sortCol = col;
    document.querySelectorAll('.sc-th[data-col]').forEach(th => {
      th.dataset.sort = th.dataset.col === col ? (sortDir === 1 ? 'asc' : 'desc') : '';
    });
    renderTable();
  }

  // ── Detail modal ─────────────────────────────────────────────────────────────
  function openDetail(sym) {
    const r = lastResults.find(x => x.sym === sym);
    if (!r) return;
    const m = $('scModal');
    if (!m) return;

    $('scMSym').textContent   = r.sym;
    $('scMName').textContent  = r.name;
    $('scMPrice').textContent = '$' + fmt(r.price);
    const chgEl = $('scMChg');
    chgEl.textContent = (r.chgPct>=0?'+':'') + fmt(r.chgPct) + '%';
    chgEl.className   = 'sc-modal-chg ' + (r.chgPct>=0?'up':'down');

    $('scMSector').textContent  = r.sector;
    $('scMMcap').textContent    = r.mcap + ' Cap';
    $('scMFloat').textContent   = r.float >= 1000 ? (r.float/1000).toFixed(1)+'B' : r.float+'M';
    $('scMVol').textContent     = fmtV(r.volume);
    $('scMAvgVol').textContent  = fmtV(Math.round(r.avgVol));
    $('scMRelVol').textContent  = fmt(r.relVol,1) + 'x';
    $('scMRsi').textContent     = r.rsi !== null ? fmt(r.rsi,1) : '--';
    $('scMDayHigh').textContent = r.dayHigh ? '$'+fmt(r.dayHigh) : '--';
    $('scMDayLow').textContent  = r.dayLow  ? '$'+fmt(r.dayLow)  : '--';
    $('scMOpen').textContent    = r.open    ? '$'+fmt(r.open)    : '--';

    const rsiZone = r.rsi === null ? '--'
      : r.rsi < 30 ? 'OVERSOLD' : r.rsi > 70 ? 'OVERBOUGHT' : r.rsi < 45 ? 'LOW' : r.rsi > 60 ? 'HIGH' : 'NEUTRAL';
    const rsiZoneCls = r.rsi === null ? '' : r.rsi < 30 ? 'oversold' : r.rsi > 70 ? 'overbought' : 'neutral';
    const rz = $('scMRsiZone');
    rz.textContent = rsiZone;
    rz.className = 'sc-mzone ' + rsiZoneCls;

    const openBtn = $('scMOpenStock');
    if (openBtn) {
      openBtn.onclick = () => {
        closeModal();
        if (typeof openStock === 'function') openStock(r.sym, { symbol: r.sym, price: r.price, previousClose: r.price - r.chg, name: r.name });
      };
    }

    m.classList.add('open');
  }

  function closeModal() {
    $('scModal')?.classList.remove('open');
  }

  // ── Watchlist toggle ─────────────────────────────────────────────────────────
  async function toggleWatch(sym, btn) {
    const alreadyOn = (typeof state !== 'undefined' ? state.watchlist : _scWatchlist).includes(sym);
    if (alreadyOn) {
      if (typeof wlAPI !== 'undefined') await wlAPI.remove(sym);
      else _scWatchlist.splice(_scWatchlist.indexOf(sym), 1);
    } else {
      if (typeof wlAPI !== 'undefined') await wlAPI.add(sym);
      else _scWatchlist.push(sym);
    }
    _scWatchlist = typeof state !== 'undefined' ? state.watchlist : _scWatchlist;
    const on = _scWatchlist.includes(sym);
    const r = lastResults.find(x => x.sym === sym);
    if (r) r.watched = on;
    document.querySelectorAll(`.sc-star[data-sym="${sym}"]`).forEach(b => b.classList.toggle('on', on));
  }

  // ── Export CSV ───────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!lastResults.length) return;
    const hdr = 'Ticker,Name,Sector,MarketCap,Price,Chg%,Volume,RelVol,RSI,Float(M)';
    const rows = lastResults.map(r =>
      `${r.sym},"${r.name}","${r.sector}",${r.mcap},${fmt(r.price)},${fmt(r.chgPct)},${r.volume},${fmt(r.relVol,2)},${r.rsi!==null?fmt(r.rsi,1):''},${r.float}`
    );
    const blob = new Blob([[hdr,...rows].join('\n')], {type:'text/csv'});
    const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:`scanner_${new Date().toISOString().slice(0,10)}.csv`});
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ── Auto-refresh ─────────────────────────────────────────────────────────────
  function setAutoRefresh(secs) {
    clearInterval(_refreshTimer);
    _refreshInterval = secs;
    _refreshSecs     = secs;
    updateCd();
    if (secs > 0) {
      _refreshTimer = setInterval(() => {
        _refreshSecs--;
        updateCd();
        if (_refreshSecs <= 0) { runScan(); _refreshSecs = _refreshInterval; }
      }, 1000);
    }
  }

  function updateCd() {
    const el = $('scCdNum');
    if (!el) return;
    el.textContent = !_refreshInterval ? 'OFF' : _refreshSecs + 's';
  }

  // ── Loading overlay ───────────────────────────────────────────────────────────
  function setLoading(on) {
    const ov = $('scLoadingOv');
    if (ov) ov.style.display = on ? 'flex' : 'none';
    const btn = $('scScanBtn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'SCANNING…' : '▶ SCAN'; }
  }

  // ── Filter helpers ────────────────────────────────────────────────────────────
  function applyPreset(key) {
    const p = PRESETS[key] || PRESETS.all;
    activePreset = key;
    filters.mcap      = new Set(p.mcap);
    filters.sector    = p.sector || '';
    filters.minChgPct = p.minChgPct ?? -999;
    filters.minVol    = p.minVol ?? 0;
    filters.minRSI    = p.minRSI ?? 0;
    filters.maxRSI    = p.maxRSI ?? 100;
    filters.minRelVol = p.minRelVol ?? 0;
    syncFiltersToUI();
    document.querySelectorAll('.sc-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === key));
  }

  function syncFiltersToUI() {
    document.querySelectorAll('.sc-mcap-btn').forEach(b => b.classList.toggle('active', filters.mcap.has(b.dataset.mcap)));
    const sel = $('scSector'); if (sel) sel.value = filters.sector || '';
    const mc  = $('scMinChg'); if (mc)  mc.value  = filters.minChgPct <= -999 ? '' : filters.minChgPct;
    const mv  = $('scMinVol');
    if (mv) { const m = {0:'0',500000:'500K',1000000:'1M',5000000:'5M'}; mv.value = m[filters.minVol] || '0'; }
    const mr1 = $('scMinRsi'); if (mr1) mr1.value = filters.minRSI || '';
    const mr2 = $('scMaxRsi'); if (mr2) mr2.value = filters.maxRSI === 100 ? '' : filters.maxRSI;
    const rrv = $('scMinRelVol');
    if (rrv) { const m = {0:'0',2:'2',3:'3',5:'5'}; rrv.value = m[filters.minRelVol] || '0'; }
  }

  function readFiltersFromUI() {
    filters.mcap = new Set();
    document.querySelectorAll('.sc-mcap-btn.active').forEach(b => filters.mcap.add(b.dataset.mcap));
    if (!filters.mcap.size) filters.mcap = new Set(['Large','Mid','Small','Micro']);
    const sel = $('scSector'); filters.sector = sel ? sel.value : '';
    const mc  = $('scMinChg'); filters.minChgPct = mc && mc.value !== '' ? parseFloat(mc.value) : -999;
    const mv  = $('scMinVol');
    if (mv) { const m = {'0':0,'500K':5e5,'1M':1e6,'5M':5e6}; filters.minVol = m[mv.value] ?? 0; }
    const mr1 = $('scMinRsi'); filters.minRSI = mr1 && mr1.value !== '' ? parseFloat(mr1.value) : 0;
    const mr2 = $('scMaxRsi'); filters.maxRSI = mr2 && mr2.value !== '' ? parseFloat(mr2.value) : 100;
    const rrv = $('scMinRelVol');
    if (rrv) { const m = {'0':0,'2':2,'3':3,'5':5}; filters.minRelVol = m[rrv.value] ?? 0; }
  }

  // ── Populate sector dropdown ──────────────────────────────────────────────────
  function buildSectorDropdown() {
    const sel = $('scSector');
    if (!sel) return;
    sel.innerHTML = '<option value="">All Sectors</option>' +
      SECTORS.filter(Boolean).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }

  // ── Init (binds events once) ──────────────────────────────────────────────────
  function init() {
    if (_inited) return;
    _inited = true;

    buildSectorDropdown();

    document.querySelectorAll('.sc-preset').forEach(btn => {
      btn.addEventListener('click', () => { applyPreset(btn.dataset.preset); runScan(); });
    });

    $('scScanBtn')?.addEventListener('click', () => {
      readFiltersFromUI();
      activePreset = '';
      document.querySelectorAll('.sc-preset').forEach(b => b.classList.remove('active'));
      runScan();
    });

    document.querySelectorAll('.sc-th[data-col]').forEach(th => {
      th.addEventListener('click', () => setSort(th.dataset.col));
    });

    document.querySelectorAll('.sc-rf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sc-rf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setAutoRefresh(parseInt(btn.dataset.secs));
      });
    });

    document.querySelectorAll('.sc-mcap-btn').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });

    $('scExportBtn')?.addEventListener('click', exportCSV);
    $('scModalClose')?.addEventListener('click', closeModal);
    $('scModal')?.addEventListener('click', e => { if (e.target === $('scModal')) closeModal(); });

    $('scFilterToggle')?.addEventListener('click', () => {
      $('scFilterPanel')?.classList.toggle('open');
    });
  }

  // ── Open (called each time page is navigated to) ───────────────────────────
  function open() {
    init();
    if (!lastResults.length) {
      applyPreset('all');
      runScan();
    }
  }

  return { open, runScan };
})();


// ═══════════════════════════════════════════════════════════════════════════════
// Custom / Manual Scanner — user-defined ticker list with full trading intelligence
// ═══════════════════════════════════════════════════════════════════════════════
const customScanner = (() => {

  const $ = id => document.getElementById(id);
  const fmt  = (n, d=2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d});
  const fmtV = v => !v ? '--' : v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v);
  const esc  = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  let tickers    = [];   // ordered list of symbols the user added
  let results    = [];   // scan results after running
  let mscSortCol = 'confidence';
  let mscSortDir = -1;
  let _inited    = false;

  // ── Ticker chip management ────────────────────────────────────────────────
  function addTicker(sym) {
    sym = sym.toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
    if (!sym || tickers.includes(sym)) return;
    tickers.push(sym);
    renderChips();
  }

  function removeTicker(sym) {
    tickers = tickers.filter(t => t !== sym);
    renderChips();
  }

  function clearTickers() {
    tickers = [];
    renderChips();
    resetResults();
  }

  function renderChips() {
    const wrap  = $('mscChipsWrap');
    const chips = $('mscChips');
    const count = $('mscChipCount');
    if (!chips) return;
    if (!tickers.length) {
      if (wrap) wrap.style.display = 'none';
      return;
    }
    if (wrap) wrap.style.display = '';
    chips.innerHTML = tickers.map(t =>
      `<span class="msc-chip" data-sym="${esc(t)}">${esc(t)}<button class="msc-chip-remove" data-sym="${esc(t)}" title="Remove">✕</button></span>`
    ).join('');
    chips.querySelectorAll('.msc-chip-remove').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); removeTicker(btn.dataset.sym); });
    });
    if (count) count.textContent = tickers.length + ' ticker' + (tickers.length !== 1 ? 's' : '') + ' queued';
  }

  // ── Autocomplete search ────────────────────────────────────────────────────
  function setupSearch() {
    const input = $('mscInput');
    const drop  = $('mscDrop');
    if (!input || !drop) return;

    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 1) { drop.style.display = 'none'; return; }
      debounce = setTimeout(async () => {
        try {
          const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
          const items = await r.json();
          if (!items.length) { drop.style.display = 'none'; return; }
          drop.innerHTML = items.slice(0,8).map(it =>
            `<div class="drop-item" data-sym="${esc(it.symbol)}">
              <span class="drop-sym">${esc(it.symbol)}</span>
              <span class="drop-name">${esc(it.name)}</span>
            </div>`
          ).join('');
          drop.style.display = 'block';
          drop.querySelectorAll('.drop-item').forEach(d => {
            d.addEventListener('mousedown', e => {
              e.preventDefault();
              addTicker(d.dataset.sym);
              input.value = '';
              drop.style.display = 'none';
            });
          });
        } catch { drop.style.display = 'none'; }
      }, 240);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = input.value.trim();
        if (v) {
          // Support comma-separated input
          v.split(',').forEach(t => addTicker(t.trim()));
          input.value = '';
          drop.style.display = 'none';
        }
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { drop.style.display = 'none'; }, 200);
    });

    $('mscAddBtn')?.addEventListener('click', () => {
      const v = input.value.trim();
      if (v) { v.split(',').forEach(t => addTicker(t.trim())); input.value = ''; drop.style.display = 'none'; }
    });
  }

  // ── Scan logic ────────────────────────────────────────────────────────────
  async function runScan() {
    if (!tickers.length) {
      alert('Add at least one ticker before scanning.');
      return;
    }

    setLoading(true);
    results = [];

    const total = tickers.length;
    let done = 0;

    // Fetch snapshots (price/volume) in batch
    const snapRes = await fetch(`/api/snapshots?symbols=${tickers.join(',')}`).then(r => r.ok ? r.json() : {}).catch(() => ({}));

    // Fetch signals in parallel (VP + EMA + regime) — throttle to 6 at once
    const CONCURRENT = 6;
    const queue = [...tickers];
    const sigMap = {};
    const rsiMap = {};

    async function worker() {
      while (queue.length) {
        const sym = queue.shift();
        try {
          const [sigRes, intraRes] = await Promise.all([
            fetch(`/api/signal/${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`/api/intraday/${sym}`).then(r => r.ok ? r.json() : null).catch(() => null),
          ]);
          sigMap[sym] = sigRes;
          if (intraRes?.bars?.length >= 15) {
            const closes = intraRes.bars.map(b => b.c);
            rsiMap[sym] = calcRSI14(closes);
          }
        } catch {}
        done++;
        updateLoadingText(done, total);
      }
    }

    // Spin up CONCURRENT workers
    await Promise.all(Array.from({ length: CONCURRENT }, worker));

    // Build results
    results = tickers.map(sym => {
      const snap = snapRes[sym] || {};
      const sig  = sigMap[sym];
      const rsi  = rsiMap[sym] ?? null;
      const px   = snap.price || 0;
      const pv   = snap.previousClose || 0;
      const vol  = snap.volume || 0;
      const avg  = snap.avgVolume || 1;
      const chgPct = pv > 0 ? (px - pv) / pv * 100 : 0;
      const relVol = avg > 0 ? vol / avg : 0;

      const sigData = sig?.signal || {};
      const signal     = sigData.signal     || 'HOLD';
      const confidence = sigData.confidence ?? 0;
      const vpZone     = sigData.zoneStr    || '';
      const checks     = sigData.checks     || {};
      const regime     = sig?.regime?.regime || '';
      const isInverse  = sig?.isInverse     || false;

      // EMA state summary
      const above9  = checks.ema_trend?.pass;
      const above50 = checks.above_ema50?.pass;
      const ribbon  = checks.ma_ribbon_bullish?.pass;
      const cross   = checks.ma_crossover?.pass;
      const emaState = cross ? 'CROSS' : ribbon ? 'RIBBON' : above9 ? 'ABOVE' : 'BELOW';

      return {
        sym, price: px, chg: px - pv, chgPct, volume: vol, avgVol: avg,
        relVol, rsi, signal, confidence, vpZone, emaState,
        regime, isInverse, above9, above50, ribbon, cross,
        dayHigh: snap.dayHigh || null, dayLow: snap.dayLow || null,
        name: snap.name || sym,
      };
    });

    // Apply filters
    applyFiltersAndRender();
    setLoading(false);
  }

  // Simple RSI (same as main scanner)
  function calcRSI14(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; d >= 0 ? g += d : l += Math.abs(d); }
    let ag = g / period, al = l / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      ag = (ag * (period-1) + (d >= 0 ? d : 0)) / period;
      al = (al * (period-1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  function applyFiltersAndRender() {
    const sigFilter = ($('mscSignalFilter')?.value || '').toUpperCase();
    const minConf   = parseFloat($('mscMinConf')?.value || '0') || 0;
    const minRsi    = parseFloat($('mscMinRsi')?.value  || '0') || 0;
    const maxRsi    = parseFloat($('mscMaxRsi')?.value  || '100') || 100;
    const minChgPct = parseFloat($('mscMinChg')?.value  || '-999') || -999;
    const minRelVol = parseFloat($('mscMinRelVol')?.value || '0') || 0;

    let filtered = results.filter(r => {
      if (sigFilter && r.signal !== sigFilter) return false;
      if (r.confidence < minConf) return false;
      if (r.rsi !== null && (r.rsi < minRsi || r.rsi > maxRsi)) return false;
      if (r.chgPct < minChgPct) return false;
      if (minRelVol > 0 && r.relVol < minRelVol) return false;
      return true;
    });

    // Sort
    const sortSel = $('mscSortSel');
    mscSortCol = sortSel ? sortSel.value : 'confidence';
    filtered.sort((a, b) => {
      const av = a[mscSortCol] ?? -Infinity;
      const bv = b[mscSortCol] ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * mscSortDir;
    });

    renderTable(filtered);
  }

  // ── Table sort (click headers) ─────────────────────────────────────────────
  function setupTableSort() {
    document.querySelectorAll('.msc-th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        mscSortDir = mscSortCol === col ? mscSortDir * -1 : -1;
        mscSortCol = col;
        document.querySelectorAll('.msc-th[data-col]').forEach(h => {
          h.dataset.sort = h.dataset.col === col ? (mscSortDir === 1 ? 'asc' : 'desc') : '';
        });
        // Also sync the dropdown
        const sel = $('mscSortSel');
        if (sel && [...sel.options].some(o => o.value === col)) sel.value = col;
        applyFiltersAndRender();
      });
    });
  }

  // ── Render results table ──────────────────────────────────────────────────
  function renderTable(rows) {
    const table  = $('mscTable');
    const body   = $('mscBody');
    const empty  = $('mscEmpty');
    const bar    = $('mscStatusBar');
    const count  = $('mscCount');
    const upd    = $('mscUpdated');

    if (!body) return;

    if (!rows.length) {
      if (table) table.style.display = 'none';
      if (empty) { empty.style.display = 'flex'; empty.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".35"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><span>No results match your filters — try relaxing the criteria</span>'; }
      if (bar) bar.style.display = 'none';
      return;
    }

    if (empty) empty.style.display = 'none';
    if (table) table.style.display = '';
    if (bar)   bar.style.display   = '';

    body.innerHTML = rows.map(r => {
      const chgCls  = r.chgPct >= 0 ? 'up' : 'down';
      const rvCls   = r.relVol >= 3 ? 'sc-surge' : '';
      const rsiStr  = r.rsi !== null ? fmt(r.rsi, 1) : '--';
      const rsiCls  = r.rsi === null ? '' : r.rsi < 30 ? 'sc-oversold' : r.rsi > 70 ? 'sc-overbought' : '';

      const sigCls  = r.signal === 'BUY' ? 'msc-sig-buy' : r.signal === 'SELL' ? 'msc-sig-sell' : 'msc-sig-hold';
      const confCls = r.confidence >= 80 ? 'msc-conf-high' : r.confidence >= 65 ? 'msc-conf-med' : 'msc-conf-low';

      const emaCls  = r.cross ? 'msc-ema-cross' : r.ribbon ? 'msc-ema-ribbon' : r.above9 ? 'msc-ema-above' : 'msc-ema-below';
      const emaLbl  = r.cross ? '✦ CROSS' : r.ribbon ? '▲▲▲ RIBBON' : r.above9 ? '▲ ABOVE' : '▼ BELOW';

      const invTag  = r.isInverse ? '<span class="at-inverse-badge">INV</span>' : '';
      const regTag  = r.regime ? `<span class="msc-regime-tag msc-regime-${r.regime.toLowerCase()}">${r.regime}</span>` : '';

      const vpShort = r.vpZone.replace(/^[^\w]*/, '').slice(0, 22);

      return `<tr class="msc-row ${rsiCls}" data-sym="${esc(r.sym)}">
        <td class="msc-td msc-td-sym">
          <span class="msc-sym">${esc(r.sym)}</span>${invTag}
          <span class="msc-name">${esc(r.name)}</span>
          <div class="msc-tags">${regTag}</div>
        </td>
        <td class="msc-td msc-td-r">${r.price ? '$'+fmt(r.price) : '--'}</td>
        <td class="msc-td msc-td-r ${chgCls}">${r.chgPct !== 0 ? (r.chgPct>=0?'+':'')+ fmt(r.chgPct)+'%' : '--'}</td>
        <td class="msc-td msc-td-r">${fmtV(r.volume)}</td>
        <td class="msc-td msc-td-r ${rvCls}">${fmt(r.relVol,1)}x</td>
        <td class="msc-td msc-td-r">${rsiStr}</td>
        <td class="msc-td"><span class="msc-sig ${sigCls}">${r.signal}</span></td>
        <td class="msc-td msc-td-r"><span class="msc-conf ${confCls}">${r.confidence}%</span></td>
        <td class="msc-td msc-td-zone">${esc(vpShort) || '--'}</td>
        <td class="msc-td"><span class="msc-ema ${emaCls}">${emaLbl}</span></td>
      </tr>`;
    }).join('');

    // Row click → open full analysis
    body.querySelectorAll('.msc-row').forEach(row => {
      row.addEventListener('click', () => {
        const r = results.find(x => x.sym === row.dataset.sym);
        if (r && typeof openStock === 'function') {
          openStock(r.sym, { symbol: r.sym, price: r.price, previousClose: r.price - r.chg, name: r.name });
        }
      });
    });

    if (count) count.textContent = `${rows.length} of ${results.length} result${results.length !== 1 ? 's' : ''}`;
    if (upd)   upd.textContent   = 'Updated ' + new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'});
  }

  function resetResults() {
    results = [];
    const table = $('mscTable'); if (table) table.style.display = 'none';
    const empty = $('mscEmpty');
    if (empty) { empty.style.display = 'flex'; empty.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".35"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><span>Add tickers above and click <strong>RUN SCAN</strong> to see results</span>'; }
    const bar   = $('mscStatusBar'); if (bar) bar.style.display = 'none';
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  function setLoading(on) {
    const ov  = $('mscLoading');
    const btn = $('mscRunBtn');
    if (ov) ov.style.display = on ? 'flex' : 'none';
    if (btn) { btn.disabled = on; btn.textContent = on ? 'SCANNING…' : '▶ RUN SCAN'; }
    if (!on) return;
    const empty = $('mscEmpty'); if (empty) empty.style.display = 'none';
    const table = $('mscTable'); if (table) table.style.display = 'none';
    const bar   = $('mscStatusBar'); if (bar) bar.style.display = 'none';
  }

  function updateLoadingText(done, total) {
    const el = $('mscLoadingTxt');
    if (el) el.textContent = `Scanning ${done}/${total}…`;
  }

  // ── Export CSV ────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!results.length) return;
    const hdr = 'Ticker,Name,Price,Chg%,Volume,RelVol,RSI,Signal,Confidence,VP Zone,EMA,Regime,Inverse';
    const rows = results.map(r =>
      `${r.sym},"${r.name}",${fmt(r.price)},${fmt(r.chgPct)},${r.volume},${fmt(r.relVol,2)},${r.rsi!==null?fmt(r.rsi,1):''},${r.signal},${r.confidence},"${r.vpZone}",${r.emaState},${r.regime},${r.isInverse}`
    );
    const blob = new Blob([[hdr,...rows].join('\n')], {type:'text/csv'});
    const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:`custom_scan_${new Date().toISOString().slice(0,10)}.csv`});
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ── Import watchlist ──────────────────────────────────────────────────────
  function importWatchlist() {
    const wl = (typeof state !== 'undefined' && state.watchlist) ? state.watchlist : [];
    if (!wl.length) { alert('Your watchlist is empty — add some stocks first.'); return; }
    wl.forEach(sym => addTicker(sym));
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    if (_inited) return;
    _inited = true;

    setupSearch();
    setupTableSort();

    $('mscClearBtn')?.addEventListener('click', clearTickers);
    $('mscImportWl')?.addEventListener('click', importWatchlist);
    $('mscExportBtn')?.addEventListener('click', exportCSV);
    $('mscRunBtn')?.addEventListener('click', runScan);

    // Re-sort when dropdown changes
    $('mscSortSel')?.addEventListener('change', () => {
      mscSortCol = $('mscSortSel').value;
      mscSortDir = -1;
      applyFiltersAndRender();
    });

    resetResults();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => customScanner.init());

// ── Pre-Market Pumps Scanner ──────────────────────────────────────────────────
const premarketScanner = (() => {
  const $ = id => document.getElementById(id);
  const fmt  = n => n == null ? '—' : n.toLocaleString();
  const fmtPct = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  const fmtVol = v => {
    if (v == null) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v.toString();
  };

  let _side    = 'gainers';
  let _minPct  = 1;
  let _timer   = null;
  let _autoSec = 0;
  let _cdTimer = null;
  let _cdLeft  = 0;

  // ── Fetch & Render ──────────────────────────────────────────────────────────
  async function fetchAndRender(force = false) {
    const loading = $('pmLoading');
    const body    = $('pmBody');
    const empty   = $('pmEmpty');
    const count   = $('pmCount');
    const asOf    = $('pmAsOf');
    const badge   = $('pmTabBadge');

    if (loading) loading.style.display = '';
    if (empty)   empty.style.display   = 'none';

    try {
      const url = `/api/premarket-scan?minPct=${_minPct}&side=${_side}&top=50${force ? '&bust=' + Date.now() : ''}`;
      const r   = await fetch(url);
      const d   = await r.json();
      const movers = d.movers || [];

      if (loading) loading.style.display = 'none';

      if (!movers.length) {
        if (body)  body.innerHTML = '';
        if (empty) empty.style.display = '';
        if (count) count.textContent = '0 results';
        if (badge) badge.style.display = 'none';
        return;
      }

      if (count) count.textContent = movers.length + ' result' + (movers.length !== 1 ? 's' : '');
      if (badge) { badge.textContent = movers.length; badge.style.display = ''; }
      if (asOf && d.asOf) {
        const t = new Date(d.asOf);
        asOf.textContent = 'Updated ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }

      if (body) body.innerHTML = movers.map((m, i) => {
        const pct     = m.pmPct ?? 0;
        const pos     = pct >= 0;
        const pctCls  = pos ? 'pm-pos' : 'pm-neg';
        const relVol  = m.relVolume;
        const relStr  = relVol == null ? '—' : relVol.toFixed(2) + '×';
        const relCls  = relVol != null && relVol >= 3 ? 'pm-rel-hot' : relVol != null && relVol >= 1.5 ? 'pm-rel-warm' : '';
        const pmHasDot = m.hasPMData ? '<span class="pm-dot" title="Live pre-market data"></span>' : '';
        const sym     = m.symbol;

        return `<tr class="pm-row" data-sym="${sym}">
          <td class="pm-td pm-td-rank">${i + 1}</td>
          <td class="pm-td pm-td-sym">
            <span class="pm-sym">${sym}</span>${pmHasDot}
          </td>
          <td class="pm-td pm-td-name">${m.name || sym}</td>
          <td class="pm-td pm-td-r">
            ${m.pmPrice != null ? '$' + m.pmPrice.toFixed(2) : '—'}
            ${m.prevClose != null ? '<span class="pm-prev">prev $' + m.prevClose.toFixed(2) + '</span>' : ''}
          </td>
          <td class="pm-td pm-td-r">
            <span class="pm-pct ${pctCls}">${fmtPct(pct)}</span>
          </td>
          <td class="pm-td pm-td-r pm-vol">${fmtVol(m.pmVolume)}</td>
          <td class="pm-td pm-td-r ${relCls}">${relStr}</td>
          <td class="pm-td pm-td-act">
            <button class="pm-add-btn" data-sym="${sym}" title="Send to Custom Scanner">+ Custom</button>
          </td>
        </tr>`;
      }).join('');

      // Wire up "add to custom scanner" buttons
      body.querySelectorAll('.pm-add-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const sym = btn.dataset.sym;
          // Dispatch to customScanner input
          const inp = document.getElementById('mscInput');
          if (inp) {
            inp.value = sym;
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
          btn.textContent = '✓ Added';
          btn.disabled = true;
          setTimeout(() => { btn.textContent = '+ Custom'; btn.disabled = false; }, 2000);
        });
      });

      // Click row → navigate to regular scanner and highlight symbol
      body.querySelectorAll('.pm-row').forEach(row => {
        row.addEventListener('click', e => {
          if (e.target.closest('.pm-add-btn')) return;
          // Switch to regular scanner tab and send to custom scanner
          const sym = row.dataset.sym;
          switchTab('regular');
          const inp = document.getElementById('mscInput');
          if (inp) {
            inp.value = sym;
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        });
      });

    } catch(e) {
      if (loading) loading.style.display = 'none';
      console.error('[PM Scan]', e.message);
    }
  }

  // ── Tab switching ────────────────────────────────────────────────────────────
  function switchTab(tab) {
    const pmPanel  = $('pmPanel');
    const scRegular = $('scRegularContent');
    const mscWrap  = $('mscWrap');
    const tabRegular = $('scTabRegular');
    const tabPM    = $('scTabPM');

    if (tab === 'premarket') {
      if (pmPanel)    pmPanel.style.display    = '';
      if (scRegular)  scRegular.style.display  = 'none';
      if (mscWrap)    mscWrap.style.display    = 'none';
      tabRegular?.classList.remove('active');
      tabPM?.classList.add('active');
      fetchAndRender(); // load data when tab opens
    } else {
      if (pmPanel)    pmPanel.style.display    = 'none';
      if (scRegular)  scRegular.style.display  = '';
      if (mscWrap)    mscWrap.style.display    = '';
      tabRegular?.classList.add('active');
      tabPM?.classList.remove('active');
    }
  }

  // ── Auto-refresh countdown ───────────────────────────────────────────────────
  function startAutoRefresh(secs) {
    clearInterval(_timer);
    clearInterval(_cdTimer);
    _autoSec = secs;
    if (!secs) return;
    _cdLeft = secs;
    _timer = setInterval(() => fetchAndRender(true), secs * 1000);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    // Tab toggle
    document.querySelectorAll('.sc-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Min gap filter
    $('pmMinPct')?.addEventListener('change', e => {
      _minPct = parseFloat(e.target.value);
      fetchAndRender(true);
    });

    // Gainers / Losers toggle
    $('pmGainersBtn')?.addEventListener('click', () => {
      _side = 'gainers';
      $('pmGainersBtn')?.classList.add('active');
      $('pmLosersBtn')?.classList.remove('active');
      fetchAndRender(true);
    });
    $('pmLosersBtn')?.addEventListener('click', () => {
      _side = 'losers';
      $('pmLosersBtn')?.classList.add('active');
      $('pmGainersBtn')?.classList.remove('active');
      fetchAndRender(true);
    });

    // Refresh button
    $('pmRefreshBtn')?.addEventListener('click', () => fetchAndRender(true));

    // Auto-refresh buttons
    document.querySelectorAll('.pm-auto-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pm-auto-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        startAutoRefresh(parseInt(btn.dataset.secs));
      });
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => premarketScanner.init());
