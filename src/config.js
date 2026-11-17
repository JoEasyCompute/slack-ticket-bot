export function readConfig(env = process.env) {
  for (const [key, pattern] of [
    ['SLACK_BOT_TOKEN', /^xoxb-\S+$/], ['SLACK_APP_TOKEN', /^xapp-\S+$/]
  ]) {
    if (!pattern.test(env[key] ?? '')) throw new Error(`Set a valid ${key} in your environment`);
  }
  const channelSetting = env.SLACK_CHANNEL_IDS !== undefined ? 'SLACK_CHANNEL_IDS' : 'SLACK_CHANNEL_ID';
  const channelIds = [...new Set((env[channelSetting] ?? '').split(',').map(id => id.trim()))];
  if (channelIds.some(id => !/^[CG][A-Z0-9]+$/.test(id))) {
    throw new Error(`Set valid comma-separated channel IDs in ${channelSetting}`);
  }
  const reaction = env.TICKET_EMOJI || 'ticket';
  if (!/^[a-z0-9_+-]+$/.test(reaction)) throw new Error('TICKET_EMOJI must be an emoji name without colons');
  return { botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN,
    channelId: channelIds[0], channelIds, reaction, dataDir: env.DATA_DIR || './data' };
}

export function readManagementConfig(env = process.env) {
  const config = readConfig(env);
  for (const key of ['COORDINATOR_USERGROUP_ID', 'SUPPORT_USERGROUP_ID']) {
    if (!/^S[A-Z0-9]+$/.test(env[key] || '')) throw new Error(`Set a valid ${key} before starting ticket management`);
  }
  if (!/^[CG][A-Z0-9]+$/.test(env.INTERNAL_SUPPORT_CHANNEL_ID || '')) throw new Error('Set INTERNAL_SUPPORT_CHANNEL_ID to the private staff channel ID');
  if (config.channelIds.includes(env.INTERNAL_SUPPORT_CHANNEL_ID)) throw new Error('The internal support channel must not be a customer intake channel');
  return { ...config, internalChannelId: env.INTERNAL_SUPPORT_CHANNEL_ID, coordinatorGroupId: env.COORDINATOR_USERGROUP_ID, supportGroupId: env.SUPPORT_USERGROUP_ID };
}
