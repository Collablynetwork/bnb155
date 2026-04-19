const fs = require("fs");
const path = require("path");
const config = require("./config");
const defaultPairs = require("./pair");

function ensureDir(dirPath) {
  if (typeof dirPath !== "string" || !dirPath.trim()) {
    throw new Error(`Invalid directory path: ${dirPath}`);
  }

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultValue) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error(`Invalid JSON file path: ${filePath}`);
  }

  ensureDir(path.dirname(filePath));

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJson(filePath, defaultValue = null) {
  try {
    ensureJsonFile(filePath, defaultValue ?? {});
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : defaultValue;
  } catch (error) {
    console.error(`readJson failed for ${filePath}:`, error.message);
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  ensureJsonFile(filePath, Array.isArray(data) ? [] : {});
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function appendJsonArray(filePath, item) {
  const arr = readJson(filePath, []);
  arr.push(item);
  writeJson(filePath, arr);
  return arr;
}

function nowIso() {
  return new Date().toISOString();
}

function uniqueUpper(values) {
  return [...new Set((values || []).map((v) => String(v).trim().toUpperCase()).filter(Boolean))];
}

function getAllowedPairs() {
  return uniqueUpper(defaultPairs);
}

function filterToAllowedPairs(pairs) {
  const allowed = new Set(getAllowedPairs());
  return uniqueUpper(pairs).filter((pair) => allowed.has(pair));
}

function getStoragePaths() {
  const storageDir = config.storageDir || path.join(__dirname, "storage");
  const strategiesDir = config.strategiesDir || path.join(storageDir, "strategies");

  return {
    storageDir,
    strategiesDir,
    pairsPath: config.pairsPath || path.join(storageDir, "pairs.json"),
    scoreStatePath: config.scoreStatePath || path.join(storageDir, "score-state.json"),
    activeSignalsPath: config.activeSignalsPath || path.join(storageDir, "active-signals.json"),
    dryRunPositionsPath: config.dryRunPositionsPath || path.join(storageDir, "dryrun-positions.json"),
    closedTradesPath: config.closedTradesPath || path.join(storageDir, "closed-trades.json"),
    learnedPumpsPath: config.learnedPumpsPath || path.join(storageDir, "learned-pumps.json"),
    internalSignalHistoryPath:
      config.internalSignalHistoryPath || path.join(storageDir, "internal-signal-history.json"),
    strategySettingsPath:
      config.strategySettingsPath || path.join(storageDir, "strategy-settings.json"),
    strategiesIndexPath: config.strategiesIndexPath || path.join(strategiesDir, "index.json"),
  };
}

function ensureStorage() {
  const paths = getStoragePaths();

  ensureDir(paths.storageDir);
  ensureDir(paths.strategiesDir);
  ensureJsonFile(paths.pairsPath, getAllowedPairs());
  ensureJsonFile(paths.scoreStatePath, {});
  ensureJsonFile(paths.activeSignalsPath, {});
  ensureJsonFile(paths.dryRunPositionsPath, []);
  ensureJsonFile(paths.closedTradesPath, []);
  ensureJsonFile(paths.learnedPumpsPath, []);
  ensureJsonFile(paths.internalSignalHistoryPath, {
    events: [],
    lastByPair: {},
  });
  ensureJsonFile(paths.strategySettingsPath, {
    keepRecentDays: Number(config.defaultStrategyRetentionDays || 3),
  });
  ensureJsonFile(paths.strategiesIndexPath, []);
}

function getWatchedPairs() {
  const paths = getStoragePaths();
  const stored = readJson(paths.pairsPath, getAllowedPairs()) || [];
  const filtered = filterToAllowedPairs(stored);
  return filtered.length ? filtered : getAllowedPairs();
}

function saveWatchedPairs(pairs) {
  const paths = getStoragePaths();
  const normalized = filterToAllowedPairs(pairs).sort();
  writeJson(paths.pairsPath, normalized);
  return normalized;
}

module.exports = {
  ensureDir,
  ensureJsonFile,
  ensureStorage,
  getStoragePaths,
  readJson,
  writeJson,
  appendJsonArray,
  nowIso,
  uniqueUpper,
  getAllowedPairs,
  filterToAllowedPairs,
  getWatchedPairs,
  saveWatchedPairs,
};
