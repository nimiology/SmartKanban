import fs from 'node:fs/promises';
import path from 'node:path';
import { Bot, InlineKeyboard, webhookCallback, type Context } from 'grammy';
import { pool } from '../db.js';
import { broadcast } from '../ws.js';
import { loadCard, logActivity, canUserSeeCard, postCardMessage, type Status } from '../cards.js';
import { transcribeAudio } from '../ai/whisper.js';
import { summarizeImage } from '../ai/vision.js';
import { AI_ENABLED } from '../ai/openai.js';
import { proposeFromText, type Proposal as AIProposal } from '../ai/propose.js';
import {
  createPending,
  deletePending,
  getLatestForUser,
  getPending,
  updatePending,
  type Destination,
  type PendingProposal,
} from './proposals.js';
import { defaultDestination, destinationOptions } from './destination.js';
import { searchCardsFts } from '../cards.js';
import { createLink, isCardLinkLabel, type CardLinkLabel } from '../card_links.js';
import { searchKnowledgeFts } from '../knowledge.js';
import { rankCandidates, type Candidate } from '../ai/dedupe.js';
import { findTemplateByName, instantiateTemplate, listTemplates } from '../templates.js';
import {
  createKnowledge,
  listKnowledge,
  loadKnowledge,
  updateKnowledge,
  archiveKnowledge,
  canUserSeeKnowledge,
  KnowledgeValidationError,
  validateUrl,
} from '../knowledge.js';
import { triggerFetch } from '../knowledge_fetch.js';
import {
  createInsight,
  countPendingByCard,
  countPendingByUser,
  countTodayByUser,
} from '../insights.js';
import { enqueueBrainstorm } from '../ai/brainstorm_queue.js';
import { isWorkflowAdmin, recordPeerTest, transitionCard, WorkflowError } from '../workflow.js';
import {
  forgetContextMessage,
  rememberContextMessage,
  REMEMBERED_CONTEXT_DAYS,
  rememberedContextForPrompt,
  searchRememberedContext,
} from './remembered_context.js';

let botInstance: Bot | null = null;
let pollingStarted = false;
let projectionTimer: ReturnType<typeof setInterval> | null = null;
const projectingCards = new Set<string>();

export function getBot(): Bot | null {
  return botInstance;
}

const ATTACHMENTS_DIR = path.resolve(process.env.ATTACHMENTS_DIR ?? 'data/attachments');

const STATUS_EMOJI: Record<Status, string> = {
  inbox: '📥',
  in_progress: '⚡',
  ready_for_test: '🧪',
  needs_fix: '🛠️',
  ready_for_release: '🚀',
  released: '✅',
};

const STATUS_LABEL: Record<Status, string> = {
  inbox: 'Inbox',
  in_progress: 'In Progress',
  ready_for_test: 'Ready for Test',
  needs_fix: 'Needs Fix',
  ready_for_release: 'Ready for Release',
  released: 'Released / Done',
};

function allowedGroupId(): number | null {
  const raw = process.env.TELEGRAM_GROUP_ID;
  return raw ? Number(raw) : null;
}

export async function hasTelegramWorkflowTopic(status: Status, workType: string): Promise<boolean> {
  const groupId = allowedGroupId();
  if (!groupId) return true;
  const route = status === 'inbox' && workType === 'bug' ? 'bugs' : status;
  const { rows } = await pool.query(
    `SELECT 1 FROM telegram_workflow_topics WHERE group_chat_id = $1 AND route_key = $2`,
    [groupId, route],
  );
  return rows.length > 0;
}

async function resolveAppUser(telegramUserId: number, username?: string): Promise<string | null> {
  const { rows } = await pool.query<{ app_user_id: string }>(
    `SELECT app_user_id FROM telegram_identities WHERE telegram_user_id = $1`,
    [telegramUserId],
  );
  if (rows[0]) return rows[0].app_user_id;
  // Fallback: try to link by matching users.name = '@username' if set elsewhere? Keep strict for now.
  return null;
}

// Extract `#tag` tokens; strip them from the text; return (tags, cleanText).
export function extractHashtags(text: string): { tags: string[]; text: string } {
  const tags: string[] = [];
  const cleaned = text.replace(/(^|\s)#([a-zA-Z0-9_\-]+)/g, (_m, lead, tag) => {
    tags.push(String(tag).toLowerCase());
    return lead;
  });
  return { tags: Array.from(new Set(tags)), text: cleaned.replace(/\s+/g, ' ').trim() };
}

// Parse leading slash-command; return { command, rest }.
export function parseCommand(text: string): { command: string | null; rest: string } {
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!m) return { command: null, rest: text };
  return { command: m[1]!.toLowerCase(), rest: m[2] ?? '' };
}

export type KnowledgeBotCommand =
  | { cmd: 'save'; url: string; title: string | undefined }
  | { cmd: 'save'; error: 'no url' }
  | { cmd: 'note'; title: string; body: string }
  | { cmd: 'note'; error: 'no body' }
  | { cmd: 'k'; q: string }
  | { cmd: 'k'; error: 'no query' }
  | { cmd: 'klist' };

const URL_RE = /^https?:\/\/\S+/;

export function parseKnowledgeCommand(text: string): KnowledgeBotCommand | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/save')) {
    const rest = trimmed.slice(5).trim();
    if (!rest) return { cmd: 'save', error: 'no url' };
    const [urlPart, ...titleParts] = rest.split('|').map((s) => s.trim());
    if (!urlPart || !URL_RE.test(urlPart)) return { cmd: 'save', error: 'no url' };
    return {
      cmd: 'save',
      url: urlPart,
      title: titleParts.length ? titleParts.join('|').trim() : undefined,
    };
  }
  if (trimmed.startsWith('/note')) {
    const rest = trimmed.slice(5);
    const stripped = rest.replace(/^\s+/, '');
    if (!stripped) return { cmd: 'note', error: 'no body' };
    const lines = stripped.split('\n');
    return {
      cmd: 'note',
      title: lines[0]!.slice(0, 200),
      body: lines.slice(1).join('\n').trimStart(),
    };
  }
  if (trimmed === '/klist' || trimmed.startsWith('/klist ') || trimmed.startsWith('/klist@')) {
    return { cmd: 'klist' };
  }
  if (trimmed === '/k' || trimmed.startsWith('/k ') || trimmed.startsWith('/k@')) {
    const q = trimmed.replace(/^\/k(@\S+)?\s*/, '').trim();
    if (!q) return { cmd: 'k', error: 'no query' };
    return { cmd: 'k', q };
  }
  return null;
}

function splitTitleDesc(text: string): { title: string; description: string } {
  const t = text.trim();
  if (t.length <= 60) return { title: t, description: '' };
  const nl = t.indexOf('\n');
  if (nl > 0 && nl <= 120) return { title: t.slice(0, nl).trim(), description: t.slice(nl + 1).trim() };
  return { title: t.slice(0, 57).trimEnd() + '…', description: t };
}

type CreateOpts = {
  title: string;
  description?: string;
  tags?: string[];
  createdBy: string;
  source: 'telegram';
  status?: Status;
  workType?: 'feature' | 'bug' | 'chore' | 'design';
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  acceptanceCriteria?: string[];
  aiSummarized?: boolean;
  needsReview?: boolean;
  assignees?: string[];
  telegramChatId?: number;
  telegramMessageId?: number;
};

async function createCard(opts: CreateOpts): Promise<string> {
  const status: Status = opts.status ?? 'inbox';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO cards
      (title, description, status, tags, source, created_by, ai_summarized, needs_review,
       telegram_chat_id, telegram_message_id, position, owner_user_id, work_type, priority, acceptance_criteria)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       COALESCE((SELECT MIN(position) - 1 FROM cards WHERE status = $3 AND NOT archived), 0),
       $11, $12, $13, $14)
     RETURNING id`,
    [
      opts.title.slice(0, 500),
      opts.description ?? '',
      status,
      opts.tags ?? [],
      opts.source,
      opts.createdBy,
      !!opts.aiSummarized,
      !!opts.needsReview,
      opts.telegramChatId ?? null,
      opts.telegramMessageId ?? null,
      opts.createdBy,
      opts.workType ?? 'chore',
      opts.priority ?? 'P2',
      opts.acceptanceCriteria ?? [],
    ],
  );
  const cardId = rows[0]!.id;
  if (opts.assignees && opts.assignees.length > 0) {
    await pool.query(
      `INSERT INTO card_assignees (card_id, user_id)
       SELECT $1, UNNEST($2::uuid[]) ON CONFLICT DO NOTHING`,
      [cardId, opts.assignees],
    );
  }
  return cardId;
}

const WORKFLOW_ROUTES: Record<string, Status | 'bugs'> = {
  inbox: 'inbox',
  'in-progress': 'in_progress',
  'ready-for-test': 'ready_for_test',
  'needs-fix': 'needs_fix',
  'ready-for-release': 'ready_for_release',
  released: 'released',
  bugs: 'bugs',
};

async function projectCardToTopic(cardId: string): Promise<void> {
  await pool.query(
    `INSERT INTO telegram_projection_outbox (card_id) VALUES ($1)
     ON CONFLICT (card_id) DO UPDATE SET next_attempt_at = NOW(), updated_at = NOW()`,
    [cardId],
  );
  if (projectingCards.has(cardId)) return;
  projectingCards.add(cardId);
  try {
    const delivered = await projectCardToTopicUnsafe(cardId);
    if (!delivered) {
      await pool.query(
        `UPDATE telegram_projection_outbox SET attempts = attempts + 1,
           next_attempt_at = NOW() + LEAST(3600, 30 * POWER(2, LEAST(attempts, 7))) * INTERVAL '1 second',
           last_error = 'projection unavailable or not delivered', updated_at = NOW()
         WHERE card_id = $1`, [cardId],
      );
    }
  } catch (error) {
    console.error('[telegram] task topic projection failed:', error);
    await pool.query(
      `UPDATE telegram_projection_outbox SET attempts = attempts + 1,
         next_attempt_at = NOW() + LEAST(3600, 30 * POWER(2, LEAST(attempts, 7))) * INTERVAL '1 second',
         last_error = $2, updated_at = NOW()
       WHERE card_id = $1`,
      [cardId, String(error).slice(0, 500)],
    ).catch(() => {});
  } finally {
    projectingCards.delete(cardId);
  }
}

export async function publishTelegramTaskProjection(cardId: string): Promise<void> {
  await projectCardToTopic(cardId);
}

async function projectCardToTopicUnsafe(cardId: string): Promise<boolean> {
  const groupId = allowedGroupId();
  if (!groupId || !botInstance) return false;
  const card = await loadCard(cardId);
  if (!card) return false;
  const routeKey = card.status === 'inbox' && card.work_type === 'bug' ? 'bugs' : card.status;
  const { rows: topicRows } = await pool.query<{ thread_id: string }>(
    `SELECT thread_id FROM telegram_workflow_topics WHERE group_chat_id = $1 AND route_key = $2`,
    [groupId, routeKey],
  );
  const threadId = topicRows[0]?.thread_id;
  if (!threadId) return false;

  const owner = card.owner_user_id ? await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`, [card.owner_user_id],
  ) : { rows: [] as Array<{ name: string }> };
  const tester = card.tester_user_id ? await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`, [card.tester_user_id],
  ) : { rows: [] as Array<{ name: string }> };
  const lines = [
    `${STATUS_EMOJI[card.status]} ${card.title}`,
    `#${card.work_type} · ${card.priority} · ${STATUS_LABEL[card.status]}`,
    `Owner: ${owner.rows[0]?.name ?? 'unassigned'} · Tester: ${tester.rows[0]?.name ?? 'unassigned'}`,
    `Task ID: ${card.id}`,
  ];
  if (card.acceptance_criteria.length) lines.push(`Acceptance: ${card.acceptance_criteria.join(' · ')}`);
  if (card.branch_url) lines.push(`Branch: ${card.branch_url}`);
  if (card.pull_request_url) lines.push(`PR: ${card.pull_request_url}`);
  if (card.peer_test_notes) lines.push(`Test notes: ${card.peer_test_notes}`);
  const nextUserIds = card.status === 'ready_for_test'
    ? (card.tester_user_id ? [card.tester_user_id] : [])
    : card.status === 'needs_fix'
      ? (card.owner_user_id ? [card.owner_user_id] : [])
      : card.status === 'ready_for_release' || card.status === 'released'
        ? (await pool.query<{ id: string }>(`SELECT id FROM users WHERE is_admin`)).rows.map((row) => row.id)
        : [];
  if (nextUserIds.length) {
    const { rows } = await pool.query<{ telegram_username: string | null; name: string | null }>(
      `SELECT DISTINCT ON (u.id) ti.telegram_username, u.short_name AS name
       FROM users u LEFT JOIN telegram_identities ti ON ti.app_user_id = u.id
       WHERE u.id = ANY($1::uuid[]) ORDER BY u.id, ti.created_at ASC`,
      [nextUserIds],
    );
    const mentions = rows.map((row) => row.telegram_username ? `@${row.telegram_username}` : row.name ?? 'teammate');
    if (mentions.length) lines.push(`Next: ${mentions.join(', ')}`);
  }
  const prior = await pool.query<{ message_id: string; thread_id: string }>(
    `SELECT message_id, thread_id FROM telegram_task_messages
     WHERE card_id = $1 AND is_current LIMIT 1`, [cardId],
  );
  const moved = prior.rows[0]
    ? `\n↪ Moved to ${routeKey.replaceAll('_', ' ')}. The current task card is posted below.`
    : '';
  if (prior.rows[0]) {
    try {
      await botInstance.api.editMessageText(
        groupId,
        Number(prior.rows[0].message_id),
        `${card.title}\n${moved}`,
      );
    } catch { /* old projection may have been deleted or become uneditable */ }
  }
  let sent;
  try {
    sent = await botInstance.api.sendMessage(groupId, lines.join('\n'), {
      message_thread_id: Number(threadId),
      link_preview_options: { is_disabled: true },
      reply_markup: postSaveKeyboard(card.id, card.status),
    });
  } catch (error) {
    console.error('[telegram] task topic projection failed:', error);
    return false;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE telegram_task_messages SET is_current = FALSE WHERE card_id = $1 AND is_current`, [cardId]);
    await client.query(
      `INSERT INTO telegram_task_messages (card_id, chat_id, thread_id, message_id, is_current)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [cardId, groupId, threadId, sent.message_id],
    );
    await client.query(`DELETE FROM telegram_projection_outbox WHERE card_id = $1`, [cardId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[telegram] task projection index update failed:', error);
    return false;
  } finally {
    client.release();
  }
  return true;
}

