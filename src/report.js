import { access } from 'node:fs/promises';
export function createReportHandler({ db, client, store, workspaceId, channelIds, internalChannelId, reaction = 'ticket' }) {
  const monitored = new Set(channelIds);
  return async event => {
    const item = event?.item;
    if (event?.type !== 'reaction_added' || event.reaction !== reaction || item?.type !== 'message' || !monitored.has(item.channel) || !/^\d+\.\d+$/.test(item.ts || '')) return;
    // Historical receipts remain receipts, including unresolved old pending claims.
    try { await access(store.path(`${item.channel}:${item.ts}`)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await client.reactions.get({ channel: item.channel, timestamp: item.ts });
    const message = result.message;
    if (!result.ok || !message) throw new Error('Cannot read report');
    if (!message.user || message.bot_id || message.subtype === 'bot_message' || (message.thread_ts && message.thread_ts !== message.ts)) return;
    let permalink = null;
    if (client.chat?.getPermalink) {
      try {
        const link = await client.chat.getPermalink({ channel: item.channel, message_ts: item.ts });
        if (link.ok && typeof link.permalink === 'string' && link.permalink) permalink = link.permalink;
      } catch { /* Optional links must not prevent durable ticket creation. */ }
    }
    let channelName = null;
    if (client.conversations?.info) {
      try {
        const info = await client.conversations.info({ channel: item.channel });
        if (info.ok && info.channel?.name) {
          channelName = info.channel.name;
          db.setChannelName(workspaceId, item.channel, channelName);
        }
      } catch { /* A display-name lookup must not prevent ticket creation. */ }
    }
    return db.create({ workspaceId, channelId: item.channel, messageTs: item.ts, reporterId: message.user, internalChannelId, channelName, title: message.text || 'Reported issue', permalink });
  };
}
