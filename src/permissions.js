const VERIFY_ERROR = 'Unable to verify permissions. Please try again.';
const ACCESS_ERROR = 'You do not have permission to manage this ticket.';

export class Permissions {
  constructor({ client, coordinatorGroupId, supportGroupId, channelIds, workspaceId, internalChannelId }) {
    this.client = client;
    this.workspaceId = workspaceId;
    this.internalChannelId = internalChannelId;
    this.coordinatorGroupId = coordinatorGroupId;
    this.supportGroupId = supportGroupId;
    this.channelIds = new Set(channelIds);
  }

  async members(channelId) {
    if (!this.channelIds.has(channelId) && channelId !== this.internalChannelId) return [];
    const users = new Set();
    const seenCursors = new Set();
    let cursor;
    try {
      do {
        const result = await this.client.conversations.members({ channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) });
        if (!result.ok || !Array.isArray(result.members)) throw new Error();
        for (const user of result.members) users.add(user);
        cursor = result.response_metadata?.next_cursor || undefined;
        if (cursor && seenCursors.has(cursor)) throw new Error();
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      return [...users];
    } catch { throw new Error(VERIFY_ERROR); }
  }

  async group(groupId) {
    if (!groupId) throw new Error(VERIFY_ERROR);
    try {
      const result = await this.client.usergroups.users.list({ usergroup: groupId, include_disabled: false });
      if (!result.ok || !Array.isArray(result.users)) throw new Error();
      return result.users;
    } catch { throw new Error(VERIFY_ERROR); }
  }

  async canView(userId, channelId) {
    if (!userId || !this.channelIds.has(channelId)) return false;
    try { return await this.isStaff(userId); }
    catch { return false; }
  }

  async isCoordinator(userId) {
    if (!userId) return false;
    try { return await this.isStaff(userId) && (await this.group(this.coordinatorGroupId)).includes(userId); }
    catch { return false; }
  }

  ownWorkspaceHuman(user) {
    return Boolean(this.workspaceId && user?.team_id === this.workspaceId && !user.deleted &&
      !user.is_bot && !user.is_app_user && !user.is_restricted && !user.is_ultra_restricted &&
      !user.is_stranger && user.id !== 'USLACKBOT');
  }

  async user(userId) {
    try {
      const result = await this.client.users.info({ user: userId });
      if (!result.ok || result.user?.id !== userId) throw new Error();
      return result.user;
    } catch { throw new Error(VERIFY_ERROR); }
  }

  async isStaff(userId) {
    if (!this.workspaceId || !this.internalChannelId || !userId) return false;
    try {
      const user = await this.user(userId);
      if (!this.ownWorkspaceHuman(user)) return false;
      const [support, coordinators, members] = await Promise.all([
        this.group(this.supportGroupId), this.group(this.coordinatorGroupId), this.members(this.internalChannelId)
      ]);
      return members.includes(userId) && (support.includes(userId) || coordinators.includes(userId));
    } catch { return false; }
  }

  // One live snapshot per Home render; never reused by reads or management actions.
  async homeAccess(userId) {
    const denied = { channelIds: new Set(), isCoordinator: false };
    if (!this.workspaceId || !this.internalChannelId || !userId) return denied;
    try {
      if (!this.ownWorkspaceHuman(await this.user(userId))) return denied;
      const [support, coordinators, members] = await Promise.all([
        this.group(this.supportGroupId), this.group(this.coordinatorGroupId), this.members(this.internalChannelId)
      ]);
      const coordinator = coordinators.includes(userId);
      if (!members.includes(userId) || (!support.includes(userId) && !coordinator)) return denied;
      return { channelIds: new Set(this.channelIds), isCoordinator: coordinator };
    } catch { return denied; }
  }

  async validateInternalChannel() {
    try {
      if (!this.workspaceId || !this.internalChannelId) throw new Error();
      const result = await this.client.conversations.info({ channel: this.internalChannelId });
      const channel = result.channel;
      if (!result.ok || channel?.id !== this.internalChannelId || channel.is_private !== true ||
          channel.is_member !== true || channel.is_shared || channel.is_ext_shared || channel.is_org_shared ||
          (Array.isArray(channel.pending_shared) ? channel.pending_shared.length > 0 : channel.pending_shared)) throw new Error();
      const allowedStaff = new Set([...(await this.group(this.supportGroupId)), ...(await this.group(this.coordinatorGroupId))]);
      for (const member of await this.members(this.internalChannelId)) {
        const user = await this.user(member);
        if (user.team_id !== this.workspaceId || user.is_restricted || user.is_ultra_restricted || user.is_stranger) throw new Error();
        if (!user.is_bot && !user.is_app_user && !user.deleted && !allowedStaff.has(member)) throw new Error();
      }
      return true;
    } catch { throw new Error(VERIFY_ERROR); }
  }

  async eligibleAssignees(channelId) {
    if (!this.channelIds.has(channelId)) return [];
    const [group, channel, internal] = await Promise.all([this.group(this.supportGroupId), this.members(channelId), this.members(this.internalChannelId)]);
    const members = new Set(channel);
    const users = [];
    for (const id of new Set(group)) {
      if (!members.has(id) || !internal.includes(id)) continue;
      try {
        const result = await this.client.users.info({ user: id });
        if (!result.ok || !result.user || result.user.id !== id) throw new Error();
        const user = result.user;
        if (this.ownWorkspaceHuman(user)) users.push(user);
      } catch { throw new Error(VERIFY_ERROR); }
    }
    return users;
  }

  async assertAssign(actorId, ticket, assigneeId) {
    if (!ticket || !await this.canView(actorId, ticket.channelId) || !await this.isCoordinator(actorId) || !(await this.members(ticket.channelId)).includes(actorId)) {
      throw new Error(ACCESS_ERROR);
    }
    if (assigneeId !== null) {
      const eligible = await this.eligibleAssignees(ticket.channelId);
      if (!eligible.some(user => user.id === assigneeId)) {
        throw new Error('Choose an active support-team member who belongs to this channel.');
      }
    }
  }

  async assertStatus(actorId, ticket) {
    if (!ticket || !await this.canView(actorId, ticket.channelId) || !(await this.members(ticket.channelId)).includes(actorId)) throw new Error(ACCESS_ERROR);
    if (await this.isCoordinator(actorId)) return;
    if (actorId !== ticket.assigneeId) throw new Error(ACCESS_ERROR);
    if (!(await this.group(this.supportGroupId)).includes(actorId)) throw new Error(ACCESS_ERROR);
  }
}
