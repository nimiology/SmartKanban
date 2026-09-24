# Telegram Project Assistant — Product and Implementation Plan

**Date:** 2026-09-23
**Status:** Partial implementation in the working tree; the TypeScript build and database migration have not been verified. The latest product direction adds lifecycle topics and an enforced development/release workflow.
**Product:** SmartKanban, adapted for a small three-person product team.

## 1. Product goal

Use the team's existing Telegram forum group as the everyday place to capture and move work. Stable topics represent the task lifecycle, while one canonical task record powers both Telegram and the live Kanban board. A teammate can reply to a message in any topic in the approved group and send an explicitly addressed `/task` instruction; the assistant uses the replied-to message and bounded, explicitly remembered context to create a structured task in the correct intake topic. Status changes publish the current task card into the topic mapped to the new status. The assistant must not read every conversation or run an open-ended search loop.

The user's request defines the product experience. The attached **Zeydi Product Development & Release Workflow** is the process reference for the lifecycle topics and working rules. Its optional tool choices remain optional: SmartKanban is the task store and board mirror, and release/deployment automation stays off until the manual flow is reliable.

## 2. Product decisions

1. **Telegram is the team's primary work surface.** Captures and status commands happen in Telegram. Each task has one durable record that powers both the Telegram message and the web board; users never enter the same task twice.
2. **One configured group and a managed set of lifecycle topics.** Use Inbox, In Progress, Ready for Test, Needs Fix, Ready for Release, and Released / Done as the workflow topics. Add Bugs / Triage as an intake topic, while Bug remains a task type/filter rather than a workflow status. A task command may be invoked by reply from any topic in the approved group. The bot routes it to the appropriate intake topic and publishes a new task-card message in the destination topic whenever status changes.
3. **AI proposes structured fields; application rules control work.** The model may extract and summarize. Server-side code validates members, permissions, ownership, transitions, and release gates.
4. **No general chat-history scan.** A reply command can use the replied-to message, the user's instruction, and only explicitly remembered messages from the same group/topic. No open-ended history search is allowed.

## 3. Task capture experience

### Entry point

A teammate replies to a message in the configured Telegram group and sends:

```text
/task@<bot_username> Turn this into a task. Use relevant context if available; identify the owner and acceptance criteria.
```

The command text is the user's prompt. The replied-to message is the primary source. The bot records the source chat, source topic, message, sender, current task topic, and Telegram update identifiers so the task can link back to its source and repeated updates cannot create duplicate tasks. A normal task starts in Inbox; a production bug starts in Bugs / Triage. Once captured, the bot acknowledges the source reply with the task ID and posts a structured task card to that topic.

### Assistant behavior

- Extract a short title, optional description, owner, type, priority, and acceptance criteria.
- Map owners only to linked team members; never infer a person from an ambiguous nickname.
- Create the task when the title and exactly one owner are clear. Ask one focused follow-up when either is missing or ambiguous.
- Keep type, priority, and acceptance criteria optional for small tasks, consistent with the attached workflow.
- Show the created task identifier/status and a link to the board; include a link to the source message when Telegram permits it.
- Only an explicit `/task` command creates a task. Ordinary chat messages do not create cards.

### Topic Manager

Treat the topics as configured workflow destinations, not as independently editable copies of the task database.

- Store a mapping from `(group_chat_id, workflow_status)` to `message_thread_id`; keep Bugs / Triage as a separate intake mapping.
- MVP setup: a linked SmartKanban admin runs `/topics bind <status>` from inside each existing Telegram topic. `/topics status` lists the configured names and missing mappings. This avoids granting the bot topic-management rights just to route messages.
- Do not create topics automatically in v1. Have the team create the seven topics in Telegram, then bind each topic from inside it. A later setup helper can be considered if manual configuration proves painful and the group accepts granting `can_manage_topics`.
- Do not promise automatic discovery of topics: the current Bot API documents topic create/edit/close operations but no topic-list method. Keep manual binding as the reliable fallback.
- Topic names may be renamed by the group without changing their stored IDs. The manager should show the expected role/name for each ID and let an admin rebind a topic.
- Topic mapping changes must never rewrite task status. Status is canonical in SmartKanban; the mapping only decides where Telegram posts the current projection.

