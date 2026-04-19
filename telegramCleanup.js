const COMMAND_MESSAGE_TTL_MS = 30_000;

function cleanupDelayMs() {
  return COMMAND_MESSAGE_TTL_MS;
}

function deleteTelegramMessageLater(bot, chatId, messageId, delayMs = cleanupDelayMs()) {
  if (!bot || !chatId || !messageId) return;

  const delay = Number(delayMs);
  if (!Number.isFinite(delay) || delay <= 0) return;

  const timer = setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      // Ignore cleanup failures. In groups, the bot must be admin to delete user messages.
    }
  }, delay);

  if (typeof timer.unref === "function") timer.unref();
}

async function sendTemporaryMessage(bot, chatId, text, options = {}, delayMs = cleanupDelayMs()) {
  if (!bot || !chatId) return null;

  const message = await bot.sendMessage(chatId, text, options);
  deleteTelegramMessageLater(bot, chatId, message?.message_id, delayMs);
  return message;
}

function cleanupIncomingMessage(bot, msg, delayMs = cleanupDelayMs()) {
  if (!msg?.chat?.id || !msg?.message_id) return;
  deleteTelegramMessageLater(bot, msg.chat.id, msg.message_id, delayMs);
}

module.exports = {
  cleanupDelayMs,
  deleteTelegramMessageLater,
  sendTemporaryMessage,
  cleanupIncomingMessage,
};
