# Ticket management implementation plan — draft for review

Status: approved and implemented locally on 2026-11-08. All four open questions were accepted by the user. Support group: @teah-team. Coordinator group: @support-coordinators (to be created).

Verification: 39 automated tests pass, all JavaScript syntax checks pass, and whitespace checks pass. Local full-flow tests cover create → assign → In progress → Resolved → reopen, transactional history/delivery, stale edits, permissions and visibility. Built-in node:sqlite works on local Node 22.22.3 with its experimental warning; no added dependency.

Live rollout remains pending: current Slack token returns missing_scope for user-group reads. Apply manifest and reauthorize, create coordinator group, configure both group IDs, then perform Slack acceptance checks before restarting production. Existing .env, receipt data and running process were not modified. No live ticket messages were sent during implementation.

## Agreed requirements

- Continue creating tickets by adding 🎫 to a human-authored top-level message in a monitored channel.
- Coordinators assign tickets to another person.
- Coordinators are identified by membership in a configured Slack user group.
- Assignees must belong to a designated support-team user group.
- Statuses: Open, In progress, Resolved; resolved tickets can be reopened.
- Assigned people and coordinators can change status.
- Ticket lists respect channel access.
- All user interaction stays in Slack: controls on ticket acknowledgment messages and a ticket list on the bot's Home tab.

## Proposed design and defaults (not yet user-approved)

Each new ticket receives a durable ID such as T-000001, channel and original-message references, reporter ID, assignee (initially none), status Open, creation/update times, and a version number. Keep an append-only history of assignments and status changes with actor and time. Store a short title derived from the original message, not attachments or the full conversation; render it as plain text to prevent unintended mentions.

The original acknowledgment becomes a ticket card containing its ID, owner, status, link to the source message, an Assign control and status controls. Assignment opens a Slack modal listing eligible people. Only coordinators can assign, reassign or clear an assignee. Do not automatically assign the coordinator who clicked. Assignment alone leaves the status unchanged. In progress requires an assignee; Open can move directly to Resolved; reopening returns to Open and retains the assignee if still eligible, otherwise clears it.

The assigned person may change status only while still in the support-team group and the ticket's channel. A coordinator also needs ticket-channel access. Enforce all authorization on the server for every button, modal submission and Home filter/page request; visible buttons are not authority. Validate the selected assignee again on submission, including support-group and channel membership. If membership checks fail, make no change and show a private explanation.

Home defaults to unresolved tickets assigned to the viewer, with All visible, Unassigned and status filters, plus pagination. Apply visibility filtering before calculating counts or returning any titles, links or IDs. Proposed visibility rule: the viewer must currently be a member of the source channel, including public channels. This is stricter than public-channel discoverability and needs confirmation below.

Home is refreshed on opening it, on explicit Refresh and after the viewer's management action. Clear/rebuild views after channel-membership events where feasible. Previously rendered Slack content cannot be guaranteed to disappear instantly after access is revoked; enforce fresh checks for every new request and never send hidden-ticket content in error messages.

Updates edit the ticket card and append a brief history entry to the original thread. Proposed notification default: mention the new assignee in that thread once on assignment/reassignment, with no DMs or reminders. Do not mention an entire support or coordinator group. If Slack publication fails after a saved change, retain the saved state and queue a retry rather than reverting the ticket or reapplying the action.

## Architecture and alternatives

Recommended: extend the current JavaScript/Bolt Socket Mode app and use a single local SQLite database under DATA_DIR. It provides transactional ticket changes, durable history, unique source-message constraints and version checks without operating a separate database service. Keep one running bot instance and persistent storage; back up the database before migration.

Alternative: continue with JSON files. Avoids changing storage, but adds fragile locking and crash-recovery work for concurrent assignments, history and list queries.

Alternative: hosted PostgreSQL. Fits multiple bot instances and higher scale but adds infrastructure and credentials; defer unless hosting requires it.

SQLite driver/runtime selection is an implementation gate: verify a supported Node runtime and driver against the deployment machine before choosing a dependency or raising the Node version. No dependency or runtime changes are authorized by this draft.

## Slack integration

Retain reactions:read and chat:write. Add usergroups:read to resolve the two configured groups, channels:read and groups:read to inspect public/private channel membership. Add users:read only if needed for eligible-user names and deactivated-account checks; confirm the final manifest against actual methods before implementation. No channel-history permission is proposed.

Enable App Home, subscribe to app_home_opened, and enable interactive actions over existing Socket Mode. Consider member_joined_channel, member_left_channel and subteam_members_changed for invalidation; validate event scopes. Fetch paginated channel membership completely and check groups with usergroups.users.list. Do not infer a human's permissions from the bot's own channel access.

