# Slack issue acknowledger

Add a 🎫 (`:ticket:`) reaction to a human-authored, top-level message in any configured channel. The bot replies in its thread:

> Thanks for reporting this. Your issue has been received.

Anyone in the channel can add the reaction. Other emoji and channels are ignored. Reactions on thread replies and bot posts are ignored. Repeated reactions, removing/re-adding the reaction, concurrent reactions and restarts do not normally create another acknowledgment.

This version acknowledges receipt only. It does not create numbered tickets, assign work or promise a response time.

## 1. Create the Slack app

1. Open [Slack apps](https://api.slack.com/apps) and choose **Create New App → From a manifest**.
2. Select your workspace. Paste the contents of `slack-manifest.json` into the JSON tab and create the app.
3. Under **Basic Information → App-Level Tokens**, generate a token named `ticket-bot` with the `connections:write` scope. Save the `xapp-…` value privately.
4. Under **OAuth & Permissions**, choose **Install to Workspace** and authorize it. Workspace policy may require administrator approval. Save the **Bot User OAuth Token**, starting with `xoxb-…`.
5. Check **Socket Mode** is enabled and **Event Subscriptions** includes the bot event `reaction_added`. The manifest configures both.
6. In each channel you want to monitor, use `/invite @Issue Acknowledger`. Invite it explicitly for private channels too.
7. Open the channel details and copy its **Channel ID** (usually near the bottom). Use the ID, not `#channel-name`.

The app requests only `reactions:read` and `chat:write`. `reactions.get` reads the reacted message using the same reaction scope; no channel-history permission is needed. Scope permissions apply to conversations the app joins; the code further filters to your configured channels.

## 2. Configure and run

Install Node.js 22.16 or newer. Open the project folder:

```sh
cd ~/Desktop/dev/slack-ticket-bot
```

For a new installation only, create your local settings file (this command preserves an existing `.env`):

```sh
cp -n .env.example .env
```

Edit `.env` locally with your two tokens and channel IDs. Keep tokens private; do not paste them into chat or commit `.env`.

```sh
npm ci
npm start
```

The terminal should say `Ticket acknowledger connected`. Keep the process running and the computer awake. Socket Mode uses an outbound connection; no public URL or inbound port is needed.

Optional: change `TICKET_EMOJI` to a Slack emoji name without colons. The default is `ticket` (🎫), not `tickets` (🎟️).

## Add more channels / upgrade from the single-channel version

Replace the three files in `src` named `app.js`, `bot.js`, and `config.js` with this updated version (or replace the source folder). Keep your existing `.env` and `data` directory / Docker volume.

In `.env`, set a comma-separated list:

```dotenv
SLACK_CHANNEL_IDS=C0123456789,C9876543210
```

Invite `@Issue Acknowledger` to **each** channel using `/invite @Issue Acknowledger`. Include private channels explicitly. Restart the process; for Docker, run `docker compose up -d --build` to rebuild and recreate it with the new source and environment. Test a fresh message and 🎫 reaction in each channel.

The existing `SLACK_CHANNEL_ID` setting still works for one channel. When both settings are present, `SLACK_CHANNEL_IDS` takes precedence. No new app or extra Slack scopes are needed. Duplicate records remain separate per channel. Keep all existing receipt data when upgrading.

## 3. Test in Slack

1. Post a new issue message in each configured channel.
2. Add the 🎫 reaction. Confirm the receipt appears in its thread.
3. Have another person add 🎫 to the same message. Confirm there is still one receipt.
4. Remove and re-add the reaction, then restart the bot and repeat. Confirm no additional receipt.
5. Confirm other emoji, other channels, and thread replies produce no receipt.

Local tests do not require Slack credentials:

```sh
npm test
npm run check
```

## 4. Keep it running

On an always-on machine with Docker Compose installed:

```sh
docker compose up -d --build
docker compose logs -f bot
```

The named `ticket-data` volume retains records across container restarts and rebuilds. Keep one instance running. Do not remove the volume or use `docker compose down -v`: deleting records permits repeat acknowledgments. Back up the volume if moving servers. No hosting service is provisioned by this package.

## Failures and recovery

The `data` directory contains one JSON record per reported message. It stores channel/message IDs and delivery status, not issue text or tokens. Retain it to prevent duplicate receipts. Docker uses `/app/data` inside the named volume.

- `sent`: Slack confirmed delivery and the acknowledgment timestamp was saved.
- `pending`: the bot reserved the message, but delivery was not confirmed. This can happen after a timeout, crash or disk error. It deliberately avoids sending again automatically because Slack may already have accepted the first attempt.
- Rate-limited posts wait for Slack’s requested delay and retry up to three times. If still rate-limited, the reservation is released; remove/re-add 🎫 later to retry.
- Known rejections such as `not_in_channel` release the reservation. Fix the problem, then remove and re-add 🎫 to try again.

For a pending record, stop the bot, inspect the indicated Slack thread, and check the logs. If no receipt exists, delete only that message's JSON record, restart the bot, and remove/re-add 🎫. If the receipt exists, keep the record; a pending record still prevents duplicates. Never bulk-delete the data folder to retry one issue. An interrupted write may leave an empty record; use the message IDs in the failure log and inspect Slack before removing it.

This is duplicate-resistant, not an exactly-once distributed transaction. Slack delivery and local disk writes cannot be committed atomically. Uncertain delivery requires manual review, and reactions added while the bot is offline are not backfilled. After downtime, remove/re-add 🎫 on an unacknowledged issue to trigger it again.

## References

- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Reaction events](https://docs.slack.dev/reference/events/reaction_added/)
- [Reading the reacted message](https://docs.slack.dev/reference/methods/reactions.get/)
- [Posting threaded replies](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [App manifest reference](https://docs.slack.dev/reference/app-manifest/)
