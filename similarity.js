const config = require('./config');
const { round } = require('./indicators');

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function closeness(a, b, tolerance) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
  return clamp(1 - (Math.abs(a - b) / tolerance));
}

function boolMatch(a, b) {
  return a === b ? 1 : 0;
}

function directionFits(direction, current) {
  return direction === current;
}

function compareFeatureSet(current, fingerprint, direction, weights) {
  const scorePieces = [];
  const reasons = [];
  const cf = current.features;
  const ff = fingerprint.features || {};
  const flowCurrent = current.flow || {};
  const flowFinger = fingerprint.flow || {};

  const bbScore = ff.bbWidthPercentile != null ? closeness(cf.bbWidthPercentile, ff.bbWidthPercentile, 25) : 0.5;
  scorePieces.push(bbScore * (weights.bb || 0));
  if (bbScore > 0.75) reasons.push(`BB compression aligned (${cf.bbWidthPercentile})`);

  const zeroScore = ff.macdZeroDistancePct != null ? closeness(cf.macdZeroDistancePct, ff.macdZeroDistancePct, 0.12) : 0.5;
  scorePieces.push(zeroScore * (weights.macdZero || 0));
  if (zeroScore > 0.75) reasons.push(`MACD zero-line approach aligned`);

  const crossValue = direction === 'long' ? boolMatch(cf.macdBullCross || cf.macdLine > cf.macdSignal, ff.macdBullCross || ff.macdLine > ff.macdSignal)
    : boolMatch(cf.macdBearCross || cf.macdLine < cf.macdSignal, ff.macdBearCross || ff.macdLine < ff.macdSignal);
  scorePieces.push(crossValue * (weights.macdCross || 0));
  if (crossValue === 1) reasons.push(`MACD ${direction === 'long' ? 'bullish' : 'bearish'} alignment matched`);

  const histScore = closeness(cf.macdHistogramSlope, ff.macdHistogramSlope, 0.02);
  scorePieces.push(histScore * (weights.histogram || 0));
  if (histScore > 0.75) reasons.push('Histogram slope aligned');

  const adxScore = closeness(cf.adx, ff.adx, 12) * closeness(cf.adxSlope, ff.adxSlope, 6);
  scorePieces.push(adxScore * (weights.adx || 0));
  if (adxScore > 0.75) reasons.push(`ADX pressure aligned (${cf.adx})`);

  const structureScore = direction === 'long'
    ? (boolMatch(Boolean(cf.bullishBos), Boolean(ff.bullishBos)) * 0.6) + (boolMatch(cf.trend === 'uptrend', ff.trend === 'uptrend') * 0.4)
    : (boolMatch(Boolean(cf.bearishBos), Boolean(ff.bearishBos)) * 0.6) + (boolMatch(cf.trend === 'downtrend', ff.trend === 'downtrend') * 0.4);
  scorePieces.push(structureScore * (weights.structure || 0));
  if (structureScore > 0.75) reasons.push('Structure and BOS aligned');

  const volumeScore = closeness(cf.volumeVsAvg20, ff.volumeVsAvg20, 2.5);
  scorePieces.push(volumeScore * (weights.volume || 0));
  if (volumeScore > 0.75) reasons.push(`Volume/avg20 aligned (${cf.volumeVsAvg20})`);

  const qvScore = closeness(cf.quoteVolumeVsAvg20, ff.quoteVolumeVsAvg20, 2.5);
  scorePieces.push(qvScore * (weights.quoteVolume || 0));

  const oiScore = closeness(flowCurrent.openInterestChangePct ?? 0, flowFinger.openInterestChangePct ?? 0, 15);
  scorePieces.push(oiScore * (weights.oi || 0));
  if (oiScore > 0.75 && Number.isFinite(flowCurrent.openInterestChangePct)) reasons.push(`OI change aligned (${round(flowCurrent.openInterestChangePct, 2)}%)`);

  const takerScore = closeness(flowCurrent.takerBuySellRatio ?? 1, flowFinger.takerBuySellRatio ?? 1, 0.8);
  scorePieces.push(takerScore * (weights.taker || 0));
  if (takerScore > 0.75 && Number.isFinite(flowCurrent.takerBuySellRatio)) reasons.push(`Taker ratio aligned (${round(flowCurrent.takerBuySellRatio, 3)})`);

  const fundingScore = closeness(flowCurrent.fundingRate ?? 0, flowFinger.fundingRate ?? 0, 0.0025);
  scorePieces.push(fundingScore * (weights.funding || 0));

  const regimeScore = direction === 'long'
    ? ((cf.trend === 'uptrend' ? 0.5 : 0.2) + ((cf.rangePositionPct ?? 50) > 55 ? 0.5 : 0.2))
    : ((cf.trend === 'downtrend' ? 0.5 : 0.2) + ((cf.rangePositionPct ?? 50) < 45 ? 0.5 : 0.2));
  scorePieces.push(clamp(regimeScore) * (weights.regime || 0));

  const riskScore = direction === 'long'
    ? ((cf.currentClose > (cf.support ?? 0)) ? 0.6 : 0.2) + ((cf.currentClose < (cf.recentHigh20 ?? cf.currentClose) * 0.995) ? 0.4 : 0.1)
    : ((cf.currentClose < (cf.resistance ?? Infinity)) ? 0.6 : 0.2) + ((cf.currentClose > (cf.recentLow20 ?? cf.currentClose) * 1.005) ? 0.4 : 0.1);
  scorePieces.push(clamp(riskScore) * (weights.risk || 0));

  const total = scorePieces.reduce((a, b) => a + b, 0);
  return { total: round(total, 2), reasons };
}

function matchStrategiesForPair(symbol, currentTfMap, strategies, weights) {
  const matches = [];

  for (const strategy of strategies) {
    const direction = strategy.direction;
    const sourceTf = strategy.fingerprint?.timeframe || strategy.sourceTimeframes?.[0] || '15m';
    const eligibleTfs = config.timeframeHierarchyMap[sourceTf] || [sourceTf];

    for (const timeframe of eligibleTfs) {
      const current = currentTfMap[timeframe];
      if (!current?.features) continue;
      const result = compareFeatureSet(current, strategy.fingerprint, direction, weights);
      matches.push({
        pair: symbol,
        direction,
        baseTimeframe: timeframe,
        sourceTimeframe: sourceTf,
        sourcePair: strategy.pair,
        sourceStrategyId: strategy.id,
        score: result.total,
        reasons: result.reasons,
        current,
        strategy
      });
    }
  }

  const bestLong = matches.filter((m) => directionFits('long', m.direction)).sort((a, b) => b.score - a.score)[0] || null;
  const bestShort = matches.filter((m) => directionFits('short', m.direction)).sort((a, b) => b.score - a.score)[0] || null;

  return {
    pair: symbol,
    long: bestLong,
    short: bestShort
  };
}

module.exports = {
  matchStrategiesForPair
};
