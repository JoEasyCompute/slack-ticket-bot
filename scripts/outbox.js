import { join } from 'node:path';
import { TicketDatabase } from '../src/database.js';
// Run only with the bot stopped. Inspect Slack before retrying a blocked/sending record.
const db = new TicketDatabase(join(process.env.DATA_DIR || './data', 'tickets.sqlite'));
const [command = 'list', rawId, cardTs] = process.argv.slice(2);
try {
  if (command === 'list') {
    for (const row of db.outboxRecords().filter(row => row.state !== 'completed')) console.log(JSON.stringify({ id: row.id, ticketId: row.ticketId, workspaceId: row.workspaceId, kind: row.kind, state: row.state, error: row.lastError }));
  } else {
    const id = Number(rawId);
    const row = db.outboxRecords().find(row => row.id === id);
    if (!row) throw new Error('Unknown outbox record');
    if (command === 'retry') db.retryOutbox(id);
    else if (command === 'confirm') {
      const ticket = db.get(row.ticketId, row.workspaceId);
      if (['card', 'internal_card'].includes(row.kind) && !(row.kind === 'internal_card' ? ticket.internalCardTs : ticket.cardTs)) {
        if (!/^\d+\.\d+$/.test(cardTs || '')) throw new Error('Supply the existing Slack card timestamp');
        if (row.kind === 'internal_card') db.setInternalCard(row.ticketId, row.workspaceId, cardTs);
        else db.setCard(row.ticketId, row.workspaceId, cardTs);
      }
      db.completeOutbox(id);
    } else throw new Error('Use list, retry ID, or confirm ID [CARD_TIMESTAMP]');
  }
} finally { db.close(); }
