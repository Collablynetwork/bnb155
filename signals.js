const config = require("./config");
const state = require("./state");
const dryrun = require("./dryrun");
const { deleteTelegramMessageLater } = require("./telegramCleanup");
const {
  buildSignalMessage,
  buildSignalReplyMarkup,
  buildScoreRisingMessage,
  buildTargetHitMessage,
  buildStopHitMessage,
  buildForceClosedMessage,
} = require("./telegramMessageBuilder");

const INTERNAL_SIGNAL_HISTORY_DEFAULT = { events: [], lastByPair: {} };
const INTERNAL_SIGNAL_EVENT_LIMIT = 100;
const REVERSE_MAJORITY_WINDOW = 3;
const REVERSE_MAJORITY_MIN = 2;
const BREADTH_REVERSAL_WINDOW = 5;

function getBand(score) {
  const value = Number(score || 0);
  if (value >= config.alertThreshold) return "alert";
  if (value > config.notifyMinScore) return "strong";
  if (value >= config.watchThreshold) return "watch";
  return "low";
}

function bandRank(band) {
  return { low: 0, watch: 1, strong: 2, alert: 3 }[band] ?? 0;
}

function normalizeCandidate(candidate) {
  if (!candidate) return null;

  return {
    ...candidate,
    pair: String(candidate.pair || candidate.symbol || "").toUpperCase(),
    side:
      String(candidate.side || candidate.direction || "LONG").toUpperCase() === "SHORT"
        ? "SHORT"
        : "LONG",
    baseTimeframe: candidate.baseTimeframe || candidate.baseTf || "N/A",
    supportTfs:
      candidate.supportTfs ||
      candidate.supportTimeframes ||
      candidate.supportingTimeframes ||
      candidate.validationTfs ||
      [],
  };
}

function buildSignalKey(candidate) {
  return [
    String(candidate.pair).toUpperCase(),
    String(candidate.side).toUpperCase(),
    String(candidate.baseTimeframe || candidate.baseTf || "N/A"),
  ].join("|");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))];
}

function oppositeSide(side) {
  return String(side || "").toUpperCase() === "SHORT" ? "LONG" : "SHORT";
}

function adjustSystemValue(value, side, direction) {
  const base = Number(value || 0);
  const adjustPct = direction === "target" ? config.systemTargetAdjustPct : config.systemStopAdjustPct;
  const factor = Number(adjustPct || 0) / 100;
  const isShort = String(side).toUpperCase() === "SHORT";

  if (!Number.isFinite(base) || base <= 0) return 0;
  if (isShort) {
    return base * (1 + factor);
  }
  return base * (1 - factor);
}

function chooseStopAndTargets(side, entry, currentFeatures = {}) {
  const atr = Number(currentFeatures.atr14 || 0);
  const minRisk = Math.max(entry * 0.003, atr * 1.1, entry * 0.0015);
  const longSupport = Number(currentFeatures.support);
  const shortResistance = Number(currentFeatures.resistance);
  let sl;

  if (side === "LONG") {
    const stopCandidate =
      Number.isFinite(longSupport) && longSupport > 0 && longSupport < entry
        ? longSupport
        : entry - minRisk;
    sl = Math.min(stopCandidate, entry - Math.max(minRisk * 0.5, entry * 0.001));
    const risk = Math.max(entry - sl, minRisk);
    return {
      systemTp1: entry + risk,
      systemSl: sl,
    };
  }

  const stopCandidate =
    Number.isFinite(shortResistance) && shortResistance > entry
      ? shortResistance
      : entry + minRisk;
  sl = Math.max(stopCandidate, entry + Math.max(minRisk * 0.5, entry * 0.001));
  const risk = Math.max(sl - entry, minRisk);

  return {
    systemTp1: entry - risk,
    systemSl: sl,
  };
}

