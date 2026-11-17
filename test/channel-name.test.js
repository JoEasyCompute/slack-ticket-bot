import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketDatabase } from '../src/database.js';
import { ticketBlocks, customerBlocks, homeView } from '../src/ticket-views.js';
const source={workspaceId:'T1',channelId:'C1',messageTs:'123.000001',reporterId:'U1',title:'Printer offline'};
test('staff cards and Home show the source name without exposing extra customer data',()=>{
 const ticket={...source,id:1,label:'T-000001',version:1,status:'Open',channelName:'customer-acme'};
 assert.match(JSON.stringify(ticketBlocks(ticket)),/Source: #customer-acme/);
 assert.match(JSON.stringify(homeView([ticket])),/Source: #customer-acme/);
 assert.ok(!JSON.stringify(customerBlocks(ticket)).includes('Source:'));
 assert.match(JSON.stringify(ticketBlocks({...ticket,channelName:null})),/Source: C1/);
});
test('source names can be populated for old tickets and updated after renames',t=>{
 const db=new TicketDatabase(':memory:');t.after(()=>db.close());
 const old=db.create(source);const current=db.create({...source,messageTs:'124.000001',channelName:'customer-acme'});
 assert.equal(db.get(current.id,'T1').channelName,'customer-acme');
 db.setChannelName('T1','C1','customer-renamed');
 assert.equal(db.get(old.id,'T1').channelName,'customer-renamed');
 assert.equal(db.get(current.id,'T1').channelName,'customer-renamed');
 db.setChannelName('TOTHER','C1','wrong-customer');assert.equal(db.get(old.id,'T1').channelName,'customer-renamed');
});
