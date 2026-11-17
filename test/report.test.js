import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TicketDatabase } from '../src/database.js';
import { FileStore } from '../src/store.js';
import { createReportHandler } from '../src/report.js';
import { readManagementConfig } from '../src/config.js';
const event={type:'reaction_added',reaction:'ticket',item:{type:'message',channel:'C1',ts:'123.000001'}};
test('report creates one managed ticket across concurrent reactions and preserves old receipts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'managed-report-'));const db=new TicketDatabase(join(dir,'tickets.sqlite'));t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const store=new FileStore(dir);let text='Issue';
 const client={reactions:{get:async()=>({ok:true,message:{user:'U1',ts:event.item.ts,text}})}};
 const handle=createReportHandler({db,client,store,workspaceId:'T1',channelIds:['C1']});
 await Promise.all(Array.from({length:10},()=>handle(event)));
 assert.equal(db.list('T1').length,1);assert.equal(db.pendingOutbox().length,1);
 const old={...event,item:{...event.item,ts:'124.000001'}};
 await writeFile(store.path('C1:124.000001'),'{}');await handle(old);assert.equal(db.list('T1').length,1);
 await handle({...event,reaction:'other'});assert.equal(db.list('T1').length,1);
});
test('management requires group settings and retains channel compatibility',()=>{
 const env={SLACK_BOT_TOKEN:'xoxb-example',SLACK_APP_TOKEN:'xapp-example',SLACK_CHANNEL_ID:'C1'};
 assert.throws(()=>readManagementConfig(env),/COORDINATOR_USERGROUP_ID/);
 assert.throws(()=>readManagementConfig({...env,COORDINATOR_USERGROUP_ID:'S1'}),/SUPPORT_USERGROUP_ID/);
 assert.equal(readManagementConfig({...env,COORDINATOR_USERGROUP_ID:'S1',SUPPORT_USERGROUP_ID:'S2',INTERNAL_SUPPORT_CHANNEL_ID:'CSTAFF'}).supportGroupId,'S2');
});