function buildSignalCandidate(matchResult) {
  if (!matchResult) return null;
  const score = Number(matchResult.score);
  if (!Number.isFinite(score)) return null;
  if (score <= Number(config.notifyMinScore || 80)) return null;

  const side =
    String(matchResult.side || matchResult.direction || "LONG").toUpperCase() === "SHORT"
      ? "SHORT"
      : "LONG";
  const baseTimeframe = matchResult.baseTimeframe || matchResult.baseTf || "N/A";
  if (!config.allowedBaseTimeframes.includes(baseTimeframe)) return null;

  const currentFeatures = matchResult.current?.features || {};
  const entry = Number(matchResult.entry ?? matchResult.entryPrice ?? currentFeatures.currentClose ?? 0);
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const supportTfsRaw =
    matchResult.supportTfs ||
    matchResult.supportTimeframes ||
    matchResult.supportingTimeframes ||
    matchResult.validationTfs ||
    [];
  const supportTfs = uniqueStrings([baseTimeframe, ...supportTfsRaw]);
  if (supportTfs.length < Number(config.minSupportCount || 3)) return null;

  const generated = chooseStopAndTargets(side, entry, currentFeatures);
  const originalSystemTp1 = Number(matchResult.tp1 ?? generated.systemTp1);
  const originalSystemSl = Number(matchResult.sl ?? matchResult.stopLoss ?? generated.systemSl);
  const targetPrice = adjustSystemValue(originalSystemTp1, side, "target");
  const stopPrice = adjustSystemValue(originalSystemSl, side, "stop");
  const riskDistance = Math.abs(entry - stopPrice);
  const rewardDistance = Math.abs(targetPrice - entry);
  const strategySourcePair =
    matchResult.strategySourcePair || matchResult.sourcePair || matchResult.strategy?.pair || "N/A";
  const strategySourceTimeframe =
    matchResult.strategySourceTimeframe ||
    matchResult.sourceTimeframe ||
    matchResult.strategy?.mainSourceTimeframe ||
    "N/A";
  const strategyUsed = `${strategySourcePair} ${strategySourceTimeframe}`.trim();

  return {
    pair: String(matchResult.pair || "").toUpperCase(),
    side,
    direction: side,
    score,
    entry,
    entryPrice: entry,
    currentPrice: Number(matchResult.currentPrice ?? currentFeatures.currentClose ?? entry),
    targetPrice,
    stopPrice,
    tp1: targetPrice,
    originalSystemTp1,
    originalSystemSl,
    sl: stopPrice,
    stopLoss: stopPrice,
    baseTimeframe,
    baseTf: baseTimeframe,
    supportTfs,
    supportTimeframes: supportTfs,
    reasons: matchResult.reasons || [],
    strategySourcePair,
    strategySourceTimeframe,
    strategySource: strategyUsed,
    strategyUsed,
    similarityScore: Number(matchResult.similarityScore || score),
    riskReward:
      Number(matchResult.riskReward) ||
      (riskDistance > 0 ? Number((rewardDistance / riskDistance).toFixed(4)) : null),
    regimeSupportScore: matchResult.regimeSupportScore ?? null,
  };
}

async function sendNewSignal(bot, chatId, candidate) {
  if (!bot || !chatId) return null;

  const text = buildSignalMessage(candidate);
  const replyMarkup = buildSignalReplyMarkup(candidate);

  return bot.sendMessage(chatId, text, {
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

async function sendScoreRise(bot, chatId, previous, current) {
  if (!bot || !chatId || !previous?.messageId) return null;

  const text = buildScoreRisingMessage({
    pair: current.pair,
    baseTf: current.baseTimeframe,
    oldScore: previous.score,
    newScore: current.score,
    updates: current.reasons?.slice(0, 4) || [],
  });

  const message = await bot.sendMessage(chatId, text, {
    reply_to_message_id: previous.messageId,
  });

  deleteTelegramMessageLater(bot, chatId, message?.message_id);
  return message;
}

function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const raw of candidates || []) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) continue;
    const key = buildSignalKey(candidate);
    const existing = byKey.get(key);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function prioritizeCandidates(candidates, prioritySignalKeys = []) {
  if (!prioritySignalKeys.length) return candidates;
  const keys = new Set(prioritySignalKeys);
  const prioritized = [];
  const remaining = [];

  for (const candidate of candidates) {
    if (keys.has(buildSignalKey(candidate))) prioritized.push(candidate);
    else remaining.push(candidate);
  }

  return [...prioritized, ...remaining];
}

function strongestCandidatePerPair(candidates) {
  const byPair = new Map();

  for (const candidate of candidates || []) {
    const existing = byPair.get(candidate.pair);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      byPair.set(candidate.pair, candidate);
    }
  }

  return [...byPair.values()];
}

