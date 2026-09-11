(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RRGStyle = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function dateKey(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestamp));
  }

  function completedCloseMap(bars, nowMs) {
    const today = dateKey(new Date(nowMs));
    const map = new Map();
    for (const bar of Array.isArray(bars) ? bars : []) {
      const close = Number(bar?.c);
      const day = dateKey(bar?.t ?? bar?.timestamp);
      if (!day || day >= today || !Number.isFinite(close) || close <= 0) continue;
      map.set(day, close);
    }
    return map;
  }

  /**
   * This intentionally does not claim to reproduce the proprietary JdK
   * normalization. It gives the sector panel a transparent RRG-style view:
   * 20-session relative strength and 5-session relative momentum versus SPY.
   */
  function calculateRrgStyle(sectorBars, benchmarkBars, {
    now = Date.now(),
    strengthLookback = 20,
    momentumLookback = 5,
  } = {}) {
    const sector = completedCloseMap(sectorBars, now);
    const benchmark = completedCloseMap(benchmarkBars, now);
    const days = [...sector.keys()]
      .filter(day => benchmark.has(day))
      .sort();
    const minimum = Math.max(strengthLookback, momentumLookback) + 1;
    if (days.length < minimum) {
      return {
        available: false,
        reason: 'INSUFFICIENT_COMPLETED_BARS',
        observations: days.length,
        asOf: days.at(-1) || null,
      };
    }

    const ratios = days.map(day => sector.get(day) / benchmark.get(day));
    const latest = ratios.length - 1;
    const ratioAtStrengthStart = ratios[latest - strengthLookback];
    const ratioAtMomentumStart = ratios[latest - momentumLookback];
    if (![ratioAtStrengthStart, ratioAtMomentumStart, ratios[latest]]
      .every(value => Number.isFinite(value) && value > 0)) {
      return { available: false, reason: 'INVALID_RELATIVE_SERIES', observations: days.length };
    }

    const rsRatio = 100 + clamp(
      ((ratios[latest] / ratioAtStrengthStart) - 1) * 1000,
      -50,
      50,
    );
    const rsMomentum = 100 + clamp(
      ((ratios[latest] / ratioAtMomentumStart) - 1) * 1000,
      -50,
      50,
    );

    let quadrant;
    if (rsRatio >= 100 && rsMomentum >= 100) quadrant = 'Leading';
    else if (rsRatio >= 100) quadrant = 'Weakening';
    else if (rsMomentum >= 100) quadrant = 'Improving';
    else quadrant = 'Lagging';

    return {
      available: true,
      quadrant,
      rsRatio: Math.round(rsRatio * 10) / 10,
      rsMomentum: Math.round(rsMomentum * 10) / 10,
      observations: days.length,
      asOf: days[latest],
      benchmark: 'SPY',
      method: '20-session relative strength / 5-session relative momentum',
    };
  }

  return { calculateRrgStyle };
}));