'use strict';

// Pure calculations: all volatility values are decimal annualized values unless noted.
const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
const n = value => finite(value) ? Number(value) : null;
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const stdev = values => {
  const avg = mean(values); if (avg == null || values.length < 2) return null;
  return Math.sqrt(values.reduce((s, x) => s + (x - avg) ** 2, 0) / (values.length - 1));
};
function closes(bars) { return (bars || []).map(x => n(x?.c ?? x?.close)).filter(x => x > 0); }
function realizedVol(bars, period, annualization = 252) {
  const values = closes(bars); if (values.length < period + 1) return null;
  const returns = values.slice(-(period + 1)).slice(1).map((x, i) => Math.log(x / values.slice(-(period + 1))[i]));
  const sd = stdev(returns); return sd == null ? null : sd * Math.sqrt(annualization);
}
function percentile(value, history) {
  const values = (history || []).map(n).filter(x => x != null);
  if (!finite(value) || !values.length) return null;
  return clamp((values.filter(x => x <= Number(value)).length / values.length) * 100);
}
function zScore(value, history) {
  const values = (history || []).map(n).filter(x => x != null); const sd = stdev(values);
  return finite(value) && sd > 0 ? (Number(value) - mean(values)) / sd : null;
}
function movingAverage(values, period) { return values.length >= period ? mean(values.slice(-period)) : null; }
function vixMetrics(bars) {
  const values = closes(bars), current = values.at(-1);
  const change = days => values.length > days && current ? ((current / values.at(-1 - days)) - 1) * 100 : null;
  const history = values.slice(-252);
  const p = percentile(current, history);
  return {
    vixLevel: current ?? null, vix1dChange: change(1), vix5dChange: change(5), vix20dChange: change(20),
    vixPercentile252: p, vixPercentile63: percentile(current, values.slice(-63)), vixZScore252: zScore(current, history),
    vixDistanceFrom20DMA: (() => { const ma = movingAverage(values, 20); return ma ? ((current / ma) - 1) * 100 : null; })(),
    vixDistanceFrom50DMA: (() => { const ma = movingAverage(values, 50); return ma ? ((current / ma) - 1) * 100 : null; })(),
    vixDistanceFrom200DMA: (() => { const ma = movingAverage(values, 200); return ma ? ((current / ma) - 1) * 100 : null; })(),
    classification: p == null ? null : p <= 20 ? 'LOW' : p <= 50 ? 'NORMAL' : p <= 75 ? 'ELEVATED' : p <= 95 ? 'HIGH' : 'EXTREME',
    realizedVol: Object.fromEntries([5, 10, 20, 30, 60].map(period => [period, realizedVol(bars, period)])),
  };
}
function termStructure(levels) {
  const vix = n(levels?.vix), vix3m = n(levels?.vix3m), vix6m = n(levels?.vix6m), vix1y = n(levels?.vix1y), vix9d = n(levels?.vix9d);
  const slope = vix != null && vix3m != null ? (vix3m / vix) - 1 : null;
  return { levels: { vix9d, vix, vix3m, vix6m, vix1y }, spreads: { vix9dVix: vix9d != null && vix != null ? vix9d - vix : null, vixVix3m: vix != null && vix3m != null ? vix - vix3m : null, vix3mVix6m: vix3m != null && vix6m != null ? vix3m - vix6m : null, vix6mVix1y: vix6m != null && vix1y != null ? vix6m - vix1y : null }, normalizedSlopes: { vix3mToVix: slope, vix6mToVix3m: vix3m && vix6m ? vix6m / vix3m - 1 : null, vix1yToVix6m: vix6m && vix1y ? vix1y / vix6m - 1 : null }, classification: slope == null ? null : slope > .05 ? 'STEEP CONTANGO' : slope > .005 ? 'CONTANGO' : slope < -.05 ? 'STEEP BACKWARDATION' : slope < -.005 ? 'BACKWARDATION' : 'FLAT' };
}
function ivRank(current, history) {
  const values = (history || []).map(n).filter(x => x != null);
  if (!finite(current) || values.length < 2) return { currentIV: n(current), ivRank: null, ivPercentile: null, high: null, low: null, status: 'UNAVAILABLE' };
  const low = Math.min(...values), high = Math.max(...values);
  return { currentIV: Number(current), ivRank: high === low ? null : clamp((Number(current) - low) / (high - low) * 100), ivPercentile: percentile(current, values), high, low, status: high === low ? 'UNAVAILABLE' : 'AVAILABLE' };
}
function expectedMove(price, iv, dte) {
  if (![price, iv, dte].every(finite) || price <= 0 || iv < 0 || dte < 0) return null;
  const amount = Number(price) * Number(iv) * Math.sqrt(Number(dte) / 365);
  return { amount, percent: amount / Number(price) * 100, upper: Number(price) + amount, lower: Number(price) - amount, dte: Number(dte) };
}
function normalPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function bsGamma({ spot, strike, iv, dte, rate = 0 }) {
  if (![spot, strike, iv, dte].every(finite) || spot <= 0 || strike <= 0 || iv <= 0 || dte <= 0) return null;
  const t = dte / 365, root = Math.sqrt(t), d1 = (Math.log(spot / strike) + (rate + iv * iv / 2) * t) / (iv * root);
  return normalPdf(d1) / (spot * iv * root);
}
function gammaExposure(chain, spot, { multiplier = 100, dealerPutSign = -1 } = {}) {
  const assumption = 'Open-interest model assigns positive call gamma and negative put gamma; positioning is inferred, not observed';
  if (!finite(spot) || !Array.isArray(chain)) return { netGamma: null, callGamma: null, putGamma: null, byStrike: [], assumption };
  let callGamma = 0, putGamma = 0; const byStrike = [];
  for (const row of chain) {
    const gamma = bsGamma({ spot, strike: n(row.strike), iv: n(row.impliedVolatility ?? row.iv), dte: n(row.dte), rate: n(row.rate) ?? 0 });
    const oi = n(row.openInterest); if (gamma == null || oi == null) continue;
    const exposure = gamma * oi * multiplier * spot * spot * .01;
    if (String(row.type || row.optionType).toLowerCase().startsWith('p')) putGamma += dealerPutSign * exposure; else callGamma += exposure;
    byStrike.push({ strike: n(row.strike), gammaExposure: String(row.type || row.optionType).toLowerCase().startsWith('p') ? dealerPutSign * exposure : exposure });
  }
  return { callGamma, putGamma, netGamma: callGamma + putGamma, totalAbsoluteGamma: Math.abs(callGamma) + Math.abs(putGamma), byStrike, assumption };
}
function gammaFlip(chain, spot, config) {
  if (!finite(spot) || !Array.isArray(chain) || !chain.length) return null;
  const strikes = [...new Set(chain.map(x => n(x.strike)).filter(x => x > 0))].sort((a,b) => a-b);
  let prior = null;
  for (const level of strikes) { const net = gammaExposure(chain, level, config).netGamma; if (prior && net != null && prior.net * net <= 0) return (prior.level + level) / 2; if (net != null) prior = { level, net }; }
  return null;
}
function betaCorrelation(stockBars, spyBars) {
  const s = closes(stockBars), p = closes(spyBars), len = Math.min(s.length, p.length);
  if (len < 3) return { beta: null, correlation: null };
  const sr = s.slice(-len).slice(1).map((x,i) => Math.log(x / s.slice(-len)[i])), pr = p.slice(-len).slice(1).map((x,i) => Math.log(x / p.slice(-len)[i]));
  const sm = mean(sr), pm = mean(pr), variance = mean(pr.map(x => (x - pm) ** 2)), covariance = mean(sr.map((x,i) => (x-sm)*(pr[i]-pm)));
  const corr = covariance / Math.sqrt(mean(sr.map(x => (x-sm)**2)) * variance);
  return { beta: variance ? covariance / variance : null, correlation: Number.isFinite(corr) ? corr : null };
}
function atrPercentile(bars, period = 14, lookback = 252) {
  const rows = (bars || []).filter(row => [row?.h ?? row?.high, row?.l ?? row?.low, row?.c ?? row?.close].every(finite));
  if (rows.length < period + 2) return null;
  const trueRanges = rows.slice(1).map((row, index) => {
    const high = n(row.h ?? row.high), low = n(row.l ?? row.low);
    const priorClose = n(rows[index].c ?? rows[index].close);
    return Math.max(high - low, Math.abs(high - priorClose), Math.abs(low - priorClose));
  });
  const atrSeries = [];
  for (let i = period - 1; i < trueRanges.length; i++) {
    const close = n(rows[i + 1].c ?? rows[i + 1].close);
    const atr = mean(trueRanges.slice(i - period + 1, i + 1));
    if (close > 0 && atr != null) atrSeries.push((atr / close) * 100);
  }
  return atrSeries.length ? percentile(atrSeries.at(-1), atrSeries.slice(-lookback)) : null;
}
function currentOptionIv(chain, spot) {
  const usable = (chain || []).filter(row =>
    finite(row?.impliedVolatility ?? row?.iv) && Number(row?.impliedVolatility ?? row?.iv) > 0
    && finite(row?.strike) && finite(row?.dte) && Number(row.dte) > 0);
  if (!usable.length) return { iv: null, dte: null };
  const expiries = [...new Set(usable.map(row => Number(row.dte)))].sort((a, b) => a - b);
  const targetDte = expiries.find(dte => dte >= 7) ?? expiries[0];
  const near = usable
    .filter(row => Number(row.dte) === targetDte)
    .sort((a, b) => Math.abs(Number(a.strike) - Number(spot)) - Math.abs(Number(b.strike) - Number(spot)))
    .slice(0, 6)
    .map(row => Number(row.impliedVolatility ?? row.iv))
    .sort((a, b) => a - b);
  if (!near.length) return { iv: null, dte: null };
  const middle = Math.floor(near.length / 2);
  return { iv: near.length % 2 ? near[middle] : (near[middle - 1] + near[middle]) / 2, dte: targetDte };
}
module.exports = { realizedVol, percentile, zScore, vixMetrics, termStructure, ivRank, expectedMove, bsGamma, gammaExposure, gammaFlip, betaCorrelation, atrPercentile, currentOptionIv, clamp };