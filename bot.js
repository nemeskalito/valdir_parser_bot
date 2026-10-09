import { Telegraf } from 'telegraf';
import { OpenSeaSDK, Chain } from '@opensea/sdk/viem';
import { OpenSeaStreamClient } from '@opensea/sdk/stream';
import { createPublicClient, http } from 'viem';
import { WebSocket } from 'ws';
import { mainnet } from 'viem/chains';
import axios from 'axios';
import fs from 'fs';
import 'dotenv/config';

const bot = new Telegraf(process.env.BOT_TOKEN);
const COLLECTION_SLUG = 'heroesofvaldir';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

// --- OpenSea SDK ---
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.RPC_URL)
});

const sdk = new OpenSeaSDK(
  { publicClient },
  { chain: Chain.Mainnet, apiKey: process.env.OPENSEA_API_KEY }
);

// --- Защита от дублей ---
const DEDUP_FILE = './dedup.json';
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 минут

let processedListings = new Map();

try {
  const data = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
  processedListings = new Map(Object.entries(data));
} catch {}

function isDuplicate(nftId) {
  const now = Date.now();

  for (const [id, ts] of processedListings.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) processedListings.delete(id);
  }

  if (processedListings.has(nftId)) return true;

  processedListings.set(nftId, now);

  try {
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(Object.fromEntries(processedListings)));
  } catch {}
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

  if (!nftId) return;
  if (isDuplicate(nftId)) return;

  const nftName =
    event.payload.item?.metadata?.name ||
    `#${nftId?.split('/').pop()}`;

  const priceEth = event.payload.base_price
    ? Number(BigInt(event.payload.base_price)) / 1e18
    : null;

  if (!priceEth) return;

  let priceUsd = null;
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { timeout: 5000 }
    );
    priceUsd = (priceEth * res.data.ethereum.usd).toFixed(2);
  } catch {}

  const link = event.payload.item?.permalink ||
    `https://opensea.io/item/ethereum/${nftId}`;

  const caption =
    `🖼 *${nftName}*\n\n` +
    `💰 *${priceEth.toFixed(4)} ETH*` +
    (priceUsd ? ` (~$${priceUsd})` : '') +
    `\n\n` +
    `🔗 [Open on OpenSea](${link})`;

  if (!GROUP_CHAT_ID) return;

  try {
    await bot.telegram.sendMessage(GROUP_CHAT_ID, caption, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`Ошибка отправки в группу:`, err.message);
  }
});

// --- Команды (только для групп) ---

bot.start((ctx) => {
  if (ctx.chat.type === 'private') return;
  ctx.reply('👋 Бот активен.');
});

bot.command('stop', (ctx) => {
  if (ctx.chat.type === 'private') return;
  ctx.reply('ℹ️ Уведомления управляются администратором.');
});

bot.command('id', (ctx) => {
  if (ctx.chat.type === 'private') return;
  ctx.reply(
    `📋 *Информация о чате*\n\n` +
    `🆔 ID: \`${ctx.chat.id}\`\n` +
    `📁 Тип: \`${ctx.chat.type}\`\n` +
    `📝 Название: ${ctx.chat.title || 'без названия'}`,
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
      console.log('🤖 Бот запущен.');
      return;
    } catch (err) {
      const isConflict =
        err?.response?.error_code === 409 ||
        err?.code === 409 ||
        String(err?.message || '').includes('409');

      if (isConflict) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Не удалось запустить бота');
}

launchWithRetry(bot).catch((err) => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  stream.disconnect();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  stream.disconnect();
  bot.stop('SIGTERM');
});