### Task card projection and status updates

Telegram's Bot API sends a message into a topic using `message_thread_id`; it does not document a method to move an existing message between topics. That is an inference from the documented Bot API method set. When a task changes status, keep the database task ID stable, post its refreshed card in the new status topic, and edit the old bot-authored card to say it moved and link to the new card when possible. Save every projection's `(chat_id, thread_id, message_id)` so stale buttons can be disabled and the current card can be updated safely. Never delete the prior card as a normal transition.

The board and Telegram commands must call the same server-side transition function. A database transaction records the state change, actor, transition, and an outbox item for Telegram delivery; a worker/retry path handles Telegram failures without rolling back or duplicating the task. If the send cannot be completed, the board remains correct and the bot reports/retries the failed mirror update.

## 4. Bounded context search and privacy

### Release 1: reply plus explicitly remembered context

Keep Telegram privacy mode enabled. Require the command to be explicitly addressed to the bot, so the bot receives the invocation and its replied-to source without subscribing to ordinary group messages. Search inputs are limited to the replied-to message, the `/task` prompt, explicitly remembered messages from the exact source chat/topic, and existing SmartKanban task records. Do not search DMs, other groups, or arbitrary Telegram history. If the information is insufficient, ask the user rather than expanding the search.

### Explicit remembered context

Use explicit per-message inclusion: a teammate replies to a message with `/remember`, which stores that message as searchable context; `/forget` removes it for the original author or the teammate who saved it. This keeps privacy mode enabled and makes the indexed set visible and intentional. Automatic capture of ordinary messages in selected topics is out of scope because Telegram's privacy setting is not per-topic. Safeguards:

- one configured group and exact source-topic scoping for each remembered message;
- 30-day retention for indexed message text, with automatic deletion after expiry;
- one local full-text search per `/task` request, returning at most 8 snippets and at most 4,000 context characters;
- one extraction operation through the configured provider path; the model cannot request another search or call tools;
- no cross-topic or cross-group retrieval;
- no LLM tool calling, recursive search, or second retrieval pass;
- send only the selected snippets to the model, with their author/date/source reference;
- show the source topic, message ID, date, and a link where Telegram permits it so a teammate can correct bad context.

These are initial hard caps, not goals for the model to manage. Search and deletion are enforced by application code. Prompt text and retrieved messages are untrusted data; they cannot change bot permissions or trigger commands. `/task` uses the replied-to source plus remembered messages from that exact chat/topic and reports which saved snippets matched.

**Telegram constraint:** the HTTP Bot API delivers updates; its pending update queue is not a searchable history store and updates are retained for no more than 24 hours. By default, group privacy mode limits which messages the bot receives. The assistant therefore cannot search arbitrary older conversation. Do not use a personal Telegram session or MTProto user-account login for v1.

**Guest Mode option:** Telegram Guest Mode can deliver an invocation and its replied-to message without making the bot a group member, but it is limited to one response and gives no history/future-message access. It may be prototyped for low-access capture, but it is not the default foundation for ongoing task status updates and notifications. See the [Telegram context retrieval research note](../../research/2026-09-23-telegram-context-retrieval.md).

