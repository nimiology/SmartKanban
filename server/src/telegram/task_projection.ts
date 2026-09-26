import type { Card } from '../cards.js';

export const TELEGRAM_SAFE_TEXT_LIMIT = 4_000;

export type TaskProjectionText = Pick<
  Card,
  | 'title'
  | 'description'
  | 'status'
  | 'work_type'
  | 'priority'
  | 'tags'
  | 'acceptance_criteria'
  | 'branch_url'
  | 'pull_request_url'
  | 'peer_test_notes'
  | 'id'
> & {
  owner_name: string | null;
  tester_name: string | null;
  parent_title?: string | null;
  board_url: string;
  status_label: string;
  type_label: string;
};

export function formatTaskProjection(task: TaskProjectionText): string {
  const lines = [
    `${task.status === 'released' ? '✅' : task.status === 'ready_for_test' ? '🧪' : task.status === 'needs_fix' ? '🛠️' : task.status === 'in_progress' ? '⚡' : task.status === 'ready_for_release' ? '🚀' : '📥'} ${task.title}`,
    `${task.status_label} · ${task.type_label} · اولویت ${task.priority}`,
    `مسئول: ${task.owner_name ?? 'تعیین‌نشده'} · آزمایش‌گر: ${task.tester_name ?? 'تعیین‌نشده'}`,
    `شناسهٔ کار: ${task.id}`,
  ];
  if (task.description.trim()) lines.push('', 'شرح کامل:', task.description.trim());
  if (task.tags.length) lines.push('', `برچسب‌ها: ${task.tags.map((tag) => `#${tag}`).join(' ')}`);
  if (task.acceptance_criteria.length) {
    lines.push('', 'معیارهای پذیرش:', ...task.acceptance_criteria.map((item) => `• ${item}`));
  }
  if (task.parent_title) lines.push('', `زیرتسکِ: ${task.parent_title}`);
  if (task.branch_url) lines.push('', `شاخه: ${task.branch_url}`);
  if (task.pull_request_url) lines.push(`درخواست ادغام: ${task.pull_request_url}`);
  if (task.peer_test_notes) lines.push('', `یادداشت آزمایش: ${task.peer_test_notes}`);
  if (task.board_url) lines.push('', `باز کردن در SmartKanban: ${task.board_url}`);
  return lines.join('\n');
}

export function splitTelegramText(text: string, limit = TELEGRAM_SAFE_TEXT_LIMIT): string[] {
  if (limit < 2) throw new Error('Telegram message limit must be at least two UTF-16 code units');
  const chars = Array.from(text);
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  while (chars.length > 0) {
    let hardSplitAt = 0;
    let codeUnits = 0;
    const prefixUnits = [0];
    while (hardSplitAt < chars.length && codeUnits + chars[hardSplitAt]!.length <= limit) {
      codeUnits += chars[hardSplitAt]!.length;
      hardSplitAt++;
      prefixUnits.push(codeUnits);
    }
    if (hardSplitAt === chars.length) break;
    const minUnits = Math.floor(limit * 0.6);
    let splitAt = hardSplitAt;
    let preferred = -1;
    for (let i = hardSplitAt - 1; i > 0; i--) {
      if (prefixUnits[i]! < minUnits) break;
      if (chars[i] === '\n') { preferred = i; break; }
    }
    if (preferred < 0) {
      for (let i = hardSplitAt - 1; i > 0; i--) {
        if (prefixUnits[i]! < minUnits) break;
        if (chars[i] === ' ') { preferred = i; break; }
      }
    }
    if (preferred > 0) splitAt = preferred;
    const part = chars.splice(0, splitAt).join('');
    if (part) parts.push(part);
  }
  const tail = chars.join('');
  if (tail) parts.push(tail);
  return parts.length ? parts : [''];
}
