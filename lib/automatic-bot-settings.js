'use strict';

function clampPositionDollars(value, fallback, maximum = 1_000_000) {
  const parsed = Number(value);
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber) ? fallbackNumber : 1_000;
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : safeFallback));
}

function serverOwnedConfig(defaults, saved, requestedPositionDollars, options = {}) {
  const key = options.key || 'maxPositionDollars';
  const maximum = options.maximum || 1_000_000;
  const savedValue = saved && typeof saved === 'object' ? saved[key] : undefined;
  return {
    ...defaults,
    [key]: clampPositionDollars(
      requestedPositionDollars ?? savedValue,
      defaults[key],
      maximum
    ),
  };
}

function serverOwnedMomentumConfig(defaults, saved, requestedPositionDollars) {
  const savedDollars = saved?.positionMode === 'fixed'
    ? saved.positionValue
    : saved?.maxPositionDollars;
  const positionValue = clampPositionDollars(
    requestedPositionDollars ?? savedDollars,
    defaults.positionValue,
    1_000_000
  );
  return {
    ...defaults,
    positionMode: 'fixed',
    positionValue,
    maxPositionDollars: positionValue,
  };
}

function shouldAutoEnableAfterConnection(mode) {
  return mode === 'paper';
}

module.exports = {
  clampPositionDollars,
  serverOwnedConfig,
  serverOwnedMomentumConfig,
  shouldAutoEnableAfterConnection,
};