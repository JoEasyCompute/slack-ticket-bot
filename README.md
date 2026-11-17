# Slack customer support tickets

Customers report an issue by adding 🎫 (`:ticket:`) to a top-level message in a monitored Slack Connect or guest-access channel. The bot keeps one durable ticket and two separate Slack views:

| Customer thread | Private #teah-support-tickets |
| --- | --- |
| Ticket ID, issue title, customer-visible status | Internal ticket card with owner and source link |
| Automatic status summaries (no attached internal note) | Internal progress/status notes and full history |
| Explicit **Reply to customer** messages | Status, note, history and reply controls |
| No owner, assignment controls or internal history | Assignment controls remain coordinator-only in Home |

Staff ticket cards and Home listings show owner/reporter Slack display names (falling back to IDs if a profile cannot be read), without sending mention notifications. They also show **Source: #channel-name** so the customer channel is identifiable without opening the original message. Names are refreshed on startup and when new reports arrive; if Slack cannot supply a name, the channel ID is shown instead.

**Notes are internal by default.** Changing status publishes the status, but the optional note stays private. For an In progress ticket, **Internal note** appends another private update. Use **Reply to customer** to deliberately send text to the customer's original thread; its dialog is explicitly labelled customer-visible. Notes and replies are limited to 2000 characters and preserve author/time in the database.

Only full members of our Slack workspace in @teah-team or @support-coordinators, who also belong to the private staff channel, can view management Home/history. Coordinators assign work; owners or coordinators change status, add notes and reply. Guests and Slack Connect users cannot access management views/actions. Assignees must be active staff in the support group, staff channel and source customer channel.

The staff channel ID is configured as `INTERNAL_SUPPORT_CHANNEL_ID=C0CG0JRJ820`; it must be private, unshared and contain only support/coordinator humans (plus local bots). The bot checks its privacy before internal sends and refuses to publish confidential content if validation fails. It never falls back to a customer channel.

**Staff visibility:** authorized support/coordinator members of the private staff channel can see all monitored customer tickets, including tickets from source channels they have not joined. Customer guests and Slack Connect members cannot see the internal queue. Managing a ticket and assignee eligibility still require source-channel membership. The original-message link also requires access to its Slack channel.

Statuses remain Open, In progress and Resolved, with reopening via Open. In progress requires an assignee. Reopening clears a now-ineligible assignee. No deletion, reminders or DMs are provided; history is retained indefinitely. Historical receipt-only reports are not imported into managed tickets.

Customer follow-up messages are not automatically copied into the internal thread in this release; staff can use **Original message** to read them and **Reply to customer** to respond.

## Upgrade an existing installation

See [SETUP.md](SETUP.md) for the complete upgrade checklist. The existing running process must be restarted after Slack permissions and the two group IDs are configured. The source files on disk do not upgrade a running process automatically.