function loadInternalSignalHistory() {
  const raw = state.readJson(config.internalSignalHistoryPath, INTERNAL_SIGNAL_HISTORY_DEFAULT) || {};
  return {
    events: Array.isArray(raw.events) ? raw.events : [],
    lastByPair: raw.lastByPair && typeof raw.lastByPair === "object" ? raw.lastByPair : {},
  };
}

function saveInternalSignalHistory(snapshot) {
  state.writeJson(config.internalSignalHistoryPath, snapshot);
  return snapshot;
}

function recordInternalSignalEvents(candidates, recordedAt = new Date().toISOString()) {
  const history = loadInternalSignalHistory();
  const strongest = strongestCandidatePerPair(candidates)
    .sort((a, b) => Number(a.score || 0) - Number(b.score || 0));

  for (const candidate of strongest) {
    const pair = String(candidate.pair || "").toUpperCase();
    const side = String(candidate.side || "").toUpperCase();
    const previous = history.lastByPair[pair];

    history.lastByPair[pair] = {
      side,
      score: Number(candidate.score || 0),
      recordedAt,
      baseTimeframe: candidate.baseTimeframe || null,
    };

    if (previous?.side === side) continue;

    history.events.push({
      pair,
      side,
      score: Number(candidate.score || 0),
      baseTimeframe: candidate.baseTimeframe || null,
      recordedAt,
    });
  }

  history.events = history.events.slice(-INTERNAL_SIGNAL_EVENT_LIMIT);
  return saveInternalSignalHistory(history);
}

function recentOtherSignalEvents(events, pair, limit) {
  return (events || [])
    .filter((event) => event.pair !== String(pair || "").toUpperCase())
    .slice(-limit);
}

function buildForcedCloseReasonForCondition1(position, reverseSide, reverseVotes, windowEvents) {
  return `Market is getting reversed. Same-pair ${reverseSide} signal appeared and ${reverseVotes} of the last ${windowEvents.length} internal signals from other pairs also flipped ${reverseSide}.`;
}

function buildForcedCloseReasonForCondition2(position, reverseSide) {
  return `Closed because the last ${BREADTH_REVERSAL_WINDOW} internal signals from other pairs were ${reverseSide}, showing broad market reversal pressure.`;
}

function evaluateInternalMarketClosures(priceByPair, candidates) {
  const history = recordInternalSignalEvents(candidates);
  const openPositions = dryrun.getBlockingOpenTrades();
  const updates = [];
  const priorityCandidates = [];

  for (const position of openPositions) {
    const reverseSide = oppositeSide(position.side);
    const reverseCandidate = (candidates || [])
      .filter(
        (candidate) =>
          String(candidate.pair || "").toUpperCase() === position.pair &&
          String(candidate.side || "").toUpperCase() === reverseSide
      )
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
    const lastThreeOther = recentOtherSignalEvents(history.events, position.pair, REVERSE_MAJORITY_WINDOW);
    const reverseVotes = lastThreeOther.filter((event) => event.side === reverseSide).length;
    const forceClosePrice =
      Number(priceByPair?.[position.pair]) ||
      Number(reverseCandidate?.currentPrice) ||
      Number(position.currentMark) ||
      Number(position.entryPrice);

    if (reverseCandidate && lastThreeOther.length >= REVERSE_MAJORITY_MIN && reverseVotes >= REVERSE_MAJORITY_MIN) {
      const forced = dryrun.forceCloseTrade(position.signalId || position.id || position.signalKey, forceClosePrice, {
        reasonCode: "MARKET_REVERSED",
        reasonText: buildForcedCloseReasonForCondition1(position, reverseSide, reverseVotes, lastThreeOther),
        forceDirection: reverseSide,
      });

      if (forced) {
        updates.push(forced);
        priorityCandidates.push(reverseCandidate);
      }
      continue;
    }

    const lastFiveOther = recentOtherSignalEvents(history.events, position.pair, BREADTH_REVERSAL_WINDOW);
    if (
      lastFiveOther.length === BREADTH_REVERSAL_WINDOW &&
      lastFiveOther.every((event) => event.side === reverseSide)
    ) {
      const forced = dryrun.forceCloseTrade(position.signalId || position.id || position.signalKey, forceClosePrice, {
        reasonCode: "BREADTH_REVERSED",
        reasonText: buildForcedCloseReasonForCondition2(position, reverseSide),
        forceDirection: reverseSide,
      });

      if (forced) updates.push(forced);
    }
  }

  return {
    updates,
    priorityCandidates,
    recordedEvents: history.events,
  };
}

