import { pool } from './db.js';
import { loadCard, type Card, type Status } from './cards.js';

const NEXT: Record<Status, readonly Status[]> = {
  inbox: ['in_progress'],
  in_progress: ['ready_for_test'],
  ready_for_test: ['needs_fix', 'ready_for_release'],
  needs_fix: ['in_progress'],
  ready_for_release: ['released'],
  released: [],
};

export class WorkflowError extends Error {
  constructor(message: string, public readonly code = 'invalid_transition') {
    super(message);
    this.name = 'WorkflowError';
  }
}

export function canTransition(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}

export async function transitionCard(
  cardId: string,
  actorId: string,
  to: Status,
  position?: number,
  peerTest?: { passed: boolean; notes: string },
): Promise<Card> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      status: Status;
      owner_user_id: string | null;
      tester_user_id: string | null;
      peer_test_result: string;
      release_id: string | null;
      staging_result: string | null;
      production_result: string | null;
      is_admin: boolean;
    }>(
      `SELECT c.status, c.owner_user_id, c.tester_user_id, c.peer_test_result,
              c.release_id, r.staging_result, r.production_result, u.is_admin
       FROM cards c
       LEFT JOIN workflow_releases r ON r.id = c.release_id
       JOIN users u ON u.id = $2
       WHERE c.id = $1 AND NOT c.archived
       FOR UPDATE OF c`,
      [cardId, actorId],
    );
    const card = rows[0];
    if (!card) throw new WorkflowError('Task not found or unavailable.', 'not_found');
    if (!canTransition(card.status, to)) {
      throw new WorkflowError(`Cannot move a task from ${card.status} to ${to}.`);
    }

    if (to === 'in_progress' && card.status === 'inbox' && actorId !== card.owner_user_id && !card.is_admin) {
      throw new WorkflowError('Only the task owner can start it.', 'forbidden');
    }
    if (to === 'ready_for_test') {
      if (actorId !== card.owner_user_id) throw new WorkflowError('Only the task owner can submit it for testing.', 'forbidden');
      if (!card.owner_user_id || !card.tester_user_id || card.owner_user_id === card.tester_user_id) {
        throw new WorkflowError('Assign one owner and a different tester before testing.', 'missing_tester');
      }
    }
    if (to === 'needs_fix') {
      if (actorId !== card.tester_user_id && !card.is_admin) throw new WorkflowError('Only the assigned tester can fail this test.', 'forbidden');
    }
    if (to === 'ready_for_release') {
      if (actorId !== card.tester_user_id) throw new WorkflowError('Only the assigned tester can approve the test.', 'forbidden');
      if (card.peer_test_result !== 'passed' && peerTest?.passed !== true) throw new WorkflowError('Record a passing peer test first.', 'test_required');
    }
    if (to === 'in_progress' && card.status === 'needs_fix' && actorId !== card.owner_user_id && !card.is_admin) {
      throw new WorkflowError('Only the task owner can resume a failed task.', 'forbidden');
    }
    if (to === 'released') {
      if (!card.is_admin) throw new WorkflowError('Only a release manager can close a release task.', 'forbidden');
      if (!card.release_id || card.staging_result !== 'passed' || card.production_result !== 'passed') {
        throw new WorkflowError('A linked release must pass staging and production smoke checks first.', 'release_gate');
      }
    }

    if (peerTest) {
      await client.query(
        `UPDATE cards SET status = $2, peer_test_result = $3, peer_test_notes = $4, updated_at = NOW()
         WHERE id = $1`,
        [cardId, to, peerTest.passed ? 'passed' : 'failed', peerTest.notes.slice(0, 2_000)],
      );
    } else if (to === 'needs_fix') {
      await client.query(
        `UPDATE cards SET status = $2, peer_test_result = 'failed', updated_at = NOW()
         WHERE id = $1`,
        [cardId, to],
      );
    } else if (to === 'ready_for_release') {
      await client.query(
        `UPDATE cards SET status = $2, peer_test_result = 'passed', updated_at = NOW()
         WHERE id = $1`,
        [cardId, to],
      );
    } else if (to === 'in_progress' && card.status === 'needs_fix') {
      await client.query(
        `UPDATE cards SET status = $2, peer_test_result = 'not_started', peer_test_notes = '', updated_at = NOW()
         WHERE id = $1`,
        [cardId, to],
      );
    } else if (position !== undefined && Number.isFinite(position)) {
      await client.query(
        `UPDATE cards SET status = $2, position = $3, updated_at = NOW() WHERE id = $1`,
        [cardId, to, position],
      );
    } else {
      await client.query(`UPDATE cards SET status = $2, updated_at = NOW() WHERE id = $1`, [cardId, to]);
    }

    await client.query(
      `INSERT INTO card_events (actor_id, card_id, action, details)
       VALUES ($1, $2, 'workflow.transition', $3)`,
      [actorId, cardId, { from: card.status, to }],
    );
    await client.query(
      `INSERT INTO telegram_projection_outbox (card_id) VALUES ($1)
       ON CONFLICT (card_id) DO UPDATE SET next_attempt_at = NOW(), updated_at = NOW()`,
      [cardId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const updated = await loadCard(cardId);
  if (!updated) throw new WorkflowError('Task disappeared after transition.', 'not_found');
  return updated;
}

export async function recordPeerTest(
  cardId: string,
  actorId: string,
  passed: boolean,
  notes = '',
): Promise<Card> {
  return transitionCard(
    cardId,
    actorId,
    passed ? 'ready_for_release' : 'needs_fix',
    undefined,
    { passed, notes },
  );
}

export async function isWorkflowAdmin(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_admin: boolean }>(
    `SELECT is_admin FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.is_admin === true;
}
