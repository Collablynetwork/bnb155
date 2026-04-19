const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");
const { getWatchedPairs, saveWatchedPairs, getAllowedPairs, writeJson } = require("./state");
const {
  loadStrategiesIndex,
  getStrategyByPair,
  rebuildStrategiesIndexFromFiles,
  getStrategyRetentionDays,
  setStrategyRetentionDays,
  clearStrategiesForPair,
  clearAllStrategies,
} = require("./strategyLearner");
const dryrun = require("./dryrun");
const { sendTemporaryMessage, cleanupIncomingMessage } = require("./telegramCleanup");

const MENU_ACTIONS = {
  pairs: "Watched Pairs",
  scan: "Run Market Scan",
  dryrun: "Trade Overview",
  pnl: "PNL Dashboard",
  signals: "Live Signals",
  closed: "Closed Trades",
  dryrunlong: "Long Dry Run",
  dryrunshort: "Short Dry Run",
  strategies: "Strategy Dashboard",
  strategylist: "Strategy List",
  help: "Help Center",
};

const COMMANDS = [
  { command: "start", description: "Open menu" },
  { command: "help", description: "Show commands" },
  { command: "pairs", description: "Show watched pairs" },
  { command: "addpair", description: "Add pair. Example: /addpair BTCUSDT" },
  { command: "removepair", description: "Remove pair. Example: /removepair BTCUSDT" },
  { command: "scan", description: "Run scan now" },
  { command: "dryrun", description: "Show dry-run summary" },
  { command: "pnl", description: "Show PNL summary" },
  { command: "signals", description: "Show active monitored signals" },
  { command: "closed", description: "Show fully closed trades" },
  { command: "dryrunlong", description: "Open dry-run LONG tests" },
  { command: "dryrunshort", description: "Open dry-run SHORT tests" },
  { command: "cleartradehistory", description: "Clear tracked trade history" },
  { command: "strategies", description: "Show saved strategy count" },
  { command: "strategylist", description: "List saved strategies" },
  { command: "strategy", description: "Show detailed strategy" },
  { command: "recentstrategyday", description: "Set strategy retention days" },
  { command: "clearstrategy", description: "Remove saved strategies for a pair" },
  { command: "clearallstrategy", description: "Remove all saved strategies" },
  { command: "rebuildstrategies", description: "Rebuild strategy index from files" },
];

function createBot() {
  if (!config.telegramBotToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    return null;
  }

  return new TelegramBot(config.telegramBotToken, {
    polling: config.telegramPolling,
  });
}

