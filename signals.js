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

const SCORE_RANGE_LABELS = {
  [-1]: "Below 70",
  0: "T0",
  1: "T1",
  2: "T2",
  3: "T3",
  4: "T4",
  5: "T5",
};

function getScoreRangeIndex(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return null;
  if (value < 70) return -1;
  if (value < 75) return 0;
  if (value < 80) return 1;
  if (value < 85) return 2;
  if (value < 90) return 3;
  if (value < 95) return 4;
  return 5;
}

function getScoreRangeLabel(index) {
  if (index === null || index === undefined) return "Start";
  return SCORE_RANGE_LABELS[index] || `T${index}`;
}

function buildScoreMove(previousIndex, currentIndex) {
  return `${getScoreRangeLabel(previousIndex)} → ${getScoreRangeLabel(currentIndex)}`;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))];
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

function oppositeSide(side) {
  return String(side || "").toUpperCase() === "SHORT" ? "LONG" : "SHORT";
}

function adjustSystemValue(value, side, direction) {
  const base = Number(value || 0);
  const adjustPct = direction === "target" ? config.systemTargetAdjustPct : config.systemStopAdjustPct;
  const factor = Number(adjustPct || 0) / 100;
  const isShort = String(side).toUpperCase() === "SHORT";

  if (!Number.isFinite(base) || base <= 0) return 0;
  if (isShort) return base * (1 + factor);
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

  const pair = String(matchResult.pair || "").toUpperCase();
  if (!pair) return null;

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
    pair,
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

function normalizeMomentumSnapshot(snapshot) {
  const lastObservedRangeIndex = Number(snapshot?.lastObservedRangeIndex);
  const lastValidRangeIndex = Number(snapshot?.lastValidRangeIndex);

  return {
    lastObservedRangeIndex: Number.isFinite(lastObservedRangeIndex) ? lastObservedRangeIndex : null,
    lastObservedScore: Number.isFinite(Number(snapshot?.lastObservedScore))
      ? Number(snapshot.lastObservedScore)
      : null,
    lastValidRangeIndex: Number.isFinite(lastValidRangeIndex) ? lastValidRangeIndex : null,
    sequenceLocked: snapshot?.sequenceLocked === true,
    updatedAt: snapshot?.updatedAt || null,
  };
}

function defaultMomentumSnapshot() {
  return normalizeMomentumSnapshot({});
}

function loadScoreMomentumState() {
  const raw = state.readJson(config.scoreMomentumStatePath, {}) || {};
  const normalized = {};

  for (const [key, value] of Object.entries(raw)) {
    normalized[key] = normalizeMomentumSnapshot(value);
  }

  return normalized;
}

function saveScoreMomentumState(snapshot) {
  state.writeJson(config.scoreMomentumStatePath, snapshot || {});
  return snapshot;
}

function shouldLogBlockedMove(previousIndex, currentIndex) {
  return (previousIndex ?? -1) >= 2 || currentIndex >= 2;
}

function evaluateCandidateMomentum(candidate, previousSnapshot, evaluatedAt = new Date().toISOString()) {
  const currentRangeIndex = getScoreRangeIndex(candidate.score);
  const currentRangeLabel = getScoreRangeLabel(currentRangeIndex);
  const previous = normalizeMomentumSnapshot(previousSnapshot);
  const previousRangeIndex = previous.lastObservedRangeIndex;
  const previousRangeLabel = getScoreRangeLabel(previousRangeIndex);
  const previousValidRangeIndex = previous.lastValidRangeIndex;
  const scoreMove = buildScoreMove(previousRangeIndex, currentRangeIndex);

  let lastObservedRangeIndex = currentRangeIndex;
  let lastValidRangeIndex = previousValidRangeIndex;
  let sequenceLocked = previous.sequenceLocked === true;
  let transitionType = "tracking";
  let momentumLabel = "Tracking Only";
  let validSignalEvent = false;
  let entryEligible = false;
  let blockedReason = null;

  if (currentRangeIndex === null) {
    blockedReason = "score range could not be determined";
    transitionType = "blocked";
    momentumLabel = "Invalid Score";
  } else if (currentRangeIndex < 0) {
    lastValidRangeIndex = null;
    sequenceLocked = false;
    transitionType = "reset";
    momentumLabel = "Reset Below 70";
  } else if (currentRangeIndex === 0) {
    lastValidRangeIndex = 0;
    sequenceLocked = false;
    transitionType = "tracking";
    momentumLabel = "Tracking Reset";
  } else if (currentRangeIndex === 1) {
    if (
      previousRangeIndex !== null &&
      previousRangeIndex >= 2 &&
      currentRangeIndex < previousRangeIndex
    ) {
      sequenceLocked = true;
      blockedReason = `fallback move ${scoreMove}; T0 reset required before T2 again`;
      momentumLabel = "Fallback Locked";
      transitionType = "blocked";
    } else if (previousRangeIndex === 0 && previousValidRangeIndex === 0 && !sequenceLocked) {
      lastValidRangeIndex = 1;
      transitionType = "tracking";
      momentumLabel = "Tracking Rising";
    } else {
      transitionType = "tracking";
      momentumLabel = sequenceLocked ? "Tracking Locked" : "Tracking Only";
    }
  } else if (previousRangeIndex !== null && currentRangeIndex === previousRangeIndex) {
    blockedReason = `same-range score move ${scoreMove}`;
    transitionType = "blocked";
    momentumLabel = "Same Range";
  } else if (previousRangeIndex !== null && currentRangeIndex < previousRangeIndex) {
    if (currentRangeIndex === 0) {
      lastValidRangeIndex = 0;
      sequenceLocked = false;
      transitionType = "reset";
      momentumLabel = "Tracking Reset";
    } else {
      sequenceLocked = true;
      blockedReason = `fallback move ${scoreMove}; T0 reset required before T2 again`;
      transitionType = "blocked";
      momentumLabel = "Fallback Locked";
    }
  } else if (previousRangeIndex !== null && currentRangeIndex > previousRangeIndex + 1) {
    blockedReason = `invalid score jump ${scoreMove}`;
    transitionType = "blocked";
    momentumLabel = "Jump Blocked";
  } else if (sequenceLocked) {
    blockedReason = `fallback lock active; T0 reset required before ${currentRangeLabel}`;
    transitionType = "blocked";
    momentumLabel = "Fallback Locked";
  } else if (currentRangeIndex === 2) {
    if (previousRangeIndex === 1 && previousValidRangeIndex === 1) {
      lastValidRangeIndex = 2;
      transitionType = "first_signal";
      momentumLabel = "Fresh Rising";
      validSignalEvent = true;
      entryEligible = true;
    } else if (previousRangeIndex === 1) {
      blockedReason = `blocked re-entry ${scoreMove}; fresh T0 → T1 → T2 sequence required`;
      transitionType = "blocked";
      momentumLabel = "Freshness Blocked";
    } else {
      blockedReason = `invalid score jump ${scoreMove}`;
      transitionType = "blocked";
      momentumLabel = "Jump Blocked";
    }
  } else if (
    previousRangeIndex === currentRangeIndex - 1 &&
    previousValidRangeIndex === currentRangeIndex - 1 &&
    previousValidRangeIndex >= 2
  ) {
    lastValidRangeIndex = currentRangeIndex;
    transitionType = "continuation";
    momentumLabel = "Step Rising";
    validSignalEvent = true;
  } else {
    blockedReason = `blocked continuation ${scoreMove}; prior fresh buildup was not valid`;
    transitionType = "blocked";
    momentumLabel = "Sequence Blocked";
  }

  const nextSnapshot = {
    lastObservedRangeIndex,
    lastObservedScore: Number(candidate.score),
    lastValidRangeIndex,
    sequenceLocked,
    updatedAt: evaluatedAt,
  };

  return {
    currentRangeIndex,
    currentRangeLabel,
    previousRangeIndex,
    previousRangeLabel,
    scoreMove,
    transitionType,
    momentumLabel,
    validSignalEvent,
    entryEligible,
    blockedReason,
    shouldLogBlocked: Boolean(blockedReason && shouldLogBlockedMove(previousRangeIndex, currentRangeIndex)),
    nextSnapshot,
  };
}

function logBlockedCandidate(candidate, evaluation) {
  if (!evaluation?.shouldLogBlocked) return;
  console.log(
    `Blocked ${candidate.pair} ${candidate.side} ${candidate.baseTimeframe}: ${evaluation.blockedReason}.`
  );
}

function enrichCandidateWithMomentum(candidate, evaluation) {
  return {
    ...candidate,
    scoreRange: evaluation.currentRangeLabel,
    scoreRangeIndex: evaluation.currentRangeIndex,
    previousScoreRange: evaluation.previousRangeLabel,
    previousScoreRangeIndex: evaluation.previousRangeIndex,
    scoreMove: evaluation.scoreMove,
    momentum: evaluation.momentumLabel,
    momentumStatus: evaluation.transitionType,
    validSignalEvent: evaluation.validSignalEvent,
    entryEligible: evaluation.entryEligible,
    blockedReason: evaluation.blockedReason,
  };
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

function prepareSignalCandidates(candidates, options = {}) {
  const evaluatedAt = options.evaluatedAt || new Date().toISOString();
  const momentumState = loadScoreMomentumState();
  const deduped = dedupeCandidates(candidates);
  const validCandidates = [];
  const blockedCandidates = [];
  const evaluatedCandidates = [];

  for (const candidate of deduped) {
    const signalKey = buildSignalKey(candidate);
    const evaluation = evaluateCandidateMomentum(candidate, momentumState[signalKey], evaluatedAt);
    const enriched = enrichCandidateWithMomentum(
      {
        ...candidate,
        signalKey,
      },
      evaluation
    );

    momentumState[signalKey] = evaluation.nextSnapshot;
    evaluatedCandidates.push(enriched);

    if (evaluation.validSignalEvent) {
      validCandidates.push(enriched);
      continue;
    }

    if (evaluation.blockedReason) {
      blockedCandidates.push(enriched);
      logBlockedCandidate(enriched, evaluation);
    }
  }

  saveScoreMomentumState(momentumState);

  return {
    evaluatedCandidates,
    validCandidates,
    blockedCandidates,
    entryCandidates: validCandidates.filter((candidate) => candidate.entryEligible),
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
    scoreRange: current.scoreRange,
    scoreMove: current.scoreMove,
    momentum: current.momentum,
    updates: current.reasons?.slice(0, 4) || [],
  });

  const message = await bot.sendMessage(chatId, text, {
    reply_to_message_id: previous.messageId,
  });

  deleteTelegramMessageLater(bot, chatId, message?.message_id);
  return message;
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
    .filter((candidate) => candidate.validSignalEvent)
    .sort((a, b) => Number(a.score || 0) - Number(b.score || 0));

  for (const candidate of strongest) {
    const pair = String(candidate.pair || "").toUpperCase();
    const side = String(candidate.side || "").toUpperCase();
    const event = {
      pair,
      side,
      score: Number(candidate.score || 0),
      scoreRange: candidate.scoreRange || null,
      scoreMove: candidate.scoreMove || null,
      momentum: candidate.momentum || null,
      transitionType: candidate.momentumStatus || null,
      entryEligible: candidate.entryEligible === true,
      baseTimeframe: candidate.baseTimeframe || null,
      signalKey: candidate.signalKey || buildSignalKey(candidate),
      recordedAt,
    };

    history.lastByPair[pair] = event;
    history.events.push(event);
  }

  history.events = history.events.slice(-INTERNAL_SIGNAL_EVENT_LIMIT);
  return saveInternalSignalHistory(history);
}

function recentOtherSignalEvents(events, pair, limit) {
  return (events || [])
    .filter((event) => event.pair !== String(pair || "").toUpperCase())
    .slice(-limit);
}

function buildForcedCloseDetails(position, reverseCandidate, reverseVotes) {
  return {
    reasonCode: "MARKET_REVERSED",
    reasonText:
      "Same-pair reverse signal plus market-wide reverse confirmation.",
    forceDirection: reverseCandidate.side,
    reverseSignalSide: reverseCandidate.side,
    reverseScoreMove: reverseCandidate.scoreMove,
    reverseScoreRange: reverseCandidate.scoreRange,
    samePairReverseValid: true,
    majorityConfirmationText: `At least ${REVERSE_MAJORITY_MIN}/${REVERSE_MAJORITY_WINDOW} internal reverse signals`,
  };
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
          String(candidate.side || "").toUpperCase() === reverseSide &&
          candidate.validSignalEvent
      )
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];

    if (!reverseCandidate) continue;

    const lastThreeOther = recentOtherSignalEvents(history.events, position.pair, REVERSE_MAJORITY_WINDOW);
    const reverseVotes = lastThreeOther.filter((event) => event.side === reverseSide).length;
    const forceClosePrice =
      Number(priceByPair?.[position.pair]) ||
      Number(reverseCandidate?.currentPrice) ||
      Number(position.currentMark) ||
      Number(position.entryPrice);

    if (
      lastThreeOther.length === REVERSE_MAJORITY_WINDOW &&
      reverseVotes >= REVERSE_MAJORITY_MIN
    ) {
      const forced = dryrun.forceCloseTrade(
        position.signalId || position.id || position.signalKey,
        forceClosePrice,
        buildForcedCloseDetails(position, reverseCandidate, reverseVotes)
      );

      if (forced) {
        updates.push(forced);
        if (reverseCandidate.entryEligible) priorityCandidates.push(reverseCandidate);
      }
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
    if (!candidate.validSignalEvent) continue;

    const signalKey = buildSignalKey(candidate);
    const previous = activeSignals[signalKey];

    if (!previous) {
      if (!candidate.entryEligible) continue;
      if (!dryrun.canOpenNewSignal()) continue;

      const tracked = dryrun.registerSignal({
        ...candidate,
        signalKey,
      });
      if (!tracked) continue;

      const sent = await sendNewSignal(bot, chatId, candidate);
      dryrun.attachSignalMessage(tracked.signalId || tracked.id, sent?.message_id || null, signalKey);

      activeSignals[signalKey] = {
        ...candidate,
        messageId: sent?.message_id || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      results.push({ type: "new", key: signalKey, candidate });
      continue;
    }

    const previousRangeIndex = Number(previous.scoreRangeIndex);
    const currentRangeIndex = Number(candidate.scoreRangeIndex);
    const isHigherRange =
      Number.isFinite(currentRangeIndex) &&
      (!Number.isFinite(previousRangeIndex) || currentRangeIndex > previousRangeIndex);

    if (candidate.momentumStatus === "continuation" && isHigherRange) {
      await sendScoreRise(bot, chatId, previous, candidate);
      activeSignals[signalKey] = {
        ...previous,
        ...candidate,
        updatedAt: new Date().toISOString(),
      };
      results.push({ type: "rise", key: signalKey, candidate });
      continue;
    }

    activeSignals[signalKey] = {
      ...previous,
      ...candidate,
      updatedAt: new Date().toISOString(),
    };
  }

  state.writeJson(config.activeSignalsPath, activeSignals);
  return results;
}

async function dispatchTradeUpdates(bot, chatId, updates) {
  if (!bot || !chatId || !Array.isArray(updates) || !updates.length) return [];

  const activeSignals = state.readJson(config.activeSignalsPath, {});
  const sent = [];
  let dirty = false;

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
  buildSignalKey,
  dedupeCandidates,
  dispatchSignals,
  dispatchTradeUpdates,
  evaluateInternalMarketClosures,
  getScoreRangeIndex,
  getScoreRangeLabel,
  prepareSignalCandidates,
};
