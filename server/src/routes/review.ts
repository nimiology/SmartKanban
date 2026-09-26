import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireUser } from '../auth.js';
import { maybeWeeklySummary } from '../ai/weekly_summary.js';

type ReviewRow = {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  created_at: string;
  tags: string[];
};

async function loadReviewRows(_userId: string) {
  const [done, stale, stuck] = await Promise.all([
    pool.query<ReviewRow>(
      `SELECT c.id, c.title, c.status, c.updated_at, c.created_at, c.tags
       FROM cards c
       WHERE NOT c.archived AND c.status = 'released' AND c.updated_at > NOW() - INTERVAL '7 days'
       ORDER BY c.updated_at DESC`,
      [],
    ),
    pool.query<ReviewRow>(
      `SELECT c.id, c.title, c.status, c.updated_at, c.created_at, c.tags
       FROM cards c
       WHERE NOT c.archived AND c.status IN ('inbox', 'in_progress', 'ready_for_test', 'needs_fix', 'ready_for_release')
         AND c.updated_at < NOW() - INTERVAL '7 days'
       ORDER BY c.updated_at ASC`,
      [],
    ),
    pool.query<ReviewRow>(
      `SELECT c.id, c.title, c.status, c.updated_at, c.created_at, c.tags
       FROM cards c
       WHERE NOT c.archived AND c.status = 'in_progress'
         AND c.updated_at < NOW() - INTERVAL '3 days'
       ORDER BY c.updated_at ASC`,
      [],
    ),
  ]);
  return { done: done.rows, stale: stale.rows, stuck: stuck.rows };
}

export async function reviewRoutes(app: FastifyInstance) {
  app.get('/api/review', { preHandler: requireUser }, async (req) => {
    const userId = req.user!.id;
    return { ...(await loadReviewRows(userId)), summary: null };
  });

  app.post('/api/review/summary', { preHandler: requireUser }, async (req) => {
    const rows = await loadReviewRows(req.user!.id);
    const summary = await maybeWeeklySummary(rows.done, rows.stale, rows.stuck);
    return { summary };
  });
}
