function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function closeSeries(candles) { return candles.map((c) => c.close); }
function highSeries(candles) { return candles.map((c) => c.high); }
function lowSeries(candles) { return candles.map((c) => c.low); }
function volumeSeries(candles) { return candles.map((c) => c.volume); }
function quoteVolumeSeries(candles) { return candles.map((c) => c.quoteVolume); }

function sma(values, period) {
  if (!values.length || values.length < period) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result.push(sum / period);
  }
  return result;
}

function ema(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i += 1) {
    const next = i === 0 ? values[0] : ((values[i] - prev) * multiplier) + prev;
    result.push(next);
    prev = next;
  }
  return result;
}

function stddev(values, period) {
  if (!values.length || values.length < period) return [];
  const result = [];
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / period;
    result.push(Math.sqrt(variance));
  }
  return result;
}

function bollingerBands(values, period = 20, mult = 2) {
  const basis = sma(values, period);
  const devs = stddev(values, period);
  if (!basis.length || !devs.length) return { basis: [], upper: [], lower: [], width: [] };
  const upper = [];
  const lower = [];
  const width = [];
  for (let i = 0; i < basis.length; i += 1) {
    const up = basis[i] + (devs[i] * mult);
    const lo = basis[i] - (devs[i] * mult);
    upper.push(up);
    lower.push(lo);
    width.push(basis[i] === 0 ? 0 : (up - lo) / basis[i]);
  }
  return { basis, upper, lower, width };
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, i) => fastEma[i] - slowEma[i]);
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => v - signal[i]);
  return { line, signal, histogram };
}

function trueRange(candles) {
  const trs = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
      continue;
    }
    const highLow = candles[i].high - candles[i].low;
    const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
    const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }
  return trs;
}

function atr(candles, period = 14) {
  return ema(trueRange(candles), period);
}

function adx(candles, period = 14) {
  if (candles.length < period + 2) return { adx: [], plusDI: [], minusDI: [] };
  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i += 1) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }

  const tr14 = ema(tr, period);
  const plus14 = ema(plusDM, period);
  const minus14 = ema(minusDM, period);
  const plusDI = plus14.map((v, i) => tr14[i] ? (100 * v) / tr14[i] : 0);
  const minusDI = minus14.map((v, i) => tr14[i] ? (100 * v) / tr14[i] : 0);
  const dx = plusDI.map((v, i) => {
    const denom = v + minusDI[i];
    return denom ? (100 * Math.abs(v - minusDI[i])) / denom : 0;
  });
  return { adx: ema(dx, period), plusDI, minusDI };
}

function roc(values, period = 1) {
  return values.map((value, index) => {
    if (index < period || values[index - period] === 0) return 0;
    return ((value - values[index - period]) / values[index - period]) * 100;
  });
}

function percentileOfLast(values) {
  if (!values.length) return null;
  const last = values[values.length - 1];
  const below = values.filter((v) => v <= last).length;
  return (below / values.length) * 100;
}

function slope(values, length = 3) {
  if (values.length < length) return 0;
  const start = values[values.length - length];
  const end = values[values.length - 1];
  return end - start;
}

function recentHigh(values, lookback = 20) {
  const window = values.slice(-lookback);
  return Math.max(...window);
}

function recentLow(values, lookback = 20) {
  const window = values.slice(-lookback);
  return Math.min(...window);
}

