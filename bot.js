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

// --- Хранилище подписчиков ---
const subscribers = new Set();

// --- Stream Client ---
const stream = new OpenSeaStreamClient({
  apiKey: process.env.OPENSEA_API_KEY,
  connectOptions: { transport: WebSocket }
});

stream.connect();

// --- Слушаем новые листинги ---
stream.onItemListed(COLLECTION_SLUG, async (event) => {
  if (subscribers.size === 0) return;

  const nftName =
    event.payload.item?.metadata?.name ||
    `#${event.payload.item?.nft_id?.split('/').pop()}`;

  const rawImageUrl = event.payload.item?.metadata?.image_url;
  const nftId = event.payload.item?.nft_id;

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

  const caption =
    `🖼 *${nftName}*\n\n` +
    `💰 *${priceEth.toFixed(4)} ETH*` +
    (priceUsd ? ` (~$${priceUsd})` : '') +
    `\n\n` +
    `🔗 [Open on OpenSea](${event.payload.item?.permalink || `https://opensea.io/item/ethereum/${nftId}`})`;

  // Собираем список URL для попытки скачать картинку
  const imageUrls = [];
  if (rawImageUrl) {
    if (rawImageUrl.startsWith('ipfs://')) {
      const hash = rawImageUrl.replace('ipfs://', '');
      imageUrls.push(
        `https://ipfs.io/ipfs/${hash}`,
        `https://gateway.pinata.cloud/ipfs/${hash}`,
        `https://dweb.link/ipfs/${hash}`,
        `https://ipfs.filebase.io/ipfs/${hash}`
      );
    } else {
      imageUrls.push(rawImageUrl);
    }
  }

  for (const chatId of subscribers) {
    try {
      let imageBuffer = null;

      for (const url of imageUrls) {
        try {
          const resp = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            maxContentLength: 10 * 1024 * 1024
          });

          const contentType = resp.headers['content-type'] || '';
          if (contentType.startsWith('image/')) {
            imageBuffer = Buffer.from(resp.data);
            break;
          } else {
            console.log(`Шлюз ${url} вернул ${contentType}, пропускаем`);
          }
        } catch (err) {
          console.log(`Шлюз ${url} не сработал: ${err.message}`);
        }
      }

      if (imageBuffer) {
        await bot.telegram.sendPhoto(
          chatId,
          { source: imageBuffer },
          { caption, parse_mode: 'Markdown' }
        );
      } else {
        await bot.telegram.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error(`Не удалось отправить в ${chatId}:`, err.message);
      try {
        await bot.telegram.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Фоллбек тоже не сработал:', e.message);
      }
    }
  }
});

// --- Команды ---

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  if (subscribers.has(chatId)) {
    return ctx.reply('Уведомления уже включены.');
  }
  subscribers.add(chatId);
  ctx.reply('✅ Уведомления включены. Буду присылать новые листинги.');
});

bot.command('stop', (ctx) => {
  const chatId = ctx.chat.id;
  if (!subscribers.has(chatId)) {
    return ctx.reply('Уведомления уже выключены.');
  }
  subscribers.delete(chatId);
  ctx.reply('🔕 Уведомления выключены.');
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