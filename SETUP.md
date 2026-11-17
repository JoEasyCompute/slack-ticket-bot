# Enable private staff ticket management

The staff channel is #teah-support-tickets, ID `C0CG0JRJ820`. That ID has been added to your existing `.env`; tokens and customer channel settings were preserved. A read-only live check verified the channel was private, unshared, and contained no guest/external members.

## Before restarting

1. Keep the bot invited to #teah-support-tickets and to all monitored customer channels.
2. Add staff to @teah-team or @support-coordinators and to the private channel. Do not invite customers or guests to the staff channel. Only coordinators assign tickets; assigned people and coordinators update status/notes/replies.
3. Keep `INTERNAL_SUPPORT_CHANNEL_ID=C0CG0JRJ820` separate from `SLACK_CHANNEL_IDS`, which contains customer intake channels only. Existing tokens/group IDs remain unchanged.
4. Authorized staff in the private channel can see all monitored customer tickets, whether or not they belong to every customer channel. To manage a ticket or be assigned to it, they must still join its source customer channel. Customers, guests and nonstaff remain excluded from the internal queue.
5. Stop the current bot and back up the complete data folder/volume. Run `npm test` and `npm run check`, then `npm start`. Docker: `docker compose up -d --build`. Keep one instance.
6. Verify a new test ticket in both places before using it for confidential work.

## What goes where

- Customer thread: ticket ID/title/status, automatic status summaries, and explicit **Reply to customer** messages only.
- Private staff channel: internal ticket card, internal notes, and full history. Coordinators assign/reassign from their personal Home tab.
- A status dialog's note is **internal**. Customer status is updated without including that note.
- **Internal note** appends updates to an In progress ticket; **Reply to customer** is a separate customer-visible action with a clearly labelled Send button.
- Customer follow-ups are not automatically mirrored; use the source link to read the customer thread.

No new Slack scopes or package dependencies are needed beyond the management manifest already applied. Existing database rows are extended non-destructively on restart; historical receipt files remain unchanged. The bot has not been restarted or sent live messages during implementation.

Existing customer cards are sanitized on startup and internal cards are created. Earlier messages already posted into customer threads are not automatically removed; review them separately. Guests/Slack Connect users are denied staff Home/history and management actions even if an older card still has a control.

See [README.md](README.md) for installation, backup, permissions, acceptance checks and uncertain-delivery recovery.

Staff cards and Home show the source channel name. Restarting populates names on existing tickets and refreshes their cards; failed name lookups fall back to channel IDs without blocking ticket creation.
