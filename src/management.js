import { withUserNames } from './user-names.js';
import { homeView, STATUSES } from './ticket-views.js';
export class TicketManager {
  constructor({ db, permissions, workspaceId, client }) { Object.assign(this, { db, permissions, workspaceId, client }); }
  async ticket(userId, id, workspaceId = this.workspaceId) {
    if (workspaceId !== this.workspaceId || !Number.isSafeInteger(Number(id))) throw new Error('Ticket unavailable.');
    const ticket = this.db.get(Number(id), workspaceId);
    if (!ticket || !await this.permissions.canView(userId, ticket.channelId)) throw new Error('Ticket unavailable or channel access missing.');
    return ticket;
  }
  async change({ userId, workspaceId, id, version, actionId, ...input }) {
    const change = {};
    if (Object.hasOwn(input, 'assigneeId')) change.assigneeId = input.assigneeId;
    if (Object.hasOwn(input, 'status')) change.status = input.status;
    if (Object.hasOwn(input, 'note')) change.note = input.note;
    const ticket = await this.ticket(userId, id, workspaceId);
    const assigning = Object.hasOwn(change, 'assigneeId');
    if (assigning && Object.hasOwn(change, 'status')) throw new Error('Choose one change at a time.');
    if (assigning) await this.permissions.assertAssign(userId, ticket, change.assigneeId);
    else {
      if (!STATUSES.includes(change.status)) throw new Error('Invalid status.');
      await this.permissions.assertStatus(userId, ticket);
      if (change.status === 'Open' && ticket.status === 'Resolved' && ticket.assigneeId) {
        const eligible = await this.permissions.eligibleAssignees(ticket.channelId);
        if (!eligible.some(person => (typeof person === 'string' ? person : person.id) === ticket.assigneeId)) change.assigneeId = null;
      }
    }
    return this.db.update({ id: ticket.id, workspaceId, version, actorId: userId, actionId, ...change });
  }
  async addNote({ userId, workspaceId, id, version, actionId, note }) {
    const ticket = await this.ticket(userId, id, workspaceId);
    await this.permissions.assertStatus(userId, ticket);
    return this.db.update({ id: ticket.id, workspaceId, version, actorId: userId, actionId, note, kind: 'note' });
  }
  async reply({ userId, workspaceId, id, version, actionId, note }) {
    const ticket = await this.ticket(userId, id, workspaceId);
    await this.permissions.assertStatus(userId, ticket);
    return this.db.update({ id: ticket.id, workspaceId, version, actorId: userId, actionId, note, kind: 'reply' });
  }
  async home(userId, { filter = 'mine', status = 'active', page = 0 } = {}) {
    if (!['mine', 'all', 'unassigned'].includes(filter) || !['active', 'any', ...STATUSES].includes(status)) throw new Error('Invalid ticket filter.');
    const visible = [];
    const access = await this.permissions.homeAccess(userId);
    for (const ticket of this.db.list(this.workspaceId)) {
      if (!access.channelIds.has(ticket.channelId)) continue;
      if (filter === 'mine' && ticket.assigneeId !== userId) continue;
      if (filter === 'unassigned' && ticket.assigneeId) continue;
      if (status === 'active' && ticket.status === 'Resolved') continue;
      if (status !== 'active' && status !== 'any' && ticket.status !== status) continue;
      visible.push(ticket);
    }
    const currentPage = Math.min(Math.max(0, Math.trunc(Number(page)) || 0), Math.max(0, Math.ceil(visible.length / 10) - 1));
    for (let i = currentPage * 10; i < Math.min(visible.length, currentPage * 10 + 10); i++) visible[i] = await withUserNames(visible[i], this.client);
    const showAssignment = access.isCoordinator;
    return homeView(visible, { filter, status, page, showAssignment });
  }
}
