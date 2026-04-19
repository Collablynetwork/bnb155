const config = require("./config");
const state = require("./state");
const binance = require("./binance");
const { buildFeatureSnapshot, round } = require("./indicators");
const { detectStructure } = require("./structure");
const { buildDynamicWeights } = require("./weights");
const { findRecentPumpLeaders } = require("./pumpDetector");
const {
  learnAndPersist,
  loadStrategies,
  rebuildStrategiesIndexFromFiles,
  getStrategyRetentionDays,
} = require("./strategyLearner");
const { matchStrategiesForPair } = require("./similarity");
const signalEngine = require("./signals");
const dryrun = require("./dryrun");
const telegram = require("./telegram");

state.ensureStorage();

const bot = telegram.createBot();
let validSymbolsSet = null;
let scanLock = false;

function timeframeToFlowPeriod(timeframe) {
  const allowed = new Set(config.supportedFlowPeriods);
  if (allowed.has(timeframe)) return timeframe;
  if (["1m"].includes(timeframe)) return "5m";
  if (timeframe === "8h") return "6h";
  if (timeframe === "3d" || timeframe === "1w") return "1d";
  return "1h";
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current], current);
    }
  }

  const size = Math.max(1, Math.min(limit || 1, items.length || 1));
  await Promise.all(Array.from({ length: size }, () => runner()));
  return results;
}

function uniqueUpper(values) {
  return [...new Set(values.map((v) => String(v).trim().toUpperCase()).filter(Boolean))];
}

function applyUniverseCap(allPairs, watchedPairs) {
  const cap = Number(config.maxScanPairs || 0);
  const prioritizeWatchedPairs =
    String(config.prioritizeWatchedPairs ?? "true").toLowerCase() === "true";

  if (!cap || cap <= 0 || allPairs.length <= cap) return allPairs;
  if (!prioritizeWatchedPairs) return allPairs.slice(0, cap);

  const watchedSet = new Set(watchedPairs);
  const priority = [];
  const rest = [];

  for (const pair of allPairs) {
    if (watchedSet.has(pair)) priority.push(pair);
    else rest.push(pair);
  }

  return [...priority, ...rest].slice(0, cap);
}

async function resolveScanUniverse() {
  const watchedPairs = state.getWatchedPairs();

  if (!validSymbolsSet) {
    validSymbolsSet = await binance.getValidUsdtPerpSet();
  }

  const watchedValid = uniqueUpper(watchedPairs.filter((pair) => validSymbolsSet.has(pair)));
  const finalPairs = applyUniverseCap(watchedValid, watchedValid);

  return {
    watchedPairs,
    watchedValid,
    scanPairs: finalPairs,
  };
}

async function buildTimeframePayload(symbol, timeframe) {
  const candles = await binance.getKlines(symbol, timeframe, config.maxKlinesPerRequest);
  const features = buildFeatureSnapshot(candles);
  const structure = detectStructure(candles);
  const flowPeriod = timeframeToFlowPeriod(timeframe);

  let fundingRate = 0;
  let openInterest = null;
  let openInterestChangePct = 0;
  let takerBuySellRatio = 1;
  let book = null;

  try {
    const [mark, oiNow, oiHist, takerHist, funding, bookTicker] = await Promise.all([
      binance.getMarkPrice(symbol),
      binance.getOpenInterest(symbol),
      binance.getOpenInterestHist(symbol, flowPeriod, 20).catch(() => []),
      binance.getTakerLongShortRatio(symbol, flowPeriod, 20).catch(() => []),
      binance.getFundingRate(symbol, 5).catch(() => []),
      binance.getBookTicker(symbol).catch(() => null),
    ]);

    features.currentClose = Number(mark.markPrice || mark.indexPrice || features.currentClose);
    openInterest = Number(oiNow.openInterest || 0);

    if (oiHist.length >= 2) {
      const start = Number(oiHist[0].sumOpenInterestValue || oiHist[0].sumOpenInterest || 0);
      const end = Number(
        oiHist[oiHist.length - 1].sumOpenInterestValue ||
          oiHist[oiHist.length - 1].sumOpenInterest ||
          0
      );
      openInterestChangePct = start ? ((end - start) / start) * 100 : 0;
    }

    if (takerHist.length) {
      const last = takerHist[takerHist.length - 1];
      takerBuySellRatio = Number(last.buySellRatio || 1);
    }

    if (funding.length) {
      fundingRate = Number(funding[funding.length - 1].fundingRate || 0);
    }

    if (bookTicker) {
      const bid = Number(bookTicker.bidPrice || 0);
      const ask = Number(bookTicker.askPrice || 0);

      book = {
        bid,
        ask,
        spreadPct: bid > 0 ? ((ask - bid) / bid) * 100 : 0,
        bidQty: Number(bookTicker.bidQty || 0),
        askQty: Number(bookTicker.askQty || 0),
      };
    }
  } catch (error) {
    console.error(`Flow build error ${symbol} ${timeframe}:`, error.message);
  }

  return {
    candles,
    features: {
      ...features,
      ...structure,
      openInterest,
      spreadPct: book?.spreadPct ?? null,
    },
    flow: {
      fundingRate,
      openInterest,
      openInterestChangePct: round(openInterestChangePct, 4),
      takerBuySellRatio: round(takerBuySellRatio, 4),
    },
    book,
  };
}

