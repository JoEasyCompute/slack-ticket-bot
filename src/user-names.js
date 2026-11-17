// Display-only profiles: permissions always use fresh membership checks and stable IDs.
const caches = new WeakMap();
async function displayName(userId, client) {
  if (!userId) return null;
  if (!client?.users?.info) return userId;
  let cache = caches.get(client);
  if (!cache) { cache = new Map(); caches.set(client, cache); }
  const cached = cache.get(userId);
  if (cached?.expires > Date.now()) return cached.name;
  try {
    const response = await client.users.info({ user: userId });
    if (!response.ok || response.user?.id !== userId) return userId;
    const user = response.user;
    const name = [user.profile?.display_name, user.profile?.real_name, user.real_name, user.name].find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 200) || userId;
    if (cache.size >= 1000) cache.clear();
    cache.set(userId, { name, expires: Date.now() + 60000 });
    return name;
  } catch { return userId; }
}
export async function withUserNames(ticket, client) {
  const [assigneeName, reporterName] = await Promise.all([displayName(ticket.assigneeId, client), displayName(ticket.reporterId, client)]);
  return { ...ticket, assigneeName, reporterName };
}
