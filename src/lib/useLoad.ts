import { useCallback, useEffect, useRef, useState } from 'react';
import { errText } from './supabase';

/** Run an async loader on mount / when deps change; expose reload for after mutations. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const reload = useCallback(async () => {
    try {
      const d = await load();
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(errText(e));
    }
  }, [load]);
  useEffect(() => { alive.current = true; reload(); return () => { alive.current = false; }; }, [reload]);
  return { data, error, reload };
}

/** Unwrap a Supabase response or throw. */
export function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data as T;
}
