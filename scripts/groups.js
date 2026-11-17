import { WebClient } from '@slack/web-api';
if (!process.env.SLACK_BOT_TOKEN) throw new Error('Set SLACK_BOT_TOKEN');
const client = new WebClient(process.env.SLACK_BOT_TOKEN, { retryConfig: { retries: 0 }, timeout: 10000 });
try {
  const result = await client.usergroups.list();
  for (const group of result.usergroups || []) if (!group.date_delete) console.log(`@${group.handle}: ${group.id}`);
} catch (error) {
  console.error(`Cannot list user groups: ${error.data?.error || error.code || 'unknown'}. Apply the manifest and reinstall the app to grant usergroups:read.`);
  process.exitCode = 1;
}
