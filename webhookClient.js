const axios = require("axios");
const config = require("./config");
const state = require("./state");

const DEFAULT_SETTINGS = {
  enabled: false,
  url: "",
  privateKey: "",
  createdAt: null,
  updatedAt: null,
  lastDeliveryAt: null,
  lastDeliveryStatus: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
}

function settingsPath() {
  return config.webhookSettingsPath || `${config.storageDir}/webhook-settings.json`;
}

function normalizeSettings(raw = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    enabled: raw.enabled === true,
    url: String(raw.url || "").trim(),
    privateKey: String(raw.privateKey || "").trim(),
  };
}

function loadWebhookSettings() {
  return normalizeSettings(state.readJson(settingsPath(), DEFAULT_SETTINGS) || DEFAULT_SETTINGS);
}

function saveWebhookSettings(settings) {
  const normalized = normalizeSettings(settings);
  state.writeJson(settingsPath(), normalized);
  return normalized;
}

function maskSecret(secret) {
  const value = String(secret || "");
  if (!value) return "not set";
  if (value.length <= 8) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function validateWebhookUrl(url) {
  const raw = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error("Invalid webhook URL. Use https://... or http://...");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid webhook URL. Use https://... or http://...");
  }

  return parsed.toString();
}

function setWebhook(url, privateKey) {
  const cleanUrl = validateWebhookUrl(url);
  const cleanKey = String(privateKey || "").trim();
  if (!cleanKey) throw new Error("Private key is required.");

  const previous = loadWebhookSettings();
  return saveWebhookSettings({
    ...previous,
    enabled: true,
    url: cleanUrl,
    privateKey: cleanKey,
    createdAt: previous.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastError: null,
  });
}

function removeWebhook() {
  return saveWebhookSettings({
    ...DEFAULT_SETTINGS,
    updatedAt: nowIso(),
  });
}

function buildWebhookStatusText() {
  const settings = loadWebhookSettings();
  return [
    "🔗 Webhook Integration",
    `Status: ${settings.enabled ? "✅ Enabled" : "❌ Disabled"}`,
    `URL: ${settings.url || "not set"}`,
    `Private Key: ${maskSecret(settings.privateKey)}`,
    `Updated: ${settings.updatedAt || "N/A"}`,
    `Last Delivery: ${settings.lastDeliveryAt || "N/A"}`,
    `Last Status: ${settings.lastDeliveryStatus || "N/A"}`,
    settings.lastError ? `Last Error: ${settings.lastError}` : null,
  ].filter(Boolean).join("\n");
}

function sanitizeSignal(signal = {}) {
  return {
    signalId: signal.signalId || signal.id || null,
    signalKey: signal.signalKey || null,
    pair: signal.pair,
    side: signal.side,
    direction: signal.side,
    baseTimeframe: signal.baseTimeframe || signal.baseTf,
    supportTimeframes: signal.supportTfs || signal.supportTimeframes || [],
    entry: Number(signal.entry || signal.entryPrice || 0),
    entryPrice: Number(signal.entry || signal.entryPrice || 0),
    targetPrice: Number(signal.targetPrice || signal.tp1 || 0),
    tp1: Number(signal.targetPrice || signal.tp1 || 0),
    stopPrice: Number(signal.stopPrice || signal.sl || signal.stopLoss || 0),
    sl: Number(signal.stopPrice || signal.sl || signal.stopLoss || 0),
    score: Number(signal.score || 0),
    scoreRange: signal.scoreRange || null,
    scoreMove: signal.scoreMove || null,
    momentum: signal.momentum || null,
    entrySetupLabel: signal.entrySetupLabel || null,
    entrySetupReasons: signal.entrySetupReasons || [],
    strategyUsed: signal.strategyUsed || signal.strategySource || null,
    riskReward: signal.riskReward || null,
    telegramMessageId: signal.telegramMessageId || signal.signalMessageId || null,
  };
}

function sanitizeTradeUpdate(position = {}, outcome = "TRADE_UPDATE") {
  return {
    signalId: position.signalId || position.id || null,
    signalKey: position.signalKey || null,
    pair: position.pair,
    side: position.side,
    outcome,
    entryPrice: Number(position.entryPrice || position.entry || 0),
    exitPrice: Number(position.pnlExitPrice || position.currentMark || 0),
    targetPrice: Number(position.targetPrice || position.tp1 || 0),
    stopPrice: Number(position.stopPrice || position.sl || 0),
    pnlStatus: position.pnlStatus || null,
    pnlPct: Number(position.pnlPct || 0),
    pnlAmount: Number(position.pnlAmount || position.realizedPnl || 0),
    score: Number(position.score || 0),
    baseTimeframe: position.baseTimeframe || null,
    forceCloseReason: position.forceCloseReason || null,
    reverseSignalSide: position.reverseSignalSide || null,
    telegramMessageId: position.signalMessageId || position.messageId || null,
  };
}

function buildPayload(eventType, data = {}) {
  return {
    eventType,
    source: "binance-futures-scanner",
    sentAt: nowIso(),
    data,
  };
}

async function postWebhook(eventType, data = {}) {
  const settings = loadWebhookSettings();
  if (!settings.enabled || !settings.url || !settings.privateKey) {
    return { ok: false, skipped: true, reason: "Webhook disabled or incomplete" };
  }

  const payload = buildPayload(eventType, data);
  const startedAt = nowIso();

  try {
    const response = await axios.post(settings.url, payload, {
      timeout: Number(config.webhookTimeoutMs || 12_000),
      headers: {
        "Content-Type": "application/json",
        "x-provider-key": settings.privateKey,
        "x-private-key": settings.privateKey,
        Authorization: `Bearer ${settings.privateKey}`,
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });

    const ok = response.status >= 200 && response.status < 300;
    saveWebhookSettings({
      ...settings,
      lastDeliveryAt: startedAt,
      lastDeliveryStatus: `${response.status} ${ok ? "OK" : "FAILED"}`,
      lastError: ok ? null : JSON.stringify(response.data).slice(0, 500),
    });

    return { ok, status: response.status, data: response.data };
  } catch (error) {
    saveWebhookSettings({
      ...settings,
      lastDeliveryAt: startedAt,
      lastDeliveryStatus: "ERROR",
      lastError: error.message,
    });
    return { ok: false, error: error.message };
  }
}

async function sendSignalWebhook(signal) {
  return postWebhook("SIGNAL_CREATED", sanitizeSignal(signal));
}

async function sendTradeUpdateWebhook(position, outcome) {
  return postWebhook("TRADE_UPDATE", sanitizeTradeUpdate(position, outcome));
}

async function sendTestWebhook() {
  return postWebhook("WEBHOOK_TEST", {
    message: "Webhook test from Telegram trading bot",
    time: nowIso(),
  });
}

module.exports = {
  loadWebhookSettings,
  setWebhook,
  removeWebhook,
  buildWebhookStatusText,
  maskSecret,
  sendSignalWebhook,
  sendTradeUpdateWebhook,
  sendTestWebhook,
};