async function buildFeatureStoreForPairs(pairs) {
  const featureStore = {};

  await mapLimit(pairs, Number(config.maxParallelRequests || 2), async (pair) => {
    featureStore[pair] = {};

    for (const timeframe of config.supportedKlineIntervals) {
      featureStore[pair][timeframe] = await buildTimeframePayload(pair, timeframe);
    }
  });

  return featureStore;
}

function recentEventsOnly(events, retentionDays = getStrategyRetentionDays()) {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => new Date(e.timestamp).getTime() >= cutoffMs);
}

function extractRegimeSupport(tfMap, direction) {
  const regimeTfs = ["1d", "3d", "1w"];
  let score = 0;

  for (const tf of regimeTfs) {
    const f = tfMap?.[tf]?.features;
    if (!f) continue;

    if (direction === "long") {
      if (f.trend === "uptrend") score += 0.4;
      if ((f.rangePositionPct ?? 50) > 55) score += 0.2;
      if ((f.diSpread ?? 0) > 0) score += 0.2;
    } else {
      if (f.trend === "downtrend") score += 0.4;
      if ((f.rangePositionPct ?? 50) < 45) score += 0.2;
      if ((f.diSpread ?? 0) < 0) score += 0.2;
    }
  }

  return Math.min(1, score);
}

function buildRegimeSupportDetail(tfMap, direction) {
  const regimeTfs = ["1d", "3d", "1w"];
  const out = {};

  for (const tf of regimeTfs) {
    const f = tfMap?.[tf]?.features || {};
    out[tf] = {
      trend: f.trend ?? null,
      bullishBos: f.bullishBos ?? null,
      bearishBos: f.bearishBos ?? null,
      rangePositionPct: f.rangePositionPct ?? null,
      diSpread: f.diSpread ?? null,
      directionSupported:
        direction === "long"
          ? f.trend === "uptrend" || (f.diSpread ?? 0) > 0
          : f.trend === "downtrend" || (f.diSpread ?? 0) < 0,
    };
  }

  return out;
}

