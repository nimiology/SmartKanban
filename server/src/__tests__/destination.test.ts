import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDestination, destinationOptions } from '../telegram/destination.js';

const baseProposal = {
  title: 'Buy eggs',
  description: '',
};

test('defaultDestination: knowledge when title contains URL', () => {
  assert.equal(
    defaultDestination({ title: 'check https://x.com today', description: '' }, true),
    'knowledge',
  );
});

test('defaultDestination: knowledge when description contains URL', () => {
  assert.equal(
    defaultDestination({ title: 'A note', description: 'see https://example.com' }, true),
    'knowledge',
  );
});

test('defaultDestination: knowledge when extra text contains URL (raw message)', () => {
  assert.equal(
    defaultDestination(baseProposal, true, 'https://news.example.com'),
    'knowledge',
  );
});

test('defaultDestination: DM tasks join the shared stream', () => {
  assert.equal(defaultDestination(baseProposal, true), 'public_card');
});

test('defaultDestination: public_card in group with no URL', () => {
  assert.equal(defaultDestination(baseProposal, false), 'public_card');
});

test('destinationOptions never offers a private task destination', () => {
  const opts = destinationOptions(true);
  assert.deepEqual(opts.map((o) => o.key), ['public_card', 'knowledge']);
});
