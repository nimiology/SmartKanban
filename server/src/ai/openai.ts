import OpenAI from 'openai';

// ---------- clients ----------
// Lazily constructed so the server boots fine without any AI keys.
let _openai: OpenAI | null | undefined;

export function openai(): OpenAI | null {
  if (_openai !== undefined) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    _openai = null;
    return null;
  }
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

export const AI_ENABLED = () => !!openai();

// ---------- capability-typed targets ----------
export type ChatTarget = { client: OpenAI; model: string; label: string };

// OpenAI is the configured provider for chat and vision.
export function chatPrimary(): ChatTarget | null {
  const oa = openai();
  if (oa) return { client: oa, model: 'gpt-4o-mini', label: 'openai' };
  return null;
}

// Kept for existing callers; this deployment uses one provider, so there is no
// second target to retry after an OpenAI request fails.
export function chatFallback(): ChatTarget | null {
  return null;
}

export function visionPrimary(): ChatTarget | null {
  const oa = openai();
  if (oa) return { client: oa, model: 'gpt-4o-mini', label: 'openai' };
  return null;
}

export function visionFallback(): ChatTarget | null {
  return null;
}

// Audio transcription uses OpenAI's Whisper API.
export function audioClient(): OpenAI | null {
  return openai();
}

// Keep the historical helper name for existing AI callers; this single-provider
// deployment makes one OpenAI request and returns null on failure.
async function _withChatFallback<T>(
  fn: (target: ChatTarget) => Promise<T>,
): Promise<T | null> {
  const primary = chatPrimary();
  if (!primary) {
    console.warn('[ai] chat: no primary client configured');
    return null;
  }
  try {
    return await fn(primary);
  } catch (err) {
    console.warn(`[ai] chat (${primary.label}/${primary.model}) failed:`, String(err).slice(0, 400));
    return null;
  }
}

// Mutable holder so tests can swap the implementation without fighting ESM sealing.
export const aiHooks: {
  withChatFallback: typeof _withChatFallback;
} = {
  withChatFallback: _withChatFallback,
};

export async function withChatFallback<T>(
  fn: (target: ChatTarget) => Promise<T>,
): Promise<T | null> {
  return aiHooks.withChatFallback(fn);
}

export async function withVisionFallback<T>(
  fn: (target: ChatTarget) => Promise<T>,
): Promise<T | null> {
  const primary = visionPrimary();
  if (!primary) {
    console.warn('[ai] vision: no primary client configured');
    return null;
  }
  try {
    return await fn(primary);
  } catch (err) {
    console.warn(`[ai] vision (${primary.label}/${primary.model}) failed:`, String(err).slice(0, 400));
    return null;
  }
}