function normalized(value, min, max) {
  if (![value, min, max].every(Number.isFinite)) return 0;
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function latest(array, offset = 0) {
  const index = array.length - 1 - offset;
  return index >= 0 ? array[index] : null;
}

function buildFeatureSnapshot(candles) {
  const closes = closeSeries(candles);
  const highs = highSeries(candles);
  const lows = lowSeries(candles);
  const vols = volumeSeries(candles);
  const qVols = quoteVolumeSeries(candles);
  const bb = bollingerBands(closes, 20, 2);
  const macdPack = macd(closes);
  const atrPack = atr(candles, 14);
  const adxPack = adx(candles, 14);
  const volAvg20 = sma(vols, 20);
  const volAvg50 = sma(vols, 50);
  const qVolAvg20 = sma(qVols, 20);
  const bbWidthPercentile = percentileOfLast(bb.width.slice(-120));
  const currentClose = latest(closes);
  const recentHi = recentHigh(highs, 20);
  const recentLo = recentLow(lows, 20);
  const rangePosition = recentHi === recentLo ? 0.5 : (currentClose - recentLo) / (recentHi - recentLo);
  const recentAtr = latest(atrPack);
  const currentVolume = latest(vols);
  const currentQuoteVolume = latest(qVols);
  const macdLine = latest(macdPack.line);
  const macdSignal = latest(macdPack.signal);
  const macdHist = latest(macdPack.histogram);
  const prevHist = latest(macdPack.histogram, 1) ?? macdHist;
  const prevLine = latest(macdPack.line, 1) ?? macdLine;
  const prevSignal = latest(macdPack.signal, 1) ?? macdSignal;
  const adxValue = latest(adxPack.adx);
  const plusDI = latest(adxPack.plusDI);
  const minusDI = latest(adxPack.minusDI);
  const bbBasis = latest(bb.basis);
  const bbUpper = latest(bb.upper);
  const bbLower = latest(bb.lower);
  const bbWidth = latest(bb.width);
  const body = candles.length ? Math.abs(candles[candles.length - 1].close - candles[candles.length - 1].open) : 0;
  const candleRange = candles.length ? candles[candles.length - 1].high - candles[candles.length - 1].low : 0;

  return {
    currentClose: round(currentClose, 8),
    recentHigh20: round(recentHi, 8),
    recentLow20: round(recentLo, 8),
    rangePositionPct: round(rangePosition * 100, 4),
    return1: round(latest(roc(closes, 1)), 4),
    return3: round(latest(roc(closes, 3)), 4),
    return5: round(latest(roc(closes, 5)), 4),
    return20: round(latest(roc(closes, 20)), 4),
    atr14: round(recentAtr, 8),
    normalizedAtrPct: currentClose ? round((recentAtr / currentClose) * 100, 4) : null,
    volume: round(currentVolume, 4),
    quoteVolume: round(currentQuoteVolume, 4),
    volumeVsAvg20: latest(volAvg20) ? round(currentVolume / latest(volAvg20), 4) : null,
    volumeVsAvg50: latest(volAvg50) ? round(currentVolume / latest(volAvg50), 4) : null,
    quoteVolumeVsAvg20: latest(qVolAvg20) ? round(currentQuoteVolume / latest(qVolAvg20), 4) : null,
    bbBasis: round(bbBasis, 8),
    bbUpper: round(bbUpper, 8),
    bbLower: round(bbLower, 8),
    bbWidth: round(bbWidth, 8),
    bbWidthPercentile: round(bbWidthPercentile, 4),
    closeToBbUpperPct: bbUpper ? round((currentClose / bbUpper) * 100, 4) : null,
    closeToBbLowerPct: bbLower ? round((currentClose / bbLower) * 100, 4) : null,
    macdLine: round(macdLine, 8),
    macdSignal: round(macdSignal, 8),
    macdHistogram: round(macdHist, 8),
    macdHistogramSlope: round(macdHist - prevHist, 8),
    macdBullCross: Boolean(prevLine <= prevSignal && macdLine > macdSignal),
    macdBearCross: Boolean(prevLine >= prevSignal && macdLine < macdSignal),
    macdAboveZero: Boolean(macdLine > 0 && macdSignal > 0),
    macdBelowZero: Boolean(macdLine < 0 && macdSignal < 0),
    macdZeroDistancePct: currentClose ? round((Math.abs(macdLine) / currentClose) * 100, 8) : null,
    adx: round(adxValue, 4),
    adxSlope: round(slope(adxPack.adx, 3), 4),
    plusDI: round(plusDI, 4),
    minusDI: round(minusDI, 4),
    diSpread: round((plusDI ?? 0) - (minusDI ?? 0), 4),
    bodyPctOfRange: candleRange ? round((body / candleRange) * 100, 4) : 0,
    currentHigh: round(latest(highs), 8),
    currentLow: round(latest(lows), 8)
  };
}

module.exports = {
  round,
  sma,
  ema,
  stddev,
  bollingerBands,
  macd,
  atr,
  adx,
  roc,
  percentileOfLast,
  slope,
  recentHigh,
  recentLow,
  normalized,
  latest,
  buildFeatureSnapshot
};