async function setupCommands(bot) {
  if (!bot) return;

  try {
    await bot.setMyCommands(COMMANDS);
    console.log("Telegram commands registered.");
  } catch (error) {
    console.error("Failed to register Telegram commands:", error.message);
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandRegex(command, withArg = false, aliases = []) {
  const patterns = [`/${command}(?:@\\w+)?`, ...aliases.map((alias) => escapeRegex(alias))];
  const source = `^(?:${patterns.join("|")})${withArg ? "\\s+(.+)$" : "$"}`;
  return new RegExp(source, "i");
}

function menuCommandRegex(command, withArg = false) {
  const alias = MENU_ACTIONS[command];
  return commandRegex(command, withArg, alias ? [alias] : []);
}

function isManagedCommandMessage(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  return Object.values(MENU_ACTIONS).some((label) => label.toLowerCase() === trimmed.toLowerCase());
}

function cleanupManagedMessage(bot, msg) {
  if (isManagedCommandMessage(msg?.text)) {
    cleanupIncomingMessage(bot, msg);
  }
}

function buildPnlSummarySection(summary) {
  return formatModelSummary("PNL", summary);
}

function buildPnlDashboardText(summary) {
  return [
    "💹 PNL Dashboard",
    `Blocking Signals: ${summary.blockingSignals}`,
    `Background Monitoring: ${summary.backgroundMonitoring}`,
    `Open Unrealized: ${summary.openUnrealized}`,
    `Realized: ${summary.realized}`,
    "",
    buildPnlSummarySection(summary.pnl),
  ].join("\n");
}

function buildDryrunOverviewText(summary) {
  return [
    "🧪 Dry-run Overview",
    `Open/Monitoring Trades: ${summary.openCount}`,
    `Fully Closed Trades: ${summary.closedCount}`,
    `Blocking Signals: ${summary.blockingSignals}`,
    `Background Monitoring: ${summary.backgroundMonitoring}`,
    `Open Unrealized PNL: ${summary.openUnrealized}`,
    `Realized PNL: ${summary.realized}`,
    "",
    buildPnlSummarySection(summary.pnl),
  ].join("\n");
}

function buildSignalStatusLabel(position) {
  return position.pnlStatus || "OPEN";
}

function formatRetentionSummary() {
  return `Strategy retention days: ${getStrategyRetentionDays()}`;
}

function buildActionRow(...keys) {
  return keys.map((key) => ({ text: MENU_ACTIONS[key] }));
}

function splitLongMessage(text, chunkSize = 3500) {
  const lines = String(text).split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > chunkSize) {
      if (current.trim()) chunks.push(current.trim());
      current = line;
    } else {
      current += `${current ? "\n" : ""}${line}`;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function buildHelpText() {
  return [
    "🤖 Binance Futures Pump Scanner",
    "",
    "Use the menu buttons below or the slash commands here:",
    "",
    "Rules active:",
    "• Only pairs present in pair.js are scanned.",
    `• New alerts only when score > ${config.notifyMinScore}.`,
    `• Base timeframe allowed: ${config.allowedBaseTimeframes.join(", ")}.`,
    `• Minimum support confirmations: ${config.minSupportCount} including self TF.`,
    "• Only one blocking signal at a time. A new signal is allowed after the active trade closes.",
    "",
    "/start - open menu",
    "/help - show commands",
    "/pairs - show watched pairs",
    "/addpair BTCUSDT - add pair if it exists in pair.js",
    "/removepair BTCUSDT - remove pair from active scan list",
    "/scan - run scan now",
    "/dryrun - dry-run overview",
    "/pnl - PNL dashboard",
    "/signals - show active monitored signals",
    "/closed - show fully closed trades",
    "/dryrunlong - create dry-run LONG tests",
    "/dryrunshort - create dry-run SHORT tests",
    "/cleartradehistory - clear tracked trades and PNL history",
    "/strategies - show saved strategy count",
    "/strategylist - list saved strategies",
    "/strategy BTCUSDT - show saved strategy in detail",
    "/recentstrategyday 3 - keep strategies for 3 days (default is 3)",
    "/clearstrategy BTCUSDT - remove saved strategies for one pair",
    "/clearallstrategy - remove all saved strategies",
    "/rebuildstrategies - rebuild strategy index from files",
  ].join("\n");
}

function buildMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        buildActionRow("scan", "signals"),
        buildActionRow("pnl", "dryrun"),
        buildActionRow("closed", "pairs"),
        buildActionRow("dryrunlong", "dryrunshort"),
        buildActionRow("strategies", "strategylist"),
        buildActionRow("help"),
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      is_persistent: true,
      input_field_placeholder: "Choose an action or type a slash command",
    },
  };
}

