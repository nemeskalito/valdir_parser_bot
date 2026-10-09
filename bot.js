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
  let imageUrl = event.payload.item?.metadata?.image_url;

  const priceEth = event.payload.base_price
    ? Number(BigInt(event.payload.base_price)) / 1e18
    : null;

  if (!priceEth) return;

  // Конвертация IPFS -> HTTP
  if (imageUrl && imageUrl.startsWith('ipfs://')) {
    imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

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
    `🔗 [Open on OpenSea](${event.payload.item?.permalink || `https://opensea.io/item/ethereum/${event.payload.item?.nft_id}`})`;

  for (const chatId of subscribers) {
    try {
      if (imageUrl) {
        const imageResponse = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        await bot.telegram.sendPhoto(
          chatId,
          { source: Buffer.from(imageResponse.data) },
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

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error(`Ошибка для ${ctx.updateType}:`, err);
});

bot.launch();
console.log('🤖 Бот запущен.');

process.once('SIGINT', () => {
  stream.disconnect();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  stream.disconnect();
  bot.stop('SIGTERM');
});