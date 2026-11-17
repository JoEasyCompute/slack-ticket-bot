import test from 'node:test';
import assert from 'node:assert/strict';
import { Delivery } from '../src/delivery.js';
function fixture(post) {
 const rows=[{id:1,ticketId:1,workspaceId:'T1',kind:'card',payload:{}}];
 const ticket={id:1,label:'T-000001',workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Test',status:'Open',version:1};
 const events=[];
 const db={pendingOutbox:()=>rows.filter(r=>!r.state),get:()=>ticket,beginOutbox:id=>{rows[0].state='sending';events.push('begin');return true;},setCard:(id,w,ts)=>{ticket.cardTs=ts;events.push('saved');},completeOutbox:()=>{rows[0].state='done';events.push('complete');},failOutbox:(id,e,{retryable}={})=>{rows[0].state=retryable?undefined:'blocked';}};
 const client={chat:{postMessage:post,update:async()=>({ok:true})}};
 return {delivery:new Delivery({db,client}),db,events,rows};
}
test('delivery persists a claim before sending and saves the returned card timestamp',async()=>{
 const f=fixture(async()=>{assert.deepEqual(f.events,['begin']);return {ok:true,ts:'456.000001'};});
 await f.delivery.flush();assert.deepEqual(f.events,['begin','saved','complete']);
});
test('ambiguous delivery is blocked and never automatically reposted',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw new Error('timeout');});
 await f.delivery.flush();await f.delivery.flush();assert.equal(calls,1);assert.equal(f.rows[0].state,'blocked');
});
test('later queued updates never bypass an uncertain earlier delivery for that ticket',async()=>{
 const f=fixture(async()=>({ok:true,ts:'456.000001'}));
 f.db.outboxRecords=()=>[{id:0,ticketId:1,workspaceId:'T1',state:'blocked'},...f.rows];
 await f.delivery.flush();assert.deepEqual(f.events,[]);
});
function privateFixture(kind, payload = {}, { privateChannel = true } = {}) {
 const rows=[{id:1,ticketId:1,workspaceId:'T1',kind,payload,state:'queued'}];
 const ticket={id:1,label:'T-000001',workspaceId:'T1',channelId:'CCUSTOMER',internalChannelId:'GINTERNAL',internalCardTs:'888.001',messageTs:'123.000001',reporterId:'U1',title:'Issue',status:'In progress',assigneeId:'UAGENT',version:2};
 const sent=[];let checks=0;
 const db={pendingOutbox:()=>rows.filter(r=>r.state==='queued'),outboxRecords:()=>rows,get:()=>ticket,beginOutbox:id=>{const row=rows.find(r=>r.id===id);row.state='sending';return true;},completeOutbox:id=>{rows.find(r=>r.id===id).state='completed';},failOutbox:(id,e,{retryable})=>{rows.find(r=>r.id===id).state=retryable?'queued':'blocked';},setCard:()=>{},setInternalCard:()=>{}};
 const client={chat:{postMessage:async p=>{sent.push(p);return {ok:true,ts:'999.001'};},update:async p=>{sent.push(p);return {ok:true};}}};
 const permissions={validateInternalChannel:async()=>{checks++;if(!privateChannel)throw new Error('public');return true;}};
 return {sent,rows,ticket,checks:()=>checks,delivery:new Delivery({db,client,permissions,internalChannelId:'GINTERNAL',logger:{error(){}}})};
}
test('notes and legacy history are sent only to validated internal channel',async()=>{
 for(const kind of ['internal_history','history']) {
  const f=privateFixture(kind,{kind:'note',note:'PRIVATE diagnostic',actorId:'UAGENT',status:'In progress'});
  await f.delivery.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,'GINTERNAL');assert.equal(f.sent[0].thread_ts,'888.001');assert.equal(f.checks(),1);
 }
});
test('internal posts fail closed if private-channel validation fails',async()=>{
 const f=privateFixture('internal_history',{kind:'note',note:'SECRET'},{privateChannel:false});
 await f.delivery.flush();assert.equal(f.sent.length,0);assert.equal(f.rows[0].state,'queued');
});
test('customer status omits internal note, owner and actor',async()=>{
 const f=privateFixture('customer_status',{status:'Resolved',note:'SECRET',actorId:'UAGENT',assigneeId:'UAGENT'});
 await f.delivery.flush();assert.equal(f.sent[0].channel,'CCUSTOMER');assert.equal(f.sent[0].thread_ts,'123.000001');assert.doesNotMatch(JSON.stringify(f.sent),/SECRET|UAGENT/);
});
test('explicit customer reply posts only approved reply text to source thread',async()=>{
 const f=privateFixture('customer_reply',{kind:'reply',note:'Please restart the printer.'});
 await f.delivery.flush();assert.equal(f.sent[0].channel,'CCUSTOMER');assert.match(JSON.stringify(f.sent),/Please restart/);assert.equal(f.checks(),0);
});
test('customer cards omit assignment, internal notes and controls',async()=>{
 const f=privateFixture('card');
 await f.delivery.flush();const value=JSON.stringify(f.sent);assert.doesNotMatch(value,/UAGENT|ticket_assign|ticket_note|ticket_history|ticket_status/);
});