async function dispatchSignals(bot, chatId, candidates, options = {}) {
  const deduped = dedupeCandidates(candidates);
  const prioritized = prioritizeCandidates(deduped, options.prioritySignalKeys || []);
  if (!prioritized.length) return [];

  const activeSignals = state.readJson(config.activeSignalsPath, {});
  const results = [];

  for (const candidate of prioritized) {
    const signalKey = buildSignalKey(candidate);
    const band = getBand(candidate.score);
    const previous = activeSignals[signalKey];

    if (!previous) {
      if (!dryrun.canOpenNewSignal()) {
        continue;
      }

      const tracked = dryrun.registerSignal({
        ...candidate,
        signalKey,
      });
      if (!tracked) continue;

      const sent = await sendNewSignal(bot, chatId, candidate);
      dryrun.attachSignalMessage(tracked.signalId || tracked.id, sent?.message_id || null, signalKey);

      activeSignals[signalKey] = {
        ...candidate,
        band,
        messageId: sent?.message_id || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      results.push({ type: "new", key: signalKey, candidate });
      continue;
    }

    const scoreRise = Number(candidate.score || 0) - Number(previous.score || 0);
    const raisedBand = bandRank(band) > bandRank(previous.band);

    if (scoreRise > 0 && (raisedBand || scoreRise >= config.scoreRiseThreshold)) {
      await sendScoreRise(bot, chatId, previous, candidate);
      activeSignals[signalKey] = {
        ...previous,
        ...candidate,
        band,
        updatedAt: new Date().toISOString(),
      };
      results.push({ type: "rise", key: signalKey, candidate });
      continue;
    }

    activeSignals[signalKey] = {
      ...previous,
      ...candidate,
      band: previous.band || band,
      updatedAt: previous.updatedAt || new Date().toISOString(),
    };
  }

  state.writeJson(config.activeSignalsPath, activeSignals);
  return results;
}

async function dispatchTradeUpdates(bot, chatId, updates) {
  if (!bot || !chatId || !Array.isArray(updates) || !updates.length) return [];

  const activeSignals = state.readJson(config.activeSignalsPath, {});
  const sent = [];
  let dirty = false

  for (const update of updates) {
    const position = update.position || update;
    const replyTo = position.signalMessageId || position.messageId || null;

    let text = "";
    if (update.type === "TARGET ACHIEVED") {
      text = buildTargetHitMessage(position);
    } else if (update.type === "SL HIT") {
      text = buildStopHitMessage(position);
    } else if (update.type === "FORCE CLOSED") {
      text = buildForceClosedMessage(position);
    } else {
      continue;
    }

    const message = await bot.sendMessage(
      chatId,
      text,
      replyTo ? { reply_to_message_id: replyTo } : {}
    );
    sent.push(message);

    const signalKey = position.signalKey || buildSignalKey(position);
    if (
      activeSignals[signalKey] &&
      (!position.signalMessageId || activeSignals[signalKey].messageId === position.signalMessageId)
    ) {
      delete activeSignals[signalKey];
      dirty = true;
    }
  }

  if (dirty) {
    state.writeJson(config.activeSignalsPath, activeSignals);
  }

  return sent;
}

module.exports = {
  buildSignalCandidate,
  dispatchSignals,
  dispatchTradeUpdates,
  buildSignalKey,
  dedupeCandidates,
  evaluateInternalMarketClosures,
};
