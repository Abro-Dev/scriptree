/**
 * Tiny shared read cache. Several screens (and the sidebar badge) ask for the same expensive
 * aggregates — current_alerts, dashboard_stats, session_summaries — within seconds of each other.
 * `cached` hands every caller inside the TTL the same promise, so concurrent and repeat requests
 * collapse into one round trip. Any write the app makes clears the whole cache (see supabase.ts),
 * so a screen that reloads after a mutation always sees fresh data.
 */
interface Entry { at: number; p: Promise<unknown> }
const store = new Map<string, Entry>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn();
  store.set(key, { at: Date.now(), p });
  // never cache a failure
  p.catch(() => { if (store.get(key)?.p === p) store.delete(key); });
  return p;
}

/** Drop everything: after any write, and on sign-out (cached rows belong to the previous user). */
export function invalidateCache() {
  store.clear();
}
