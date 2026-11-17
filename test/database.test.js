import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TicketDatabase } from '../src/database.js';
const input = { workspaceId: 'T1', channelId: 'C1', messageTs: '123.456', reporterId: 'U1', title: 'Printer is broken' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tickets-'));
  const path = join(dir, 'tickets.sqlite');
  const db = new TicketDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path };
}
test('creates one durable ticket per source and isolates workspaces', t => {
  const { db, path } = fixture(t);
  const ticket = db.create(input);
  assert.equal(ticket.label, 'T-000001');
  assert.equal(ticket.status, 'Open');
  assert.equal(ticket.assigneeId, null);
  assert.equal(db.create(input).id, ticket.id);
  assert.equal(db.list('T1').length, 1);
  assert.equal(db.get(ticket.id, 'T2'), null);
  const second = new TicketDatabase(path);
  try { assert.equal(second.get(ticket.id, 'T1').title, input.title); } finally { second.close(); }
  assert.equal(db.pendingOutbox().length, 1);
});
test('updates atomically with history, version checks and action idempotency', t => {
  const { db } = fixture(t);
  const ticket = db.create(input);
  const update = { id: ticket.id, workspaceId: 'T1', version: ticket.version, actorId: 'U2', actionId: 'a1', assigneeId: 'U3' };
  const assigned = db.update(update);
  assert.equal(assigned.assigneeId, 'U3');
  assert.equal(assigned.version, ticket.version + 1);
  assert.equal(db.update(update).version, assigned.version);
  assert.equal(db.history(ticket.id, 'T1').length, 1);
  assert.equal(db.pendingOutbox().length, 3);
  assert.throws(() => db.update({ ...update, actionId: 'a2' }), /stale/i);
  const progress = db.update({ ...update, actionId: 'a3', version: assigned.version, status: 'In progress' });
  const resolved = db.update({ ...update, actionId: 'a4', version: progress.version, status: 'Resolved' });
  const reopened = db.update({ ...update, actionId: 'a5', version: resolved.version, status: 'Open' });
  assert.equal(reopened.assigneeId, 'U3');
  assert.equal(reopened.status, 'Open');
});
test('rejects invalid state and cross-ticket action replay without changes', t => {
  const { db } = fixture(t);
  const ticket = db.create(input);
  const base = { id: ticket.id, workspaceId: 'T1', version: ticket.version, actorId: 'U2', actionId: 'a1' };
  assert.throws(() => db.update({ ...base, status: 'In progress' }), /assignee/i);
  assert.throws(() => db.update({ ...base, status: 'Other' }), /status/i);
  assert.throws(() => db.update({ ...base, workspaceId: 'T2' }), /not found/i);
  db.update({ ...base, assigneeId: 'U3' });
  const other = db.create({ ...input, messageTs: '234.567' });
  assert.throws(() => db.update({ ...base, id: other.id }), /action/i);
  assert.equal(db.get(other.id, 'T1').assigneeId, null);
});
test('outbox failure remains retryable and card metadata is durable', t => {
  const { db } = fixture(t);
  const ticket = db.create({ ...input, title: 'x'.repeat(400) });
  assert.equal(ticket.title.length, 200);
  const item = db.pendingOutbox()[0];
  db.failOutbox(item.id, new Error('rate limit'), { retryable: true });
  assert.equal(db.pendingOutbox()[0].attempts, 1);
  db.setCard(ticket.id, 'T1', '999.001');
  assert.equal(db.get(ticket.id, 'T1').cardTs, '999.001');
  db.completeOutbox(item.id);
  assert.equal(db.pendingOutbox().length, 0);
});
test('outbox claims survive restart and uncertain failures cannot silently resend', t => {
  const { db, path } = fixture(t);
  const ticket = db.create(input);
  const item = db.pendingOutbox()[0];
  assert.equal(db.beginOutbox(item.id), true);
  assert.equal(db.beginOutbox(item.id), false);
  assert.equal(db.pendingOutbox().length, 0);
  const second = new TicketDatabase(path);
  try { assert.equal(second.pendingOutbox().length, 0); } finally { second.close(); }
  db.failOutbox(item.id, new Error('timeout'));
  assert.equal(db.pendingOutbox().length, 0);
  assert.equal(db.outboxRecords()[0].state, 'blocked');
  db.retryOutbox(item.id);
  assert.equal(db.pendingOutbox().length, 1);
  db.beginOutbox(item.id);
  db.failOutbox(item.id, new Error('rate limit'), { retryable: true });
  assert.equal(db.pendingOutbox()[0].state, 'queued');
  assert.equal(db.get(ticket.id, 'T1').status, 'Open');
});
test('card refresh queues existing card updates once without adding announcements', t => {
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 const ticket=db.create({workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Test'});
 for(const row of db.pendingOutbox())db.completeOutbox(row.id);
 db.setCard(ticket.id,'T1','456.000001');
 db.refreshCards('T1');db.refreshCards('T1');
 assert.equal(db.pendingOutbox().length,1);assert.equal(db.pendingOutbox()[0].kind,'card');
});
test('internal notes and explicit customer replies have separated delivery rows',t=>{
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 let ticket=db.create({...input,internalChannelId:'GINTERNAL'});
 assert.equal(ticket.internalChannelId,'GINTERNAL');
 assert.deepEqual(db.pendingOutbox().map(x=>x.kind),['card','internal_card']);
 ticket=db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'U2',actionId:'reply',kind:'reply',note:'Customer answer'});
 assert.equal(ticket.status,'Open');
 assert.ok(db.pendingOutbox().some(x=>x.kind==='customer_reply'));
 assert.ok(db.pendingOutbox().some(x=>x.kind==='internal_history'));
 assert.throws(()=>db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'U2',actionId:'bad',kind:'reply',note:'x',status:'Resolved'}),/reply/i);
 db.configureInternalChannel('T1','GINTERNAL');
 assert.throws(()=>db.configureInternalChannel('T1','GOTHER'),/different/i);
 db.setInternalCard(ticket.id,'T1','111.222');
 assert.equal(db.get(ticket.id,'T1').internalCardTs,'111.222');
});