function buildAllTimeframeSnapshot(tfMap) {
  const snapshot = {};

  for (const [timeframe, payload] of Object.entries(tfMap || {})) {
    const f = payload?.features || {};
    const flow = payload?.flow || {};

    snapshot[timeframe] = {
      currentClose: f.currentClose ?? null,
      trend: f.trend ?? null,
      bullishBos: f.bullishBos ?? null,
      bearishBos: f.bearishBos ?? null,
      support: f.support ?? null,
      resistance: f.resistance ?? null,
      bbWidthPercentile: f.bbWidthPercentile ?? null,
      bbWidth: f.bbWidth ?? null,
      bbBasis: f.bbBasis ?? null,
      bbUpper: f.bbUpper ?? null,
      bbLower: f.bbLower ?? null,
      macdLine: f.macdLine ?? null,
      macdSignal: f.macdSignal ?? null,
      macdHistogram: f.macdHistogram ?? null,
      macdHistogramSlope: f.macdHistogramSlope ?? null,
      macdBullCross: f.macdBullCross ?? null,
      macdBearCross: f.macdBearCross ?? null,
      macdAboveZero: f.macdAboveZero ?? null,
      macdBelowZero: f.macdBelowZero ?? null,
      adx: f.adx ?? null,
      adxSlope: f.adxSlope ?? null,
      plusDI: f.plusDI ?? null,
      minusDI: f.minusDI ?? null,
      diSpread: f.diSpread ?? null,
      volumeVsAvg20: f.volumeVsAvg20 ?? null,
      volumeVsAvg50: f.volumeVsAvg50 ?? null,
      quoteVolumeVsAvg20: f.quoteVolumeVsAvg20 ?? null,
      rangePositionPct: f.rangePositionPct ?? null,
      openInterest: flow.openInterest ?? null,
      openInterestChangePct: flow.openInterestChangePct ?? null,
      takerBuySellRatio: flow.takerBuySellRatio ?? null,
      fundingRate: flow.fundingRate ?? null,
    };
  }

  return snapshot;
}

function findSupportingTimeframes(tfMap, baseTimeframe, direction) {
  const map = config.timeframeHierarchyMap || {};
  const stack = map[baseTimeframe] || [baseTimeframe];
  const out = [];

  for (const tf of stack) {
    const f = tfMap?.[tf]?.features;
    if (!f) continue;

    if (tf === baseTimeframe) {
      out.push(tf);
      continue;
    }

    if (direction === "long") {
      const supported =
        f.trend === "uptrend" ||
        f.bullishBos ||
        (f.diSpread ?? 0) > 0 ||
        ((f.macdLine ?? 0) >= (f.macdSignal ?? 0) && (f.macdHistogramSlope ?? 0) >= 0);

      if (supported) out.push(tf);
    } else {
      const supported =
        f.trend === "downtrend" ||
        f.bearishBos ||
        (f.diSpread ?? 0) < 0 ||
        ((f.macdLine ?? 0) <= (f.macdSignal ?? 0) && (f.macdHistogramSlope ?? 0) <= 0);

      if (supported) out.push(tf);
    }
  }

  return [...new Set(out)];
}

function dedupeCandidates(candidates) {
  const map = new Map();

  for (const candidate of candidates) {
    const key = signalEngine.buildSignalKey(candidate);
    const existing = map.get(key);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      map.set(key, candidate);
    }
  }

  return [...map.values()].sort((a, b) => b.score - a.score);
}