async function flushProjectionOutbox(): Promise<void> {
  const { rows } = await pool.query<{ card_id: string }>(
    `SELECT card_id FROM telegram_projection_outbox WHERE next_attempt_at <= NOW()
     ORDER BY updated_at LIMIT 25`,
  );
  for (const row of rows) await projectCardToTopic(row.card_id);
}

async function cardForReply(
  chatId: number | undefined,
  replyToMessageId: number | undefined,
): Promise<string | null> {
  if (!chatId || !replyToMessageId) return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM cards WHERE telegram_chat_id = $1 AND telegram_message_id = $2
     UNION ALL
     SELECT card_id AS id FROM telegram_task_messages
     WHERE chat_id = $1 AND message_id = $2 LIMIT 1`,
    [chatId, replyToMessageId],
  );
  return rows[0]?.id ?? null;
}

// Map @usernames mentioned in the command body to app user IDs via telegram_identities.
async function usersFromMentions(mentions: string[]): Promise<string[]> {
  const clean = mentions.map((m) => m.replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (clean.length === 0) return [];
  const { rows } = await pool.query<{ app_user_id: string }>(
    `SELECT DISTINCT app_user_id FROM telegram_identities WHERE LOWER(telegram_username) = ANY($1::text[])`,
    [clean],
  );
  return rows.map((r) => r.app_user_id);
}

export function extractMentions(text: string): string[] {
  const m = text.match(/@[A-Za-z0-9_]{3,}/g) ?? [];
  return Array.from(new Set(m));
}

async function attachFile(
  cardId: string,
  kind: 'audio' | 'image' | 'file',
  storagePath: string,
  originalFilename?: string,
): Promise<void> {
  // storagePath is saved relative so we can relocate the data dir later.
  const rel = path.relative(ATTACHMENTS_DIR, storagePath);
  await pool.query(
    `INSERT INTO card_attachments (card_id, kind, storage_path, original_filename)
     VALUES ($1, $2, $3, $4)`,
    [cardId, kind, rel, originalFilename ?? null],
  );
}

async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  cardId: string,
  ext: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = path.join(ATTACHMENTS_DIR, cardId);
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${fileId}${ext}`);
  await fs.writeFile(outPath, buf);
  return outPath;
}

type ReactionEmoji = '👍' | '🤔';
async function reactOk(ctx: Context, emoji: ReactionEmoji = '👍'): Promise<void> {
  try {
    await ctx.api.setMessageReaction(ctx.chat!.id, ctx.msg!.message_id, [
      { type: 'emoji', emoji },
    ]);
  } catch {}
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, ''))));
}

function proposalText(p: AIProposal, links: string[] = []): string {
  const tags = p.tags.length ? `\nTags: ${p.tags.map((t) => `#${t}`).join(' ')}` : '';
  const desc = p.description ? `\n\n${p.description}` : '';
  const linksBlock = links.length
    ? `\n\n🔗 ${links.map((l) => `[link](${l})`).join('  ·  ')}`
    : '';
  const hint = p.is_actionable
    ? ''
    : '\n\n_Doesn\'t look like a task — save anyway if you want._';
  return `📝 *${escapeMd(p.title)}*${desc}${tags}${linksBlock}${hint}`;
}

