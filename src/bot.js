import { setTimeout } from 'node:timers/promises';

export const RECEIPT = 'Thanks for reporting this. Your issue has been received.';
// Only errors known to reject the request before posting are safe to retry.
const REJECTED = new Set(['not_in_channel', 'channel_not_found', 'is_archived', 'invalid_auth', 'token_expired', 'token_revoked', 'missing_scope', 'no_permission', 'message_not_found', 'thread_not_found', 'restricted_action']);

export function createHandler({ channelId, channelIds, client, store, reaction = 'ticket', sleep = setTimeout }) {
  const monitoredChannels = new Set(channelIds ?? [channelId]);
  return async event => {
    const item = event?.item;
    if (event?.type !== 'reaction_added' || event.reaction !== reaction || item?.type !== 'message' ||
        !monitoredChannels.has(item.channel) || !/^\d+\.\d+$/.test(item.ts ?? '')) return 'ignored';

    const result = await client.reactions.get({ channel: item.channel, timestamp: item.ts });
    const message = result.message;
    if (!result.ok || !message) throw new Error('Unable to read reacted message');
    if (message.bot_id || message.subtype === 'bot_message' || !message.user ||
        (message.thread_ts && message.thread_ts !== message.ts)) return 'ignored';

    const key = `${item.channel}:${item.ts}`;
    const record = { channel: item.channel, messageTs: item.ts };
    if (!await store.claim(key, record)) return 'duplicate';
    let response;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          response = await client.chat.postMessage({
            channel: item.channel, thread_ts: item.ts, text: RECEIPT,
            reply_broadcast: false, unfurl_links: false, unfurl_media: false
          });
          break;
        } catch (error) {
          if (error.code !== 'slack_webapi_rate_limited_error' || attempt >= 3) throw error;
          await sleep(Math.max(1, Number(error.retryAfter) || 1) * 1000);
        }
      }
      if (!response.ok || !response.ts) throw new Error('Unconfirmed Slack response; inspect pending receipt');
    } catch (error) {
      if (error.code === 'slack_webapi_rate_limited_error' ||
          (error.code === 'slack_webapi_platform_error' && REJECTED.has(error.data?.error))) {
        await store.release(key);
      }
      throw error;
    }
    await store.complete(key, { ...record, acknowledgmentTs: response.ts });
    return 'sent';
  };
}
