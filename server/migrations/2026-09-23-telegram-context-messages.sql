-- Explicitly remembered Telegram messages for bounded, same-topic task context.
CREATE TABLE IF NOT EXISTS telegram_context_messages (
  chat_id         BIGINT NOT NULL,
  thread_id       BIGINT NOT NULL DEFAULT 0,
  message_id      BIGINT NOT NULL,
  source_user_id  BIGINT NOT NULL,
  remembered_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  fts             TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(body, '') || ' ' || coalesce(note, ''))
                  ) STORED,
  remembered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_id, thread_id, message_id)
);

CREATE INDEX IF NOT EXISTS telegram_context_messages_fts_idx
  ON telegram_context_messages USING GIN (fts);
CREATE INDEX IF NOT EXISTS telegram_context_messages_expiry_idx
  ON telegram_context_messages (expires_at);
