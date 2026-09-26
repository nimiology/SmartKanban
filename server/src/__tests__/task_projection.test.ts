import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskProjection, splitTelegramText, TELEGRAM_SAFE_TEXT_LIMIT } from '../telegram/task_projection.js';

const task = {
  id: 'task-123',
  title: 'تکمیل کارت تسک',
  description: 'شرح کامل فارسی task',
  status: 'ready_for_test' as const,
  work_type: 'feature' as const,
  priority: 'P1' as const,
  tags: ['تلگرام', 'تجربه-کاربری'],
  acceptance_criteria: ['توضیح کامل نمایش داده شود', 'کارت در DM هم ویرایش شود'],
  branch_url: 'https://example.com/branch',
  pull_request_url: 'https://example.com/pull/1',
  peer_test_notes: 'آزمایش روی گفت‌وگوی ساده',
  owner_name: 'Nima',
  tester_name: 'Sara',
  parent_title: 'تسک مادر',
  board_url: 'https://kanban.example/m/card/task-123',
  status_label: 'آمادهٔ آزمایش',
  type_label: 'قابلیت',
};

test('task projection includes complete task fields and the entire description', () => {
  const rendered = formatTaskProjection(task);
  for (const value of [
    task.title,
    task.description,
    task.status_label,
    task.type_label,
    task.priority,
    task.owner_name,
    task.tester_name,
    task.id,
    ...task.tags,
    ...task.acceptance_criteria,
    task.parent_title!,
    task.board_url,
  ]) assert.ok(rendered.includes(value), `missing projected field: ${value}`);
});

test('long Persian and emoji text splits below Telegram limit without losing characters', () => {
  const text = `${'🙂 متن فارسی و English '.repeat(600)}\nپایان`;
  const parts = splitTelegramText(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= TELEGRAM_SAFE_TEXT_LIMIT));
  assert.equal(parts.join(''), text);
});
