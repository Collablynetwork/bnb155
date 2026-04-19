const { round } = require('./indicators');

function findSwingPoints(candles, lookback = 3) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const high = candles[i].high;
    const low = candles[i].low;
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (candles[j].high > high) isSwingHigh = false;
      if (candles[j].low < low) isSwingLow = false;
    }
    if (isSwingHigh) swingHighs.push({ index: i, price: high, time: candles[i].closeTime });
    if (isSwingLow) swingLows.push({ index: i, price: low, time: candles[i].closeTime });
  }
  return { swingHighs, swingLows };
}

function latestConfirmedLevel(points, beforeIndex = Infinity) {
  const filtered = points.filter((p) => p.index < beforeIndex);
  return filtered.length ? filtered[filtered.length - 1] : null;
}

function detectStructure(candles) {
  const { swingHighs, swingLows } = findSwingPoints(candles, 3);
  const lastIndex = candles.length - 1;
  const currentClose = candles[lastIndex]?.close ?? null;
  const lastSwingHigh = latestConfirmedLevel(swingHighs, lastIndex);
  const lastSwingLow = latestConfirmedLevel(swingLows, lastIndex);
  const bullishBos = Boolean(lastSwingHigh && currentClose > lastSwingHigh.price);
  const bearishBos = Boolean(lastSwingLow && currentClose < lastSwingLow.price);

  const prevSwingHigh = swingHighs.length >= 2 ? swingHighs[swingHighs.length - 2] : null;
  const prevSwingLow = swingLows.length >= 2 ? swingLows[swingLows.length - 2] : null;

  const hh = Boolean(prevSwingHigh && lastSwingHigh && lastSwingHigh.price > prevSwingHigh.price);
  const hl = Boolean(prevSwingLow && lastSwingLow && lastSwingLow.price > prevSwingLow.price);
  const lh = Boolean(prevSwingHigh && lastSwingHigh && lastSwingHigh.price < prevSwingHigh.price);
  const ll = Boolean(prevSwingLow && lastSwingLow && lastSwingLow.price < prevSwingLow.price);

  let trend = 'sideways';
  if (hh && hl) trend = 'uptrend';
  else if (lh && ll) trend = 'downtrend';

  return {
    lastSwingHigh: lastSwingHigh ? round(lastSwingHigh.price, 8) : null,
    lastSwingLow: lastSwingLow ? round(lastSwingLow.price, 8) : null,
    bullishBos,
    bearishBos,
    hh,
    hl,
    lh,
    ll,
    trend,
    resistance: lastSwingHigh ? round(lastSwingHigh.price, 8) : null,
    support: lastSwingLow ? round(lastSwingLow.price, 8) : null
  };
}

module.exports = {
  findSwingPoints,
  detectStructure
};
