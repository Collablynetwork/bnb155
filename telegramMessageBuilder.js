const { round } = require("./indicators");

function buildBinancePairLink(pair) {
  return `https://www.binance.com/en/futures/${String(pair || "").toUpperCase()}`;
}

function formatPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  if (Math.abs(num) >= 1000) return num.toFixed(2);
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

function formatScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? round(num, 2) : "N/A";
}

function formatRatio(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${round(num, 2)}R` : "N/A";
}

function formatPct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${round(num, digits)}%` : "N/A";
}

function sideEmoji(side) {
  return String(side || "").toUpperCase() === "SHORT" ? "🔴" : "🟢";
}

function sideWord(side) {
  return String(side || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

function buildSignalMessage(candidate) {
  const side = sideWord(candidate.side);
  const emoji = sideEmoji(side);
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 4) : [];
  const supportTfs = candidate.supportTfs || candidate.supportTimeframes || [];

  return [
    `${emoji} ${side} SIGNAL`,
    `🪙 Pair: ${candidate.pair}`,
    `🌐 Binance: ${buildBinancePairLink(candidate.pair)}`,
    `⏱ Base TF: ${candidate.baseTimeframe || candidate.baseTf || "N/A"}`,
    `📚 Support TFs (${supportTfs.length}): ${supportTfs.join(", ") || "N/A"}`,
    `🎯 Score: ${formatScore(candidate.score)}`,
    `💵 Entry Price: ${formatPrice(candidate.entry)}`,
    `✅ Target Price: ${formatPrice(candidate.targetPrice)}`,
    `❌ Stop Price: ${formatPrice(candidate.stopPrice)}`,
    `⚖️ Risk/Reward: ${formatRatio(candidate.riskReward)}`,
    `🧠 Strategy Source: ${candidate.strategyUsed || candidate.strategySource || "N/A"}`,
    reasons.length ? `✅ Conditions: ${reasons.join(" | ")}` : "✅ Conditions: Matched learned setup",
    `ℹ️ Performance uses the target and stop shown above.`,
  ].join("\n");
}

function buildSignalReplyMarkup(candidate) {
  return {
    inline_keyboard: [[
      {
        text: "Open Futures Contract",
        url: buildBinancePairLink(candidate.pair),
      },
    ]],
  };
}

function buildScoreRisingMessage({ pair, baseTf, oldScore, newScore, updates = [] }) {
  return [
    `🚀 Score Increased for ${pair}`,
    `⏱ TF: ${baseTf || "N/A"}`,
    `📈 Score: ${formatScore(oldScore)} → ${formatScore(newScore)}`,
    updates.length ? `✅ Updates: ${updates.join(" | ")}` : null,
  ].filter(Boolean).join("\n");
}

function buildTargetHitMessage(position) {
  const title = "🎯 TARGET ACHIEVED";
  const targetPrice = position.targetPrice;
  const pnlAmount = position.pnlAmount;
  const pnlPct = position.pnlPct;

  return [
    title,
    `🪙 Pair: ${position.pair}`,
    `📍 Side: ${position.side}`,
    `⏱ Base TF: ${position.baseTimeframe}`,
    `💵 Entry: ${formatPrice(position.entryPrice || position.entry)}`,
    `🏁 Exit Target: ${formatPrice(targetPrice)}`,
    `📌 Current Mark: ${formatPrice(position.currentMark)}`,
    `💹 PNL: ${formatPrice(pnlAmount)} (${formatPct(pnlPct)})`,
  ].join("\n");
}

function buildStopHitMessage(position) {
  const title = "❌ STOP LOSS HIT";
  const stopPrice = position.stopPrice;
  const pnlAmount = position.pnlAmount;
  const pnlPct = position.pnlPct;

  return [
    title,
    `🪙 Pair: ${position.pair}`,
    `📍 Side: ${position.side}`,
    `⏱ Base TF: ${position.baseTimeframe}`,
    `💵 Entry: ${formatPrice(position.entryPrice || position.entry)}`,
    `🧯 Stop Price: ${formatPrice(stopPrice)}`,
    `📌 Exit Mark: ${formatPrice(position.currentMark)}`,
    `💥 PNL: ${formatPrice(pnlAmount)} (${formatPct(pnlPct)})`,
  ].join("\n");
}

function buildForceClosedMessage(position) {
  return [
    "⚠️ SIGNAL CLOSED FORCEFULLY",
    `🪙 Pair: ${position.pair}`,
    `📍 Side: ${position.side}`,
    `⏱ Base TF: ${position.baseTimeframe}`,
    `💵 Entry: ${formatPrice(position.entryPrice || position.entry)}`,
    `📌 Exit Mark: ${formatPrice(position.currentMark)}`,
    `💹 PNL: ${formatPrice(position.pnlAmount)} (${formatPct(position.pnlPct)})`,
    `📝 Reason: ${position.forceCloseReason || "Internal market breadth reversed."}`,
  ].join("\n");
}

module.exports = {
  buildBinancePairLink,
  buildSignalMessage,
  buildSignalReplyMarkup,
  buildScoreRisingMessage,
  buildTargetHitMessage,
  buildStopHitMessage,
  buildForceClosedMessage,
};