function escapeMd(s: string): string {
  // Minimal escaping for MarkdownV2-ish safety; we use Markdown mode for bold only.
  return s.replace(/([_*`\[\]])/g, '\\$1');
}

// ---------- structured-capture keyboards (new flow) ----------

function destinationKeyboard(
  pid: string,
  def: Destination,
  isPrivateChat: boolean,
  taskOnly = false,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const options = destinationOptions(isPrivateChat).filter(
    (option) => !taskOnly || option.key !== 'knowledge',
  );
  for (const o of options) {
    kb.text(`${o.key === def ? '✓ ' : ''}${o.label}`, `dest:${o.key}:${pid}`);
  }
  kb.row()
    .text('🤖 Check duplicates with AI', `dup:check:${pid}`)
    .text('🔗 Link to existing', `linkpick:${pid}`);
  kb.row()
    .text('✏️ Edit', `edit:${pid}`)
    .text('❌ Cancel', `drop:${pid}`);
  return kb;
}

function captureChoiceKeyboard(pid: string, mediaLabel?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (AI_ENABLED()) {
    kb.text(mediaLabel ? `🤖 ${mediaLabel} with OpenAI` : '🤖 Draft with OpenAI', `capture:ai:${pid}`);
  }
  kb.text(mediaLabel ? '✍️ Enter task manually' : '✍️ Save my text as task', `capture:manual:${pid}`)
    .row()
    .text('❌ Cancel', `drop:${pid}`);
  return kb;
}

function correctionChoiceKeyboard(pid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🤖 Apply with OpenAI', `capture:edit-ai:${pid}`)
    .text('✍️ Use correction as written', `capture:edit-manual:${pid}`)
    .row()
    .text('❌ Cancel', `drop:${pid}`);
}

function plainProposal(text: string, fallbackTitle = 'New task'): AIProposal {
  const { tags, text: clean } = extractHashtags(text);
  const { title, description } = splitTitleDesc(clean);
  return {
    is_actionable: true,
    title: (title || fallbackTitle).slice(0, 120),
    description,
    tags: tags.slice(0, 3),
    reason: 'created from user-provided text without AI',
  };
}

async function sendCaptureChoice(
  ctx: Context,
  pending: PendingProposal,
  prompt: string,
  mediaLabel?: string,
): Promise<void> {
  const aiConfigured = AI_ENABLED();
  const message = await ctx.reply(
    `${prompt}\n\n${aiConfigured
      ? 'I will only send this content to OpenAI if you choose the OpenAI button.'
      : 'OpenAI is not configured here; no AI call will be made.'}`,
    { reply_markup: captureChoiceKeyboard(pending.id, mediaLabel) },
  );
  updatePending(pending.id, { promptMessageId: message.message_id });
}

function helpText(): string {
  return [
    'I ignore normal group conversation. Mention me, use a command, or reply to one of my active prompts.',
    '',
    'Create tasks',
    '• Mention me with a task: `@bot Add dark mode`',
    '• Reply to a message with `/task [instruction]`',
    '• Choose “Draft with OpenAI” or “Save my text as task” — I do not call OpenAI unless you tap its button.',
    '• Send me a task in a private chat to get the same choices.',
    '• `/today <task>` saves the text directly without AI.',
    '',
    'Remember topic context',
    '• Reply to a message with `/remember [note]` or `/forget`.',
    '',
    'Task workflow (reply to a task card)',
    '• `/start`, `/test`, `/approve`, `/fail [notes]`',
    '• `/topics status` shows topic bindings; admins can use `/topics bind <route>` inside a topic.',
    '• `/assign @user` and `/share @user` update a task.',
    '• Admins: `/release <version> <commit-sha> <pass|fail> [notes]`, then `/done <version> <commit-sha> <pass|fail> [notes]`.',
    '',
    'Knowledge and templates (private chat)',
    '• `/save <url> | <title>`, `/note <title> | <body>`, `/k <query>`, `/klist`.',
    '• `/templates` lists templates; `/use <template>` creates one.',
    '',
    'Other',
    '• `/help` shows this guide.',
    '• AI brainstorm and duplicate checks run only when you tap their clearly labeled AI buttons. Use `@ai` in a card discussion when you want an AI reply.',
  ].join('\n');
}

function columnKeyboard(pid: string): InlineKeyboard {
  return new InlineKeyboard().text('📥 Inbox', `col:inbox:${pid}`);
}

function attachmentKindKeyboard(pid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✨ New', `att:new:${pid}`)
    .text('🔗 Attach to existing', `att:pick:${pid}`)
    .row()
    .text('❌ Cancel', `drop:${pid}`);
}

function attachPickerKeyboard(
  pid: string,
  items: Array<{ id: string; kind: 'card' | 'knowledge'; label: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const it of items) {
    kb.text(`Pick: ${it.label.slice(0, 50)}`, `att:to:${it.kind}:${it.id}:${pid}`).row();
  }
  kb.text('❌ Cancel', `drop:${pid}`);
  return kb;
}

function dupResultsKeyboard(
  pid: string,
  matches: Array<{ kind: 'card' | 'knowledge'; id: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const top = matches[0];
  if (top) {
    kb.text(
      `🔗 Link to ${top.kind === 'card' ? 'card' : 'knowledge'}`,
      `dup:link:${top.kind}:${top.id}:${pid}`,
    );
    kb.text('👁 Same — just touch', `dup:touch:${top.kind}:${top.id}:${pid}`).row();
  }
  kb.text('+ Save anyway', `dup:save:${pid}`).row().text('❌ Cancel', `drop:${pid}`);
  return kb;
}

function postSaveKeyboard(cardId: string, currentStatus: Status): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (currentStatus === 'inbox') kb.text('▶️ Start', `wf:start:${cardId}`);
  if (currentStatus === 'in_progress') kb.text('🧪 Submit for test', `wf:test:${cardId}`);
  if (currentStatus === 'ready_for_test') {
    kb.text('✅ Approve', `wf:approve:${cardId}`).text('🛠️ Needs fix', `wf:fail:${cardId}`);
  }
  kb.text('🗑', `arch:${cardId}`);
  kb.row().text('🤖 AI brainstorm', `brain:${cardId}`);
  return kb;
}

function taskContextDetails(pending: PendingProposal): Record<string, unknown> {
  if (pending.taskSourceMessageId === undefined) return {};
  return {
    source_message_id: pending.taskSourceMessageId,
    source_thread_id: pending.taskSourceThreadId ?? 0,
    remembered_context_message_ids: pending.contextMessageIds ?? [],
  };
}

async function sendProposal(
  ctx: Context,
  pendingId: string,
  p: AIProposal,
  isPrivateChat: boolean,
  links: string[] = [],
): Promise<number | null> {
  const def = defaultDestination(p, isPrivateChat, links.join(' '));
  try {
    const msg = await ctx.reply(proposalText(p, links), {
      parse_mode: 'Markdown',
      reply_markup: destinationKeyboard(
        pendingId,
        def,
        isPrivateChat,
        getPending(pendingId)?.taskSourceMessageId !== undefined,
      ),
      reply_parameters: { message_id: ctx.msg!.message_id, allow_sending_without_reply: true },
    });
    return msg.message_id;
  } catch {
    return null;
  }
}

// ---------- handlers ----------
async function handleText(
  ctx: Context,
  text: string,
  createdBy: string,
  isPrivate = false,
): Promise<void> {
  const { command, rest } = parseCommand(text);
  const body = command ? rest : text;

  if (command === 'help') {
    await ctx.reply(helpText());
    return;
  }

  // If the user has a pending proposal awaiting a correction or a link,
  // route this message accordingly and re-show the updated proposal.
  const tgUserId = ctx.from?.id;
  if (tgUserId && !command) {
    const existing = getLatestForUser(tgUserId);
    if (existing?.awaitingManual) {
      const proposal = plainProposal(text, existing.captureType === 'photo' ? 'Photo task' : existing.captureType === 'voice' ? 'Voice task' : 'New task');
      updatePending(existing.id, { proposal, manualText: text, awaitingManual: false, aiSummarized: false });
      if (existing.captureType === 'photo' || existing.captureType === 'voice') {
        const message = await ctx.reply(
          `✍️ Manual task details saved: ${proposal.title}\n\nCreate a new task or attach this file to an existing task?`,
          { reply_markup: attachmentKindKeyboard(existing.id) },
        );
        updatePending(existing.id, { promptMessageId: message.message_id });
      } else {
        const messageId = await sendProposal(ctx, existing.id, proposal, existing.isPrivateChat);
        updatePending(existing.id, { promptMessageId: messageId });
      }
      return;
    }
    if (existing && existing.awaitingEdit) {
      updatePending(existing.id, { awaitingEdit: false, correction: text });
      const message = await ctx.reply(
        'Correction received. Choose whether to apply it with OpenAI or use it as written.',
        { reply_markup: correctionChoiceKeyboard(existing.id) },
      );
      updatePending(existing.id, { promptMessageId: message.message_id });
      return;
    }
    if (existing && existing.awaitingLinks) {
      const urls = extractUrls(text);
      if (urls.length === 0) {
        await ctx.reply('No URL detected — send a link starting with http(s)://');
        return;
      }
      const merged = Array.from(new Set([...existing.links, ...urls]));
      updatePending(existing.id, { links: merged, awaitingLinks: false });
      const msgId = await sendProposal(
        ctx,
        existing.id,
        existing.proposal,
        existing.isPrivateChat,
        merged,
      );
      updatePending(existing.id, { promptMessageId: msgId });
      return;
    }
    if (existing && (existing.attachMode === 'pickRecent' || existing.attachMode === 'pickFiltered')) {
      await showAttachPicker(ctx, existing, text);
      return;
    }
    if (existing && existing.awaitingLinkNote) {
      updatePending(existing.id, { awaitingLinkNote: false });
      await finalizeCardWithLink(ctx, existing, text.slice(0, 500));
      return;
    }
  }

  // Reply-based commands: /assign, /share, and workflow actions use the referenced card.
  const replyToId = ctx.msg?.reply_to_message?.message_id;
  const chatId = ctx.chat?.id;
  const referencedCardId = await cardForReply(chatId, replyToId);

  if (command === 'release' || command === 'done') {
    if (isPrivate || chatId !== allowedGroupId() || !(await isWorkflowAdmin(createdBy))) {
      await ctx.reply('Release checks are available to workflow admins in the configured group.');
      return;
    }
    const match = rest.trim().match(/^(\S+)\s+([a-f0-9]{40})\s+(pass|fail)(?:\s+([\s\S]+))?$/i);
    if (!match) {
      await ctx.reply(command === 'release'
        ? 'Usage: `/release <version> <commit-sha> <pass|fail> [staging notes]`'
        : 'Usage: `/done <version> <commit-sha> <pass|fail> [production smoke notes]`',
      { parse_mode: 'Markdown' });
      return;
    }
    const [, version, rawSha, result, notes = ''] = match;
    const sha = rawSha!.toLowerCase();
    const passed = result!.toLowerCase() === 'pass';
    if (command === 'release') {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workflow_releases (version, commit_sha, staging_result, staging_notes, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (version) DO UPDATE SET
           staging_result = EXCLUDED.staging_result,
           staging_notes = EXCLUDED.staging_notes,
           updated_at = NOW()
         WHERE workflow_releases.commit_sha = EXCLUDED.commit_sha
           AND workflow_releases.production_result <> 'passed'
         RETURNING id`,
        [version, sha, passed ? 'passed' : 'failed', notes.slice(0, 2_000), createdBy],
      );
      if (!rows[0]) {
        await ctx.reply('That version already exists with a different commit SHA or has completed production release.');
        return;
      }
      const linked = passed
        ? await pool.query(
          `UPDATE cards SET release_id = $1, updated_at = NOW()
           WHERE status = 'ready_for_release' AND NOT archived AND (release_id IS NULL OR release_id = $1)`,
          [rows[0].id],
        )
        : { rowCount: 0 };
      await ctx.reply(passed
        ? `✅ Staging passed for ${version} (${sha.slice(0, 12)}). Linked ${linked.rowCount ?? 0} Ready for Release tasks. Run /done after production smoke checks.`
        : `❌ Staging failed for ${version} (${sha.slice(0, 12)}). ${notes ? 'Notes recorded.' : 'Add notes with the command.'}`);
      return;
    }

    const client = await pool.connect();
    let releasedIds: string[] = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        id: string; commit_sha: string; staging_result: string; production_result: string;
      }>(
        `SELECT id, commit_sha, staging_result, production_result
         FROM workflow_releases WHERE version = $1 FOR UPDATE`, [version],
      );
      const release = rows[0];
      if (!release || release.commit_sha.toLowerCase() !== sha) {
        throw new WorkflowError('Release version or exact commit SHA does not match staging.');
      }
      if (release.staging_result !== 'passed') {
        throw new WorkflowError('Production cannot be marked until staging has passed.');
      }
      if (release.production_result === 'passed') {
        throw new WorkflowError('This release has already passed production smoke checks.');
      }
      await client.query(
        `UPDATE workflow_releases SET production_result = $2, production_notes = $3,
           deployed_at = CASE WHEN $2 = 'passed' THEN NOW() ELSE deployed_at END, updated_at = NOW()
         WHERE id = $1`,
        [release.id, passed ? 'passed' : 'failed', notes.slice(0, 2_000)],
      );
      if (passed) {
        const cards = await client.query<{ id: string; status: Status }>(
          `UPDATE cards SET status = 'released', updated_at = NOW()
           WHERE release_id = $1 AND status = 'ready_for_release' AND NOT archived
           RETURNING id, status`, [release.id],
        );
        releasedIds = cards.rows.map((card) => card.id);
        for (const id of releasedIds) {
          await client.query(
            `INSERT INTO card_events (actor_id, card_id, action, details)
             VALUES ($1, $2, 'workflow.transition', $3)`,
            [createdBy, id, { from: 'ready_for_release', to: 'released', release_version: version, commit_sha: sha }],
          );
          await client.query(
            `INSERT INTO telegram_projection_outbox (card_id) VALUES ($1)
             ON CONFLICT (card_id) DO UPDATE SET next_attempt_at = NOW(), updated_at = NOW()`, [id],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await ctx.reply(error instanceof WorkflowError ? error.message : 'Could not record production verification.');
      return;
    } finally {
      client.release();
    }
    for (const id of releasedIds) {
      const card = await loadCard(id);
      if (card) {
        broadcast({ type: 'card.updated', card });
        await projectCardToTopic(id);
      }
    }
    await ctx.reply(passed
      ? `✅ Production smoke passed for ${version}. Released ${releasedIds.length} tasks.`
      : `❌ Production smoke failed for ${version}. Tasks remain Ready for Release.`);
    return;
  }

  if (command === 'topics') {
    const allowed = allowedGroupId();
    if (isPrivate || chatId === undefined || allowed === null || chatId !== allowed) {
      await ctx.reply('Topic management is available only in the configured Telegram group.');
      return;
    }
    if (!(await isWorkflowAdmin(createdBy))) {
      await ctx.reply('Only a workflow admin can bind topic routes.');
      return;
    }
    const [action, route] = rest.trim().toLowerCase().split(/\s+/, 2);
    if (action === 'bind') {
      const routeKey = route ? WORKFLOW_ROUTES[route] : undefined;
      const threadId = ctx.msg?.message_thread_id;
      if (!routeKey || !threadId) {
        await ctx.reply('Open a forum topic and run `/topics bind inbox|in-progress|ready-for-test|needs-fix|ready-for-release|released|bugs` there.', { parse_mode: 'Markdown' });
        return;
      }
      try {
        await pool.query(
          `INSERT INTO telegram_workflow_topics (group_chat_id, route_key, thread_id, bound_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (group_chat_id, route_key) DO UPDATE
             SET thread_id = EXCLUDED.thread_id, bound_by = EXCLUDED.bound_by, updated_at = NOW()`,
          [chatId, routeKey, threadId, createdBy],
        );
        await ctx.reply(`Bound this topic to ${routeKey === 'bugs' ? 'Bugs / Triage' : STATUS_LABEL[routeKey]}.`);
      } catch (error) {
        console.error('[telegram] topic bind failed:', error);
        await ctx.reply('That topic is already bound to another workflow route. Check `/topics status`.');
      }
      return;
    }
    if (action === 'status') {
      const { rows } = await pool.query<{ route_key: string; thread_id: string }>(
        `SELECT route_key, thread_id FROM telegram_workflow_topics WHERE group_chat_id = $1 ORDER BY route_key`,
        [chatId],
      );
      await ctx.reply(rows.length
        ? `Workflow topic bindings:\n${rows.map((row) => `• ${row.route_key}: topic ${row.thread_id}`).join('\n')}`
        : 'No topic routes are bound. Run `/topics bind <route>` from each forum topic.',
      { parse_mode: 'Markdown' });
      return;
    }
    await ctx.reply('Use `/topics status` or run `/topics bind <route>` from inside a forum topic.', { parse_mode: 'Markdown' });
    return;
  }

  if (['start', 'test', 'approve', 'fail'].includes(command ?? '')) {
    const allowed = allowedGroupId();
    if (isPrivate || chatId === undefined || allowed === null || chatId !== allowed) {
      await ctx.reply('Workflow actions are available only in the configured Telegram group.');
      return;
    }
    if (!referencedCardId) {
      await ctx.reply(`Reply to a task card with /${command}${command === 'fail' ? ' <test notes>' : ''}.`);
      return;
    }
    try {
      const targetStatus: Status = command === 'start' ? 'in_progress'
        : command === 'test' ? 'ready_for_test'
          : command === 'approve' ? 'ready_for_release' : 'needs_fix';
      const task = await loadCard(referencedCardId);
      if (task && !(await hasTelegramWorkflowTopic(targetStatus, task.work_type))) {
        await ctx.reply(`Bind the ${STATUS_LABEL[targetStatus]} topic first with /topics bind ${targetStatus.replaceAll('_', '-')}.`);
        return;
      }
      const updated = command === 'start'
        ? await transitionCard(referencedCardId, createdBy, 'in_progress')
        : command === 'test'
          ? await transitionCard(referencedCardId, createdBy, 'ready_for_test')
          : await recordPeerTest(referencedCardId, createdBy, command === 'approve', rest.trim());
      broadcast({ type: 'card.updated', card: updated });
      await projectCardToTopic(updated.id);
      await ctx.reply(`${STATUS_EMOJI[updated.status]} ${updated.title} → ${STATUS_LABEL[updated.status]}`);
    } catch (error) {
      if (error instanceof WorkflowError) await ctx.reply(error.message);
      else {
        console.error('[telegram] workflow action failed:', error);
        await ctx.reply('Could not update that task.');
      }
    }
    return;
  }

  if (command === 'remember' || command === 'forget') {
    const allowed = allowedGroupId();
    const source = ctx.msg?.reply_to_message;
    const sourceText = (source?.text ?? source?.caption ?? '').trim();
    if (isPrivate || chatId === undefined || allowed === null || chatId !== allowed) {
      await ctx.reply('This command is available only in the configured Telegram group.');
      return;
    }
    if (!source || !source.message_id) {
      await ctx.reply(`Reply to a text message with /${command}${command === 'remember' && rest.trim() ? ' <optional note>' : ''}.`);
      return;
    }
    if (!sourceText || source.from?.is_bot || source.from?.id === undefined) {
      await ctx.reply('I can remember text messages from people, not bot messages or media without a caption.');
      return;
    }
    const threadId = source.message_thread_id ?? ctx.msg?.message_thread_id ?? 0;
    try {
      if (command === 'remember') {
        await rememberContextMessage({
          chatId,
          threadId,
          messageId: source.message_id,
          sourceUserId: source.from.id,
          rememberedBy: createdBy,
          body: sourceText,
          note: rest,
        });
        await ctx.reply(`🧠 Remembered for ${REMEMBERED_CONTEXT_DAYS} days. It can be used as task context only in this same topic.`);
      } else {
        const removed = await forgetContextMessage(
          chatId,
          threadId,
          source.message_id,
          createdBy,
          ctx.from!.id,
        );
        await ctx.reply(removed
          ? '🗑 Removed from remembered context.'
          : 'Not found, or only the person who remembered it or the original author can forget it.');
      }
    } catch (error) {
      console.error('[telegram] remembered-context command failed:', error);
      await ctx.reply('Could not update remembered context. Check that the database schema has been applied.');
    }
    return;
  }

  if (command === 'task') {
    const allowed = allowedGroupId();
    const source = ctx.msg?.reply_to_message;
    if (isPrivate || chatId === undefined || allowed === null || chatId !== allowed) {
      await ctx.reply('Use /task as a reply inside the configured Telegram group.');
      return;
    }
    if (!source || source.from?.is_bot || !(source.text ?? source.caption)?.trim()) {
      await ctx.reply('Reply to a person\'s text message with /task <instruction>.');
      return;
    }

    const sourceText = (source.text ?? source.caption ?? '').trim().slice(0, 2_000);
    const instruction = rest.trim().slice(0, 1_000);
    const guessedType = /#bug\b|\bbug\b/i.test(`${instruction} ${sourceText}`) ? 'bug' : 'chore';
    if (!(await hasTelegramWorkflowTopic('inbox', guessedType))) {
      await ctx.reply(`Bind the ${guessedType === 'bug' ? 'Bugs / Triage' : 'Inbox'} topic first with /topics bind ${guessedType === 'bug' ? 'bugs' : 'inbox'}.`);
      return;
    }
    const original = [
      instruction ? `Task instruction: ${instruction}` : 'Task instruction: Create a task from the replied-to message.',
      `Replied-to message: ${sourceText}`,
    ].join('\n');
    const threadId = source.message_thread_id ?? ctx.msg?.message_thread_id ?? 0;
    const manualText = [instruction, sourceText].filter(Boolean).join('\n\n');
    const pending = createPending({
      tgUserId: ctx.from!.id,
      appUserId: createdBy,
      chatId,
      isPrivateChat: false,
      original,
      proposal: plainProposal(manualText),
    });
    updatePending(pending.id, {
      captureType: 'text',
      manualText,
      captureMessageId: ctx.msg?.message_id,
      taskSourceMessageId: source.message_id,
      taskSourceThreadId: threadId,
      taskWorkType: guessedType,
    });
    await sendCaptureChoice(ctx, pending, 'Task request is ready. Draft it with AI, or save your text as the task. The AI option may also include matching messages you explicitly saved with /remember in this topic.');
    return;
  }

  if (command === 'assign' && referencedCardId) {
    const userIds = await usersFromMentions(extractMentions(rest));
    if (userIds.length > 0) {
      await pool.query(`DELETE FROM card_assignees WHERE card_id = $1`, [referencedCardId]);
      await pool.query(
        `INSERT INTO card_assignees (card_id, user_id) SELECT $1, UNNEST($2::uuid[]) ON CONFLICT DO NOTHING`,
        [referencedCardId, userIds],
      );
      await logActivity(createdBy, referencedCardId, 'telegram.assign', { assignees: userIds });
      const card = (await loadCard(referencedCardId))!;
      broadcast({ type: 'card.updated', card });
      await reactOk(ctx);
    } else {
      await reactOk(ctx, '🤔');
    }
    return;
  }

  if (command === 'share' && referencedCardId) {
    const userIds = await usersFromMentions(extractMentions(rest));
    if (userIds.length > 0) {
      for (const uid of userIds) {
        await pool.query(
          `INSERT INTO card_shares (card_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [referencedCardId, uid],
        );
      }
      await logActivity(createdBy, referencedCardId, 'telegram.share', { shares: userIds });
      const card = (await loadCard(referencedCardId))!;
      broadcast({ type: 'card.updated', card });
      await reactOk(ctx);
    } else {
      await reactOk(ctx, '🤔');
    }
    return;
  }

  // Legacy /today alias creates a task in the new Inbox workflow.
  const { tags, text: clean } = extractHashtags(body);
  if (command === 'today') {
    const { title, description } = splitTitleDesc(clean);
    if (!title) return;
    const cardId = await createCard({
      title,
      description,
      tags,
      createdBy,
      source: 'telegram',
      status: 'inbox',
      telegramChatId: chatId,
      telegramMessageId: ctx.msg?.message_id,
      assignees: isPrivate ? [createdBy] : undefined,
    });
    await logActivity(createdBy, cardId, 'telegram.today');
    const card = (await loadCard(cardId))!;
    broadcast({ type: 'card.created', card });
    await reactOk(ctx);
    return;
  }

  // Templates: only meaningful in DM. Group invocations are silent (early return)
  // to prevent the command body from being passed to the AI-propose flow as a card seed.
  if ((command === 'use' || command === 't' || command === 'templates') && !isPrivate) {
    return;
  }
  if ((command === 'use' || command === 't') && isPrivate) {
    const name = rest.trim();
    if (!name) {
      await ctx.reply('Usage: `/use <template>` — see `/templates` for the list.', {
        parse_mode: 'Markdown',
      });
      return;
    }
    const tpl = await findTemplateByName(createdBy, name);
    if (!tpl) {
      await ctx.reply(`No template \`${escapeMd(name)}\`. Try /templates.`, {
        parse_mode: 'Markdown',
      });
      return;
    }
    const card = await instantiateTemplate(createdBy, tpl.id, {
      source: 'telegram',
      telegramChatId: chatId,
      telegramMessageId: ctx.msg?.message_id,
    });
    if (!card) {
      await ctx.reply('Template no longer exists.');
      return;
    }
    broadcast({ type: 'card.created', card });
    // instantiateTemplate already logs a 'create' activity with template_id/template_name.
    // The source=telegram column on the card distinguishes this path; no extra log needed.
    await reactOk(ctx);
    await ctx.reply(`✓ Saved · ${STATUS_EMOJI[card.status]} ${STATUS_LABEL[card.status]} — ${escapeMd(card.title)}`, {
      parse_mode: 'Markdown',
      reply_markup: postSaveKeyboard(card.id, card.status),
    });
    return;
  }

  if (command === 'templates' && isPrivate) {
    const list = await listTemplates(createdBy);
    if (list.length === 0) {
      await ctx.reply('No templates yet. Add one in Settings → Templates.');
      return;
    }
    const lines = list.map(
      (t) => `${t.visibility === 'private' ? '🔒' : '👥'} \`${escapeMd(t.name)}\` — ${escapeMd(t.title)}`,
    );
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // Knowledge: DM-only. Group invocations are silent (early return).
  const kcmd = parseKnowledgeCommand(text);
  if (kcmd && !isPrivate) return;
  if (kcmd) {
    await handleKnowledgeCommand(ctx, kcmd, createdBy, chatId);
    return;
  }

  // Text capture is opt-in for AI. Keep the user's original text as the
  // manual draft so choosing the manual path never contacts OpenAI.
  if (tgUserId === undefined || chatId === undefined) return;
  const manualText = (command ? rest : text) || text;
  if (!manualText.trim()) {
    await ctx.reply('Please include the task details after mentioning me. Use /help for examples.');
    return;
  }
  const pending = createPending({
    tgUserId,
    appUserId: createdBy,
    chatId,
    isPrivateChat: isPrivate,
    original: manualText,
    proposal: plainProposal(manualText),
  });
  const seededLinks = extractUrls(manualText);
  updatePending(pending.id, {
    captureType: 'text',
    manualText,
    captureMessageId: ctx.msg?.message_id,
    links: seededLinks,
  });
  await sendCaptureChoice(ctx, pending, 'Choose how to save this task.');
}

async function handleVoice(
  ctx: Context,
  appUserId: string,
  isPrivate = false,
  caption = '',
): Promise<void> {
  const voice = ctx.msg?.voice ?? ctx.msg?.audio;
  const chatId = ctx.chat?.id;
  if (!voice || chatId === undefined || ctx.from?.id === undefined) return;
  const manualText = caption.trim();
  const pending = createPending({
    tgUserId: ctx.from.id,
    appUserId,
    chatId,
    isPrivateChat: isPrivate,
    original: manualText || 'Voice note task',
    proposal: plainProposal(manualText, 'Voice note task'),
  });
  updatePending(pending.id, {
    captureType: 'voice',
    captureMessageId: ctx.msg?.message_id,
    manualText,
    pendingAudioFileId: voice.file_id,
    attachMode: 'new',
  });
  await sendCaptureChoice(
    ctx,
    pending,
    'Voice note received. You can ask OpenAI to transcribe it, or enter the task details yourself.',
    'Transcribe audio',
  );
}

async function handlePhoto(
  ctx: Context,
  appUserId: string,
  isPrivate = false,
  caption = '',
): Promise<void> {
  const photos = ctx.msg?.photo;
  const chatId = ctx.chat?.id;
  if (!photos?.length || chatId === undefined || ctx.from?.id === undefined) return;
  const manualText = caption.trim();
  const pending = createPending({
    tgUserId: ctx.from.id,
    appUserId,
    chatId,
    isPrivateChat: isPrivate,
    original: manualText || 'Photo task',
    proposal: plainProposal(manualText, 'Photo task'),
  });
  updatePending(pending.id, {
    captureType: 'photo',
    captureMessageId: ctx.msg?.message_id,
    manualText,
    pendingPhotoFileId: photos[photos.length - 1]!.file_id,
    attachMode: 'new',
  });
  await sendCaptureChoice(
    ctx,
    pending,
    'Image received. You can ask OpenAI to describe it, or enter the task details yourself.',
    'Analyze image',
  );
}

async function sendMediaAttachmentChoice(ctx: Context, pending: PendingProposal): Promise<void> {
  const icon = pending.captureType === 'photo' ? '📷' : '🎙';
  const message = await ctx.reply(
    `${icon} ${pending.proposal.title}${pending.proposal.description ? `\n\n${pending.proposal.description}` : ''}\n\nCreate a new task or attach this file to an existing task?`,
    { reply_markup: attachmentKindKeyboard(pending.id) },
  );
  updatePending(pending.id, { promptMessageId: message.message_id });
}

async function captureWithAI(ctx: Context, pending: PendingProposal): Promise<void> {
  if (!AI_ENABLED()) {
    await ctx.reply('OpenAI is not configured. No task was created; use the manual option.');
    return;
  }

  let proposal: AIProposal | null = null;
  let usedAI = false;
  try {
    if (pending.captureType === 'photo' && pending.pendingPhotoFileId) {
      const imagePath = await downloadTelegramFile(getBot()!, pending.pendingPhotoFileId, crypto.randomUUID(), '.jpg');
      try {
        const vision = await summarizeImage(imagePath);
        if (vision) {
          proposal = {
            is_actionable: true,
            title: vision.title,
            description: [vision.description, pending.manualText].filter(Boolean).join('\n\n'),
            tags: pending.manualText ? extractHashtags(pending.manualText).tags : [],
            reason: 'user requested an OpenAI image summary',
          };
          usedAI = true;
        }
      } finally {
        await fs.unlink(imagePath).catch(() => {});
        await fs.rmdir(path.dirname(imagePath)).catch(() => {});
      }
    } else if (pending.captureType === 'voice' && pending.pendingAudioFileId) {
      const audioPath = await downloadTelegramFile(getBot()!, pending.pendingAudioFileId, crypto.randomUUID(), '.ogg');
      try {
        const transcript = await transcribeAudio(audioPath);
        if (transcript) {
          proposal = plainProposal([pending.manualText, transcript].filter(Boolean).join('\n\n'), 'Voice task');
          usedAI = true;
          updatePending(pending.id, { original: transcript });
        }
      } finally {
        await fs.unlink(audioPath).catch(() => {});
        await fs.rmdir(path.dirname(audioPath)).catch(() => {});
      }
    } else {
      let context: string[] = [];
      if (pending.taskSourceMessageId !== undefined && pending.taskSourceThreadId !== undefined) {
        try {
          const remembered = await searchRememberedContext(
            pending.chatId,
            pending.taskSourceThreadId,
            pending.manualText ?? pending.original,
          );
          context = rememberedContextForPrompt(remembered);
          updatePending(pending.id, { contextSnippets: context, contextMessageIds: remembered.map((item) => item.message_id) });
        } catch (error) {
          console.error('[telegram] remembered-context search failed:', error);
        }
      }
      proposal = await proposeFromText(pending.original, undefined, undefined, context);
      usedAI = Boolean(proposal);
    }
  } catch (error) {
    console.error('[telegram] requested AI task capture failed:', error);
  }

  if (!proposal) {
    await ctx.reply('OpenAI could not prepare this task. Nothing was saved; use the manual option on the original prompt.');
    return;
  }
  updatePending(pending.id, { proposal, aiSummarized: usedAI, awaitingManual: false });
  if (pending.captureType === 'photo' || pending.captureType === 'voice') {
    await sendMediaAttachmentChoice(ctx, pending);
    return;
  }
  const messageId = await sendProposal(ctx, pending.id, proposal, pending.isPrivateChat, pending.links);
  updatePending(pending.id, { promptMessageId: messageId });
}

// ---------- structured-capture helpers ----------

async function finalizeKnowledge(ctx: Context, pending: PendingProposal): Promise<void> {
  const proposal = pending.proposal;
  const candidateUrls = [
    ...extractUrls(proposal.title),
    ...extractUrls(proposal.description ?? ''),
    ...extractUrls(pending.original),
  ];
  let url: string | null = null;
  for (const u of candidateUrls) {
    try {
      validateUrl(u);
      url = u;
      break;
    } catch {}
  }
  const title = (proposal.title || pending.original.slice(0, 80)).trim();
  try {
    const created = await createKnowledge(pending.appUserId, {
      title,
      body: proposal.description || (url ? '' : pending.original),
      url: url ?? undefined,
      tags: proposal.tags ?? [],
      visibility: 'private',
      source: 'telegram',
    });
    broadcast({ type: 'knowledge.created', knowledge: created });
    if (url) {
      try { triggerFetch(created.id); } catch { /* non-fatal */ }
    }
    await ctx.reply(`📚 Saved · ${title}`);
  } catch (e) {
    await ctx.reply(`Save failed: ${e instanceof Error ? e.message : 'error'}`);
  }
  deletePending(pending.id);
}

async function finalizeCard(
  ctx: Context,
  pending: PendingProposal,
  status: Status,
): Promise<void> {
  const proposal = pending.proposal;
  const isPrivate = pending.destination === 'private_card';
  const assignees = isPrivate ? [pending.appUserId] : undefined;
  const cardId = await createCard({
    title: proposal.title || pending.original.slice(0, 80),
    description: proposal.description ?? '',
    tags: proposal.tags ?? [],
    createdBy: pending.appUserId,
    source: 'telegram',
    status,
    workType: pending.taskWorkType ?? 'chore',
    aiSummarized: pending.aiSummarized ?? false,
    assignees,
    telegramChatId: pending.chatId,
    telegramMessageId: pending.captureMessageId ?? pending.taskSourceMessageId ?? pending.promptMessageId ?? undefined,
  });

  // Attach any pending media (set by photo/voice handlers in Task 8/9)
  if (pending.pendingPhotoFileId && botInstance) {
    try {
      const localPath = await downloadTelegramFile(botInstance, pending.pendingPhotoFileId, cardId, '.jpg');
      await attachFile(cardId, 'image', localPath);
    } catch { /* non-fatal */ }
  }
  if (pending.pendingAudioFileId && botInstance) {
    try {
      const localPath = await downloadTelegramFile(botInstance, pending.pendingAudioFileId, cardId, '.ogg');
      await attachFile(cardId, 'audio', localPath);
    } catch { /* non-fatal */ }
  }

  const card = await loadCard(cardId);
  if (card) {
    broadcast({ type: 'card.created', card });
  }
  if (pending.taskSourceMessageId !== undefined) await projectCardToTopic(cardId);

  await logActivity(
    pending.appUserId,
    cardId,
    pending.taskSourceMessageId !== undefined
      ? 'telegram.task'
      : isPrivate
        ? 'telegram.text.private'
        : 'telegram.text',
    taskContextDetails(pending),
  );
  deletePending(pending.id);
  const emoji = STATUS_EMOJI[status];
  const label = STATUS_LABEL[status];
  await ctx.reply(`✓ Saved · ${emoji} ${label} — ${proposal.title}`, {
    reply_markup: postSaveKeyboard(cardId, status),
  });
}

function relativeAge(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const days = Math.floor(d / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hrs = Math.floor(d / 3_600_000);
  if (hrs >= 1) return `${hrs}h ago`;
  const mins = Math.floor(d / 60_000);
  return `${Math.max(1, mins)}m ago`;
}

// ---------- attach-picker helpers ----------

async function showAttachPicker(
  ctx: Context,
  pending: PendingProposal,
  filter: string,
): Promise<void> {
  let cardItems: Array<{ id: string; label: string }> = [];
  let kItems: Array<{ id: string; label: string }> = [];
  if (filter.trim()) {
    const cs = await searchCardsFts(pending.appUserId, filter, 5);
    const ks = await searchKnowledgeFts(pending.appUserId, filter, 3);
    cardItems = cs.map((c) => ({ id: c.id, label: `${STATUS_EMOJI[c.status]} ${c.title}` }));
    kItems = ks.map((k) => ({ id: k.id, label: `📚 ${k.title}` }));
  } else {
    const cs = await pool.query<{ id: string; title: string; status: Status }>(
      `SELECT DISTINCT c.id, c.title, c.status
       FROM cards c
       LEFT JOIN card_assignees ca ON ca.card_id = c.id
       LEFT JOIN card_shares cs ON cs.card_id = c.id
       WHERE NOT c.archived
         AND (
           c.created_by = $1
           OR ca.user_id = $1
           OR cs.user_id = $1
           OR NOT EXISTS (SELECT 1 FROM card_assignees ca2 WHERE ca2.card_id = c.id)
         )
       ORDER BY c.updated_at DESC LIMIT 5`,
      [pending.appUserId],
    );
    cardItems = cs.rows.map((c) => ({ id: c.id, label: `${STATUS_EMOJI[c.status]} ${c.title}` }));
    const ks = await pool.query<{ id: string; title: string }>(
      `SELECT k.id, COALESCE(NULLIF(k.title, ''), '(untitled)') AS title
       FROM knowledge_items k
       LEFT JOIN knowledge_shares ks ON ks.knowledge_id = k.id
       WHERE NOT k.archived
         AND (
           k.owner_id = $1
           OR k.visibility = 'inbox'
           OR (k.visibility = 'shared' AND ks.user_id = $1)
         )
       ORDER BY k.updated_at DESC LIMIT 3`,
      [pending.appUserId],
    );
    kItems = ks.rows.map((k) => ({ id: k.id, label: `📚 ${k.title}` }));
  }
  const items = [
    ...cardItems.map((i) => ({ kind: 'card' as const, ...i })),
    ...kItems.map((i) => ({ kind: 'knowledge' as const, ...i })),
  ];
  updatePending(pending.id, {
    attachMode: filter.trim() ? 'pickFiltered' : 'pickRecent',
    attachFilter: filter,
    attachPickerIds: items.map((it) => ({ kind: it.kind, id: it.id })),
  });
  if (items.length === 0) {
    await ctx.reply('No items found. Reply with different words or tap Cancel.', {
      reply_markup: new InlineKeyboard().text('❌ Cancel', `drop:${pending.id}`),
    });
    return;
  }
  await ctx.reply('Pick one (or reply with a few words to filter):', {
    reply_markup: attachPickerKeyboard(pending.id, items),
  });
}

async function attachToTarget(
  ctx: Context,
  pending: PendingProposal,
  kind: 'card' | 'knowledge',
  targetId: string,
): Promise<void> {
  if (!pending.pendingPhotoFileId && !pending.pendingAudioFileId) {
    await ctx.reply('Nothing to attach.');
    deletePending(pending.id);
    return;
  }
  if (kind === 'card') {
    try {
      if (pending.pendingPhotoFileId && botInstance) {
        const p = await downloadTelegramFile(botInstance, pending.pendingPhotoFileId, targetId, '.jpg');
        await attachFile(targetId, 'image', p);
      }
      if (pending.pendingAudioFileId && botInstance) {
        const p = await downloadTelegramFile(botInstance, pending.pendingAudioFileId, targetId, '.ogg');
        await attachFile(targetId, 'audio', p);
      }
      const card = await loadCard(targetId);
      if (card) broadcast({ type: 'card.updated', card });
      const actionLabel = pending.pendingPhotoFileId ? 'telegram.photo.attach' : 'telegram.voice.attach';
      await logActivity(pending.appUserId, targetId, actionLabel);
      await ctx.reply('📎 Attached to card.');
    } catch (e) {
      await ctx.reply(`Attach failed: ${e instanceof Error ? e.message : 'error'}`);
    }
  } else {
    // Knowledge items don't support binary attachments — fall back to new private card.
    await ctx.reply("Knowledge items don't support attachments yet — saving as new card instead.");
    updatePending(pending.id, { destination: 'private_card', attachMode: 'new' });
    await finalizeCard(ctx, pending, 'inbox');
    return;
  }
  deletePending(pending.id);
}

async function runDuplicateCheck(ctx: Context, pending: PendingProposal): Promise<void> {
  const q = pending.proposal.title || pending.original.slice(0, 120);
  const [cardHits, kHits] = await Promise.all([
    searchCardsFts(pending.appUserId, q, 10),
    searchKnowledgeFts(pending.appUserId, q, 10),
  ]);
  if (cardHits.length === 0 && kHits.length === 0) {
    await ctx.reply('🔍 No related items found. Pick a destination above to save.');
    return;
  }
  const candidates: Candidate[] = [
    ...cardHits.map((h) => ({
      kind: 'card' as const,
      id: h.id,
      title: h.title,
      snippet: (h.description || '').slice(0, 120),
      contextLine: `${STATUS_LABEL[h.status]}, ${relativeAge(h.updated_at)}`,
    })),
    ...kHits.map((h) => ({
      kind: 'knowledge' as const,
      id: h.id,
      title: h.title,
      snippet: h.snippet,
      contextLine: h.url ? 'Knowledge (URL)' : 'Knowledge (note)',
    })),
  ];
  const ranked = await rankCandidates(pending.original, candidates);
  if (ranked.length === 0) {
    await ctx.reply('🔍 No strong matches found. Pick a destination above to save.');
    return;
  }
  updatePending(pending.id, {
    dupCandidates: ranked.map((r) => ({
      kind: r.kind,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      contextLine: r.contextLine,
      confidence: r.confidence,
      why: r.why,
    })),
  });
  const lines = ranked.map((r) => {
    const conf = r.confidence !== undefined ? ` — ${r.confidence}% match` : '';
    const why = r.why ? `\n      why: ${r.why}` : '';
    return `• [${r.kind}] '${r.title}' (${r.contextLine})${conf}${why}`;
  });
  await ctx.reply(`🔍 Found ${ranked.length} possibly related:\n${lines.join('\n')}`, {
    reply_markup: dupResultsKeyboard(pending.id, ranked),
  });
}

// ---------- bot wiring ----------

// Post-save quick actions use the same server-side transition rules as slash commands.
async function handlePostSaveCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? '';
  const workflowMatch = data.match(/^wf:(start|test|approve|fail):([0-9a-f-]{36})$/);
  const archMatch = data.match(/^arch:([0-9a-f-]{36})$/);
  if (!workflowMatch && !archMatch) return false;

  const cardId = workflowMatch ? workflowMatch[2]! : archMatch![1]!;
  const tgUser = ctx.from;
  const appUserId = tgUser ? await resolveAppUser(tgUser.id) : null;
  const { rows } = await pool.query<{ created_by: string | null }>(
    `SELECT created_by FROM cards WHERE id = $1`,
    [cardId],
  );
  const creator = rows[0]?.created_by ?? null;
  if (!appUserId || (archMatch && (!creator || appUserId !== creator))) {
    await ctx.answerCallbackQuery({ text: 'Only the creator can change this.' });
    return true;
  }

  if (archMatch) {
    await pool.query(
      `UPDATE cards SET archived = TRUE, updated_at = NOW() WHERE id = $1`,
      [cardId],
    );
    await logActivity(appUserId, cardId, 'telegram.archive');
    broadcast({ type: 'card.deleted', id: cardId });
    try {
      await ctx.editMessageText('🗑 Archived.', { reply_markup: undefined });
    } catch {}
    await ctx.answerCallbackQuery({ text: 'Archived' });
    return true;
  }

  const action = workflowMatch![1]!;
  const targetStatus: Status = action === 'start' ? 'in_progress'
    : action === 'test' ? 'ready_for_test'
      : action === 'approve' ? 'ready_for_release' : 'needs_fix';
  const currentCard = await loadCard(cardId);
  if (currentCard && !(await hasTelegramWorkflowTopic(targetStatus, currentCard.work_type))) {
    await ctx.answerCallbackQuery({
      text: `Bind the ${STATUS_LABEL[targetStatus]} topic first.`,
      show_alert: true,
    });
    return true;
  }
  const card = action === 'start'
    ? await transitionCard(cardId, appUserId, 'in_progress')
    : action === 'test'
      ? await transitionCard(cardId, appUserId, 'ready_for_test')
      : await recordPeerTest(cardId, appUserId, action === 'approve');
  const newStatus = card.status;
  const badge = `${STATUS_EMOJI[newStatus]} ${STATUS_LABEL[newStatus]}`;
  broadcast({ type: 'card.updated', card });
  await projectCardToTopic(card.id);
  try {
    const current = ctx.callbackQuery!.message?.text ?? '';
    // Replace any existing "✓ Saved · …" badge line with the new one; fall back to prepend.
    const nextBody = current.replace(/^(✓ Saved · )[^\n]*/, `$1${badge}`);
    const text = nextBody === current ? `✓ Moved · ${badge}\n\n${current}` : nextBody;
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: postSaveKeyboard(cardId, newStatus),
    });
  } catch {}
  await ctx.answerCallbackQuery({ text: badge });
  return true;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function handleKnowledgeCommand(
  ctx: Context,
  cmd: KnowledgeBotCommand,
  createdBy: string,
  chatId: number | undefined,
): Promise<void> {
  if (cmd.cmd === 'save') {
    if ('error' in cmd) {
      await ctx.reply('Usage: `/save <url> [| title]`', { parse_mode: 'Markdown' });
      return;
    }
    let placeholder;
    try {
      placeholder = await ctx.reply(`🔗 Saving ${new URL(cmd.url).hostname}...`);
    } catch {
      placeholder = null;
    }
    try {
      const titleAuto = !cmd.title;
      const k = await createKnowledge(createdBy, {
        title: cmd.title ?? new URL(cmd.url).hostname,
        title_auto: titleAuto,
        url: cmd.url,
        visibility: 'private',
        source: 'telegram',
        auto_fetch: true,
      });
      broadcast({ type: 'knowledge.created', knowledge: k });
      triggerFetch(k.id);

      // Wait briefly for fetch worker, then edit placeholder.
      setTimeout(async () => {
        const updated = await loadKnowledge(k.id);
        const buttons = new InlineKeyboard()
          .text('👥 Share with family', `kshare:${k.id}`)
          .row()
          .text('🏷 Tag', `ktag:${k.id}`)
          .text('🗑 Discard', `karchive:${k.id}`);
        const txt =
          updated?.fetch_status === 'ok'
            ? `✓ Saved · ${updated.title}`
            : updated?.fetch_status === 'failed'
              ? `⚠ Saved (no preview): ${updated.fetch_error ?? 'fetch failed'}`
              : `✓ Saved (still fetching) · ${k.title}`;
        if (placeholder && chatId) {
          await ctx.api
            .editMessageText(chatId, placeholder.message_id, txt, { reply_markup: buttons })
            .catch(() => {});
        } else {
          await ctx.reply(txt, { reply_markup: buttons }).catch(() => {});
        }
      }, 4000);
    } catch (e) {
      const msg =
        e instanceof KnowledgeValidationError ? e.message : (e as Error).message;
      const errText = `Cannot save: ${msg}`;
      if (placeholder && chatId) {
        await ctx.api.editMessageText(chatId, placeholder.message_id, errText).catch(() => {});
      } else {
        await ctx.reply(errText).catch(() => {});
      }
    }
    return;
  }

  if (cmd.cmd === 'note') {
    if ('error' in cmd) {
      await ctx.reply('Usage: `/note <body>`', { parse_mode: 'Markdown' });
      return;
    }
    try {
      const k = await createKnowledge(createdBy, {
        title: cmd.title,
        body: cmd.body,
        visibility: 'private',
        source: 'telegram',
        auto_fetch: false,
      });
      broadcast({ type: 'knowledge.created', knowledge: k });
      await ctx.reply(`✓ Note saved · ${k.title}`);
    } catch (e) {
      const msg = e instanceof KnowledgeValidationError ? e.message : (e as Error).message;
      await ctx.reply(`Cannot save note: ${msg}`);
    }
    return;
  }

  if (cmd.cmd === 'k') {
    if ('error' in cmd) {
      await ctx.reply('Usage: `/k <query>`', { parse_mode: 'Markdown' });
      return;
    }
    const items = await listKnowledge(createdBy, { q: cmd.q, scope: 'all', limit: 5 });
    if (items.length === 0) {
      await ctx.reply('Nothing matched.');
      return;
    }
    const lines = items
      .map((k, i) => {
        const host = k.url ? safeHost(k.url) : null;
        return `${i + 1}. ${k.title}${host ? ` — ${host}` : ''}`;
      })
      .join('\n');
    const kb = new InlineKeyboard();
    items.forEach((k, i) => kb.text(`${i + 1}`, `kshow:${k.id}`));
    await ctx.reply(lines, { reply_markup: kb });
    return;
  }

  if (cmd.cmd === 'klist') {
    const items = await listKnowledge(createdBy, { scope: 'all', limit: 10 });
    if (items.length === 0) {
      await ctx.reply('No knowledge yet.');
      return;
    }
    const lines = items
      .map((k, i) => {
        const host = k.url ? safeHost(k.url) : null;
        return `${i + 1}. ${k.title}${host ? ` — ${host}` : ''}`;
      })
      .join('\n');
    await ctx.reply(lines);
    return;
  }
}

function linkLabelEmoji(label: CardLinkLabel): string {
  switch (label) {
    case 'evolves_from': return '🌱';
    case 'supersedes':   return '➡️';
    case 'split_from':   return '✂️';
    case 'related':      return '🔗';
    case 'inspired_by':  return '💡';
    case 'duplicate_of': return '👯';
  }
}

async function showLinkPicker(
  ctx: Context,
  pending: PendingProposal,
  filter: string,
): Promise<void> {
  const userId = pending.appUserId;
  let cards: Array<{ id: string; title: string }> = [];
  if (filter.trim()) {
    const hits = await searchCardsFts(userId, filter, 8);
    cards = hits.map((h) => ({ id: h.id, title: h.title }));
  } else {
    const { rows } = await pool.query<{ id: string; title: string }>(
      `SELECT DISTINCT c.id, c.title
       FROM cards c
       LEFT JOIN card_assignees ca ON ca.card_id = c.id
       LEFT JOIN card_shares cs ON cs.card_id = c.id
       WHERE NOT c.archived
         AND (c.created_by = $1 OR ca.user_id = $1 OR cs.user_id = $1
              OR NOT EXISTS (SELECT 1 FROM card_assignees ca2 WHERE ca2.card_id = c.id))
       ORDER BY c.updated_at DESC
       LIMIT 5`,
      [userId],
    );
    cards = rows;
  }
  if (cards.length === 0) {
    const kb = new InlineKeyboard().text('❌ Cancel', `drop:${pending.id}`);
    await ctx.reply('No cards to link. Reply with different words or Cancel.', { reply_markup: kb });
    return;
  }
  const kb = new InlineKeyboard();
  for (const c of cards) {
    kb.text(`Pick: ${c.title.slice(0, 40)}`, `linkto:${c.id}:${pending.id}`).row();
  }
  kb.text('❌ Cancel', `drop:${pending.id}`);
  await ctx.reply('Pick a card to link to (or reply with words to filter):', { reply_markup: kb });
}

async function finalizeCardWithLink(
  ctx: Context,
  pending: PendingProposal,
  noteText: string | null,
): Promise<void> {
  const status: Status = 'inbox';
  if (pending.destination === 'knowledge') {
    await ctx.reply('Linking is only available for card destinations. Pick Private or Public first.');
    deletePending(pending.id);
    return;
  }
  if (!pending.pendingLinkTargetId || !pending.pendingLinkLabel) {
    await ctx.reply('Missing link target or label. Restart the flow.');
    deletePending(pending.id);
    return;
  }

  const cardId = await createCard({
    title: pending.proposal.title || pending.original.slice(0, 80),
    description: pending.proposal.description ?? '',
    tags: pending.proposal.tags ?? [],
    createdBy: pending.appUserId,
    source: 'telegram',
    status,
    workType: pending.taskWorkType ?? 'chore',
    aiSummarized: true,
    assignees: pending.destination === 'private_card' ? [pending.appUserId] : undefined,
    telegramChatId: pending.chatId,
    telegramMessageId: pending.promptMessageId ?? undefined,
  });

  try {
    await createLink(
      pending.appUserId,
      cardId,
      pending.pendingLinkTargetId,
      pending.pendingLinkLabel,
      noteText,
    );
  } catch {
    // Non-fatal — card is saved even if link fails
  }

  await logActivity(
    pending.appUserId,
    cardId,
    pending.taskSourceMessageId !== undefined
      ? `telegram.task.${pending.destination}.linked`
      : `telegram.${pending.destination}.linked`,
    taskContextDetails(pending),
  );
  deletePending(pending.id);

  const target = await loadCard(pending.pendingLinkTargetId);
  const noteLine = noteText ? `\n   note: "${noteText.slice(0, 80)}"` : '';
  const card = await loadCard(cardId);
  await ctx.reply(
    `✓ Saved · ${STATUS_EMOJI[status]} ${STATUS_LABEL[status]} — ${pending.proposal.title}\n🔗 ${pending.pendingLinkLabel} "${target?.title ?? '(unknown)'}"${noteLine}`,
    {
      reply_markup: card ? postSaveKeyboard(cardId, status) : undefined,
    },
  );
  if (card) {
    broadcast({ type: 'card.created', card });
    if (pending.taskSourceMessageId !== undefined) await projectCardToTopic(cardId);
  }
}

export function buildBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on('callback_query:data', async (ctx, next) => {
    try {
      if (await handlePostSaveCallback(ctx)) return;
    } catch {
      try {
        await ctx.answerCallbackQuery({ text: 'error' });
      } catch {}
      return;
    }
    return next();
  });

  bot.callbackQuery(/^kshow:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice('kshow:'.length);
    const tgId = ctx.from.id;
    const userId = await resolveAppUser(tgId);
    if (!userId) {
      await ctx.answerCallbackQuery({ text: 'Link your Telegram identity first.' });
      return;
    }
    const k = await loadKnowledge(id);
    if (!k) {
      await ctx.answerCallbackQuery({ text: 'Item not found.' });
      return;
    }
    if (!(await canUserSeeKnowledge(userId, k))) {
      await ctx.answerCallbackQuery({ text: 'Not visible.' });
      return;
    }
    const body = (k.body || '').slice(0, 4000);
    await ctx.answerCallbackQuery();
    await ctx.reply(`${k.title}\n\n${body}${(k.body ?? '').length > 4000 ? '\n...' : ''}`);
  });

  bot.callbackQuery(/^kshare:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice('kshare:'.length);
    const userId = await resolveAppUser(ctx.from.id);
    if (!userId) {
      await ctx.answerCallbackQuery({ text: 'Link your Telegram identity first.' });
      return;
    }
    try {
      const updated = await updateKnowledge(userId, id, { visibility: 'inbox' });
      if (!updated) {
        await ctx.answerCallbackQuery({ text: 'Not found.' });
        return;
      }
      broadcast({ type: 'knowledge.updated', knowledge: updated });
      await ctx.answerCallbackQuery({ text: 'Shared with family.' });
    } catch {
      await ctx.answerCallbackQuery({ text: 'Cannot change visibility.' });
    }
  });

  bot.callbackQuery(/^karchive:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice('karchive:'.length);
    const userId = await resolveAppUser(ctx.from.id);
    if (!userId) {
      await ctx.answerCallbackQuery({ text: 'Link your Telegram identity first.' });
      return;
    }
    const k = await loadKnowledge(id);
    if (!k) {
      await ctx.answerCallbackQuery({ text: 'Not found.' });
      return;
    }
    const ok = await archiveKnowledge(userId, id);
    if (!ok) {
      await ctx.answerCallbackQuery({ text: 'Forbidden.' });
      return;
    }
    broadcast({
      type: 'knowledge.deleted',
      id,
      owner_id: k.owner_id,
      visibility: k.visibility,
      shares: k.shares ?? [],
    });
    await ctx.answerCallbackQuery({ text: 'Archived.' });
  });

  bot.callbackQuery(/^ktag:/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: 'Reply to the saved message with #tag #tag — coming soon.',
    });
  });

  // ---------- structured-capture callbacks ----------

  bot.callbackQuery(/^capture:ai:([^:]+)$/, async (ctx) => {
    const pending = getPending(ctx.match![1]!);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired. Send the task again.', show_alert: true });
      return;
    }
    if (ctx.from.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Only the sender can choose this.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Sending this request to OpenAI…' });
    await captureWithAI(ctx, pending);
  });

  bot.callbackQuery(/^capture:manual:([^:]+)$/, async (ctx) => {
    const pending = getPending(ctx.match![1]!);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired. Send the task again.', show_alert: true });
      return;
    }
    if (ctx.from.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Only the sender can choose this.' });
      return;
    }
    await ctx.answerCallbackQuery();
    const media = pending.captureType === 'photo' || pending.captureType === 'voice';
    if (media && !pending.manualText?.trim()) {
      updatePending(pending.id, { awaitingManual: true, aiSummarized: false });
      const message = await ctx.reply('Reply to this message with the task title and any details. I will save it without AI.');
      updatePending(pending.id, { promptMessageId: message.message_id });
      return;
    }
    const proposal = plainProposal(pending.manualText ?? pending.original,
      pending.captureType === 'photo' ? 'Photo task' : pending.captureType === 'voice' ? 'Voice task' : 'New task');
    updatePending(pending.id, { proposal, aiSummarized: false, awaitingManual: false });
    if (media) {
      await sendMediaAttachmentChoice(ctx, pending);
      return;
    }
    const messageId = await sendProposal(ctx, pending.id, proposal, pending.isPrivateChat, pending.links);
    updatePending(pending.id, { promptMessageId: messageId });
  });

  bot.callbackQuery(/^capture:edit-ai:([^:]+)$/, async (ctx) => {
    const pending = getPending(ctx.match![1]!);
    if (!pending || !pending.correction) {
      await ctx.answerCallbackQuery({ text: 'Correction expired. Edit the task again.', show_alert: true });
      return;
    }
    if (ctx.from.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Only the sender can choose this.' });
      return;
    }
    if (!AI_ENABLED()) {
      await ctx.answerCallbackQuery({ text: 'OpenAI is not configured.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Sending your correction to OpenAI…' });
    let revised: AIProposal | null = null;
    try {
      revised = await proposeFromText(pending.original, pending.proposal, pending.correction, pending.contextSnippets);
    } catch (error) {
      console.error('[telegram] requested AI correction failed:', error);
    }
    if (!revised) {
      await ctx.reply('OpenAI could not apply that correction. You can choose “Use correction as written” on the previous prompt.');
      return;
    }
    updatePending(pending.id, { proposal: revised, correction: undefined, aiSummarized: true });
    const messageId = await sendProposal(ctx, pending.id, revised, pending.isPrivateChat, pending.links);
    updatePending(pending.id, { promptMessageId: messageId });
  });

  bot.callbackQuery(/^capture:edit-manual:([^:]+)$/, async (ctx) => {
    const pending = getPending(ctx.match![1]!);
    if (!pending || !pending.correction) {
      await ctx.answerCallbackQuery({ text: 'Correction expired. Edit the task again.', show_alert: true });
      return;
    }
    if (ctx.from.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Only the sender can choose this.' });
      return;
    }
    await ctx.answerCallbackQuery();
    const revised = plainProposal(pending.correction);
    updatePending(pending.id, { proposal: revised, correction: undefined, aiSummarized: false });
    const messageId = await sendProposal(ctx, pending.id, revised, pending.isPrivateChat, pending.links);
    updatePending(pending.id, { promptMessageId: messageId });
  });

  bot.callbackQuery(/^edit:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired. Send your message again.', show_alert: true });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Only the sender can act on this proposal.' });
      return;
    }
    updatePending(pid, { awaitingEdit: true });
    try {
      await ctx.editMessageText(
        `${proposalText(pending.proposal, pending.links)}\n\n✏️ _Reply to this message with your correction. I will ask before sending it to OpenAI._`,
        { parse_mode: 'Markdown', reply_markup: undefined },
      );
    } catch {}
    await ctx.answerCallbackQuery({ text: 'Send your correction' });
  });

  bot.callbackQuery(/^drop:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Already gone.' });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Only the sender can act on this proposal.' });
      return;
    }
    deletePending(pid);
    try {
      await ctx.editMessageText('❌ Discarded.', { reply_markup: undefined });
    } catch {}
    await ctx.answerCallbackQuery({ text: 'Discarded' });
  });

  bot.callbackQuery(/^dest:(private_card|public_card|knowledge):([^:]+)$/, async (ctx) => {
    const dest = ctx.match![1] as Destination;
    const pid = ctx.match![2]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired. Send your message again.', show_alert: true });
      return;
    }
    updatePending(pid, { destination: dest });
    await ctx.answerCallbackQuery();
    if (dest === 'knowledge') {
      await finalizeKnowledge(ctx, pending);
      return;
    }
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: columnKeyboard(pid) });
      await ctx.reply('Which column?');
    } catch { /* edit non-fatal */ }
  });

  bot.callbackQuery(/^col:(inbox):([^:]+)$/, async (ctx) => {
    const status = ctx.match![1] as Status;
    const pid = ctx.match![2]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await finalizeCard(ctx, pending, status);
  });

  bot.callbackQuery(/^dup:check:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Scanning…' });
    await runDuplicateCheck(ctx, pending);
  });

  // dup:link — user confirmed the proposed text is a duplicate of an existing
  // item. Do NOT create a new card. Bump the existing item's updated_at so it
  // surfaces as recently active, log activity, and (for cards) append the
  // original telegram text as a card message so the existing card grows context
  // instead of fragmenting into N near-identical copies.
  bot.callbackQuery(/^dup:link:(card|knowledge):([^:]+):([^:]+)$/, async (ctx) => {
    const kind = ctx.match![1] as 'card' | 'knowledge';
    const id = ctx.match![2]!;
    const pid = ctx.match![3]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      if (kind === 'card') {
        await postCardMessage(id, pending.appUserId, `[telegram dup] ${pending.original}`);
        await pool.query(`UPDATE cards SET updated_at = now() WHERE id = $1`, [id]);
        await logActivity(pending.appUserId, id, 'telegram.dup.linked', {
          original: pending.original.slice(0, 500),
        });
        const card = await loadCard(id);
        if (card) {
          broadcast({ type: 'card.updated', card });
          await ctx.reply(`🔗 Merged into "${card.title}" — last interaction now.`);
        } else {
          await ctx.reply('🔗 Merged into existing card.');
        }
      } else {
        await pool.query(`UPDATE knowledge_items SET updated_at = now() WHERE id = $1`, [id]);
        const knowledge = await loadKnowledge(id);
        if (knowledge) {
          broadcast({ type: 'knowledge.updated', knowledge });
          await ctx.reply(`🔗 Touched "${knowledge.title}" — last interaction now.`);
        } else {
          await ctx.reply('🔗 Merged into existing knowledge item.');
        }
      }
    } catch (err) {
      console.error('[telegram] dup:link failed:', err);
      await ctx.reply('Could not merge into existing item.');
    }
    deletePending(pid);
  });

  // dup:touch — same target, but no message appended. Just bumps updated_at
  // so the existing item rises to the top with no extra noise on its timeline.
  bot.callbackQuery(/^dup:touch:(card|knowledge):([^:]+):([^:]+)$/, async (ctx) => {
    const kind = ctx.match![1] as 'card' | 'knowledge';
    const id = ctx.match![2]!;
    const pid = ctx.match![3]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      if (kind === 'card') {
        await pool.query(`UPDATE cards SET updated_at = now() WHERE id = $1`, [id]);
        await logActivity(pending.appUserId, id, 'telegram.dup.touched');
        const card = await loadCard(id);
        if (card) {
          broadcast({ type: 'card.updated', card });
          await ctx.reply(`👁 "${card.title}" — last interaction now.`);
        } else {
          await ctx.reply('👁 Touched existing card.');
        }
      } else {
        await pool.query(`UPDATE knowledge_items SET updated_at = now() WHERE id = $1`, [id]);
        const knowledge = await loadKnowledge(id);
        if (knowledge) {
          broadcast({ type: 'knowledge.updated', knowledge });
          await ctx.reply(`👁 "${knowledge.title}" — last interaction now.`);
        } else {
          await ctx.reply('👁 Touched existing knowledge item.');
        }
      }
    } catch (err) {
      console.error('[telegram] dup:touch failed:', err);
      await ctx.reply('Could not touch existing item.');
    }
    deletePending(pid);
  });

  bot.callbackQuery(/^dup:save:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: destinationKeyboard(
          pid,
          defaultDestination(pending.proposal, pending.isPrivateChat),
          pending.isPrivateChat,
        ),
      });
    } catch {}
  });

  // att:new:<pid> — proceed to text destination flow with media pending
  bot.callbackQuery(/^att:new:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Not your prompt.', show_alert: true });
      return;
    }
    updatePending(pid, { attachMode: 'new' });
    await ctx.answerCallbackQuery();
    const def = defaultDestination(pending.proposal, pending.isPrivateChat);
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: destinationKeyboard(pid, def, pending.isPrivateChat),
      });
    } catch {}
  });

  // att:pick:<pid> — open attach picker (recent items)
  bot.callbackQuery(/^att:pick:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Not your prompt.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showAttachPicker(ctx, pending, '');
  });

  // att:to:<kind>:<targetId>:<pid> — attach to picked target
  bot.callbackQuery(/^att:to:(card|knowledge):([^:]+):([^:]+)$/, async (ctx) => {
    const kind = ctx.match![1] as 'card' | 'knowledge';
    const targetId = ctx.match![2]!;
    const pid = ctx.match![3]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Not your prompt.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await attachToTarget(ctx, pending, kind, targetId);
  });

  // linkpick:<pid> — open recent-cards picker for linking
  bot.callbackQuery(/^linkpick:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Not your prompt.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showLinkPicker(ctx, pending, '');
  });

  // linkto:<targetCardId>:<pid> — user picked a card to link to
  bot.callbackQuery(/^linkto:([0-9a-f-]+):([^:]+)$/, async (ctx) => {
    const targetId = ctx.match![1]!;
    const pid = ctx.match![2]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    if (ctx.from?.id !== pending.tgUserId) {
      await ctx.answerCallbackQuery({ text: 'Not your prompt.', show_alert: true });
      return;
    }
    if (!(await canUserSeeCard(pending.appUserId, targetId))) {
      await ctx.answerCallbackQuery({ text: 'Card not visible to you.', show_alert: true });
      return;
    }
    updatePending(pid, { pendingLinkTargetId: targetId });
    await ctx.answerCallbackQuery();
    const target = await loadCard(targetId);
    const kb = new InlineKeyboard();
    const labels: CardLinkLabel[] = [
      'evolves_from', 'supersedes', 'split_from', 'related', 'inspired_by', 'duplicate_of',
    ];
    labels.forEach((l, i) => {
      kb.text(`${linkLabelEmoji(l)} ${l.replace(/_/g, ' ')}`, `linklabel:${l}:${pid}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply(
      `Link to "${target?.title ?? targetId}" — what kind of relationship?`,
      { reply_markup: kb },
    );
  });

  // linklabel:<label>:<pid> — user picked a label
  bot.callbackQuery(/^linklabel:([a-z_]+):([^:]+)$/, async (ctx) => {
    const labelStr = ctx.match![1]!;
    const pid = ctx.match![2]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    if (!isCardLinkLabel(labelStr)) {
      await ctx.answerCallbackQuery({ text: 'Invalid label.', show_alert: true });
      return;
    }
    updatePending(pid, { pendingLinkLabel: labelStr, awaitingLinkNote: true });
    await ctx.answerCallbackQuery();
    const skipKb = new InlineKeyboard().text('Skip', `linknote:skip:${pid}`);
    await ctx.reply('Add a note? Reply with text or tap Skip.', { reply_markup: skipKb });
  });

  // linknote:skip:<pid>
  bot.callbackQuery(/^linknote:skip:([^:]+)$/, async (ctx) => {
    const pid = ctx.match![1]!;
    const pending = getPending(pid);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    updatePending(pid, { awaitingLinkNote: false });
    await finalizeCardWithLink(ctx, pending, null);
  });

  bot.callbackQuery(/^brain:([^:]+)$/, async (ctx) => {
    const cardId = ctx.match![1]!;
    const tgUserId = ctx.from?.id;
    if (!tgUserId) {
      await ctx.answerCallbackQuery({ text: 'no user', show_alert: true });
      return;
    }
    const appUserId = await resolveAppUser(tgUserId, ctx.from?.username ?? undefined);
    if (!appUserId) {
      await ctx.answerCallbackQuery({ text: 'Link your Telegram identity first.', show_alert: true });
      return;
    }
    if (!AI_ENABLED()) {
      await ctx.answerCallbackQuery({ text: 'AI not configured.', show_alert: true });
      return;
    }
    if (!(await canUserSeeCard(appUserId, cardId))) {
      await ctx.answerCallbackQuery({ text: 'Card not visible to you.', show_alert: true });
      return;
    }
    const [pendingCard, pendingUser, today] = await Promise.all([
      countPendingByCard(cardId),
      countPendingByUser(appUserId),
      countTodayByUser(appUserId),
    ]);
    if (pendingCard >= 1) {
      await ctx.answerCallbackQuery({ text: 'Already researching this card.', show_alert: true });
      return;
    }
    if (pendingUser >= 5) {
      await ctx.answerCallbackQuery({ text: 'Too many pending — try later.', show_alert: true });
      return;
    }
    if (today >= 50) {
      await ctx.answerCallbackQuery({ text: 'Daily limit reached.', show_alert: true });
      return;
    }
    const insight = await createInsight(cardId, appUserId);
    enqueueBrainstorm(insight.id);
    await ctx.answerCallbackQuery({ text: 'Research queued' });
    // Strip the brainstorm button so it isn't re-tapped
    try {
      const card = await loadCard(cardId);
      if (card) {
        await ctx.editMessageReplyMarkup({ reply_markup: postSaveKeyboard(cardId, card.status) });
      }
    } catch { /* edit non-fatal */ }
    await ctx.reply('✓ Research queued — open card for results when ready.');
  });

  bot.on('message', async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    const allowed = allowedGroupId();
    const isPrivateChat = chatType === 'private';
    // Accept: (a) messages in the configured family group, or
    //         (b) DMs from any registered telegram_identity (private capture).
    if (!isPrivateChat && allowed !== null && chatId !== allowed) {
      return; // silent ignore outside family group
    }

    // Group messages are opt-in: only process commands, direct @mentions, and
    // replies to an active capture prompt. Ordinary conversation stays ignored.
    let text = ctx.msg?.text ?? ctx.msg?.caption;
    const username = botInstance?.botInfo?.username;
    const mentionPattern = username ? new RegExp(`@${username}`, 'ig') : null;
    const mentionsBot = Boolean(text && mentionPattern?.test(text));
    const command = text ? parseCommand(text).command : null;
    const pending = ctx.from ? getLatestForUser(ctx.from.id) : null;
    const replyId = ctx.msg?.reply_to_message?.message_id;
    const explicitPendingReply = Boolean(
      pending && pending.chatId === chatId && replyId === pending.promptMessageId && (
        pending.awaitingManual || pending.awaitingEdit || pending.awaitingLinks || pending.awaitingLinkNote ||
        pending.attachMode === 'pickRecent' || pending.attachMode === 'pickFiltered'
      ),
    );
    if (!isPrivateChat && !mentionsBot && !command && !explicitPendingReply) return;
    if (text && mentionPattern) text = text.replace(mentionPattern, '').trim();

    const tgUser = ctx.from;
    if (!tgUser) return;
    const appUserId = await resolveAppUser(tgUser.id, tgUser.username);
    if (!appUserId) return; // unknown sender: silent ignore

    try {
      if (ctx.msg?.voice || ctx.msg?.audio) {
        await handleVoice(ctx, appUserId, isPrivateChat, text ?? '');
      } else if (ctx.msg?.photo) {
        await handlePhoto(ctx, appUserId, isPrivateChat, text ?? '');
      } else if (text) {
        await handleText(ctx, text, appUserId, isPrivateChat);
      }
    } catch (e) {
      // Never drop user input silently: save a card with raw body if possible.
      const raw = ctx.msg?.text ?? ctx.msg?.caption ?? '[telegram message — handler error]';
      const failedCommand = parseCommand(raw).command;
      if (failedCommand === 'task' || failedCommand === 'remember' || failedCommand === 'forget') {
        console.error('[telegram] command failed; not creating a fallback card:', e);
        await ctx.reply('The command failed. If this was /task, check the board before retrying.');
        return;
      }
      const { tags, text: clean } = extractHashtags(raw);
      const cardId = await createCard({
        title: splitTitleDesc(clean).title || '[telegram error]',
        description: splitTitleDesc(clean).description,
        tags,
        createdBy: appUserId,
        source: 'telegram',
        needsReview: true,
      });
      await logActivity(appUserId, cardId, 'telegram.error', {
        error: String((e as Error)?.message ?? e),
      });
      const card = (await loadCard(cardId))!;
      broadcast({ type: 'card.created', card });
    }
    return next();
  });

  // Global error handler. Without this, any handler throw — including expected
  // grammy errors like a stale answerCallbackQuery (400 "query is too old") —
  // bubbles out of bot.start() and kills the long-polling loop. We log and
  // swallow so polling survives.
  bot.catch((err) => {
    console.error('[telegram] handler error on update', err.ctx?.update?.update_id, ':', err.error);
  });

  return bot;
}

export async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  if (botInstance) return;
  botInstance = buildBot(token);
  // Resolve the bot username before webhook updates arrive so direct mentions
  // can be distinguished from ordinary group messages.
  await botInstance.init();
  if (!projectionTimer) {
    projectionTimer = setInterval(() => {
      flushProjectionOutbox().catch((error) => console.error('[telegram] projection retry failed:', error));
    }, 30_000);
    projectionTimer.unref();
    flushProjectionOutbox().catch((error) => console.error('[telegram] projection retry failed:', error));
  }

  // Webhook mode if a URL is configured, otherwise long polling as dev fallback.
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  if (webhookUrl) {
    await botInstance.api.setWebhook(webhookUrl);
    console.log('[telegram] webhook mode:', webhookUrl);
  } else if (!pollingStarted) {
    pollingStarted = true;
    // Clear any stale webhook + drop pending updates before starting long polling.
    // grammy's bot.start() does call deleteWebhook by default, but only with
    // drop_pending_updates=false, so a wedged update can keep it from advancing.
    try {
      await botInstance.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      console.error('[telegram] deleteWebhook failed:', err);
    }
    botInstance
      .start({ onStart: (info) => console.log('[telegram] polling started as @' + info.username) })
      .catch((err) => console.error('[telegram] polling crashed:', err));
  }
}

export function telegramWebhookCallback() {
  if (!botInstance) return null;
  return webhookCallback(botInstance, 'fastify');
}

export async function sendBrainstormNudge(
  appUserId: string,
  cardTitle: string,
  status: 'ok' | 'failed',
  error?: string,
): Promise<void> {
  if (!botInstance) return;
  const { rows } = await pool.query<{ telegram_user_id: number }>(
    `SELECT telegram_user_id FROM telegram_identities WHERE app_user_id = $1 LIMIT 1`,
    [appUserId],
  );
  const tgUserId = rows[0]?.telegram_user_id;
  if (!tgUserId) return;
  const text = status === 'ok'
    ? `📚 Brainstorm done — ${cardTitle}`
    : `⚠ Brainstorm failed: ${error?.slice(0, 100) ?? 'unknown error'} — try again from the card.`;
  try {
    await botInstance.api.sendMessage(tgUserId, text);
  } catch { /* user blocked bot, etc. */ }
}