1. Keep your existing `.env` and `data/`. Stop the bot and back up the entire data directory, including SQLite sidecar files if present. Keep only one instance running.
2. In [Slack app settings](https://api.slack.com/apps), open your existing app's **App Manifest** and apply `slack-manifest.json`. Keep existing app identity and tokens; do not create another app.
3. Reinstall/reauthorize the app to grant the added scopes. Check the Home tab, interactive actions, and event subscriptions are enabled.
4. Keep the configured staff channel ID and add actual user-group IDs to `.env`:

```dotenv
COORDINATOR_USERGROUP_ID=S_REPLACE_WITH_ACTUAL_ID
SUPPORT_USERGROUP_ID=S_REPLACE_WITH_ACTUAL_ID
INTERNAL_SUPPORT_CHANNEL_ID=C0CG0JRJ820
```

The support group is `@teah-team`. Create `@support-coordinators`, add the people who can assign work, and use that group's ID. IDs start with S and contain letters/numbers, without underscores. The placeholders above are intentionally invalid until replaced.

5. Invite the bot into every monitored channel, including private channels, and ensure intended assignees belong to those channels too.
6. Run the checks and restart:

```sh
cd ~/Desktop/dev/slack-ticket-bot
npm test
npm run check
npm start
```

Use Node 22.16 or newer with `node:sqlite` available. This uses Node's built-in SQLite module, which emits an experimental warning on Node 22; no new package is required. The current local runtime is Node 22.22.3. Keep persistent local storage and one bot instance.

For Docker, rebuild and recreate with `docker compose up -d --build`. Preserve the `ticket-data` volume. Do not run `docker compose down -v`.

## New Slack app

Create an app **From a manifest** at [Slack apps](https://api.slack.com/apps) using `slack-manifest.json`. Generate an app-level `xapp-…` token with `connections:write` under Basic Information. Install the app to get its `xoxb-…` bot token. Enable Socket Mode; it needs no inbound URL. Populate `.env` using `.env.example` without sharing or committing real tokens.

```sh
cd ~/Desktop/dev/slack-ticket-bot
cp -n .env.example .env
npm ci
```

Set the two tokens, `SLACK_CHANNEL_IDS` (comma separated), and the two group IDs and the private internal channel ID, then run `npm start`. The legacy `SLACK_CHANNEL_ID` still works for one channel; `SLACK_CHANNEL_IDS` takes precedence. `TICKET_EMOJI=ticket` and `DATA_DIR=./data` remain the defaults.

To find group IDs after granting `usergroups:read`, use Slack's `usergroups.list` API (the admin helper below prints only handles and IDs). Group handles alone are not accepted in `.env`.

```sh
npm run groups
```

## Slack permissions

The manifest keeps `reactions:read` and `chat:write`, and adds:

| Scope | Purpose |
| --- | --- |
| `usergroups:read` | Read coordinator and support membership |
| `channels:read` | Check public-channel membership |
| `groups:read` | Check private-channel membership |
| `users:read` | Show assignee names and exclude deactivated/bot accounts |

Events: `reaction_added`, `app_home_opened`, `member_joined_channel`, `member_left_channel`. Interactivity and the Home tab are enabled in the manifest. No channel-history permission is requested.

All management actions recheck the actor's channel and group membership and validate the ticket version before saving. Assignment selectors preload eligible names for one minute; reopen the dialog if options expire. The final submission always checks current eligibility again. A stale card asks you to refresh rather than overwriting another person's change.

Home views refresh when opened, on Refresh, after your changes and on channel membership events. Already-rendered Slack content may remain visible temporarily after access is revoked, but new reads/actions are checked again. Membership lookup failure hides tickets/denies changes; it never grants access.

## Persistence, delivery and recovery

Managed tickets, audit history and the delivery queue live in `data/tickets.sqlite`. SQLite WAL/SHM sidecars may exist. Old JSON receipt files stay in place and continue preventing duplicate reports for old messages. The database stores a short issue title, Slack IDs, owner/status and history, not full conversations or attachments. Internal notes and explicit customer replies are retained in history and the delivery queue. Each ticket stores separate customer and internal card references. Keep database backups protected because they contain issue summaries.

Changes save to the database before Slack publication. Customer and internal deliveries have separate queue kinds. Legacy queued history is treated as internal, never as a customer post. The delivery worker normally runs immediately and retries safe updates every 30 seconds, respecting rate-limit delays. A failure on one ticket does not stop unrelated tickets. The UI may briefly lag the saved database state. Network uncertainty during a new post is blocked for review to avoid duplicate cards or mentions; later deliveries for that ticket wait behind it.

For blocked delivery, **stop the bot first**, inspect the source thread, then list unfinished records:

```sh
npm run outbox -- list
```

If the post is definitely absent, retry only that record (replace 12):

```sh
npm run outbox -- retry 12
```

If a history post already exists, mark its queue record confirmed:

```sh
npm run outbox -- confirm 12
```

For an existing initial ticket card (customer `card` or staff `internal_card`), also supply its Slack message timestamp so future changes edit that card:

```sh
npm run outbox -- confirm 12 1700000000.123456
```

These recovery commands are local operator tools; never guess whether an uncertain post exists. Recheck the thread first. Restart after recovery. On Docker, stop the bot and run the helper in a one-off container using the same volume and environment (`docker compose run --rm bot npm run outbox -- list`).

No exactly-once guarantee across Slack and local storage is possible. Interrupted sends may need manual reconciliation. Reactions while offline are not backfilled; remove/re-add 🎫 to report an unacknowledged new issue after downtime. Existing managed tickets are deduplicated by workspace, channel and message timestamp.

## Backup and rollback

With the bot stopped, copy the complete data directory into a protected backup location. Docker users must back up the named volume instead. Never copy only a live SQLite main file while omitting its WAL.

To roll back the code, baseline commit `b4c3ede` contains the acknowledgment-only version. Restore files from that revision using a separate checkout/deployment and keep data backups. That old version does not understand managed tickets, so pause reporting during rollback to avoid new receipt-only acknowledgments on messages with managed tickets. Do not delete the management database.

## Acceptance checks

Run `npm test` and `npm run check`, then test in Slack:

1. React 🎫 in a customer test channel: the customer card contains ID/title/status only; the private staff channel receives the internal card.
2. A coordinator assigns via Home: the customer sees neither owner nor an assignment announcement. An eligible owner must also belong to the staff and customer channels.
3. Change status with a distinctive internal note: customer sees the status only; the note appears only in the staff thread and staff history.
4. Add repeated Internal notes while In progress: earlier notes remain; customer thread receives none.
5. Use Reply to customer: only that explicitly entered reply reaches the original customer's thread. The private history records it separately.
6. A guest/Slack Connect user cannot view Home ticket data or use old management controls. Ordinary nonstaff local users are also denied.
7. Remove a staff actor from the group/channel and retry: fresh permissions reject their action. Add an unauthorized human or share the internal channel: internal posting is withheld.
8. Verify authorized staff can view all monitored tickets while customers/nonstaff cannot. Verify source membership is still required for management actions. Test concurrent/stale actions and uncertain delivery recovery.

On first startup after upgrade, existing customer cards are refreshed without management data and internal cards are created for existing managed tickets. **Messages/notes previously posted into customer threads are not deleted or made private retrospectively.** Review those separately before treating this as a confidentiality boundary. Blocked deliveries may need operator reconciliation before their cards refresh.

## References

- [App Home](https://docs.slack.dev/surfaces/app-home/)
- [Channel membership](https://docs.slack.dev/reference/methods/conversations.members/)
- [User-group membership](https://docs.slack.dev/reference/methods/usergroups.users.list/)
- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
