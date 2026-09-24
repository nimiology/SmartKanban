-- SmartKanban Telegram workflow v2: lifecycle states, task ownership, topic map,
-- Telegram card projections, and release tracking.

ALTER TYPE card_status ADD VALUE IF NOT EXISTS 'inbox';
ALTER TYPE card_status ADD VALUE IF NOT EXISTS 'ready_for_test';
ALTER TYPE card_status ADD VALUE IF NOT EXISTS 'needs_fix';
ALTER TYPE card_status ADD VALUE IF NOT EXISTS 'ready_for_release';
ALTER TYPE card_status ADD VALUE IF NOT EXISTS 'released';

UPDATE cards SET tags = array_append(tags, 'legacy-today')
WHERE status = 'today' AND NOT ('legacy-today' = ANY(tags));
WITH legacy AS (
  SELECT id, created_by, status::text AS old_status
  FROM cards WHERE status IN ('backlog', 'today', 'done')
), moved AS (
  UPDATE cards c SET status = CASE WHEN legacy.old_status = 'done' THEN 'released'::card_status ELSE 'inbox'::card_status END
  FROM legacy WHERE c.id = legacy.id
  RETURNING c.id
)
INSERT INTO card_events (actor_id, card_id, action, details)
SELECT legacy.created_by, legacy.id, 'workflow.migration',
       jsonb_build_object('from', legacy.old_status,
                          'to', CASE WHEN legacy.old_status = 'done' THEN 'released' ELSE 'inbox' END)
FROM legacy JOIN moved ON moved.id = legacy.id;
ALTER TABLE cards ALTER COLUMN status SET DEFAULT 'inbox';

UPDATE card_templates SET status = 'inbox' WHERE status IN ('backlog', 'today');
UPDATE card_templates SET status = 'released' WHERE status = 'done';
ALTER TABLE card_templates ALTER COLUMN status SET DEFAULT 'inbox';

ALTER TABLE cards ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS tester_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS work_type TEXT NOT NULL DEFAULT 'chore'
  CHECK (work_type IN ('feature','bug','chore','design'));
ALTER TABLE cards ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'P2'
  CHECK (priority IN ('P0','P1','P2','P3'));
ALTER TABLE cards ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS peer_test_result TEXT NOT NULL DEFAULT 'not_started'
  CHECK (peer_test_result IN ('not_started','passed','failed'));
ALTER TABLE cards ADD COLUMN IF NOT EXISTS peer_test_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS branch_url TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS pull_request_url TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS release_id UUID;
CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner_user_id) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS idx_cards_tester ON cards(tester_user_id) WHERE NOT archived;

-- Keep a historical assignee as the accountable owner, falling back to the creator.
UPDATE cards c SET owner_user_id = COALESCE(
  (SELECT ca.user_id FROM card_assignees ca WHERE ca.card_id = c.id ORDER BY ca.user_id LIMIT 1),
  c.created_by
) WHERE c.owner_user_id IS NULL;

CREATE TABLE IF NOT EXISTS telegram_workflow_topics (
  group_chat_id BIGINT NOT NULL,
  route_key TEXT NOT NULL CHECK (route_key IN (
    'inbox','in_progress','ready_for_test','needs_fix','ready_for_release','released','bugs'
  )),
  thread_id BIGINT NOT NULL,
  bound_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_chat_id, route_key),
  UNIQUE (group_chat_id, thread_id)
);

CREATE TABLE IF NOT EXISTS telegram_task_messages (
  id BIGSERIAL PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  thread_id BIGINT NOT NULL DEFAULT 0,
  message_id BIGINT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, thread_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_task_messages_current_idx
  ON telegram_task_messages(card_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS telegram_projection_outbox (
  card_id UUID PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL UNIQUE,
  commit_sha TEXT NOT NULL,
  staging_result TEXT NOT NULL DEFAULT 'pending'
    CHECK (staging_result IN ('pending','passed','failed')),
  staging_notes TEXT NOT NULL DEFAULT '',
  production_result TEXT NOT NULL DEFAULT 'pending'
    CHECK (production_result IN ('pending','passed','failed')),
  production_notes TEXT NOT NULL DEFAULT '',
  deployed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE cards ADD CONSTRAINT cards_release_id_fkey
    FOREIGN KEY (release_id) REFERENCES workflow_releases(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
