import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketDatabase } from '../src/database.js';
import { TicketManager } from '../src/management.js';
import { Delivery } from '../src/delivery.js';
import { ticketBlocks, historyView, noteView } from '../src/ticket-views.js';
function fixture(t) {
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 const permissions={canView:async()=>true,assertStatus:async()=>{},assertAssign:async()=>{}};
 const manager=new TicketManager({db,permissions,workspaceId:'T1'});
 let ticket=db.create({workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Issue',internalChannelId:'CSTAFF'});
 ticket=db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'UC',actionId:'assign',assigneeId:'U2'});
 return {db,manager,permissions,ticket};
}
test('status notes are optional and notes save atomically with the status',async t=>{
 const f=fixture(t);let ticket=await f.manager.change({userId:'U2',workspaceId:'T1',id:f.ticket.id,version:2,actionId:'start',status:'In progress',note:' Investigating '});
 assert.equal(f.db.history(ticket.id,'T1').at(-1).payload.note,'Investigating');
 ticket=await f.manager.change({userId:'U2',workspaceId:'T1',id:ticket.id,version:ticket.version,actionId:'resolve',status:'Resolved',note:''});
 assert.equal(ticket.status,'Resolved');assert.equal(f.db.history(ticket.id,'T1').at(-1).payload.note,'');
});
test('progress notes append without changing status and retries do not duplicate history',async t=>{
 const f=fixture(t);let ticket=f.db.update({id:f.ticket.id,workspaceId:'T1',version:2,actorId:'U2',actionId:'start',status:'In progress'});
 const input={userId:'U2',workspaceId:'T1',id:ticket.id,version:ticket.version,actionId:'note1',note:'Waiting for logs'};
 ticket=await f.manager.addNote(input);await f.manager.addNote(input);
 assert.equal(ticket.status,'In progress');assert.equal(ticket.assigneeId,'U2');
 assert.equal(f.db.history(ticket.id,'T1').filter(h=>h.payload.kind==='note').length,1);
 await f.manager.addNote({...input,version:ticket.version,actionId:'note2',note:'Logs received'});
 assert.equal(f.db.history(ticket.id,'T1').filter(h=>h.payload.kind==='note').length,2);
});
test('progress notes enforce status permissions and input limits',async t=>{
 const f=fixture(t);const input={userId:'U2',workspaceId:'T1',id:f.ticket.id,version:2,actionId:'note',note:'Test'};
 await assert.rejects(f.manager.addNote(input),/In progress/);
 f.db.update({id:f.ticket.id,workspaceId:'T1',version:2,actorId:'U2',actionId:'start',status:'In progress'});
 await assert.rejects(f.manager.addNote({...input,version:3,note:'  '}),/note/i);
 await assert.rejects(f.manager.addNote({...input,version:3,note:'x'.repeat(2001)}),/2000/);
 f.permissions.assertStatus=async()=>{throw new Error('Denied');};
 await assert.rejects(f.manager.addNote({...input,version:3}),/Denied/);
 assert.equal(f.db.history(f.ticket.id,'T1').length,2);
});
test('note dialogs and history display notes without parsing mentions',()=>{
 const ticket={id:1,label:'T-000001',workspaceId:'T1',channelId:'C1',messageTs:'123.000001',status:'In progress',version:3};
 const view=noteView(ticket,'Resolved');assert.equal(view.blocks.find(b=>b.type==='input').optional,true);
 assert.equal(noteView(ticket).blocks.find(b=>b.type==='input').optional,false);
 assert.ok(JSON.stringify(ticketBlocks(ticket)).includes('ticket_note'));
 assert.ok(!JSON.stringify(ticketBlocks({...ticket,status:'Resolved'})).includes('ticket_note'));
 const history=historyView(ticket,[{payload:{kind:'note',actorId:'U2',status:'In progress',note:'<@U123> <!channel>'}}]);
 assert.ok(JSON.stringify(history).includes('<!channel>'));
 assert.equal(history.blocks.at(-1).text.type,'plain_text');
});
test('thread progress notes render plain text and do not produce false status changes',async t=>{
 const f=fixture(t);const ticket=f.db.update({id:f.ticket.id,workspaceId:'T1',version:2,actorId:'U2',actionId:'start',status:'In progress'});
 await f.manager.addNote({userId:'U2',workspaceId:'T1',id:ticket.id,version:ticket.version,actionId:'note',note:'<!channel> update'});
 const posts=[];const client={chat:{postMessage:async p=>{posts.push(p);return {ok:true,ts:'456.000001'};},update:async()=>({ok:true})}};
 await new Delivery({db:f.db,client,internalChannelId:'CSTAFF',permissions:{validateInternalChannel:async()=>true}}).flush();
 const post=posts.at(-1);assert.equal(post.channel,'CSTAFF');assert.match(post.text,/progress note/i);assert.ok(!JSON.stringify(posts.filter(p=>p.channel==='C1')).includes('<!channel>'));assert.equal(post.blocks.at(-1).text.type,'plain_text');
 assert.equal(post.blocks.at(-1).text.text,'<!channel> update');
});
test('stale progress submissions cannot attach notes to a ticket changed by someone else',async t=>{
 const f=fixture(t);const ticket=f.db.update({id:f.ticket.id,workspaceId:'T1',version:2,actorId:'U2',actionId:'start',status:'In progress'});
 f.db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'U2',actionId:'resolve',status:'Resolved'});
 await assert.rejects(f.manager.addNote({userId:'U2',workspaceId:'T1',id:ticket.id,version:ticket.version,actionId:'stale',note:'Too late'}),/Stale/);
 assert.equal(f.db.history(ticket.id,'T1').length,3);
});
