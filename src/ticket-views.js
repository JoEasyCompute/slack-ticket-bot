export const STATUSES = ['Open', 'In progress', 'Resolved'];
const plain = text => ({ type: 'plain_text', text: String(text).slice(0, 2900), emoji: false });
const button = (text, action_id, value) => ({ type: 'button', text: plain(text), action_id, value });
export const sourceUrl = ticket => ticket.permalink || `https://slack.com/app_redirect?channel=${ticket.channelId}&team=${ticket.workspaceId}`;
export function customerBlocks(ticket) {
  return [
    { type: 'section', text: plain(`${ticket.label} · ${ticket.status}\n${ticket.title}`) },
    { type: 'context', elements: [plain('Your issue has been received. Customer updates will appear in this thread.')] }
  ];
}
export function ticketBlocks(ticket, { showAssignment = false } = {}) {
  return [
    { type: 'section', text: plain(`${ticket.label} · ${ticket.status}\n${ticket.title}`) },
    { type: 'context', elements: [plain(`Source: ${ticket.channelName ? `#${ticket.channelName}` : ticket.channelId}\nOwner: ${ticket.assigneeName || ticket.assigneeId || 'Unassigned'} · Reported by: ${ticket.reporterName || ticket.reporterId}`)] },
    { type: 'actions', elements: [
      ...(showAssignment ? [button('Assign / reassign', 'ticket_assign', `${ticket.id}:${ticket.version}`)] : []),
      { type: 'static_select', action_id: 'ticket_status', placeholder: plain('Change status'), options: STATUSES.map(status => ({ text: plain(status === 'Open' && ticket.status === 'Resolved' ? 'Reopen' : status), value: JSON.stringify({ id: ticket.id, version: ticket.version, status }) })) },
      ...(ticket.status === 'In progress' ? [button('Internal note', 'ticket_note', `${ticket.id}:${ticket.version}`)] : []),
      button('Reply to customer', 'ticket_reply', `${ticket.id}:${ticket.version}`),
      button('History', 'ticket_history', String(ticket.id)),
      { type: 'button', text: plain('Original message'), url: sourceUrl(ticket), action_id: 'ticket_source' }
    ] }
  ];
}
export function assignmentView(ticket) {
  return { type: 'modal', callback_id: 'ticket_assign_submit', private_metadata: JSON.stringify({ id: ticket.id, version: ticket.version, workspaceId: ticket.workspaceId }),
    title: plain(`Assign ${ticket.label}`), submit: plain('Save'), close: plain('Cancel'), blocks: [
      { type: 'section', text: plain('Choose an eligible support-team member who belongs to the ticket channel. Choose Unassigned to clear the owner. Search expires after one minute; close and reopen this dialog to refresh.') },
      { type: 'input', block_id: 'owner', label: plain('Assignee'), element: { type: 'external_select', action_id: 'assignee', placeholder: plain('Search support members'), min_query_length: 0 } }
    ] };
}
export function loadingView() {
  return { type: 'modal', title: plain('Ticket management'), close: plain('Close'), blocks: [{ type: 'section', text: plain('Checking access…') }] };
}
export function messageView(text) { return { type: 'modal', title: plain('Ticket management'), close: plain('Close'), blocks: [{ type: 'section', text: plain(text) }] }; }
export function historyView(ticket, history) {
  const entries = history.slice(-30).map(h => {
    const p = h.payload || h;
    return { type: 'section', text: plain(`${h.createdAt || ''} · ${p.actorId || 'System'} · ${p.kind === 'reply' ? 'Customer reply' : p.kind === 'note' ? 'Internal progress note' : p.status || 'Updated'} · Owner: ${p.assigneeId || 'Unassigned'}${p.note ? `\n${p.note}` : ''}`) };
  });
  return { type: 'modal', title: plain(`${ticket.label} history`), close: plain('Close'), blocks: [
    { type: 'section', text: plain(`Created: ${ticket.createdAt || 'Unknown'} · Latest 30 changes`) },
    ...(entries.length ? entries : [{ type: 'section', text: plain('No changes yet.') }])
  ] };
}
export function noteView(ticket, status) {
  const progress = status === undefined;
  return { type: 'modal', callback_id: 'ticket_note_submit', private_metadata: JSON.stringify({ id: ticket.id, version: ticket.version, workspaceId: ticket.workspaceId, ...(progress ? {} : { status }) }),
    title: plain(progress ? 'Add progress note' : 'Change ticket status'), submit: plain('Save'), close: plain('Cancel'), blocks: [
      { type: 'section', text: plain(`${ticket.label} · ${progress ? 'In progress' : `${ticket.status} → ${status}`}\n${progress ? 'Internal note — not sent to the customer. Add an update without changing status. Earlier notes stay in the internal history.' : 'The status is visible to the customer. An optional internal note is not sent to the customer.'}`) },
      { type: 'input', block_id: 'note', optional: !progress, label: plain('Note'), element: { type: 'plain_text_input', action_id: 'text', multiline: true, max_length: 2000 } }
    ] };
}

export function replyView(ticket) {
  const view = noteView(ticket);
  view.private_metadata = JSON.stringify({ id: ticket.id, version: ticket.version, workspaceId: ticket.workspaceId, kind: 'reply' });
  view.title = plain('Reply to customer');
  view.submit = plain('Send to customer');
  view.blocks[0].text = plain(`${ticket.label} · CUSTOMER-VISIBLE REPLY\nThis message will be posted in the original customer's thread. Check the customer and message before sending.`);
  view.blocks[1].label = plain('Customer reply');
  return view;
}

export function homeView(tickets, { page = 0, filter = 'mine', status = 'active', showAssignment = false } = {}) {
  const total = tickets.length;
  page = Math.min(Math.max(0, Math.trunc(Number(page)) || 0), Math.max(0, Math.ceil(total / 10) - 1));
  const metadata = { page, filter, status };
  const blocks = [
    { type: 'header', text: plain('Support tickets') },
    { type: 'actions', elements: ['mine', 'all', 'unassigned'].map(value => button({ mine: 'My tickets', all: 'All visible', unassigned: 'Unassigned' }[value], `home_${value}`, JSON.stringify({ ...metadata, filter: value, page: 0 }))) },
    { type: 'actions', elements: [
      { type: 'static_select', action_id: 'home_status', initial_option: { text: plain(status), value: status }, options: ['active', 'any', ...STATUSES].map(value => ({ text: plain(value), value })) },
      button('Refresh', 'home_refresh', JSON.stringify(metadata))
    ] },
    { type: 'context', elements: [plain(`${total} visible tickets · ${filter} · ${status} · Page ${page + 1}`)] }
  ];
  for (const ticket of tickets.slice(page * 10, page * 10 + 10)) blocks.push(...ticketBlocks(ticket, { showAssignment }), { type: 'divider' });
  if (!total) blocks.push({ type: 'section', text: plain('No tickets match these filters.') });
  const navigation = [];
  if (page > 0) navigation.push(button('Previous', 'home_previous', JSON.stringify({ ...metadata, page: page - 1 })));
  if ((page + 1) * 10 < total) navigation.push(button('Next', 'home_next', JSON.stringify({ ...metadata, page: page + 1 })));
  if (navigation.length) blocks.push({ type: 'actions', elements: navigation });
  return { type: 'home', private_metadata: JSON.stringify(metadata), blocks };
}
