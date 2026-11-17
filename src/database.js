import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATUSES = new Set(['Open', 'In progress', 'Resolved']);
export class TicketDatabase {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspaceId TEXT NOT NULL, channelId TEXT NOT NULL,
        messageTs TEXT NOT NULL, reporterId TEXT NOT NULL, title TEXT NOT NULL,
        assigneeId TEXT, status TEXT NOT NULL DEFAULT 'Open', version INTEGER NOT NULL DEFAULT 1,
        cardTs TEXT, permalink TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        UNIQUE(workspaceId, channelId, messageTs));
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticketId INTEGER NOT NULL REFERENCES tickets(id),
        workspaceId TEXT NOT NULL, actionId TEXT NOT NULL, actorId TEXT NOT NULL, payload TEXT NOT NULL,
        createdAt TEXT NOT NULL, UNIQUE(workspaceId, actionId));
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticketId INTEGER NOT NULL REFERENCES tickets(id),
        workspaceId TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        lastError TEXT, completedAt TEXT, createdAt TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued');`);
    if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(column => column.name === 'state')) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'queued'");
    }
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'permalink')) this.db.exec('ALTER TABLE tickets ADD COLUMN permalink TEXT');
    for (const column of ['internalChannelId','internalCardTs','channelName']) if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(c => c.name === column)) this.db.exec(`ALTER TABLE tickets ADD COLUMN ${column} TEXT`);
  }
    // Schema additions preserve existing ticket and delivery records.
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  ticket(row) { return row ? { ...row, label: `T-${String(row.id).padStart(6, '0')}` } : null; }
  get(id, workspaceId) { return this.ticket(this.db.prepare('SELECT * FROM tickets WHERE id=? AND workspaceId=?').get(id, workspaceId)); }
  list(workspaceId) { return this.db.prepare('SELECT * FROM tickets WHERE workspaceId=? ORDER BY id DESC').all(workspaceId).map(row => this.ticket(row)); }
  enqueue(ticket, kind, payload) {
    this.db.prepare('INSERT INTO outbox(ticketId,workspaceId,kind,payload,createdAt) VALUES(?,?,?,?,?)')
      .run(ticket.id, ticket.workspaceId, kind, JSON.stringify(payload), new Date().toISOString());
  }
  create({ workspaceId, channelId, messageTs, reporterId, title, permalink = null, internalChannelId = null, channelName = null }) {
    if (![workspaceId, channelId, messageTs, reporterId].every(value => typeof value === 'string' && value.length)) throw new Error('Ticket identifiers are required');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM tickets WHERE workspaceId=? AND channelId=? AND messageTs=?').get(workspaceId, channelId, messageTs);
      if (existing) return this.ticket(existing);
      const now = new Date().toISOString();
      const result = this.db.prepare('INSERT INTO tickets(workspaceId,channelId,messageTs,reporterId,title,permalink,internalChannelId,channelName,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(workspaceId, channelId, messageTs, reporterId, String(title || 'Reported issue').replace(/\s+/g, ' ').trim().slice(0, 200), permalink, internalChannelId, typeof channelName === 'string' ? channelName.trim().slice(0, 200) || null : null, now, now);
      const ticket = this.get(Number(result.lastInsertRowid), workspaceId);
      this.enqueue(ticket, 'card', { version: ticket.version });
      if (ticket.internalChannelId) this.enqueue(ticket, 'internal_card', { version: ticket.version });
      return ticket;
    });
  }
  update({ id, workspaceId, version, actorId, actionId, assigneeId, status, note = '', kind = 'change' }) {
    if (!actorId || !actionId) throw new Error('Actor and action IDs are required');
    return this.transaction(() => {
      const ticket = this.get(id, workspaceId);
      if (!ticket) throw new Error('Ticket not found');
      const replay = this.db.prepare('SELECT ticketId,actorId FROM history WHERE workspaceId=? AND actionId=?').get(workspaceId, actionId);
      if (replay) {
        if (replay.ticketId !== id || replay.actorId !== actorId) throw new Error('Action ID already used');
        return ticket;
      }
      if (ticket.version !== version) throw new Error('Stale ticket: refresh before making changes');
      if (typeof note !== 'string' || note.length > 2000) throw new Error('Notes must be at most 2000 characters');
      note = note.trim();
      if (!['change', 'note', 'reply'].includes(kind)) throw new Error('Invalid history kind');
      if (kind === 'note' && (ticket.status !== 'In progress' || !note || status !== undefined || assigneeId !== undefined)) throw new Error('Add a nonempty progress note to an In progress ticket');
      if (kind === 'reply' && (!note || status !== undefined || assigneeId !== undefined)) throw new Error('A reply must contain text and cannot change ticket state');
      const nextAssignee = assigneeId === undefined ? ticket.assigneeId : assigneeId;
      const nextStatus = status === undefined ? ticket.status : status;
      if (!STATUSES.has(nextStatus)) throw new Error('Invalid status');
      if (nextAssignee !== null && (typeof nextAssignee !== 'string' || !nextAssignee)) throw new Error('Invalid assignee');
      if (nextStatus === 'In progress' && !nextAssignee) throw new Error('In progress requires an assignee');
      const payload = { kind, note, actorId, assigneeId: nextAssignee, status: nextStatus, previousAssigneeId: ticket.assigneeId, previousStatus: ticket.status };
      const now = new Date().toISOString();
      this.db.prepare('UPDATE tickets SET assigneeId=?,status=?,version=version+1,updatedAt=? WHERE id=? AND workspaceId=?')
        .run(nextAssignee, nextStatus, now, id, workspaceId);
      this.db.prepare('INSERT INTO history(ticketId,workspaceId,actionId,actorId,payload,createdAt) VALUES(?,?,?,?,?,?)')
        .run(id, workspaceId, actionId, actorId, JSON.stringify(payload), now);
      const updated = this.get(id, workspaceId);
      this.enqueue(updated, 'card', { version: updated.version });
      if (updated.internalChannelId) this.enqueue(updated, 'internal_card', { version: updated.version });
      this.enqueue(updated, 'internal_history', payload);
      if (kind === 'reply') this.enqueue(updated, 'customer_reply', payload);
      else if (nextStatus !== ticket.status) this.enqueue(updated, 'customer_status', { status: nextStatus, previousStatus: ticket.status });
      return updated;
    });
  }
  history(id, workspaceId) {
    return this.db.prepare('SELECT * FROM history WHERE ticketId=? AND workspaceId=? ORDER BY id').all(id, workspaceId)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  pendingOutbox() { return this.db.prepare("SELECT * FROM outbox WHERE completedAt IS NULL AND state='queued' ORDER BY id").all().map(row => ({ ...row, payload: JSON.parse(row.payload) })); }
  beginOutbox(id) { return this.db.prepare("UPDATE outbox SET state='sending' WHERE id=? AND state='queued' AND completedAt IS NULL").run(id).changes === 1; }
  outboxRecords() { return this.db.prepare('SELECT * FROM outbox ORDER BY id').all().map(row => ({ ...row, payload: JSON.parse(row.payload) })); }
  retryOutbox(id) { this.db.prepare("UPDATE outbox SET state='queued',lastError=NULL WHERE id=? AND state IN ('sending','blocked') AND completedAt IS NULL").run(id); }
  completeOutbox(id) { this.db.prepare("UPDATE outbox SET completedAt=?,state='completed' WHERE id=?").run(new Date().toISOString(), id); }
  failOutbox(id, error, { retryable = false } = {}) { this.db.prepare('UPDATE outbox SET attempts=attempts+1,lastError=?,state=? WHERE id=?').run(String(error?.code || error?.message || error).slice(0, 300), retryable ? 'queued' : 'blocked', id); }
  configureInternalChannel(workspaceId, channelId) {
    if (!channelId) throw new Error('Internal channel is required');
    return this.transaction(() => {
      if (this.list(workspaceId).some(t => t.internalChannelId && t.internalChannelId !== channelId)) throw new Error('Tickets already use a different internal channel');
      this.db.prepare('UPDATE tickets SET internalChannelId=? WHERE workspaceId=? AND internalChannelId IS NULL').run(channelId, workspaceId);
      for (const ticket of this.list(workspaceId)) {
        if (!ticket.internalCardTs && !this.db.prepare("SELECT 1 FROM outbox WHERE ticketId=? AND workspaceId=? AND kind='internal_card' AND state!='completed'").get(ticket.id, workspaceId)) this.enqueue(ticket, 'internal_card', { version: ticket.version });
      }
    });
  }
  refreshCards(workspaceId) {
    return this.transaction(() => {
      for (const ticket of this.list(workspaceId)) {
        for (const kind of ['card', ...(ticket.internalChannelId ? ['internal_card'] : [])]) {
          if (kind === 'card' && !ticket.cardTs) continue;
          const pending = this.db.prepare("SELECT 1 FROM outbox WHERE ticketId=? AND workspaceId=? AND kind=? AND state != 'completed'").get(ticket.id, workspaceId, kind);
          if (!pending) this.enqueue(ticket, kind, { version: ticket.version });
        }
      }
    });
  }
  setChannelName(workspaceId, channelId, name) {
    if (typeof name !== 'string' || !name.trim()) return;
    this.db.prepare('UPDATE tickets SET channelName=? WHERE workspaceId=? AND channelId=?').run(name.trim().slice(0, 200), workspaceId, channelId);
  }
  setInternalCard(id, workspaceId, ts) { this.db.prepare('UPDATE tickets SET internalCardTs=? WHERE id=? AND workspaceId=?').run(ts, id, workspaceId); }
  setCard(id, workspaceId, cardTs) { this.db.prepare('UPDATE tickets SET cardTs=? WHERE id=? AND workspaceId=?').run(cardTs, id, workspaceId); }
  close() { this.db.close(); }
}
