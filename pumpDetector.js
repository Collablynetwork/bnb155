const { buildFeatureSnapshot, round } = require("./indicators");
const { detectStructure } = require("./structure");

function getMoveThresholdByTimeframe(timeframe) {
  const map = {
    "1m": 0.8,
    "5m": 1.2,
    "15m": 1.8,
    "30m": 2.2,
    "1h": 2.8,
    "2h": 3.2,
    "4h": 4.0,
    "6h": 4.5,
    "8h": 5.0,
    "12h": 6.0,
    "1d": 7.0,
    "3d": 9.0,
    "1w": 12.0,
  };

  return map[timeframe] ?? 2.5;
}

function bestBullishWindows(candles, window = 20, limit = 3) {
  const results = [];

  for (let i = 0; i < candles.length - window; i += 1) {
    const base = candles[i].close;

    for (let j = i + 1; j < Math.min(candles.length, i + window); j += 1) {
      const gainPct = ((candles[j].high - base) / base) * 100;

      results.push({
        startIndex: i,
        endIndex: j,
        movePct: gainPct,
        startPrice: base,
        endPrice: candles[j].high,
      });
    }
  }

  results.sort((a, b) => b.movePct - a.movePct);

  return dedupeNearbyWindows(results).slice(0, limit);
}

function bestBearishWindows(candles, window = 20, limit = 3) {
  const results = [];

  for (let i = 0; i < candles.length - window; i += 1) {
    const base = candles[i].close;

    for (let j = i + 1; j < Math.min(candles.length, i + window); j += 1) {
      const dropPct = ((base - candles[j].low) / base) * 100;

      results.push({
        startIndex: i,
        endIndex: j,
        movePct: dropPct,
        startPrice: base,
        endPrice: candles[j].low,
      });
    }
  }

  results.sort((a, b) => b.movePct - a.movePct);

  return dedupeNearbyWindows(results).slice(0, limit);
}

function dedupeNearbyWindows(windows) {
  const kept = [];

  for (const item of windows) {
    const nearExisting = kept.some(
      (x) =>
        Math.abs(x.startIndex - item.startIndex) <= 3 &&
        Math.abs(x.endIndex - item.endIndex) <= 3
    );

    if (!nearExisting) kept.push(item);
  }

  return kept;
}

function extractPreMoveFeatures(candles, move, direction) {
  const triggerIndex = Math.max(move.startIndex, 25);
  const preSlice = candles.slice(Math.max(0, triggerIndex - 120), triggerIndex + 1);

  const features = buildFeatureSnapshot(preSlice);
  const structure = detectStructure(preSlice);

  const triggerCandle = candles[triggerIndex];
  const moveCandle = candles[move.endIndex];

  return {
    ...features,
    ...structure,
    triggerTime: new Date(triggerCandle.closeTime).toISOString(),
    moveTime: new Date(moveCandle.closeTime).toISOString(),
    movePct: round(move.movePct, 4),
    direction,
    triggerPrice: round(triggerCandle.close, 8),
    resultPrice: round(move.endPrice, 8),
  };
}

function detectEventQuality(features, direction) {
  let score = 0;

  if ((features.bbWidthPercentile ?? 100) < 20) score += 18;
  if ((features.quoteVolumeVsAvg20 ?? 0) > 1.3) score += 8;
  if ((features.bodyPctOfRange ?? 0) > 55) score += 8;

  if (direction === "long") {
    if (
      (features.macdBullCross ||
        ((features.macdLine ?? 0) > (features.macdSignal ?? 0))) &&
      (features.macdHistogramSlope ?? 0) > 0
    ) {
      score += 16;
    }

    if ((features.adx ?? 0) >= 16 && (features.adxSlope ?? 0) > 0) score += 10;
    if (features.bullishBos) score += 18;
    if ((features.volumeVsAvg20 ?? 0) > 1.5) score += 12;
    if ((features.diSpread ?? 0) > 0) score += 10;
    if ((features.macdAboveZero ?? false) || Math.abs(features.macdLine ?? 0) < 0.0005) score += 8;
  } else {
    if (
      (features.macdBearCross ||
        ((features.macdLine ?? 0) < (features.macdSignal ?? 0))) &&
      (features.macdHistogramSlope ?? 0) < 0
    ) {
      score += 16;
    }

    if ((features.adx ?? 0) >= 16 && (features.adxSlope ?? 0) > 0) score += 10;
    if (features.bearishBos) score += 18;
    if ((features.volumeVsAvg20 ?? 0) > 1.5) score += 12;
    if ((features.diSpread ?? 0) < 0) score += 10;
    if ((features.macdBelowZero ?? false) || Math.abs(features.macdLine ?? 0) < 0.0005) score += 8;
  }

  return score;
}

function buildPumpEventsForTimeframe(symbol, timeframe, candles, flow) {
  if (!candles || candles.length < 60) return [];

  const events = [];
  const minMove = getMoveThresholdByTimeframe(timeframe);

  const bullWindows = bestBullishWindows(candles, 20, 3);
  const bearWindows = bestBearishWindows(candles, 20, 3);

  for (const bull of bullWindows) {
    if (bull.movePct < minMove) continue;

    const features = extractPreMoveFeatures(candles, bull, "long");
    const score = detectEventQuality(features, "long");

    events.push({
      pair: symbol,
      direction: "long",
      timeframe,
      movePct: round(bull.movePct, 4),
      eventScore: score,
      sourceWindow: bull,
      features,
      flow,
      timestamp: features.moveTime,
    });
  }

  for (const bear of bearWindows) {
    if (bear.movePct < minMove) continue;

    const features = extractPreMoveFeatures(candles, bear, "short");
    const score = detectEventQuality(features, "short");

    events.push({
      pair: symbol,
      direction: "short",
      timeframe,
      movePct: round(bear.movePct, 4),
      eventScore: score,
      sourceWindow: bear,
      features,
      flow,
      timestamp: features.moveTime,
    });
  }

  return events;
}

function findRecentPumpLeaders(featureStore) {
  const events = [];

  for (const [symbol, tfMap] of Object.entries(featureStore || {})) {
    for (const [timeframe, payload] of Object.entries(tfMap || {})) {
      if (payload?.candles?.length) {
        events.push(
          ...buildPumpEventsForTimeframe(
            symbol,
            timeframe,
            payload.candles,
            payload.flow || {}
          )
        );
      }
    }
  }

  events.sort((a, b) => {
    const aScore = (a.eventScore || 0) + (a.movePct || 0);
    const bScore = (b.eventScore || 0) + (b.movePct || 0);
    return bScore - aScore;
  });

  // keep all qualifying events; do not cut to 50 anymore
  return events;
}

module.exports = {
  buildPumpEventsForTimeframe,
  findRecentPumpLeaders,
};
