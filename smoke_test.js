const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const projectDir = __dirname;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bnb153-smoke-'));
const storageDir = path.join(tempRoot, 'storage');

const config = require('./config');
config.storageDir = storageDir;
config.pairsPath = path.join(storageDir, 'pairs.json');
config.scoreStatePath = path.join(storageDir, 'score-state.json');
config.activeSignalsPath = path.join(storageDir, 'active-signals.json');
config.dryRunPositionsPath = path.join(storageDir, 'dryrun-positions.json');
config.closedTradesPath = path.join(storageDir, 'closed-trades.json');
config.learnedPumpsPath = path.join(storageDir, 'learned-pumps.json');
config.internalSignalHistoryPath = path.join(storageDir, 'internal-signal-history.json');
config.strategySettingsPath = path.join(storageDir, 'strategy-settings.json');
config.strategiesDir = path.join(storageDir, 'strategies');
config.strategiesIndexPath = path.join(config.strategiesDir, 'index.json');

process.on('exit', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const state = require('./state');
state.ensureStorage();
const signals = require('./signals');
const dryrun = require('./dryrun');
const strategyLearner = require('./strategyLearner');

function makeMatch(overrides = {}) {
  return {
    pair: 'BTCUSDT',
    direction: 'long',
    score: 86,
    baseTimeframe: '1m',
    current: {
      features: {
        currentClose: 100,
        atr14: 0.5,
        support: 99.4,
        resistance: 101.8,
        recentHigh20: 101.3,
        recentLow20: 98.7,
      }
    },
    supportTimeframes: ['1m', '3m', '5m'],
    reasons: ['rule A', 'rule B'],
    ...overrides,
  };
}

function makeStrategy(pair, eventTime, suffix) {
  return {
    id: `${pair}-long-5m-${suffix}`,
    pair,
    direction: 'long',
    detectedAt: new Date().toISOString(),
    eventTime,
    fileName: `${suffix}_${pair}_5m_bullish_pump.json`,
    mainSourceTimeframe: '5m',
    sourceTimeframes: ['5m'],
    savedTimeframes: ['5m'],
    supportingTimeframes: ['15m'],
    resultingExpansionPct: 2.5,
    fingerprint: {
      timeframe: '5m',
      direction: 'long',
      features: {},
      flow: {},
      supportingTimeframes: ['15m'],
    },
    allTimeframes: {},
  };
}

// 1) Candidate strict filtering
assert.strictEqual(signals.buildSignalCandidate(makeMatch({ baseTimeframe: '15m' })), null, '15m should be rejected');
assert.strictEqual(signals.buildSignalCandidate(makeMatch({ supportTimeframes: ['1m', '3m'] })), null, 'Need 3 support timeframes');

const candidate = signals.buildSignalCandidate(makeMatch());
assert(candidate, '1m candidate with 3 supports should pass');
assert.strictEqual(candidate.baseTimeframe, '1m');
assert.strictEqual(candidate.supportTfs.length, 3);
assert(candidate.targetPrice < candidate.originalSystemTp1, 'Adjusted target should be lower');
assert(candidate.stopPrice < candidate.originalSystemSl, 'Adjusted stop should be lower');
assert.strictEqual(candidate.tp2, undefined, 'TP3 should be removed');
assert.strictEqual(candidate.tp3, undefined, 'TP4 should be removed');
assert.strictEqual(candidate.ignoredTp3, undefined, 'Ignored TP3 should be removed');
assert.strictEqual(candidate.ignoredTp4, undefined, 'Ignored TP4 should be removed');

// 2) One blocking signal at a time
const first = dryrun.registerSignal({ ...candidate, signalKey: signals.buildSignalKey(candidate), signalMessageId: 111 });
assert(first, 'First signal should register');
assert.strictEqual(dryrun.canOpenNewSignal(), false, 'Gate should be blocked after first open');
assert.strictEqual(dryrun.getBlockingOpenTrades().length, 1, 'Blocking trade should be visible');

const blocked = dryrun.registerSignal({ ...candidate, pair: 'ETHUSDT', signalKey: 'ETHUSDT|LONG|1m', signalMessageId: 222 });
assert.strictEqual(blocked, null, 'Second signal must be blocked while first is fully open');

// 3) Manual clear should remove blocking trades
const cleared = dryrun.clearOpenTrades();
assert.strictEqual(cleared.removedCount, 1, 'Manual clear should remove the open trade');
assert.strictEqual(dryrun.loadOpenPositions().length, 0, 'No open trades should remain after manual clear');
assert.strictEqual(dryrun.canOpenNewSignal(), true, 'Gate should open after manual clear');

const reopened = dryrun.registerSignal({ ...candidate, signalKey: signals.buildSignalKey(candidate), signalMessageId: 444 });
assert(reopened, 'Trade should open again after manual clear');

// 4) Trade closes only on the adjusted target
let updates = dryrun.evaluateTargetsAndStops({ BTCUSDT: candidate.targetPrice + 0.01 });
assert(updates.some((u) => u.type === 'TARGET ACHIEVED'), 'Adjusted target should close the trade');
let open = dryrun.loadOpenPositions();
assert.strictEqual(open.length, 0, 'Trade should be fully closed after the target');
assert.strictEqual(dryrun.canOpenNewSignal(), true, 'New signal should be allowed after the trade closes');

// 5) New signal can open after the first trade closes
const secondCandidate = signals.buildSignalCandidate(makeMatch({ pair: 'ETHUSDT', current: { features: { currentClose: 200, atr14: 1, support: 198.5, resistance: 203.2, recentHigh20: 202.1, recentLow20: 197.3 } }, supportTimeframes: ['1m','3m','5m'], score: 87 }));
const second = dryrun.registerSignal({ ...secondCandidate, signalKey: signals.buildSignalKey(secondCandidate), signalMessageId: 333 });
assert(second, 'Second signal should open after the previous trade closes');

// 6) Stop should close the second trade
updates = dryrun.evaluateTargetsAndStops({ ETHUSDT: secondCandidate.stopPrice - 0.01 });
assert(updates.some((u) => u.type === 'SL HIT' && u.pair === 'ETHUSDT'), 'Adjusted stop should close the trade');
const closed = dryrun.loadClosedTrades();
assert(closed.some((t) => t.pair === 'BTCUSDT' && t.pnlStatus === 'TARGET ACHIEVED'), 'BTC trade should be fully closed');
assert(closed.some((t) => t.pair === 'ETHUSDT' && t.pnlStatus === 'SL HIT'), 'ETH trade should be stopped out');

// 7) Stats must track the single active trade model
const pnl = dryrun.pnlModelSummary();
assert.strictEqual(pnl.totalSignals, 2, 'Trade summary should count all trades');
assert.strictEqual(pnl.targetCount, 1, 'Target count should update');
assert.strictEqual(pnl.slCount, 1, 'Stop count should update');

// 8) Strategy retention should prune old entries and persist configured days
const now = Date.now();
strategyLearner.setStrategyRetentionDays(3);
strategyLearner.saveStrategy(
  makeStrategy('OLDUSDT', new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), 'old')
);
strategyLearner.saveStrategy(
  makeStrategy('KEEPUSDT', new Date(now - 24 * 60 * 60 * 1000).toISOString(), 'keep')
);

