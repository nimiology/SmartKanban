import type { Status } from './types.ts';

const NEXT: Record<Status, readonly Status[]> = {
  inbox: ['in_progress'],
  in_progress: ['ready_for_test'],
  ready_for_test: ['needs_fix', 'ready_for_release'],
  needs_fix: ['in_progress'],
  ready_for_release: ['released'],
  released: [],
};

export function canMoveCard(from: Status, to: Status): boolean {
  return from === to || NEXT[from].includes(to);
}
