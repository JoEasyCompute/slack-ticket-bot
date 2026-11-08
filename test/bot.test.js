import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../src/bot.js';
import { FileStore } from '../src/store.js';
import { readConfig } from '../src/config.js';

const event = { type: 'reaction_added', reaction: 'ticket', user: 'U2', item: { type: 'message', channel: 'C123ABC', ts: '1234567890.123456' } };
async function fixture(t, { message = {}, post } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-bot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = [];
  const client = {
    reactions: { get: async () => ({ ok: true, message: { user: 'U1', ts: event.item.ts, ...message } }) },
    chat: { postMessage: async payload => { sent.push(payload); if (post) return post(payload); return { ok: true, ts: '999.000001' }; } }
  };
  const store = new FileStore(dir);
  const handler = createHandler({ channelId: 'C123ABC', client, store });
  return { handler, client, store, sent, dir };
}
test('posts the receipt in the reported message thread', async t => {
  const f = await fixture(t);
  assert.equal(await f.handler(event), 'sent');
  assert.equal(f.sent[0].thread_ts, event.item.ts);
  assert.equal(f.sent[0].channel, 'C123ABC');
  assert.equal(f.sent[0].text, 'Thanks for reporting this. Your issue has been received.');
  assert.equal(f.sent[0].reply_broadcast, false);
});
test('ignores wrong emoji, channel, non-message and malformed events', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { ...event, reaction: 'white_check_mark' }, { ...event, item: { ...event.item, channel: 'COTHER' } }, { ...event, item: { type: 'file' } }, { ...event, item: { ...event.item, ts: '../../escape' } }]) {
    assert.equal(await f.handler(value), 'ignored');
  }
  assert.equal(f.sent.length, 0);
});
test('ignores bot posts and replies within existing threads', async t => {
  for (const message of [{ bot_id: 'B1' }, { subtype: 'bot_message' }, { thread_ts: '111.000001' }]) {
    const f = await fixture(t, { message });
    assert.equal(await f.handler(event), 'ignored');
    assert.equal(f.sent.length, 0);
  }
});
test('concurrent reactions produce one receipt, including after restart', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, () => f.handler(event)));
  const restarted = createHandler({ channelId: 'C123ABC', client: f.client, store: new FileStore(f.dir) });
  assert.equal(await restarted(event), 'duplicate');
  assert.equal(f.sent.length, 1);
  const files = await readdir(f.dir);
  const record = JSON.parse(await readFile(join(f.dir, files[0]), 'utf8'));
  assert.equal(record.status, 'sent');
});
test('explicit Slack rejection can be retried by another reaction', async t => {
  let fail = true;
  const f = await fixture(t, { post: async () => {
    if (fail) throw Object.assign(new Error('rejected'), { code: 'slack_webapi_platform_error', data: { error: 'not_in_channel' } });
    return { ok: true, ts: '999.000001' };
  } });
  await assert.rejects(f.handler(event), /rejected/);
  fail = false;
  assert.equal(await f.handler(event), 'sent');
});
test('ambiguous timeout retains pending claim across restart', async t => {
  const f = await fixture(t, { post: async () => { throw new Error('timeout'); } });
  await assert.rejects(f.handler(event), /timeout/);
  const restarted = createHandler({ channelId: 'C123ABC', client: f.client, store: new FileStore(f.dir) });
  assert.equal(await restarted(event), 'duplicate');
  assert.equal(f.sent.length, 1);
  const files = await readdir(f.dir);
  assert.equal(JSON.parse(await readFile(join(f.dir, files[0]), 'utf8')).status, 'pending');
});
test('internal Slack errors retain claims because side effects may have occurred', async t => {
  const f = await fixture(t, { post: async () => { throw Object.assign(new Error('internal'), { code: 'slack_webapi_platform_error', data: { error: 'internal_error' } }); } });
  await assert.rejects(f.handler(event));
  assert.equal(await f.handler(event), 'duplicate');
});
test('read failures do not reserve the message', async t => {
  const f = await fixture(t);
  f.client.reactions.get = async () => { throw new Error('read failed'); };
  await assert.rejects(f.handler(event), /read failed/);
  assert.deepEqual(await readdir(f.dir), []);
});
test('validates required settings without revealing token values', () => {
  assert.throws(() => readConfig({}), /SLACK_BOT_TOKEN/);
  const env = { SLACK_BOT_TOKEN: 'xoxb-example', SLACK_APP_TOKEN: 'xapp-example', SLACK_CHANNEL_ID: 'C123ABC' };
  assert.equal(readConfig(env).reaction, 'ticket');
  assert.equal(readConfig(env).channelId, 'C123ABC');
  assert.throws(() => readConfig({ ...env, SLACK_CHANNEL_ID: '#support' }), /SLACK_CHANNEL_ID/);
});
test('rate-limited posts wait and retry without duplicating the receipt', async t => {
  let calls = 0;
  const f = await fixture(t, { post: async () => {
    if (calls++ === 0) throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 2 });
    return { ok: true, ts: '999.000001' };
  } });
  const waits = [];
  const handle = createHandler({ channelId: 'C123ABC', client: f.client, store: f.store, sleep: async ms => waits.push(ms) });
  assert.equal(await handle(event), 'sent');
  assert.deepEqual(waits, [2000]);
  assert.equal(calls, 2);
  assert.equal(await handle(event), 'duplicate');
});
test('comma-separated channels are trimmed, deduplicated and validated', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-example', SLACK_APP_TOKEN: 'xapp-example', SLACK_CHANNEL_IDS: ' C123ABC, G456DEF,C123ABC ' };
  assert.deepEqual(readConfig(env).channelIds, ['C123ABC', 'G456DEF']);
  assert.throws(() => readConfig({ ...env, SLACK_CHANNEL_IDS: 'C123ABC,#support' }), /SLACK_CHANNEL_IDS/);
  assert.throws(() => readConfig({ ...env, SLACK_CHANNEL_IDS: 'C123ABC,' }), /SLACK_CHANNEL_IDS/);
  assert.throws(() => readConfig({ ...env, SLACK_CHANNEL_IDS: ' ' }), /SLACK_CHANNEL_IDS/);
  assert.deepEqual(readConfig({ ...env, SLACK_CHANNEL_ID: 'CLEGACY' }).channelIds, ['C123ABC', 'G456DEF']);
});
test('legacy single-channel environment remains supported', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-example', SLACK_APP_TOKEN: 'xapp-example', SLACK_CHANNEL_ID: 'C123ABC' };
  assert.deepEqual(readConfig(env).channelIds, ['C123ABC']);
});
test('multiple monitored channels keep receipts separate and ignore unlisted channels', async t => {
  const f = await fixture(t);
  const handle = createHandler({ channelIds: ['C123ABC', 'CSECOND'], client: f.client, store: f.store });
  const second = { ...event, item: { ...event.item, channel: 'CSECOND' } };
  assert.equal(await handle(event), 'sent');
  assert.equal(await handle(second), 'sent');
  assert.equal(await handle(second), 'duplicate');
  assert.equal(await handle({ ...event, item: { ...event.item, channel: 'COTHER' } }), 'ignored');
  assert.deepEqual(f.sent.map(p => p.channel), ['C123ABC', 'CSECOND']);
});
