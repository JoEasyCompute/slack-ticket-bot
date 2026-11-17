import test from 'node:test';
import assert from 'node:assert/strict';
import { Permissions } from '../src/permissions.js';
import { TicketManager } from '../src/management.js';

function fixture(channelCount) {
 const channelIds = Array.from({ length: channelCount }, (_, i) => `C${i}`);
 const calls = { users: 0, groups: 0, members: 0 };
 const state = { staff: true, coordinator: true, fail: false };
 const client = {
  users: { info: async () => { calls.users++; return { ok: true, user: { id: 'U1', team_id: 'T1' } }; } },
  usergroups: { users: { list: async ({ usergroup }) => {
   calls.groups++;
   if (state.fail) throw new Error('Lookup failed');
   return { ok: true, users: (usergroup === 'SCOORD' ? state.coordinator : state.staff) ? ['U1'] : [] };
  } } },
  conversations: { members: async () => { calls.members++; return { ok: true, members: state.staff ? ['U1'] : [] }; } }
 };
 const permissions = new Permissions({ client, workspaceId: 'T1', internalChannelId: 'CSTAFF', coordinatorGroupId: 'SCOORD', supportGroupId: 'SSUPPORT', channelIds });
 const tickets = [...channelIds, 'CUNMONITORED'].map((channelId, i) => ({ id: i + 1, label: `T-${i}`, channelId, title: channelId === 'CUNMONITORED' ? 'HIDDEN' : 'Issue', status: 'Open' }));
 const manager = new TicketManager({ db: { list: () => tickets }, permissions, workspaceId: 'T1' });
 return { manager, calls, state };
}

test('Home permission calls stay constant across source channels and exclude unmonitored tickets', async () => {
 for (const count of [1, 10, 30]) {
  const f = fixture(count);
  const view = JSON.stringify(await f.manager.home('U1', { filter: 'all' }));
  assert.match(view, new RegExp(`${count} visible tickets`));
  assert.ok(!view.includes('HIDDEN'));
  assert.ok(view.includes('ticket_assign'));
  assert.deepEqual(f.calls, { users: 1, groups: 2, members: 1 });
 }
});

test('Home refresh rechecks staff and coordinator membership without caching across requests', async () => {
 const f = fixture(2);
 assert.match(JSON.stringify(await f.manager.home('U1', { filter: 'all' })), /ticket_assign/);
 f.state.coordinator = false;
 const supportView = JSON.stringify(await f.manager.home('U1', { filter: 'all' }));
 assert.match(supportView, /2 visible tickets/);
 assert.ok(!supportView.includes('ticket_assign'));
 f.state.staff = false;
 assert.match(JSON.stringify(await f.manager.home('U1', { filter: 'all' })), /0 visible tickets/);
});

test('Home permission lookup failure hides ticket data and assignment controls', async () => {
 const f = fixture(2);
 f.state.fail = true;
 const view = JSON.stringify(await f.manager.home('U1', { filter: 'all' }));
 assert.match(view, /0 visible tickets/);
 assert.ok(!view.includes('Issue'));
 assert.ok(!view.includes('ticket_assign'));
});
