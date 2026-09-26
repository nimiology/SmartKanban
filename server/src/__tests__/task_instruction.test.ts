import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskInstruction } from '../telegram/task_instruction.js';

test('task instruction parser accepts explicit move and assignment actions', () => {
  assert.deepEqual(parseTaskInstruction({ action: 'move', status: 'in_progress' }), {
    action: 'move', status: 'in_progress',
  });
  assert.deepEqual(parseTaskInstruction({ action: 'assign', person: '@sara' }), {
    action: 'assign', person: '@sara',
  });
});

test('task instruction parser requires clarification for invalid or incomplete actions', () => {
  assert.equal(parseTaskInstruction({ action: 'move', status: 'done' })?.action, 'unclear');
  assert.equal(parseTaskInstruction({ action: 'assign', person: '' })?.action, 'unclear');
  assert.equal(parseTaskInstruction({ action: 'split', tasks: [{ title: 'only one' }] })?.action, 'unclear');
  assert.deepEqual(parseTaskInstruction({ action: 'unclear', question: 'کدام عضو؟' }), {
    action: 'unclear', question: 'کدام عضو؟',
  });
});

test('task instruction parser returns separate-task and split previews only with complete task drafts', () => {
  assert.deepEqual(parseTaskInstruction({
    action: 'separate', task: { title: 'کار مستقل', description: 'شرح' },
  }), { action: 'separate', title: 'کار مستقل', description: 'شرح' });
  assert.deepEqual(parseTaskInstruction({
    action: 'split', tasks: [{ title: 'بخش یک' }, { title: 'بخش دو', description: 'شرح' }],
  }), {
    action: 'split',
    tasks: [
      { title: 'بخش یک', description: '' },
      { title: 'بخش دو', description: 'شرح' },
    ],
  });
});