function formatStrategyTimeframes(strategy) {
  const details = strategy.allTimeframes || {};
  const timeframes = Object.keys(details);

  if (!timeframes.length) {
    return "No all-timeframe snapshot saved.";
  }

  return timeframes
    .map((tf) => {
      const row = details[tf] || {};
      return [
        `⏱ ${tf}`,
        `trend=${row.trend ?? "n/a"}`,
        `bullBos=${row.bullishBos ?? "n/a"}`,
        `bearBos=${row.bearishBos ?? "n/a"}`,
        `bbPct=${row.bbWidthPercentile ?? "n/a"}`,
        `macd=${row.macdLine ?? "n/a"}`,
        `signal=${row.macdSignal ?? "n/a"}`,
        `hist=${row.macdHistogram ?? "n/a"}`,
        `adx=${row.adx ?? "n/a"}`,
        `vol20=${row.volumeVsAvg20 ?? "n/a"}`,
        `qVol20=${row.quoteVolumeVsAvg20 ?? "n/a"}`,
        `oiChg=${row.openInterestChangePct ?? "n/a"}`,
        `taker=${row.takerBuySellRatio ?? "n/a"}`,
        `funding=${row.fundingRate ?? "n/a"}`,
        `close=${row.currentClose ?? "n/a"}`,
      ].join(" | ");
    })
    .join("\n");
}

function formatStrategyMessage(strategy) {
  const trigger = strategy.triggerFeatures || {};
  const flow = strategy.flowFeatures || {};

  const text = [
    `🧠 Strategy for ${strategy.pair}`,
    `Direction: ${strategy.direction}`,
    `Event Time: ${strategy.eventTime}`,
    `Main Source TF: ${strategy.mainSourceTimeframe || "N/A"}`,
    `Saved TFs: ${(strategy.savedTimeframes || []).join(", ") || "N/A"}`,
    `Supporting TFs: ${(strategy.supportingTimeframes || []).join(", ") || "N/A"}`,
    `Expansion: ${strategy.resultingExpansionPct}%`,
    `Pump Window: ${strategy.sourcePumpWindow?.startIndex ?? "n/a"} -> ${strategy.sourcePumpWindow?.endIndex ?? "n/a"}`,
    "",
    "📌 Trigger Features",
    `BB Width Percentile: ${trigger.bbWidthPercentile ?? "n/a"}`,
    `BB Width: ${trigger.bbWidth ?? "n/a"}`,
    `MACD Line: ${trigger.macdLine ?? "n/a"}`,
    `MACD Signal: ${trigger.macdSignal ?? "n/a"}`,
    `MACD Histogram: ${trigger.macdHistogram ?? "n/a"}`,
    `MACD Hist Slope: ${trigger.macdHistogramSlope ?? "n/a"}`,
    `MACD Bull Cross: ${trigger.macdBullCross ?? "n/a"}`,
    `MACD Bear Cross: ${trigger.macdBearCross ?? "n/a"}`,
    `MACD Above Zero: ${trigger.macdAboveZero ?? "n/a"}`,
    `MACD Below Zero: ${trigger.macdBelowZero ?? "n/a"}`,
    `ADX: ${trigger.adx ?? "n/a"}`,
    `ADX Slope: ${trigger.adxSlope ?? "n/a"}`,
    `DI Spread: ${trigger.diSpread ?? "n/a"}`,
    `Volume/Avg20: ${trigger.volumeVsAvg20 ?? "n/a"}`,
    `Volume/Avg50: ${trigger.volumeVsAvg50 ?? "n/a"}`,
    `QuoteVol/Avg20: ${trigger.quoteVolumeVsAvg20 ?? "n/a"}`,
    `Bullish BOS: ${trigger.bullishBos ?? "n/a"}`,
    `Bearish BOS: ${trigger.bearishBos ?? "n/a"}`,
    `Trend: ${trigger.trend ?? "n/a"}`,
    `Support: ${trigger.support ?? "n/a"}`,
    `Resistance: ${trigger.resistance ?? "n/a"}`,
    "",
    "🌊 Flow Features",
    `Funding Rate: ${flow.fundingRate ?? "n/a"}`,
    `Open Interest: ${flow.openInterest ?? "n/a"}`,
    `OI Change %: ${flow.openInterestChangePct ?? "n/a"}`,
    `Taker Buy/Sell Ratio: ${flow.takerBuySellRatio ?? "n/a"}`,
    "",
    "📝 Explanation",
    strategy.reusableStrategyExplanation || "No explanation stored.",
    "",
    "📚 Saved All-Timeframe Snapshot",
    formatStrategyTimeframes(strategy),
  ].join("\n");

  return splitLongMessage(text);
}

