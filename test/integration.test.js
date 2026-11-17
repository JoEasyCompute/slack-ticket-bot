import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketDatabase } from '../src/database.js';
import { TicketManager } from '../src/management.js';
import { Delivery } from '../src/delivery.js';
test('create, assign, progress, resolve and reopen persist history and deliver updates',async t=>{
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 const permissions={canView:async()=>true,assertAssign:async()=>{},assertStatus:async()=>{},eligibleAssignees:async()=>[{id:'U2'}]};
 const manager=new TicketManager({db,permissions,workspaceId:'T1'});let ticket=db.create({workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Issue',internalChannelId:'CSTAFF'});
 const posts=[],updates=[];const client={chat:{postMessage:async p=>{posts.push(p);return {ok:true,ts:`456.${String(posts.length).padStart(6,'0')}`};},update:async p=>{updates.push(p);return {ok:true};}}};
 const delivery=new Delivery({db,client,internalChannelId:'CSTAFF',permissions:{validateInternalChannel:async()=>true}});await delivery.flush();
 for(const change of [{assigneeId:'U2'},{status:'In progress'},{status:'Resolved'},{status:'Open'}]){
  ticket=await manager.change({workspaceId:'T1',userId:'UCOORD',id:ticket.id,version:ticket.version,actionId:`a${ticket.version}`,...change});await delivery.flush();
 }
 assert.equal(ticket.status,'Open');assert.equal(ticket.assigneeId,'U2');assert.equal(db.history(ticket.id,'T1').length,4);
 const customerPosts=posts.filter(p=>p.channel==='C1');assert.equal(customerPosts.length,4);assert.equal(updates.length,8);assert.ok(customerPosts.slice(1).every(post=>post.text.includes('Status changed')));assert.equal(posts.filter(p=>p.channel==='CSTAFF').length,5);
 assert.equal(db.pendingOutbox().length,0);
});
test('unrelated tickets continue when one channel rejects delivery',async t=>{
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 for(const channelId of ['CFAIL','COK'])db.create({workspaceId:'T1',channelId,messageTs:'123.000001',reporterId:'U1',title:'Issue',internalChannelId:'CSTAFF'});
 const sent=[];const client={chat:{postMessage:async p=>{if(p.channel==='CFAIL')throw Object.assign(new Error('denied'),{code:'slack_webapi_platform_error',data:{error:'not_in_channel'}});sent.push(p.channel);return {ok:true,ts:'456.000001'};}}};
 const delivery=new Delivery({db,client,logger:{error(){}}});await delivery.flush();assert.deepEqual(sent,['COK']);
});
test('untrusted extra fields cannot override the authorized actor or target',async t=>{
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());const ticket=db.create({workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Issue',internalChannelId:'CSTAFF'});
 const permissions={canView:async()=>true,assertStatus:async()=>{}};const manager=new TicketManager({db,permissions,workspaceId:'T1'});
 await manager.change({userId:'UREAL',workspaceId:'T1',id:ticket.id,version:1,actionId:'a',status:'Resolved',actorId:'UFAKE'});
 assert.equal(db.history(ticket.id,'T1')[0].actorId,'UREAL');
});

test('assignment, reassignment and clearing are audited without thread announcements',async t=>{
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 let ticket=db.create({workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Issue',internalChannelId:'CSTAFF'});
 const posts=[];const delivery=new Delivery({db,internalChannelId:'CSTAFF',permissions:{validateInternalChannel:async()=>true},client:{chat:{postMessage:async p=>{posts.push(p);return {ok:true,ts:'456.000001'};},update:async()=>({ok:true})}}});
 await delivery.flush();
 for(const assigneeId of ['U2','U3',null]){
  ticket=db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'UC',actionId:`assign${ticket.version}`,assigneeId});
  await delivery.flush();
 }
 assert.equal(posts.filter(p=>p.channel==='C1').length,1);assert.equal(db.history(ticket.id,'T1').length,3);assert.equal(db.pendingOutbox().length,0);
 // Reopening may also clear an ineligible owner: publish status, never assignment details.
 ticket=db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'UC',actionId:'resolve',status:'Resolved',assigneeId:'U2'});await delivery.flush();
 ticket=db.update({id:ticket.id,workspaceId:'T1',version:ticket.version,actorId:'UC',actionId:'reopen',status:'Open',assigneeId:null,note:'Retry needed'});await delivery.flush();
 const customerPosts=posts.filter(p=>p.channel==='C1');assert.match(customerPosts.at(-1).text,/Status changed to Open/);assert.ok(!JSON.stringify(customerPosts).includes('Retry needed'));assert.ok(JSON.stringify(posts.filter(p=>p.channel==='CSTAFF')).includes('Retry needed'));
 assert.ok(!posts.filter(p=>p.channel==='C1').slice(1).some(p=>/assigned this ticket|cleared the assignment/.test(p.text)));
});