let rebuilt = strategyLearner.rebuildStrategiesIndexFromFiles();
assert.strictEqual(rebuilt.length, 1, 'Only recent strategy should remain after rebuild');
assert.strictEqual(rebuilt[0].pair, 'KEEPUSDT');
assert.strictEqual(strategyLearner.getStrategyRetentionDays(), 3, 'Retention should default to 3 days');

strategyLearner.saveStrategy(
  makeStrategy('MIDUSDT', new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), 'mid')
);
const retentionUpdate = strategyLearner.setStrategyRetentionDays(2);
assert.strictEqual(retentionUpdate.keepRecentDays, 2, 'Retention update should persist requested days');
assert.strictEqual(strategyLearner.getStrategyRetentionDays(), 2, 'Retention setting should read back as 2 days');
assert.strictEqual(retentionUpdate.remainingCount, 1, 'Only newest strategy should remain after reducing retention');

// 9) Pair-specific clear should remove only the requested pair
strategyLearner.saveStrategy(
  makeStrategy('BTCUSDT', new Date(now - 60 * 60 * 1000).toISOString(), 'btc')
);
strategyLearner.saveStrategy(
  makeStrategy('ETHUSDT', new Date(now - 60 * 60 * 1000).toISOString(), 'eth')
);
const clearPairResult = strategyLearner.clearStrategiesForPair('BTCUSDT');
assert.strictEqual(clearPairResult.removedCount, 1, 'BTC strategy should be removed');
assert(strategyLearner.loadStrategies().every((item) => item.pair !== 'BTCUSDT'), 'BTC strategy should no longer exist');
assert(strategyLearner.loadStrategies().some((item) => item.pair === 'ETHUSDT'), 'ETH strategy should remain');

// 10) Clear-all should wipe strategies but keep retention configuration
const clearAllResult = strategyLearner.clearAllStrategies();
assert(clearAllResult.removedCount >= 1, 'Clear-all should remove remaining strategies');
assert.strictEqual(strategyLearner.loadStrategies().length, 0, 'No strategies should remain after clear-all');
assert.strictEqual(strategyLearner.getStrategyRetentionDays(), 2, 'Clear-all should not reset retention days');

