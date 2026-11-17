import test from 'node:test';
import assert from 'node:assert/strict';
import { withUserNames } from '../src/user-names.js';
import { ticketBlocks } from '../src/ticket-views.js';
const ticket={id:1,label:'T-000001',channelId:'C1',workspaceId:'T1',messageTs:'123.000001',status:'Open',assigneeId:'U1',reporterId:'U2',version:1};
test('staff metadata uses display names without sending mentions',async()=>{
 const client={users:{info:async({user})=>({ok:true,user:{id:user,profile:{display_name:user==='U1'?'JoEasyCompute':'Customer Alice'}}})}};
 const named=await withUserNames(ticket,client);
 const blocks=ticketBlocks(named);const metadata=blocks.find(b=>b.type==='context').elements[0];
 assert.match(metadata.text,/Owner: JoEasyCompute/);assert.match(metadata.text,/Reported by: Customer Alice/);
 assert.equal(metadata.type,'plain_text');assert.ok(!metadata.text.includes('U1'));assert.equal(named.assigneeId,'U1');
});
test('lookup failures retain the ID and unassigned tickets stay labelled Unassigned',async()=>{
 const client={users:{info:async()=>{throw new Error('unavailable');}}};
 const named=await withUserNames({...ticket,assigneeId:null},client);
 assert.match(JSON.stringify(ticketBlocks(named)),/Owner: Unassigned/);assert.equal(named.reporterName,'U2');
});
test('name lookups reuse successful profiles and never confuse different clients',async()=>{
 let calls=0;const client={users:{info:async({user})=>{calls++;return {ok:true,user:{id:user,real_name:'A name'}};}}};
 await withUserNames(ticket,client);await withUserNames(ticket,client);assert.equal(calls,2);
 const other={users:{info:async({user})=>({ok:true,user:{id:user,name:'Another name'}})}};
 assert.equal((await withUserNames(ticket,other)).assigneeName,'Another name');
});
