import test from 'node:test';
import assert from 'node:assert/strict';
import { Permissions } from '../src/permissions.js';

function setup() {
  const groups = { SCOORD: ['UCOORD'], SSUPPORT: ['UOWNER', 'UOTHER', 'UBOT', 'UDEAD'] };
  let channelMembers = ['UCOORD', 'UOWNER', 'UOTHER', 'UBOT', 'UDEAD'];
  const calls = [];
  let internalMembers = ['UCOORD', 'UOWNER', 'UOTHER', 'UBOT', 'UDEAD'];
  const userOverrides = {};
  const channelInfo = { id: 'GINTERNAL', is_private: true, is_shared: false, is_ext_shared: false, is_org_shared: false, is_member: true };
  const client = {
    conversations: { members: async args => {
      calls.push(args);
      if (args.channel === 'GINTERNAL') return { ok: true, members: internalMembers, response_metadata: {} };
      return args.cursor ? { ok: true, members: channelMembers.slice(2), response_metadata: {} }
        : { ok: true, members: channelMembers.slice(0, 2), response_metadata: { next_cursor: 'page2' } };
    }, info: async () => ({ ok: true, channel: channelInfo }) },
    usergroups: { users: { list: async ({ usergroup }) => ({ ok: true, users: groups[usergroup] || [] }) } },
    users: { info: async ({ user }) => ({ ok: true, user: { id: user, name: user, team_id: 'TOWN', ...userOverrides[user], is_bot: user === 'UBOT', deleted: user === 'UDEAD' } }) }
  };
  const permissions = new Permissions({ client, coordinatorGroupId: 'SCOORD', supportGroupId: 'SSUPPORT', channelIds: ['CONE'], workspaceId: 'TOWN', internalChannelId: 'GINTERNAL' });
  return { permissions, client, groups, calls, userOverrides, channelInfo, setInternalMembers: users => { internalMembers = users; }, setMembers: users => { channelMembers = users; } };
}
const ticket = { channelId: 'CONE', assigneeId: 'UOWNER' };
test('reads every membership page and excludes unconfigured channels', async () => {
  const f = setup();
  assert.deepEqual(await f.permissions.members('CONE'), ['UCOORD','UOWNER','UOTHER','UBOT','UDEAD']);
  assert.equal(f.calls.length, 2);
  assert.equal(await f.permissions.canView('UOTHER', 'CONE'), true);
  assert.equal(f.calls.length, 3);
  assert.equal(await f.permissions.canView('UOTHER', 'COTHER'), false);
  assert.equal(f.calls.length, 3);
});
test('membership API failures deny visibility', async () => {
  const f = setup();
  f.client.conversations.members = async () => { throw new Error('private secret'); };
  assert.equal(await f.permissions.canView('UOWNER', 'CONE'), false);
  await assert.rejects(f.permissions.assertStatus('UOWNER', ticket), error => !error.message.includes('secret'));
});
test('eligible assignees intersect support group, channel and active human users', async () => {
  const f = setup();
  const eligible = await f.permissions.eligibleAssignees('CONE');
  assert.deepEqual(eligible.map(user => user.id), ['UOWNER', 'UOTHER']);
  f.setMembers(['UCOORD']);
  assert.deepEqual(await f.permissions.eligibleAssignees('CONE'), []);
});
test('only coordinators with channel access assign or clear eligible owners', async () => {
  const f = setup();
  await f.permissions.assertAssign('UCOORD', ticket, 'UOTHER');
  await f.permissions.assertAssign('UCOORD', ticket, null);
  await assert.rejects(f.permissions.assertAssign('UOWNER', ticket, 'UOTHER'));
  await assert.rejects(f.permissions.assertAssign('UCOORD', ticket, 'UOUTSIDER'));
  f.setMembers(['UOWNER']);
  await assert.rejects(f.permissions.assertAssign('UCOORD', ticket, null));
});
test('status changes require coordinator or assigned support member in the channel', async () => {
  const f = setup();
  await f.permissions.assertStatus('UOWNER', ticket);
  await f.permissions.assertStatus('UCOORD', ticket);
  await assert.rejects(f.permissions.assertStatus('UOTHER', ticket));
  f.groups.SSUPPORT = [];
  await assert.rejects(f.permissions.assertStatus('UOWNER', ticket));
  f.groups.SCOORD = [];
  await assert.rejects(f.permissions.assertStatus('UCOORD', ticket));
});
test('failed group/user lookups never produce an eligible assignment', async () => {
  const f = setup();
  f.client.usergroups.users.list = async () => ({ ok: false });
  assert.equal(await f.permissions.isCoordinator('UCOORD'), false);
  await assert.rejects(f.permissions.assertAssign('UCOORD', ticket, 'UOWNER'));
  const g = setup();
  g.client.users.info = async () => { throw new Error('lookup failed'); };
  await assert.rejects(g.permissions.eligibleAssignees('CONE'), /verify/);
});

test('staff access requires own-workspace full member, role and internal membership', async () => {
  for (const override of [{ team_id: 'TEXTERNAL' }, { team_id: undefined }, { is_restricted: true }, { is_ultra_restricted: true }, { is_stranger: true }]) {
    const f = setup();
    f.userOverrides.UOWNER = override;
    assert.equal(await f.permissions.isStaff('UOWNER'), false);
    assert.equal(await f.permissions.canView('UOWNER', 'CONE'), false);
  }
  const f = setup();
  f.setInternalMembers(['UCOORD']);
  assert.equal(await f.permissions.isStaff('UOWNER'), false);
  assert.equal(await f.permissions.isCoordinator('UCOORD'), true);
  f.userOverrides.UCOORD = { is_restricted: true };
  assert.equal(await f.permissions.isCoordinator('UCOORD'), false);
});
test('internal delivery rejects shared, public, mismatched and nonmember channels', async () => {
  for (const change of [{ is_private: false }, { is_shared: true }, { is_ext_shared: true }, { is_org_shared: true }, { pending_shared: ['TOTHER'] }, { is_member: false }, { id: 'CWRONG' }]) {
    const f = setup();
    Object.assign(f.channelInfo, change);
    await assert.rejects(f.permissions.validateInternalChannel(), /verify/);
  }
});
test('internal delivery validates every member, allowing own-workspace bots only', async () => {
  const f = setup();
  await f.permissions.validateInternalChannel();
  f.userOverrides.UOTHER = { is_stranger: true };
  await assert.rejects(f.permissions.validateInternalChannel(), /verify/);
  delete f.userOverrides.UOTHER;
  f.userOverrides.UBOT = { team_id: 'TEXTERNAL' };
  await assert.rejects(f.permissions.validateInternalChannel(), /verify/);
});
test('internal channel rejects a local member outside both staff groups',async()=>{
 const f=setup();f.setInternalMembers(['UCOORD','UOWNER','UUNAUTHORIZED']);
 await assert.rejects(f.permissions.validateInternalChannel(),/verify/);
});
test('authorized staff can see all customer tickets without source membership',async()=>{
 const f=setup();f.setMembers([]);
 assert.equal(await f.permissions.canView('UOTHER','CONE'),true);
 await f.permissions.validateInternalChannel();
 await assert.rejects(f.permissions.assertStatus('UOWNER',ticket));
 await assert.rejects(f.permissions.assertAssign('UCOORD',ticket,null));
 assert.deepEqual(await f.permissions.eligibleAssignees('CONE'),[]);
});
