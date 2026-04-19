function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function baseWeights() {
  return {
    bb: 18,
    macdZero: 14,
    macdCross: 10,
    histogram: 8,
    adx: 12,
    structure: 14,
    volume: 10,
    quoteVolume: 4,
    oi: 6,
    taker: 6,
    funding: 2,
    regime: 8,
    risk: 8
  };
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const result = {};
  for (const [key, value] of Object.entries(weights)) {
    result[key] = (value / total) * 100;
  }
  return result;
}

function buildDynamicWeights(learnedEvents) {
  const weights = baseWeights();
  if (!learnedEvents.length) return normalizeWeights(weights);

  const bbCompression = average(learnedEvents.map((e) => e.features?.bbWidthPercentile ?? 50));
  const macdNearZero = average(learnedEvents.map((e) => Math.max(0, 1 - ((e.features?.macdZeroDistancePct ?? 1) * 100))));
  const adxValue = average(learnedEvents.map((e) => e.features?.adx ?? 18));
  const volumeVsAvg = average(learnedEvents.map((e) => e.features?.volumeVsAvg20 ?? 1));
  const oiChange = average(learnedEvents.map((e) => Math.abs(e.flow?.openInterestChangePct ?? 0)));
  const takerBias = average(learnedEvents.map((e) => Math.abs((e.flow?.takerBuySellRatio ?? 1) - 1)));
  const strongHigherTf = average(learnedEvents.map((e) => e.regimeSupportScore ?? 0.5));

  if (bbCompression < 20) weights.bb += 7;
  if (macdNearZero > 0.5) weights.macdZero += 5;
  if (adxValue > 20) weights.adx += 4;
  if (volumeVsAvg > 1.8) {
    weights.volume += 5;
    weights.quoteVolume += 2;
  }
  if (oiChange > 2) weights.oi += 5;
  if (takerBias > 0.15) weights.taker += 3;
  if (strongHigherTf > 0.65) weights.regime += 5;

  return normalizeWeights(weights);
}

module.exports = {
  baseWeights,
  buildDynamicWeights,
  normalizeWeights
};
