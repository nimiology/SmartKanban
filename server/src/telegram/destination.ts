import type { Proposal as AIProposal } from '../ai/propose.js';
import type { Destination } from './proposals.js';

const URL_RE = /https?:\/\//i;

/**
 * Picks the auto-selected destination for the new structured-capture flow.
 *
 *   - Knowledge: title or description contains a URL
 *   - Shared team task: any chat with no URL
 *
 * The AIProposal type does not carry an explicit `links` array, so URL
 * detection happens on the title + description strings directly. The
 * original message text is checked by the caller via `extractUrls`.
 */
export function defaultDestination(
  p: Pick<AIProposal, 'title' | 'description'>,
  isPrivateChat: boolean,
  extraText = '',
): Destination {
  const hasLink =
    URL_RE.test(p.title) ||
    URL_RE.test(p.description ?? '') ||
    URL_RE.test(extraText);
  if (hasLink) return 'knowledge';
  void isPrivateChat;
  return 'public_card';
}

export function destinationOptions(
  isPrivateChat: boolean,
): Array<{ key: Destination; label: string }> {
  void isPrivateChat;
  return [
    { key: 'public_card', label: '👥 جریان مشترک تسک‌ها' },
    { key: 'knowledge', label: '📚 دانش' },
  ];
}