// 11) Condition 1 should force-close and prioritize same-pair reversal
dryrun.clearTradeHistory();
state.writeJson(config.internalSignalHistoryPath, { events: [], lastByPair: {} });

const longCandidate = signals.buildSignalCandidate(makeMatch({ pair: 'BTCUSDT', score: 88 }));
const trackedLong = dryrun.registerSignal({
  ...longCandidate,
  signalKey: signals.buildSignalKey(longCandidate),
  signalMessageId: 999,
});
assert(trackedLong, 'Reversal test trade should open');

signals.evaluateInternalMarketClosures(
  { BTCUSDT: 100, ETHUSDT: 200, XRPUSDT: 0.5 },
  [
    { pair: 'ETHUSDT', side: 'SHORT', score: 85, baseTimeframe: '1m', currentPrice: 200 },
    { pair: 'XRPUSDT', side: 'SHORT', score: 84, baseTimeframe: '1m', currentPrice: 0.5 },
  ]
);

const reversalResult = signals.evaluateInternalMarketClosures(
  { BTCUSDT: 99.7, ETHUSDT: 200, XRPUSDT: 0.5 },
  [
    { pair: 'ETHUSDT', side: 'SHORT', score: 85, baseTimeframe: '1m', currentPrice: 200 },
    { pair: 'XRPUSDT', side: 'SHORT', score: 84, baseTimeframe: '1m', currentPrice: 0.5 },
    { pair: 'BTCUSDT', side: 'SHORT', score: 90, baseTimeframe: '1m', currentPrice: 99.7 },
  ]
);
assert.strictEqual(reversalResult.updates.length, 1, 'Same-pair reversal should force close');
assert.strictEqual(reversalResult.updates[0].type, 'FORCE CLOSED', 'Forced close type should be emitted');
assert.strictEqual(reversalResult.priorityCandidates[0].pair, 'BTCUSDT', 'Same pair should be prioritized for reverse entry');
assert.strictEqual(reversalResult.priorityCandidates[0].side, 'SHORT', 'Reverse direction should be prioritized');
assert(dryrun.loadClosedTrades().some((trade) => trade.forceCloseCode === 'MARKET_REVERSED'), 'Forced reversal reason should persist');

// 12) Condition 2 should close on 5 opposite-direction internal signals
dryrun.clearTradeHistory();
state.writeJson(config.internalSignalHistoryPath, { events: [], lastByPair: {} });

const breadthLong = signals.buildSignalCandidate(makeMatch({ pair: 'ETHUSDT', score: 89 }));
const trackedBreadthLong = dryrun.registerSignal({
  ...breadthLong,
  signalKey: signals.buildSignalKey(breadthLong),
  signalMessageId: 1001,
});
assert(trackedBreadthLong, 'Breadth test trade should open');

const breadthResult = signals.evaluateInternalMarketClosures(
  { ETHUSDT: 199.4, BNBUSDT: 600, SOLUSDT: 150, XRPUSDT: 0.5, ADAUSDT: 1.2, DOGEUSDT: 0.2 },
  [
    { pair: 'BNBUSDT', side: 'SHORT', score: 85, baseTimeframe: '1m', currentPrice: 600 },
    { pair: 'SOLUSDT', side: 'SHORT', score: 84, baseTimeframe: '1m', currentPrice: 150 },
    { pair: 'XRPUSDT', side: 'SHORT', score: 83, baseTimeframe: '1m', currentPrice: 0.5 },
    { pair: 'ADAUSDT', side: 'SHORT', score: 82, baseTimeframe: '1m', currentPrice: 1.2 },
    { pair: 'DOGEUSDT', side: 'SHORT', score: 81, baseTimeframe: '1m', currentPrice: 0.2 },
  ]
);
assert.strictEqual(breadthResult.updates.length, 1, 'Broad opposite breadth should force close');
assert.strictEqual(breadthResult.updates[0].reasonCode, 'BREADTH_REVERSED', 'Breadth close reason code should persist');

// 13) Clearing trade history should remove open and closed records
const historyReset = dryrun.clearTradeHistory();
assert.strictEqual(historyReset.removedTotalCount >= 1, true, 'Trade history reset should remove tracked trades');
assert.strictEqual(dryrun.loadOpenPositions().length, 0, 'Open trades should be cleared');
assert.strictEqual(dryrun.loadClosedTrades().length, 0, 'Closed trades should be cleared');

console.log('All smoke tests passed');
console.log(JSON.stringify({
  candidate,
  pnl,
  openTrades: dryrun.loadOpenPositions().length,
  closedTrades: dryrun.loadClosedTrades().length,
  strategyRetentionDays: strategyLearner.getStrategyRetentionDays(),
}, null, 2));
