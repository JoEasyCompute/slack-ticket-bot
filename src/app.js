import bolt from '@slack/bolt';
import { readConfig } from './config.js';
import { FileStore } from './store.js';
import { createHandler } from './bot.js';

const config = readConfig();
const app = new bolt.App({
  token: config.botToken, appToken: config.appToken, socketMode: true,
  // A timeout after posting may mean Slack accepted the message. Avoid blind retries.
  clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true }
});
const handle = createHandler({ channelIds: config.channelIds, reaction: config.reaction,
  client: app.client, store: new FileStore(config.dataDir) });
app.event('reaction_added', async ({ event, logger }) => {
  try {
    const status = await handle(event);
    if (status !== 'ignored') logger.info(`Receipt ${status}: ${event.item.channel}/${event.item.ts}`);
  } catch (error) {
    // Do not log tokens, message bodies or the full Slack request object.
    logger.error(`Receipt failed: ${error.data?.error || error.code || 'unconfirmed_delivery'}. Inspect data records and Slack thread before retrying.`);
  }
});
app.error(async error => { console.error(`Slack connection error: ${error.code || 'unknown'}`); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await app.stop();
  process.exit(0);
});
await app.start();
console.log(`Ticket acknowledger connected; channels=${config.channelIds.join(',')}, emoji=:${config.reaction}:`);