Official references: [Telegram Bot API updates and forum methods](https://core.telegram.org/bots/api), [Telegram bot privacy mode](https://core.telegram.org/bots/features#privacy-mode), and [forum topics / message threads](https://core.telegram.org/bots/api#message).

## 5. Board and task lifecycle

Use these board states and matching Telegram topics from the attached workflow:

```text
Inbox → In Progress → Ready for Test → Needs Fix → Ready for Release → Released / Done
```

The six states above are the only workflow statuses and board columns. The **Bugs / Triage** Telegram topic is an intake queue, not a seventh state; Bug is a task type/filter, with P0–P3 priority. After triage and assignment, bugs enter the same six-state lifecycle as other work. Every task has exactly one owner. Testing must be assigned to someone other than the owner. A task cannot become Ready for Release until peer testing passes; a release cannot become Released until its staging checks pass and the deployed version/tag and commit SHA are recorded.

Allowed transitions are: Inbox → In Progress; In Progress → Ready for Test; Ready for Test → Needs Fix or Ready for Release; Needs Fix → In Progress; Ready for Release → Released / Done. Only the assigned tester can record a passing peer test, and the tester must differ from the owner. A release manager can mark release work Released / Done only after the release record has a passing staging result, deployed version/tag and commit SHA, and production smoke-check result. A small non-release task may finish after implementation, self-test, and peer verification; do not require release metadata for work that is not shipped in a release.

Keep the current live board/WebSocket approach, but replace free status dragging with the same validated transition rules used by Telegram. The board and Telegram actions update the same task record; the bot publishes the new task card in the mapped topic and notifies the next responsible person where appropriate. The board is a live view, not a second manual task system.

### Working rules and commands

- Capture every real task in Telegram, give it exactly one owner, and allow small tasks to use only title, owner, and status.
- Track type (Feature / Bug / Chore / Design), priority (P0–P3), acceptance criteria, branch URL, and PR URL when relevant. A P0 production issue enters Bugs / Triage and follows the hotfix path; lower priorities are triaged normally.
- Code tasks use a dedicated `feature/<name>`, `fix/<name>`, `chore/<name>`, or `hotfix/<name>` branch. Keep `main` releasable and merge through a lightweight PR. In v1, the assistant records branch/PR links and progress but does not push, merge, or deploy code.
- The owner self-tests and moves the task to Ready for Test. A different teammate records Pass or Fail; Fail routes to Needs Fix and returns ownership to the developer.
- Peer-tested work joins a release candidate. Run the staging smoke/regression checks before release; deploy a versioned/tagged build and record the exact commit SHA; run production smoke checks before closing release tasks.
- Use staging secrets, data, and services that are separate from production; identify every tested build by version and commit SHA. On a production bug, record which missed check would have caught it and add only a useful test/check to the process.
- Keep deployments manual in this phase. Add CI/test notifications or automatic deployment only after the manual path is working consistently.
- Suggested commands: `/task` capture; `/start` Inbox → In Progress; `/test` In Progress → Ready for Test; `/fail` Ready for Test → Needs Fix; `/approve` Ready for Test → Ready for Release (tester only); `/release` record a release candidate/result; `/done` Released / Done after production verification. Every command is checked against the transition table and caller role; command names never bypass a gate.
- Add a release record that groups selected Ready for Release tasks under one version/tag, commit SHA, staging result, production deployment result, and smoke-check result. This answers “which tasks shipped in this version?”

## 6. AI provider and failure behavior

Use OpenAI through the server-side `OPENAI_API_KEY`. The assistant must still work without an LLM: users can create and update tasks with explicit commands or through the web board. Model timeouts, malformed output, rate limits, or unavailable providers must never create partial/duplicate tasks.

Store only the structured task and source reference beyond the context-index retention period. Do not send the entire group history to the LLM. Keep provider keys server-side and impose an application-level request budget.

## 7. Delivery phases

### Phase 0 — Confirm team configuration

- Confirm the group's numeric chat ID and create/bind the six lifecycle topics plus Bugs / Triage.
- Link the three Telegram users to their SmartKanban accounts and short names.
- Confirm status transitions, owner/tester mapping, who may configure topics, and release-manager role.
- Keep the current explicit `/remember` index behavior: only explicitly saved messages are searchable, for 30 days, in the same topic.

### Phase 1 — Team task model and live board

- Extend the existing card/task model for one owner, task type, priority, acceptance criteria, tester, test result, release reference, and Telegram source identifiers.
- Replace the current Backlog/Today/In Progress/Done statuses with the six workflow states and labels. Define a data-preserving migration: Backlog → Inbox, In Progress → In Progress, Done → Released / Done (legacy completion, without inventing release metadata), and Today → Inbox with a `legacy-today` tag and migration activity entry so its previous meaning is recoverable.
- Keep one durable task record and preserve existing WebSocket update behavior.
- Make status validation a server-side domain function used by both HTTP board changes and Telegram commands; the frontend may hide invalid moves but cannot authorize them.
- Add task type, one-owner, tester, and release metadata to the live board without making the short-task path bureaucratic.

### Phase 2 — Telegram topic and reply-based capture

- Restrict task and topic-configuration commands to linked members in the configured group; restrict topic binding/setup and release-gate actions to designated admins/testers/release manager.
- Implement `/topics bind`, `/topics status`, and a no-surprise topic setup path; store stable topic IDs and validate that a task target is configured before accepting a transition.
- Accept an addressed `/task` reply from any topic; route normal work to Inbox and bugs to Bugs / Triage.
- Add projection history and idempotent transition delivery: publish in the new topic, mark the old bot card as superseded, and retain both task/source links.
- Add `/start`, `/test`, `/fail`, `/approve`, `/release`, and `/done`, with role/transition checks and a clear response for invalid or incomplete steps.

### Phase 3 — Structured AI extraction

- Add a strict JSON extraction schema and validate every field against linked team members and allowed values.
- Ask only for missing title/owner information; create directly when the required information is clear.
- Add timeouts, rate limits, deduplication, and a no-AI/manual fallback.

### Phase 4 — Scoped remembered context (partly implemented)

- Preserve explicit per-message opt-in through `/remember` and `/forget` in the exact source topic.
- Finish operational wiring and verification for indexed storage, same-topic full-text search, hard result/token caps, source references, and automatic expiry.
- Verify that no message outside the configured chat/topic reaches storage or an LLM prompt.

### Phase 5 — Peer test, staging, and release tracking

- Enforce owner/tester separation and the full transition state machine in DB-backed server logic.
- Add a release record with included tasks, version/tag, commit SHA, staging result, production deploy result, and production smoke-test result.
- Send Telegram notifications in the correct status topic for Ready for Test, Needs Fix, Ready for Release, and release outcomes.
- Keep deployments manual until this workflow is reliable, following the attached process document.

## 8. Acceptance criteria

- An explicitly addressed `/task` reply from any topic in the configured group creates at most one task, routes it to Inbox or Bugs / Triage, and preserves source topic/message references.
- `/topics status` shows all seven topic bindings; rebinding an ID does not change task status or task history.
- A valid status transition posts a fresh card in the mapped topic and marks the prior bot projection as superseded; failed Telegram delivery is retried without duplicate task records.
- An ordinary message or a command from an unconfigured group cannot create a task.
- The bot asks for clarification when the title or unique owner is missing; it does not invent a team member.
- No unremembered Telegram messages are searched or sent to an LLM; context retrieval is limited to the replied-to source and saved messages from that exact topic.
- Retrieval obeys exact source-chat/topic scoping, retention, result limit, and character cap; each task request performs one bounded retrieval and one extraction operation, with no recursive search.
- Board and Telegram show the same task state after a change; WebSocket subscribers receive the update; board drag and Telegram commands obey the same transition checks.
- A task owner cannot approve their own test; release gates and version metadata are enforced, and non-release tasks are not blocked on irrelevant deployment fields.
- AI provider failure leaves the task unchanged and offers a manual path.

## 9. Source of truth and implementation note

This plan is the authoritative product definition for this feature. Telegram API capabilities and privacy limits are sourced from the official references above; the attached PDF is the team-process reference. Before implementation, inspect the current bot handlers, card routes, database schema, and WebSocket payloads and mirror their actual contracts rather than inventing endpoint names or response shapes.
