import test from 'node:test';
import assert from 'node:assert/strict';
import { customerBlocks, ticketBlocks, noteView, replyView } from '../src/ticket-views.js';
import { TicketManager } from '../src/management.js';
const ticket={id:1,label:'T-000001',workspaceId:'T1',channelId:'C1',internalChannelId:'CSTAFF',messageTs:'123.000001',reporterId:'U1',assigneeId:'U2',title:'Customer issue',status:'In progress',version:3};
test('customer cards contain only customer-visible status and no management data or controls',()=>{
 const json=JSON.stringify(customerBlocks(ticket));
 for(const secret of ['ticket_assign','ticket_status','ticket_note','ticket_history','ticket_reply','U2','Owner:'])assert.ok(!json.includes(secret),secret);
 assert.match(json,/In progress/);assert.match(json,/T-000001/);
});
test('staff cards offer internal notes and explicitly public replies',()=>{
 const json=JSON.stringify(ticketBlocks(ticket));assert.match(json,/ticket_reply/);assert.match(json,/Internal note/);
 assert.match(JSON.stringify(noteView(ticket,'Resolved')),/not sent to the customer/i);
 const reply=replyView(ticket);assert.equal(JSON.parse(reply.private_metadata).kind,'reply');
 assert.match(JSON.stringify(reply),/customer/i);assert.equal(reply.blocks.find(b=>b.type==='input').optional,false);
});
test('explicit customer reply checks status-management permissions and scopes its data',async()=>{
 const updates=[];const permissions={canView:async()=>true,assertStatus:async()=>{throw new Error('Denied');}};
 const db={get:()=>ticket,update:args=>{updates.push(args);return ticket;}};
 const m=new TicketManager({db,permissions,workspaceId:'T1'});
 const input={userId:'U2',workspaceId:'T1',id:1,version:3,actionId:'reply1',note:'Public update',actorId:'UFORGED'};
 await assert.rejects(m.reply(input),/Denied/);assert.equal(updates.length,0);
 permissions.assertStatus=async()=>{};await m.reply(input);
 assert.equal(updates[0].kind,'reply');assert.equal(updates[0].actorId,'U2');assert.equal(updates[0].note,'Public update');
});