Suggested settings: COORDINATOR_USERGROUP_ID and SUPPORT_USERGROUP_ID, in addition to existing tokens, SLACK_CHANNEL_IDS, TICKET_EMOJI and DATA_DIR. Use IDs rather than mutable group handles. Fresh membership checks are required for writes; cache reads only with explicit invalidation and a short lifetime. Fail closed when Slack cannot establish access. API rate limits must yield a private retry message, not a permissions bypass.

References checked during planning:
- https://docs.slack.dev/reference/methods/conversations.members/
- https://docs.slack.dev/reference/methods/users.conversations/
- https://docs.slack.dev/reference/scopes/usergroups.read/

## Migration and failure handling

Preserve existing .env and receipt files. Recommended default: historical acknowledged messages remain receipts, not automatically imported tickets; start managing newly reported issues after deployment. If historical tickets are wanted, design a separate explicit import first.

Use unique (workspace ID, channel ID, source timestamp) and stable action IDs to prevent duplicate ticket creation/history on retries. Commit changes and an outbox item in one transaction. Publish or update Slack cards outside that transaction. Use version checks to reject stale concurrent edits with a request to refresh. Never automatically repost an acknowledgment after an ambiguous send result without reconciling it first.

Do not delete tickets or history through Slack in this version. Retention is indefinite on local storage, subject to a later explicit retention policy. Deleted source messages may leave ticket records; their links may cease to work. A lost channel/group membership prevents new actions even if a previously assigned owner remains recorded.

## Implementation tasks (after approval)

### 1. Durable ticket model and migration
Files: new src/tickets.js and src/database.js; tests in test/tickets.test.js; preserve src/store.js until migration is proven.
- [ ] Write failing tests for unique ticket creation, ID allocation, reopen transitions, history, persistence after restart and stale-version rejection.
- [ ] Choose the supported SQLite runtime/driver and implement createTicket, getTicket, updateTicket and listTickets with transactions and workspace-scoped keys.
- [ ] Implement non-destructive initialization and backup/restore instructions; test against a copy of existing receipt files.
- [ ] Run full tests and syntax checks before committing this task.

### 2. Membership and permission checks
Files: new src/permissions.js and test/permissions.test.js; update src/config.js and test/bot.test.js.
- [ ] Write failing tests for coordinator-only assignment, eligible assignees, unauthorized status edits, cross-channel leakage, pagination, membership revocation and Slack API failures.
- [ ] Implement group lookup and channel checks with explicit actor/workspace context; validate group IDs and settings on startup.
- [ ] Use identical visibility rules for Home, modals, counts, actions and notifications; test that hidden tickets never enter a rendered response.
- [ ] Run full tests and syntax checks before committing this task.

### 3. Ticket creation and thread controls
Files: update src/bot.js and src/app.js; new src/ticket-views.js and test/ticket-actions.test.js.
- [ ] Write failing tests for creation from a ticket reaction, duplicate delivery, forged action IDs, stale modals, concurrent reassignment, status changes and uncertain Slack sends.
- [ ] Replace the receipt-only response for new reports with a durable ticket card; preserve existing channel/emoji/bot/thread filtering.
- [ ] Add assignment modal and status actions, acknowledge Slack interactions promptly, revalidate permissions before saving, and publish through a durable outbox.
- [ ] Test recovery when Slack posting fails after the database transaction succeeds; run full suite and syntax checks.

### 4. Home ticket list
Files: new src/home.js and test/home.test.js; wire app_home_opened and Home actions in src/app.js.
- [ ] Write failing tests for viewer-specific visibility, My tickets, Unassigned, status filters, pagination, counts and channel access changes.
- [ ] Implement personalized Home views and refresh behavior with membership checks before rendering.
- [ ] Test Slack view-size limits and empty/error states without exposing hidden-ticket metadata.
- [ ] Run full tests and syntax checks before committing this task.

### 5. Setup, acceptance testing and rollout
Files: slack-manifest.json, .env.example, README.md, SETUP.md, compose.yaml/Dockerfile only if runtime/storage changes require it.
- [ ] Document group IDs, new scopes, app reinstall/reauthorization, Home/interactivity settings, backups and rollback.
- [ ] Run all automated tests and syntax checks; review authorization and migration independently.
- [ ] Test in Slack with a coordinator, an eligible assignee, a non-coordinator and a person outside a private test channel. Test revoked membership and duplicate/concurrent actions.
- [ ] Deploy only after plan approval and successful acceptance checks. Keep baseline commit b4c3ede and a storage backup for rollback.

## Open questions before implementation

1. Confirm visibility means channel membership even for public channels, rather than showing all public-channel tickets a workspace member could browse.
2. Approve or change the proposed defaults: assignment mentions in the ticket thread (no DMs), historical receipts remain receipts, no deletion, and indefinite retention.
3. Provide the coordinator and support-team group handles or IDs before live setup. They need not be supplied to implement configurable settings.
4. Confirm deployment remains one always-on process with persistent local disk. If it is moving to multiple instances or ephemeral hosting, reconsider SQLite before implementation.
