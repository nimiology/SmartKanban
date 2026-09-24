import { useEffect, useState } from 'react';
import type { Card, Status } from './types.ts';
import { connectWS } from './ws.ts';

// Read-only kiosk view styled for a two-way mirror (high contrast white on black).
// Auth is via ?token=...; passed to the server as X-Mirror-Token on API calls and ?mirror=... on ws.

export function MirrorView() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') ?? '';
  const [cards, setCards] = useState<Card[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch('/api/cards?scope=personal', {
        headers: { 'x-mirror-token': token },
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setCards(await r.json());
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    if (!token) {
      setErr('missing token');
      return;
    }
    refresh();
    const iv = setInterval(refresh, 30_000);
    const disconnect = connectWS(
      (ev) => {
        if (ev.type === 'card.updated' || ev.type === 'card.created') refresh();
        if (ev.type === 'card.deleted') refresh();
      },
      { mirrorToken: token },
    );
    return () => {
      clearInterval(iv);
      disconnect();
    };
  }, [token]);

  const active = cards.filter((c) => ['in_progress', 'ready_for_test', 'needs_fix'].includes(c.status));
  const grouped: Record<Status, Card[]> = {
    inbox: [],
    in_progress: active.filter((c) => c.status === 'in_progress'),
    ready_for_test: active.filter((c) => c.status === 'ready_for_test'),
    needs_fix: active.filter((c) => c.status === 'needs_fix'),
    ready_for_release: [],
    released: [],
  };

  return (
    <div
      className="min-h-screen bg-black text-white"
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div className="p-10">
        <div className="text-[10vw] leading-none font-extralight tracking-tight">My Day</div>
        {err && <div className="mt-6 text-xl text-red-400">{err}</div>}
        {grouped.in_progress.length > 0 && (
          <section className="mt-10">
            <h2 className="text-2xl text-neutral-400">In Progress</h2>
            <ul className="mt-4 space-y-3">
              {grouped.in_progress.map((c) => (
                <li key={c.id} className="text-4xl font-light">
                  {c.title}
                </li>
              ))}
            </ul>
          </section>
        )}
        {grouped.ready_for_test.length > 0 && (
          <section className="mt-10">
            <h2 className="text-2xl text-neutral-400">Ready for Test</h2>
            <ul className="mt-4 space-y-3">
              {grouped.ready_for_test.map((c) => (
                <li key={c.id} className="text-4xl font-light">
                  {c.title}
                </li>
              ))}
            </ul>
          </section>
        )}
        {grouped.needs_fix.length > 0 && (
          <section className="mt-10">
            <h2 className="text-2xl text-red-300">Needs Fix</h2>
            <ul className="mt-4 space-y-3">
              {grouped.needs_fix.map((c) => <li key={c.id} className="text-4xl font-light">{c.title}</li>)}
            </ul>
          </section>
        )}
        {active.length === 0 && !err && (
          <div className="mt-12 text-3xl text-neutral-600">Nothing on deck.</div>
        )}
      </div>
    </div>
  );
}
