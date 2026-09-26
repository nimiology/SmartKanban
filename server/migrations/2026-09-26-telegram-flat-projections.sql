-- Replace lifecycle-topic projections with one group card and per-member DM mirrors.
ALTER TABLE telegram_task_messages
  ADD COLUMN IF NOT EXISTS recipient_telegram_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS part_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS projected_hash TEXT,
  ADD COLUMN IF NOT EXISTS projected_status TEXT,
  ADD COLUMN IF NOT EXISTS projected_owner_user_id UUID,
  ADD COLUMN IF NOT EXISTS projected_tester_user_id UUID,
  ADD COLUMN IF NOT EXISTS notified_status TEXT;

DROP INDEX IF EXISTS telegram_task_messages_current_idx;

-- Existing messages remain as history. The outbox worker posts fresh root-chat
-- and DM projections after deployment.
UPDATE telegram_task_messages
SET is_current = FALSE
WHERE is_current;

CREATE UNIQUE INDEX IF NOT EXISTS telegram_task_messages_current_group_idx
  ON telegram_task_messages(card_id, part_index)
  WHERE is_current AND recipient_telegram_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_task_messages_current_dm_idx
  ON telegram_task_messages(card_id, recipient_telegram_user_id, part_index)
  WHERE is_current AND recipient_telegram_user_id IS NOT NULL;

DROP TABLE IF EXISTS telegram_workflow_topics;

CREATE OR REPLACE FUNCTION enqueue_telegram_card_projection() RETURNS trigger AS $$
BEGIN
  INSERT INTO telegram_projection_outbox (card_id)
  VALUES (NEW.id)
  ON CONFLICT (card_id) DO UPDATE SET next_attempt_at = NOW(), updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cards_telegram_projection_outbox ON cards;
CREATE TRIGGER cards_telegram_projection_outbox
AFTER INSERT OR UPDATE OF title, description, status, tags, archived, owner_user_id,
  tester_user_id, work_type, priority, acceptance_criteria, due_date,
  branch_url, pull_request_url, peer_test_notes
ON cards FOR EACH ROW EXECUTE FUNCTION enqueue_telegram_card_projection();