function summarizeDryrunInsert(results, side) {
  const added = results.filter(Boolean);
  if (!added.length) {
    return `No ${side} candidates were opened. Either nothing qualified or a blocking signal is still active.`;
  }

  const lines = added.slice(0, 30).map(
    (c) => `${c.pair} | ${c.baseTimeframe} | score ${c.score} | pnl=${buildSignalStatusLabel(c)}`
  );

  return [
    `🧪 ${side} dry-run added`,
    `Positions opened: ${added.length}`,
    "",
    ...lines,
  ].join("\n");
}

function formatModelSummary(label, summary) {
  return [
    `${label}`,
    `Total Signals: ${summary.totalSignals}`,
    `Targets Achieved: ${summary.targetCount}`,
    `Stop Loss Hits: ${summary.slCount}`,
    `Win Rate: ${summary.winRate}%`,
    `Loss Rate: ${summary.lossRate}%`,
    `Cumulative PNL: ${summary.cumulativeProfitLoss}`,
  ].join("\n");
}

function registerHandlers(bot, callbacks) {
  if (!bot) return;

  bot.on("message", (msg) => {
    cleanupManagedMessage(bot, msg);
  });

  bot.onText(commandRegex("start"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(bot, 
      msg.chat.id,
      `✅ Bot is online.\n\n${buildHelpText()}`,
      buildMainMenu()
    );
  });

  bot.onText(menuCommandRegex("help"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(bot, msg.chat.id, buildHelpText(), buildMainMenu());
  });

  bot.onText(menuCommandRegex("pairs"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const pairs = getWatchedPairs();
    await sendTemporaryMessage(bot, 
      msg.chat.id,
      pairs.length
        ? `📋 Active scanned pairs (${pairs.length})\n${pairs.join(", ")}\n\nAllowed from pair.js: ${getAllowedPairs().join(", ")}`
        : "No watched pairs found.",
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("addpair", true), async (msg, match) => {
    cleanupIncomingMessage(bot, msg);
    const pair = String(match[1] || "").trim().toUpperCase();
    if (!pair) {
      await sendTemporaryMessage(bot, msg.chat.id, "Send like: /addpair BTCUSDT", buildMainMenu());
      return;
    }

    if (!getAllowedPairs().includes(pair)) {
      await sendTemporaryMessage(bot, 
        msg.chat.id,
        `❌ ${pair} is not in pair.js, so it cannot be scanned.`,
        buildMainMenu()
      );
      return;
    }

    const pairs = getWatchedPairs();
    if (!pairs.includes(pair)) {
      pairs.push(pair);
      saveWatchedPairs(pairs);
      await sendTemporaryMessage(bot, msg.chat.id, `✅ Added ${pair}`, buildMainMenu());
      return;
    }

    await sendTemporaryMessage(bot, msg.chat.id, `ℹ️ ${pair} already exists`, buildMainMenu());
  });

  bot.onText(commandRegex("removepair", true), async (msg, match) => {
    cleanupIncomingMessage(bot, msg);
    const pair = String(match[1] || "").trim().toUpperCase();
    const next = getWatchedPairs().filter((item) => item !== pair);
    saveWatchedPairs(next);
    await sendTemporaryMessage(bot, msg.chat.id, `🗑 Removed ${pair}`, buildMainMenu());
  });

  bot.onText(menuCommandRegex("scan"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(bot, msg.chat.id, "🔎 Running manual scan...");
    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
    });

    const text = [
      "✅ Scan done",
      `Pairs checked: ${summary.pairsChecked || 0}`,
      `Candidates: ${summary.candidates || 0}`,
      `Learned strategies: ${summary.learnedStrategies || 0}`,
      summary.error ? `Error: ${summary.error}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await sendTemporaryMessage(bot, msg.chat.id, text, buildMainMenu());
  });

  bot.onText(menuCommandRegex("dryrun"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const summary = dryrun.pnlSummary();
    await sendTemporaryMessage(bot, msg.chat.id, buildDryrunOverviewText(summary), buildMainMenu());
  });

  bot.onText(menuCommandRegex("pnl"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const summary = dryrun.pnlSummary();
    await sendTemporaryMessage(bot, msg.chat.id, buildPnlDashboardText(summary), buildMainMenu());
  });

  bot.onText(menuCommandRegex("dryrunlong"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(bot, msg.chat.id, "🧪 Building LONG dry-run tests...");
    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      suppressSignals: true,
    });

    const longCandidates = (summary.topCandidates || []).filter((c) => c.side === "LONG");
    const added = longCandidates.map((candidate) => dryrun.registerSignal(candidate)).filter(Boolean);

    await sendTemporaryMessage(bot, 
      msg.chat.id,
      summarizeDryrunInsert(added, "LONG"),
      buildMainMenu()
    );
  });

  bot.onText(menuCommandRegex("dryrunshort"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(bot, msg.chat.id, "🧪 Building SHORT dry-run tests...");
    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      suppressSignals: true,
    });

    const shortCandidates = (summary.topCandidates || []).filter((c) => c.side === "SHORT");
    const added = shortCandidates.map((candidate) => dryrun.registerSignal(candidate)).filter(Boolean);

    await sendTemporaryMessage(bot, 
      msg.chat.id,
      summarizeDryrunInsert(added, "SHORT"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("cleartradehistory"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const result = dryrun.clearTradeHistory();
    writeJson(config.activeSignalsPath, {});
    writeJson(config.internalSignalHistoryPath, {
      events: [],
      lastByPair: {},
    });

    await sendTemporaryMessage(
      bot,
      msg.chat.id,
      [
        "🧹 Trade history cleared",
        `Removed open trades: ${result.removedOpenCount}`,
        `Removed closed trades: ${result.removedClosedCount}`,
        `Removed total records: ${result.removedTotalCount}`,
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(menuCommandRegex("signals"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const open = dryrun.loadOpenPositions();
    if (!open.length) {
      await sendTemporaryMessage(bot, msg.chat.id, "No active monitored trades.", buildMainMenu());
      return;
    }

    const text = open
      .slice(0, 20)
      .map(
        (p) =>
          `${p.pair} ${p.side} | ${p.baseTimeframe} | gate=${p.blocksNewSignals ? "BLOCKED" : "FREE"} | pnl=${buildSignalStatusLabel(p)} | mark=${p.currentMark}`
      )
      .join("\n");

    await sendTemporaryMessage(bot, msg.chat.id, `📡 Monitored Trades\n${text}`, buildMainMenu());
  });

  bot.onText(menuCommandRegex("closed"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const closed = dryrun.loadClosedTrades().slice(-20).reverse();
    if (!closed.length) {
      await sendTemporaryMessage(bot, msg.chat.id, "No fully closed trades.", buildMainMenu());
      return;
    }

    const text = closed
      .map(
        (p) =>
          `${p.pair} ${p.side} | pnl=${buildSignalStatusLabel(p)} | realized=${p.realizedPnl}`
      )
      .join("\n");

    await sendTemporaryMessage(bot, msg.chat.id, `📦 Fully Closed Trades\n${text}`, buildMainMenu());
  });

  bot.onText(menuCommandRegex("strategies"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const index = loadStrategiesIndex();
    await sendTemporaryMessage(bot, 
      msg.chat.id,
      [
        `🧠 Saved learned strategies: ${index.length}`,
        formatRetentionSummary(),
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(menuCommandRegex("strategylist"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const index = loadStrategiesIndex().slice(0, 100);

    if (!index.length) {
      await sendTemporaryMessage(bot, msg.chat.id, "No saved strategies yet.", buildMainMenu());
      return;
    }

    const text = index
      .map(
        (s) =>
          `${s.pair} | ${s.direction} | ${s.eventTime} | mainTF=${s.mainSourceTimeframe || "n/a"} | savedTFs=${(s.savedTimeframes || []).join(",")} | supportTFs=${(s.supportingTimeframes || []).join(",")}`
      )
      .join("\n");

    for (const chunk of splitLongMessage(`🗂 Strategy List\n${text}`)) {
      await sendTemporaryMessage(bot, msg.chat.id, chunk, buildMainMenu());
    }
  });

  bot.onText(commandRegex("strategy", true), async (msg, match) => {
    cleanupIncomingMessage(bot, msg);
    const pair = String(match[1] || "").trim().toUpperCase();
    const strategiesForPair = getStrategyByPair(pair);

    if (!strategiesForPair.length) {
      await sendTemporaryMessage(bot, msg.chat.id, `No strategy saved for ${pair}`, buildMainMenu());
      return;
    }

    for (const strategy of strategiesForPair.slice(0, 20)) {
      const chunks = formatStrategyMessage(strategy);
      for (const chunk of chunks) {
        await sendTemporaryMessage(bot, msg.chat.id, chunk, buildMainMenu());
      }
    }
  });

  bot.onText(commandRegex("recentstrategyday"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(
      bot,
      msg.chat.id,
      [
        formatRetentionSummary(),
        "Set it like: /recentstrategyday 3",
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("recentstrategyday", true), async (msg, match) => {
    cleanupIncomingMessage(bot, msg);
    const days = Number(String(match[1] || "").trim());

    if (!Number.isFinite(days) || days <= 0) {
      await sendTemporaryMessage(
        bot,
        msg.chat.id,
        "Send like: /recentstrategyday 3",
        buildMainMenu()
      );
      return;
    }

    const result = setStrategyRetentionDays(days);
    await sendTemporaryMessage(
      bot,
      msg.chat.id,
      [
        "🗓 Strategy retention updated",
        `Keep recent days: ${result.keepRecentDays}`,
        `Remaining strategies: ${result.remainingCount}`,
        `Removed strategies: ${result.removedCount}`,
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("clearstrategy"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    await sendTemporaryMessage(
      bot,
      msg.chat.id,
      "Send like: /clearstrategy BTCUSDT",
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("clearstrategy", true), async (msg, match) => {
    cleanupIncomingMessage(bot, msg);
    const pair = String(match[1] || "").trim().toUpperCase();

    if (!pair) {
      await sendTemporaryMessage(
        bot,
        msg.chat.id,
        "Send like: /clearstrategy BTCUSDT",
        buildMainMenu()
      );
      return;
    }

    const result = clearStrategiesForPair(pair);
    await sendTemporaryMessage(
      bot,
      msg.chat.id,
      [
        `🧹 Strategy cleanup for ${result.pair || pair}`,
        `Removed strategies: ${result.removedCount}`,
        `Remaining strategies: ${result.remainingCount}`,
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("clearallstrategy"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const result = clearAllStrategies();
    await sendTemporaryMessage(
      bot,
      msg.chat.id,
      [
        "🧹 All strategies cleared",
        `Removed strategies: ${result.removedCount}`,
        `Remaining strategies: ${result.remainingCount}`,
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("rebuildstrategies"), async (msg) => {
    cleanupIncomingMessage(bot, msg);
    const rebuilt = rebuildStrategiesIndexFromFiles();
    await sendTemporaryMessage(bot, 
      msg.chat.id,
      [
        "♻️ Strategy index rebuilt",
        `Total strategies indexed: ${rebuilt.length}`,
        `Removed old strategies: ${rebuilt.removedFiles?.length || 0}`,
        `Retention days: ${rebuilt.retentionDays ?? getStrategyRetentionDays()}`,
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.on("polling_error", (error) => {
    console.error("Telegram polling error:", error.message);
  });
}

module.exports = {
  createBot,
  setupCommands,
  registerHandlers,
  buildHelpText,
};