async function runScan(options = {}) {
  if (scanLock) {
    return {
      skipped: true,
      pairsChecked: 0,
      candidates: 0,
      topCandidates: [],
    };
  }

  scanLock = true;

  try {
    const { watchedPairs, watchedValid, scanPairs } = await resolveScanUniverse();

    if (!scanPairs.length) {
      return {
        skipped: false,
        pairsChecked: 0,
        candidates: 0,
        watchedPairs: watchedPairs.length,
        watchedValid: watchedValid.length,
        scannedUniverse: 0,
        topCandidates: [],
      };
    }

    const featureStore = await buildFeatureStoreForPairs(scanPairs);

    const retentionDays = getStrategyRetentionDays();
    let recentLeaders = recentEventsOnly(findRecentPumpLeaders(featureStore), retentionDays);
    recentLeaders = recentLeaders.map((event) => ({
      ...event,
      regimeSupportScore: extractRegimeSupport(featureStore[event.pair], event.direction),
      regimeSupport: buildRegimeSupportDetail(featureStore[event.pair], event.direction),
      allTimeframes: buildAllTimeframeSnapshot(featureStore[event.pair]),
      supportingTimeframes: findSupportingTimeframes(
        featureStore[event.pair],
        event.timeframe,
        event.direction
      ),
    }));

    const learnedWeights = buildDynamicWeights(recentLeaders);
    state.writeJson(config.learnedPumpsPath, recentLeaders);

    const newStrategies = learnAndPersist(recentLeaders, learnedWeights);
    const strategies = loadStrategies();
    const candidates = [];

    for (const pair of scanPairs) {
      const match = matchStrategiesForPair(pair, featureStore[pair], strategies, learnedWeights);

      const longSupport = match.long
        ? findSupportingTimeframes(featureStore[pair], match.long.baseTimeframe, "long")
        : [];
      const shortSupport = match.short
        ? findSupportingTimeframes(featureStore[pair], match.short.baseTimeframe, "short")
        : [];

      const longSignal = signalEngine.buildSignalCandidate({
        ...match.long,
        supportTimeframes: longSupport,
      });
      const shortSignal = signalEngine.buildSignalCandidate({
        ...match.short,
        supportTimeframes: shortSupport,
      });

      if (longSignal) {
        longSignal.isWatchedPair = watchedValid.includes(pair);
        longSignal.discoveryType = "watched";
        candidates.push(longSignal);
      }

      if (shortSignal) {
        shortSignal.isWatchedPair = watchedValid.includes(pair);
        shortSignal.discoveryType = "watched";
        candidates.push(shortSignal);
      }
    }

    const allCandidates = dedupeCandidates(candidates);
    const topCandidates = allCandidates.slice(0, 25);

    state.writeJson(config.scoreStatePath, {
      generatedAt: new Date().toISOString(),
      watchedPairs,
      watchedValid,
      scannedUniverse: scanPairs.length,
      candidates: topCandidates,
    });

    const prices = {};
    for (const pair of scanPairs) {
      const mark = featureStore[pair]?.["1m"]?.features?.currentClose;
      if (Number.isFinite(mark)) prices[pair] = mark;
    }

    const forcedClosures = signalEngine.evaluateInternalMarketClosures(prices, allCandidates);
    if (forcedClosures.updates.length) {
      await signalEngine.dispatchTradeUpdates(
        bot,
        options.chatId || config.telegramChatId,
        forcedClosures.updates
      );
    }

    if (!options.suppressSignals) {
      const prioritySignalKeys = (forcedClosures.priorityCandidates || []).map((candidate) =>
        signalEngine.buildSignalKey(candidate)
      );
      const dispatchCandidates = [
        ...(forcedClosures.priorityCandidates || []),
        ...topCandidates,
      ];

      await signalEngine.dispatchSignals(
        bot,
        options.chatId || config.telegramChatId,
        dispatchCandidates,
        { prioritySignalKeys }
      );
    }

    const updates = dryrun.evaluateTargetsAndStops(prices);
    if (updates.length) {
      await signalEngine.dispatchTradeUpdates(
        bot,
        options.chatId || config.telegramChatId,
        updates
      );
    }

    return {
      skipped: false,
      watchedPairs: watchedPairs.length,
      watchedValid: watchedValid.length,
      scannedUniverse: scanPairs.length,
      pairsChecked: scanPairs.length,
      candidates: topCandidates.length,
      learnedStrategies: newStrategies.length,
      topCandidates,
    };
  } catch (error) {
    console.error("runScan error:", error);
    return {
      skipped: false,
      pairsChecked: 0,
      candidates: 0,
      topCandidates: [],
      error: error.message,
    };
  } finally {
    scanLock = false;
  }
}

telegram.registerHandlers(bot, { runScan });

async function bootstrap() {
  if (typeof rebuildStrategiesIndexFromFiles === "function") {
    const rebuilt = rebuildStrategiesIndexFromFiles();
    console.log("Strategy retention cleanup:", {
      retentionDays: rebuilt.retentionDays,
      keptStrategies: rebuilt.length,
      removedStrategies: rebuilt.removedFiles.length,
    });
  } else {
    console.warn("rebuildStrategiesIndexFromFiles export missing, skipping index rebuild.");
  }

  if (bot && typeof telegram.setupCommands === "function") {
    await telegram.setupCommands(bot);
    console.log("Telegram command menu registered.");
  }

  try {
    await binance.ping();
    console.log("Connected to Binance Futures REST");
  } catch (error) {
    console.error("Binance ping failed:", error.message);
  }

  const first = await runScan();
  console.log("Initial scan summary:", first);

  setInterval(() => {
    runScan().then((summary) => {
      console.log("Scheduled scan summary:", summary);
    });
  }, config.scanEveryMs);
}

if (require.main === module) {
  bootstrap();
}

module.exports = {
  runScan,
  bootstrap,
  resolveScanUniverse,
  findSupportingTimeframes,
};
