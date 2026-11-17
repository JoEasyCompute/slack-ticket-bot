import { withUserNames } from './user-names.js';
import { ticketBlocks, customerBlocks } from './ticket-views.js';
const rejected = new Set(['not_in_channel', 'channel_not_found', 'is_archived', 'invalid_auth', 'token_expired', 'token_revoked', 'missing_scope', 'no_permission', 'message_not_found', 'thread_not_found', 'restricted_action']);
const internalKind = kind => ['internal_card', 'internal_history', 'history'].includes(kind);
const plain = text => ({ type: 'section', text: { type: 'plain_text', text, emoji: false } });
export class Delivery {
  constructor({ db, client, permissions, internalChannelId, logger = console }) {
    Object.assign(this, { db, client, permissions, internalChannelId, logger }); this.running = null;
  }
  flush() {
    if (this.running) return this.running;
    if (Date.now() < (this.retryAfterUntil || 0)) return Promise.resolve();
    this.running = this.sendPending().finally(() => { this.running = null; });
    return this.running;
  }
  async sendPending() {
    for (const item of this.db.pendingOutbox()) {
      // Internal uncertainty must not suppress a separate, sanitized customer status update.
      const earlierUncertain = (this.db.outboxRecords?.() || []).some(row => row.ticketId === item.ticketId && row.workspaceId === item.workspaceId && row.id < item.id && row.state !== 'completed' && internalKind(row.kind) === internalKind(item.kind) && !(item.kind === 'internal_card' && !this.db.get(item.ticketId, item.workspaceId)?.internalCardTs && row.kind !== 'internal_card'));
      if (earlierUncertain) continue;
      const ticket = this.db.get(item.ticketId, item.workspaceId);
      if (!ticket) continue;
      const internal = internalKind(item.kind);
      const card = item.kind === 'card' || item.kind === 'internal_card';
      const cardTs = internal ? ticket.internalCardTs : ticket.cardTs;
      const updating = card && Boolean(cardTs);
      // Check routing and private-channel policy before reserving the send.
      if (internal) {
        try {
          if (!this.internalChannelId || ticket.internalChannelId !== this.internalChannelId || !this.permissions?.validateInternalChannel) throw new Error('Private internal channel is not configured');
          if (await this.permissions.validateInternalChannel() === false) throw new Error('Internal channel privacy check failed');
          if (!card && !ticket.internalCardTs) continue;
        } catch (error) {
          this.logger.error(`Internal delivery withheld: outbox=${item.id}`);
          continue;
        }
      }
      if (!this.db.beginOutbox(item.id)) continue;
      try {
        if (card) {
          const content = {
            channel: internal ? ticket.internalChannelId : ticket.channelId,
            text: internal ? `${ticket.label} · ${ticket.status} · Source: ${ticket.channelName ? `#${ticket.channelName}` : ticket.channelId}` : `${ticket.label} · ${ticket.status} · Your issue has been received.`,
            blocks: internal ? ticketBlocks(await withUserNames(ticket, this.client)) : customerBlocks(ticket),
            unfurl_links: false, unfurl_media: false
          };
          if (updating) {
            const result = await this.client.chat.update({ ...content, ts: cardTs });
            if (!result.ok) throw new Error('Unconfirmed update');
          } else {
            const result = await this.client.chat.postMessage({ ...content, ...(!internal ? { thread_ts: ticket.messageTs } : {}), reply_broadcast: false });
            if (!result.ok || !result.ts) throw new Error('Unconfirmed delivery');
            if (internal) this.db.setInternalCard(ticket.id, ticket.workspaceId, result.ts);
            else this.db.setCard(ticket.id, ticket.workspaceId, result.ts);
          }
        } else {
          const p = item.payload;
          let text;
          let blocks;
          if (item.kind === 'customer_reply') {
            text = `${ticket.label}: Support replied.\n${String(p.note || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`;
            blocks = [plain(`${ticket.label}: Support replied.`), plain(String(p.note || ''))];
          } else if (item.kind === 'customer_status') {
            text = `${ticket.label}: Status changed to ${p.status}.`;
            blocks = [plain(text)];
          } else if (internal) {
            text = `${ticket.label}: ${p.kind === 'note' ? 'Internal progress note' : p.kind === 'reply' ? 'Customer reply recorded' : 'Ticket updated'} · ${p.status || ticket.status}`;
            blocks = [plain(text), plain(`By: ${p.actorId || 'System'} · Owner: ${p.assigneeId || 'Unassigned'}`), ...(p.note ? [plain(String(p.note))] : [])];
          } else throw new Error('Unknown outbox kind');
          const result = await this.client.chat.postMessage({ channel: internal ? ticket.internalChannelId : ticket.channelId, thread_ts: internal ? ticket.internalCardTs : ticket.messageTs, text, blocks, reply_broadcast: false, unfurl_links: false, unfurl_media: false });
          if (!result.ok || !result.ts) throw new Error('Unconfirmed delivery');
        }
        this.db.completeOutbox(item.id);
      } catch (error) {
        const retryable = updating || error.code === 'slack_webapi_rate_limited_error' || (error.code === 'slack_webapi_platform_error' && rejected.has(error.data?.error));
        this.db.failOutbox(item.id, error, { retryable });
        this.logger.error(`Ticket delivery ${retryable ? 'will retry' : 'requires review'}: outbox=${item.id}, code=${error.data?.error || error.code || 'unconfirmed'}`);
        if (error.code === 'slack_webapi_rate_limited_error') {
          this.retryAfterUntil = Date.now() + Math.max(1, Number(error.retryAfter) || 30) * 1000;
          break;
        }
      }
    }
  }
}
