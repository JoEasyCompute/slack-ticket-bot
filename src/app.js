import bolt from '@slack/bolt';
import { join } from 'node:path';
import { readManagementConfig } from './config.js';
import { FileStore } from './store.js';
import { TicketDatabase } from './database.js';
import { Permissions } from './permissions.js';
import { TicketManager } from './management.js';
import { Delivery } from './delivery.js';
import { createReportHandler } from './report.js';
import { assignmentView, loadingView, messageView, historyView, noteView, replyView, STATUSES } from './ticket-views.js';

process.umask(0o077);
const config = readManagementConfig();
const app = new bolt.App({ token: config.botToken, appToken: config.appToken, socketMode: true,
  clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000 }, deferInitialization: true });
const auth = await app.client.auth.test();
if (!auth.ok || !auth.team_id) throw new Error('Cannot identify Slack workspace');
const workspaceId = auth.team_id;
const db = new TicketDatabase(join(config.dataDir, 'tickets.sqlite'));
const permissions = new Permissions({ client: app.client, workspaceId, ...config });
// Validate configured groups before accepting work; no real token values are logged.
await permissions.group(config.coordinatorGroupId);
await permissions.group(config.supportGroupId);
await permissions.validateInternalChannel();
db.configureInternalChannel(workspaceId, config.internalChannelId);
const manager = new TicketManager({ db, permissions, workspaceId, client: app.client });
const delivery = new Delivery({ db, client: app.client, permissions, internalChannelId: config.internalChannelId });
const report = createReportHandler({ db, client: app.client, store: new FileStore(config.dataDir), workspaceId, ...config });
const assignmentOptions = new Map();
const actorWorkspace = body => body.team?.id || body.user?.team_id || body.team_id;
const validateWorkspace = body => { if (actorWorkspace(body) !== workspaceId) throw new Error('Workspace unavailable.'); };
const log = error => console.error(`Ticket operation failed: ${error.code || 'operation_failed'}`);
const privateError = async (userId, text = 'Unable to complete that action. Refresh and check your channel access and role, then try again.') => {
  await app.client.views.publish({ user_id: userId, view: { type: 'home', blocks: [
    { type: 'section', text: { type: 'plain_text', text } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Refresh tickets' }, action_id: 'home_refresh', value: '{}' }] }
  ] } });
};
const publishHome = async (userId, options) => app.client.views.publish({ user_id: userId, view: await manager.home(userId, options) });
const safeError = async (body, error) => { log(error); try { await privateError(body.user.id); } catch (failure) { log(failure); } };

app.event('reaction_added', async ({ event, body }) => {
  if (body.team_id !== workspaceId) return;
  try { await report(event); await delivery.flush(); } catch (error) { log(error); }
});
app.event('app_home_opened', async ({ event, body }) => {
  if (body.team_id !== workspaceId || event.tab !== 'home') return;
  try { await publishHome(event.user); } catch (error) { log(error); await privateError(event.user); }
});
// Acknowledge first, then do membership/API work. Every read and write is scoped to the authenticated workspace.
app.action(/^home_/, async ({ ack, body, action }) => {
  await ack();
  try {
    validateWorkspace(body);
    let options;
    if (action.action_id === 'home_status') options = { ...JSON.parse(body.view?.private_metadata || '{}'), status: action.selected_option.value, page: 0 };
    else options = JSON.parse(action.value || '{}');
    await publishHome(body.user.id, options);
  } catch (error) { await safeError(body, error); }
});
app.action('ticket_source', async ({ ack }) => { await ack(); });
app.action('ticket_assign', async ({ ack, body, action }) => {
  await ack();
  let viewId;
  try {
    validateWorkspace(body);
    const opened = await app.client.views.open({ trigger_id: body.trigger_id, view: loadingView() });
    viewId = opened.view.id;
    const [id, version] = action.value.split(':').map(Number);
    const ticket = await manager.ticket(body.user.id, id);
    await permissions.assertAssign(body.user.id, ticket, null);
    if (ticket.version !== version) throw new Error('Stale ticket. Refresh before assigning.');
    const users = await permissions.eligibleAssignees(ticket.channelId);
    for (const [key, value] of assignmentOptions) if (value.expires < Date.now()) assignmentOptions.delete(key);
    assignmentOptions.set(`${body.user.id}:${viewId}`, { users, expires: Date.now() + 60000 });
    await app.client.views.update({ view_id: viewId, view: assignmentView(ticket) });
  } catch (error) {
    log(error);
    if (viewId) await app.client.views.update({ view_id: viewId, view: messageView('Assignment unavailable. Check your coordinator role and channel membership, then refresh the ticket.') });
    else await safeError(body, error);
  }
});
app.options('assignee', async ({ ack, body }) => {
  let options = [];
  try {
    validateWorkspace(body);
    const lookup = async () => {
      const meta = JSON.parse(body.view.private_metadata);
      const ticket = await manager.ticket(body.user.id, meta.id, meta.workspaceId);
      await permissions.assertAssign(body.user.id, ticket, null);
      const cached = assignmentOptions.get(`${body.user.id}:${body.view.id}`);
      if (!cached || cached.expires < Date.now()) return [];
      const users = cached.users;
      const query = String(body.value || '').toLowerCase();
      const eligible = users.map(user => ({ text: { type: 'plain_text', text: `${user.profile?.display_name || user.real_name || user.name || user.id} (${user.id})`.slice(0, 75) }, value: user.id }));
      return [{ text: { type: 'plain_text', text: 'Unassigned' }, value: '__unassigned__' }, ...eligible.filter(option => option.text.text.toLowerCase().includes(query))].slice(0, 100);
    };
    let timer;
    try { options = await Promise.race([lookup(), new Promise(resolve => { timer = setTimeout(() => resolve([]), 2200); })]); }
    finally { clearTimeout(timer); }
  } catch (error) { log(error); }
  await ack({ options });
});
app.view('ticket_assign_submit', async ({ ack, body, view }) => {
  await ack({ response_action: 'update', view: loadingView() });
  try {
    validateWorkspace(body);
    const meta = JSON.parse(view.private_metadata);
    const selected = view.state.values.owner.assignee.selected_option?.value;
    if (!selected) throw new Error('Choose an assignee.');
    const ticket = await manager.change({ userId: body.user.id, workspaceId: meta.workspaceId, id: meta.id, version: meta.version,
      actionId: `assign:${view.id}:${view.hash}`, assigneeId: selected === '__unassigned__' ? null : selected });
    await app.client.views.update({ view_id: view.id, view: messageView(`${ticket.label} assignment saved. Internal ticket details will be updated.`) });
    await delivery.flush();
    await publishHome(body.user.id);
  } catch (error) {
    log(error);
    await app.client.views.update({ view_id: view.id, view: messageView('Assignment was not confirmed. Refresh the ticket and check your coordinator role, assignee eligibility and channel membership before retrying.') });
  }
});
app.action(/^(ticket_status|ticket_note|ticket_reply)$/, async ({ ack, body, action }) => {
  await ack();
  let viewId;
  try {
    validateWorkspace(body);
    const opened = await app.client.views.open({ trigger_id: body.trigger_id, view: loadingView() });
    viewId = opened.view.id;
    const progress = action.action_id === 'ticket_note';
    const replying = action.action_id === 'ticket_reply';
    const value = (progress || replying) ? (() => { const [id, version] = action.value.split(':').map(Number); return { id, version }; })() : JSON.parse(action.selected_option.value);
    const ticket = await manager.ticket(body.user.id, value.id);
    await permissions.assertStatus(body.user.id, ticket);
    if (ticket.version !== value.version) throw new Error('Stale ticket');
    if (progress && ticket.status !== 'In progress') throw new Error('Ticket is not In progress');
    if (!progress && !replying && !STATUSES.includes(value.status)) throw new Error('Invalid status');
    await app.client.views.update({ view_id: viewId, view: replying ? replyView(ticket) : noteView(ticket, progress ? undefined : value.status) });
  } catch (error) {
    log(error);
    if (viewId) await app.client.views.update({ view_id: viewId, view: messageView('Unable to open this change. Refresh the ticket and check your role and channel access.') });
    else await safeError(body, error);
  }
});
app.view('ticket_note_submit', async ({ ack, body, view }) => {
  const note = view.state.values.note?.text?.value || '';
  let meta;
  try { meta = JSON.parse(view.private_metadata); }
  catch { await ack({ response_action: 'errors', errors: { note: 'Invalid ticket context. Close and reopen this dialog.' } }); return; }
  const replying = meta.kind === 'reply';
  const progress = !replying && !Object.hasOwn(meta, 'status');
  if (note.length > 2000 || ((progress || replying) && !note.trim())) {
    await ack({ response_action: 'errors', errors: { note: 'Enter a message of up to 2000 characters.' } }); return;
  }
  await ack({ response_action: 'update', view: loadingView() });
  let saved = false;
  try {
    validateWorkspace(body);
    const input = { userId: body.user.id, workspaceId: meta.workspaceId, id: meta.id, version: meta.version, actionId: `note:${view.id}:${view.hash}`, note };
    const ticket = replying ? await manager.reply(input) : progress ? await manager.addNote(input) : await manager.change({ ...input, status: meta.status });
    saved = true;
    await app.client.views.update({ view_id: view.id, view: messageView(`${ticket.label}: ${replying ? 'customer reply queued for delivery' : progress ? 'internal note saved — not sent to the customer' : 'status saved; the customer sees the status, but any note stays internal'}.`) });
    await delivery.flush();
    await publishHome(body.user.id);
  } catch (error) {
    log(error);
    await app.client.views.update({ view_id: view.id, view: messageView(saved ? 'Your change was saved. Refresh Home to see it; thread delivery may still be pending.' : `Change not saved. Refresh and check your role and ticket status before retrying.\n\n${note ? `Your note (copy before closing):\n${note}` : ''}`) });
  }
});
app.action('ticket_history', async ({ ack, body, action }) => {
  await ack();
  let viewId;
  try {
    validateWorkspace(body);
    const opened = await app.client.views.open({ trigger_id: body.trigger_id, view: loadingView() });
    viewId = opened.view.id;
    const ticket = await manager.ticket(body.user.id, Number(action.value));
    await app.client.views.update({ view_id: viewId, view: historyView(ticket, db.history(ticket.id, workspaceId)) });
  } catch (error) {
    log(error);
    if (viewId) await app.client.views.update({ view_id: viewId, view: messageView('History unavailable. Refresh and check channel access.') });
  }
});
// Rebuild Home views for members affected by access changes; writes always recheck live membership regardless.
for (const eventName of ['member_joined_channel', 'member_left_channel']) app.event(eventName, async ({ event, body }) => {
  if (body.team_id !== workspaceId || ![...config.channelIds, config.internalChannelId].includes(event.channel)) return;
  try { await publishHome(event.user); } catch (error) { log(error); }
});
app.error(async error => log(error));
const interval = setInterval(() => delivery.flush().catch(log), 30000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  clearInterval(interval);
  await app.stop();
  await delivery.flush();
  db.close();
  process.exit(0);
});
for (const channelId of config.channelIds) {
  try {
    const result = await app.client.conversations.info({ channel: channelId });
    if (result.ok && result.channel?.name) db.setChannelName(workspaceId, channelId, result.channel.name);
  } catch { console.warn(`Channel name unavailable; displaying channel ID: ${channelId}`); }
}
db.refreshCards(workspaceId);
await app.init();
await app.start();
await delivery.flush();
console.log(`Ticket management connected; channels=${config.channelIds.join(',')}`);
