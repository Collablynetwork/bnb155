const path = require("path");
require("dotenv").config();

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeFuturesRestUrl(rawValue) {
  const raw = trimSlash(rawValue);
  if (!raw) return "https://fapi.binance.com";

  const lower = raw.toLowerCase();

  if (
    lower.includes("api.binance.com/api/v3") ||
    lower.includes("api-gcp.binance.com/api/v3") ||
    /https:\/\/api[1-4]\.binance\.com\/api\/v3/.test(lower)
  ) {
    return "https://fapi.binance.com";
  }

  if (lower.includes("/fapi/")) {
    return raw.slice(0, lower.indexOf("/fapi/"));
  }

  return raw;
}

function finiteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const storageDir = path.join(__dirname, "storage");
const strategiesDir = path.join(storageDir, "strategies");
const notifyMinScore = finiteNumber(process.env.NOTIFY_MIN_SCORE, 80);
const defaultStrategyRetentionDays = finiteNumber(process.env.STRATEGY_RETENTION_DAYS, 3);

module.exports = {
  storageDir,
  env: process.env.NODE_ENV || "development",

  binanceApiUrl: normalizeFuturesRestUrl(
    process.env.BINANCE_FUTURES_API_URL || process.env.BINANCE_API_URL
  ),
  binanceWsUrl: trimSlash(
    process.env.BINANCE_FUTURES_WS_URL ||
      process.env.BINANCE_WS_URL ||
      "wss://fstream.binance.com"
  ),

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  telegramPolling:
    String(process.env.TELEGRAM_POLLING || "true").toLowerCase() === "true",

  scanEveryMs: finiteNumber(process.env.SCAN_EVERY_MS, 60_000),
  maxKlinesPerRequest: finiteNumber(process.env.MAX_KLINES_PER_REQUEST, 300),
  maxParallelRequests: finiteNumber(process.env.MAX_PARALLEL_REQUESTS, 4),

  watchThreshold: finiteNumber(process.env.WATCH_THRESHOLD, 70),
  strongThreshold: finiteNumber(process.env.STRONG_THRESHOLD, 80),
  alertThreshold: finiteNumber(process.env.ALERT_THRESHOLD, 90),
  scoreRiseThreshold: finiteNumber(process.env.SCORE_RISE_THRESHOLD, 5),
  notifyMinScore,

  allowedBaseTimeframes: ["1m", "5m"],
  minSupportCount: finiteNumber(process.env.MIN_SUPPORT_COUNT, 3),
  systemTargetAdjustPct: finiteNumber(process.env.SYSTEM_TARGET_ADJUST_PCT, 0.1),
  systemStopAdjustPct: finiteNumber(process.env.SYSTEM_STOP_ADJUST_PCT, 0.1),

  dryRunNotional: finiteNumber(process.env.DRYRUN_NOTIONAL, 100),
  defaultStrategyRetentionDays,

  scanAllValidUsdtPairs: false,
  maxScanPairs: 0,
  prioritizeWatchedPairs: true,

  pairsPath: path.join(storageDir, "pairs.json"),
  scoreStatePath: path.join(storageDir, "score-state.json"),
  activeSignalsPath: path.join(storageDir, "active-signals.json"),
  dryRunPositionsPath: path.join(storageDir, "dryrun-positions.json"),
  closedTradesPath: path.join(storageDir, "closed-trades.json"),
  learnedPumpsPath: path.join(storageDir, "learned-pumps.json"),
  internalSignalHistoryPath: path.join(storageDir, "internal-signal-history.json"),
  strategySettingsPath: path.join(storageDir, "strategy-settings.json"),

  strategiesDir,
  strategiesIndexPath: path.join(strategiesDir, "index.json"),

  supportedKlineIntervals: [
    "1m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w",
  ],

  supportedFlowPeriods: ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"],

  timeframeHierarchyMap: {
    "1m": ["1m", "5m", "15m"],
    "5m": ["5m", "15m", "30m", "1h"],
    "15m": ["15m", "30m", "1h", "4h"],
    "30m": ["30m", "1h", "2h", "4h"],
    "1h": ["1h", "2h", "4h", "1d"],
    "2h": ["2h", "4h", "6h", "1d"],
    "4h": ["4h", "6h", "12h", "1d", "3d"],
    "6h": ["6h", "12h", "1d", "3d"],
    "8h": ["8h", "12h", "1d", "3d"],
    "12h": ["12h", "1d", "3d", "1w"],
    "1d": ["4h", "12h", "1d", "3d", "1w"],
    "3d": ["12h", "1d", "3d", "1w"],
    "1w": ["1d", "3d", "1w"],
  },
};
