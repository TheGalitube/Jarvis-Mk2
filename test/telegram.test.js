import test from "node:test";
import assert from "node:assert/strict";
import { TelegramBot, telegramConfig } from "../lib/telegram.js";

test("Telegram requires an allowlist when a bot token is set", () => {
  assert.throws(() => telegramConfig({ JARVIS_TELEGRAM_BOT_TOKEN: "secret" }), /ALLOWED_CHAT_IDS/);
  assert.deepEqual(telegramConfig({ JARVIS_TELEGRAM_BOT_TOKEN: "secret", JARVIS_TELEGRAM_ALLOWED_CHAT_IDS: "123, -456, nope" }), {
    enabled: true, token: "secret", allowedChatIds: ["123", "-456"],
  });
});

test("Telegram ignores non-allowlisted chats and queues allowed text", async () => {
  const received = [];
  const bot = new TelegramBot({ allowedChatIds: ["42"], onText: async (message) => received.push(message) });
  bot.handle({ update_id: 1, message: { chat: { id: 9 }, text: "no" } });
  bot.handle({ update_id: 2, message: { chat: { id: 42 }, text: " hello " } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ chatId: "42", text: "hello" }]);
});

test("Telegram sends only concise text replies", async () => {
  const calls = [];
  const bot = new TelegramBot({ token: "secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  } });
  await bot.sendMessage("42", "x".repeat(5_000));
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, "42");
  assert.equal(body.text.length, 4_000);
  assert.ok(!calls[0].url.includes("secret") || calls[0].url.includes("botsecret"));
});
