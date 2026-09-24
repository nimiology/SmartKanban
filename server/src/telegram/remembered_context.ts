import { pool } from '../db.js';

export const REMEMBERED_CONTEXT_DAYS = 30;
export const MAX_REMEMBERED_CONTEXT_RESULTS = 8;
export const MAX_REMEMBERED_CONTEXT_CHARS = 4_000;

export type RememberedContextInput = {
  chatId: number;
  threadId: number;
  messageId: number;
  sourceUserId: number;
  rememberedBy: string;
  body: string;
  note?: string;
};

export type RememberedContextMessage = {
  message_id: number;
  body: string;
  note: string;
  remembered_at: string;
};

export async function rememberContextMessage(input: RememberedContextInput): Promise<void> {
  const body = input.body.trim().slice(0, MAX_REMEMBERED_CONTEXT_CHARS);
  if (!body) throw new Error('Only text messages can be remembered.');
  const note = (input.note ?? '').trim().slice(0, 500);

  await pool.query(
    `INSERT INTO telegram_context_messages
       (chat_id, thread_id, message_id, source_user_id, remembered_by, body, note,
        remembered_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + ($8::int * INTERVAL '1 day'))
     ON CONFLICT (chat_id, thread_id, message_id) DO UPDATE
       SET source_user_id = EXCLUDED.source_user_id,
           remembered_by = EXCLUDED.remembered_by,
           body = EXCLUDED.body,
           note = CASE WHEN EXCLUDED.note = '' THEN telegram_context_messages.note ELSE EXCLUDED.note END,
           remembered_at = NOW(),
           expires_at = NOW() + ($8::int * INTERVAL '1 day')`,
    [
      input.chatId,
      input.threadId,
      input.messageId,
      input.sourceUserId,
      input.rememberedBy,
      body,
      note,
      REMEMBERED_CONTEXT_DAYS,
    ],
  );
}

export async function forgetContextMessage(
  chatId: number,
  threadId: number,
  messageId: number,
  userId: string,
  telegramUserId: number,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM telegram_context_messages
     WHERE chat_id = $1 AND thread_id = $2 AND message_id = $3
       AND (remembered_by = $4 OR source_user_id = $5)`,
    [chatId, threadId, messageId, userId, telegramUserId],
  );
  return (rowCount ?? 0) > 0;
}

export async function searchRememberedContext(
  chatId: number,
  threadId: number,
  query: string,
): Promise<RememberedContextMessage[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];

  await pool.query(
    `DELETE FROM telegram_context_messages
     WHERE chat_id = $1 AND thread_id = $2 AND expires_at <= NOW()`,
    [chatId, threadId],
  );

  const { rows } = await pool.query<RememberedContextMessage>(
    `SELECT message_id, body, note, remembered_at::text
     FROM telegram_context_messages
     WHERE chat_id = $1 AND thread_id = $2 AND expires_at > NOW()
       AND fts @@ websearch_to_tsquery('simple', $3)
     ORDER BY ts_rank(fts, websearch_to_tsquery('simple', $3)) DESC, remembered_at DESC
     LIMIT $4`,
    [chatId, threadId, q, MAX_REMEMBERED_CONTEXT_RESULTS],
  );

  let remaining = MAX_REMEMBERED_CONTEXT_CHARS;
  const bounded: RememberedContextMessage[] = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const body = row.body.slice(0, remaining);
    remaining -= body.length;
    const note = row.note.slice(0, Math.min(300, remaining));
    remaining -= note.length;
    bounded.push({ ...row, body, note });
  }
  return bounded;
}

export function rememberedContextForPrompt(messages: RememberedContextMessage[]): string[] {
  return messages.map((message) => {
    const note = message.note ? `\nRememberer's note: ${message.note}` : '';
    return `Saved group message #${message.message_id} (${message.remembered_at}): ${message.body}${note}`;
  });
}
