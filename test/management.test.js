import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketBlocks, homeView, assignmentView } from '../src/ticket-views.js';
import { TicketManager } from '../src/management.js';
const ticket = { id: 1, label: 'T-000001', workspaceId: 'T1', channelId: 'C1', messageTs: '123.000001', reporterId: 'U1', title: '<@everyone> issue', assigneeId: null, status: 'Open', version: 1 };
test('ticket text is plain text and action values bind to ticket version', () => {
 const blocks = ticketBlocks(ticket, { showAssignment: true });
 assert.ok(blocks.some(b => b.type === 'section' && b.text.type === 'plain_text' && b.text.text.includes('<@everyone>')));
 assert.match(JSON.stringify(blocks), /ticket_assign/);
 assert.equal(blocks.find(b => b.type === 'actions').elements[0].value, '1:1');
});
test('Home paginates only supplied visible tickets and has no hidden counts', () => {
 const view = homeView(Array.from({length: 25}, (_, i) => ({...ticket,id:i+1})), {page:1, filter:'all', status:'active'});
 assert.equal(view.type,'home');
 assert.ok(view.blocks.length < 100);
 assert.match(JSON.stringify(view), /25 visible/);
});
test('assignment modal uses external options so large support teams fit Slack limits', () => {
 const view = assignmentView(ticket);
 assert.equal(view.callback_id,'ticket_assign_submit');
 assert.equal(view.blocks.find(b=>b.type==='input').element.type,'external_select');
});
function fixture() {
 const updates=[];
 const db={ get:(id,w)=> id===1 && w==='T1'?ticket:null, list:()=>[ticket,{...ticket,id:2,channelId:'CPRIVATE',title:'SECRET'}], update: args=>{updates.push(args);return {...ticket,...args};}, history:()=>[] };
 const permissions={canView:async(u,c)=>c==='C1', assertAssign:async()=>{}, assertStatus:async()=>{}, eligibleAssignees:async()=>[], isCoordinator:async()=>false};
 return {db, permissions, updates, manager:new TicketManager({db,permissions,workspaceId:'T1'})};
}
test('Home filters inaccessible channels before rendering', async()=>{
 const f=fixture(); const view=await f.manager.home('U1',{filter:'all'});
 assert.ok(!JSON.stringify(view).includes('SECRET'));
 assert.match(JSON.stringify(view),/1 visible/);
});
test('forged workspace or inaccessible tickets cannot be changed',async()=>{
 const f=fixture(); await assert.rejects(f.manager.change({userId:'U1',workspaceId:'OTHER',id:1,version:1,status:'Resolved',actionId:'a'}));
 f.permissions.assertStatus=async()=>{throw new Error('Not permitted');};
 await assert.rejects(f.manager.change({userId:'U1',workspaceId:'T1',id:1,version:1,status:'Resolved',actionId:'a'}));
 assert.equal(f.updates.length,0);
});
test('status and assignment permissions are checked independently',async()=>{
 const f=fixture(); let assignChecks=0;
 f.permissions.assertAssign=async()=>{assignChecks++;throw new Error('Coordinator required');};
 await assert.rejects(f.manager.change({userId:'U1',workspaceId:'T1',id:1,version:1,assigneeId:'U2',actionId:'a'}));
 assert.equal(assignChecks,1);assert.equal(f.updates.length,0);
});
test('history renders saved nested change details', async()=>{
 const {historyView}=await import('../src/ticket-views.js');
 const view=historyView(ticket,[{createdAt:'2026-11-08',payload:{actorId:'UCOORD',status:'In progress',assigneeId:'UOWNER'}}]);
 assert.match(JSON.stringify(view),/In progress/);assert.match(JSON.stringify(view),/UOWNER/);
});

test('shared cards have status controls but no assignment control',()=>{
 const blocks=JSON.stringify(ticketBlocks({...ticket,status:'In progress'}));
 assert.ok(!blocks.includes('ticket_assign'));assert.ok(blocks.includes('ticket_status'));assert.ok(blocks.includes('ticket_note'));
});
test('Home assignment controls depend on current coordinator membership',async()=>{
 const f=fixture();
 assert.ok(!JSON.stringify(await f.manager.home('U1',{filter:'all',showAssignment:true})).includes('ticket_assign'));
 f.permissions.isCoordinator=async()=>true;
 assert.ok(JSON.stringify(await f.manager.home('U1',{filter:'all'})).includes('ticket_assign'));
 f.permissions.isCoordinator=async()=>false;
 assert.ok(!JSON.stringify(await f.manager.home('U1',{filter:'all'})).includes('ticket_assign'));
});
