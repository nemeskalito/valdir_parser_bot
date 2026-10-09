import { Telegraf } from 'telegraf';
import { OpenSeaSDK, Chain } from '@opensea/sdk/viem';
import { OpenSeaStreamClient } from '@opensea/sdk/stream';
import { createPublicClient, http } from 'viem';
import { WebSocket } from 'ws';
import { mainnet } from 'viem/chains';
import axios from 'axios';
import 'dotenv/config';

const bot = new Telegraf(process.env.BOT_TOKEN);
const COLLECTION_SLUG = 'heroesofvaldir';

// --- OpenSea SDK ---
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.RPC_URL)
});

const sdk = new OpenSeaSDK(
  { publicClient },
  { chain: Chain.Mainnet, apiKey: process.env.OPENSEA_API_KEY }
);

// --- Хранилище подписчиков (только группы) ---
const subscribers = new Set();

// --- Защита от дублей ---
const processedListings = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 минут

function isDuplicate(nftId) {
  const now = Date.now();
  for (const [id, ts] of processedListings.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) processedListings.delete(id);
  }
  if (processedListings.has(nftId)) return true;
  processedListings.set(nftId, now);
  return false;
}

// --- Stream Client ---
const stream = new OpenSeaStreamClient({
  apiKey: process.env.OPENSEA_API_KEY,
  connectOptions: { transport: WebSocket }
});

stream.connect();

// --- Слушаем новые листинги ---
stream.onItemListed(COLLECTION_SLUG, async (event) => {
  const nftId = event.payload.item?.nft_id;

  if (!nftId || isDuplicate(nftId)) {
    console.log(`⏭ Пропускаем дубль: ${nftId}`);
    return;
  }

  const nftName =
    event.payload.item?.metadata?.name ||
    `#${nftId?.split('/').pop()}`;

  const priceEth = event.payload.base_price
    ? Number(BigInt(event.payload.base_price)) / 1e18
    : null;

  if (!priceEth) return;

  // Курс ETH -> USD
  let priceUsd = null;
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { timeout: 5000 }
    );
    priceUsd = (priceEth * res.data.ethereum.usd).toFixed(2);
  } catch (err) {
    console.error('Не удалось получить курс USD:', err.message);
  }

  const link = event.payload.item?.permalink ||
    `https://opensea.io/item/ethereum/${nftId}`;

  const caption =
    `🖼 *${nftName}*\n\n` +
    `💰 *${priceEth.toFixed(4)} ETH*` +
    (priceUsd ? ` (~$${priceUsd})` : '') +
    `\n\n` +
    `🔗 [Open on OpenSea](${link})`;

  if (subscribers.size === 0) return;

  for (const chatId of subscribers) {
    try {
      await bot.telegram.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`Не удалось отправить в ${chatId}:`, err.message);
    }
  }
});

// --- Команды (только для групп) ---

// /start — включить уведомления для этой группы
bot.start((ctx) => {
  // Игнорируем личку
  if (ctx.chat.type === 'private') return;

  const chatId = String(ctx.chat.id);

  if (subscribers.has(chatId)) {
    return ctx.reply('Уведомления для этой группы уже включены.');
  }
  subscribers.add(chatId);
  ctx.reply('✅ Уведомления включены. Буду присылать новые листинги.');
});

// /stop — выключить уведомления
bot.command('stop', (ctx) => {
  if (ctx.chat.type === 'private') return;

  const chatId = String(ctx.chat.id);

  if (!subscribers.has(chatId)) {
    return ctx.reply('Уведомления для этой группы уже выключены.');
  }
  subscribers.delete(chatId);
  ctx.reply('🔕 Уведомления выключены.');
});

// /id — показать chat_id группы
bot.command('id', (ctx) => {
  if (ctx.chat.type === 'private') return;

  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'без названия';

  ctx.reply(
    `📋 *Информация о чате*\n\n` +
    `🆔 ID: \`${chatId}\`\n` +
    `📁 Тип: \`${chatType}\`\n` +
    `📝 Название: ${chatTitle}`,
    { parse_mode: 'Markdown' }
  );
});

// --- Обработка ошибок ---
bot.catch((err, ctx) => {
  console.error(`Ошибка для ${ctx.updateType}:`, err);
});

// --- Запуск с ретраем при 409 ---
async function launchWithRetry(botInstance, options = {}, maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await botInstance.telegram.deleteWebhook({ drop_pending_updates: true });
      await botInstance.launch(options);
      console.log('🤖 Бот запущен и подключён к Telegram.');
      return;
    } catch (err) {
      const isConflict =
        err?.response?.error_code === 409 ||
        err?.code === 409 ||
        String(err?.message || '').includes('409');

      if (isConflict) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
        console.warn(
          `⚠️ Конфликт сессий Telegram (409), попытка ${attempt}/${maxAttempts} через ${delay}мс...`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Не удалось запустить бота после всех попыток');
}

launchWithRetry(bot).catch((err) => {
  console.error('Фатальная ошибка запуска:', err);
  process.exit(1);
});

// --- Graceful shutdown ---
process.once('SIGINT', () => {
  stream.disconnect();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  stream.disconnect();
  bot.stop('SIGTERM');
});