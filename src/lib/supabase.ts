import { createClient } from '@supabase/supabase-js';
import { invalidateCache } from './cache';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && anon);

/** 'invite' or 'recovery' when the page was opened from an emailed link. Read before the client consumes the URL hash. */
export const urlAuthType: string | null = typeof window === 'undefined' ? null
  : new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type');

/** RPCs that only read. Every other non-GET request is a write and clears the read cache. */
const READ_RPCS = new Set([
  'current_alerts', 'session_summaries', 'dashboard_stats', 'session_counts', 'reconcile_session', 'verify_audit_chain',
  'notification_status', 'my_exams', 'my_documents', 'upload_limit_mb', 'resolve_identifier',
]);
/**
 * Hall writes that set a value rather than add one: sending them twice leaves the same record (at worst a
 * second audit line). Safe to retry when a weak hall connection drops the request or the reply.
 */
const IDEMPOTENT_RPCS = new Set(['mark_attendance', 'mark_all_present', 'set_headcount', 'set_attendance_mode']);
const MAX_RETRIES = 3;

function isWrite(url: string, method: string) {
  if (method === 'GET' || method === 'HEAD') return false;
  const rpc = /\/rest\/v1\/rpc\/([\w]+)/.exec(url);
  if (rpc) return !READ_RPCS.has(rpc[1]);
  // token refreshes and signed-URL requests don't change app data
  return !/\/auth\/v1\/token|\/storage\/v1\/object\/sign\//.test(url);
}

/** Exponential backoff with jitter, so many clients rejected at once don't all retry in lockstep. */
function backoff(attempt: number, retryAfter: string | null) {
  const s = Number(retryAfter);
  if (retryAfter && Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 8000);
  return 500 * 2 ** attempt * (0.5 + Math.random() / 2);
}

const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((done, fail) => {
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); fail(signal.reason); }, { once: true });
});

/**
 * fetch with retries for transient failures, and cache invalidation on writes.
 *  - 429 / 503 from the database API or storage: the request was refused before it ran, so any method is safe to retry.
 *  - 502 / 504 / network errors: retried for reads and for the few hall writes that are safe to repeat
 *    (IDEMPOTENT_RPCS); any other write might already have landed.
 *  - Edge functions and auth are never retried on 429: there it means a real rate limit (e.g. sign-in lockout).
 */
async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const rpcName = /\/rest\/v1\/rpc\/(\w+)/.exec(url)?.[1];
  const readOnly = method === 'GET' || method === 'HEAD' || (rpcName !== undefined && (READ_RPCS.has(rpcName) || IDEMPOTENT_RPCS.has(rpcName)));
  const refusedIsRetryable = /\/(rest|storage)\/v1\//.test(url);
  const write = isWrite(url, method);
  if (write) invalidateCache();
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(input, init);
      } catch (e) {
        if (!readOnly || attempt >= MAX_RETRIES || init?.signal?.aborted) throw e;
        await wait(backoff(attempt, null), init?.signal);
        continue;
      }
      const retry = attempt < MAX_RETRIES && (
        (refusedIsRetryable && (res.status === 429 || res.status === 503)) || (readOnly && (res.status === 502 || res.status === 504)));
      if (!retry) return res;
      await wait(backoff(attempt, res.headers.get('retry-after')), init?.signal);
    }
  } finally {
    // again after the write lands, in case a read cached stale data while it was in flight
    if (write) invalidateCache();
  }
}

// A placeholder client keeps the app renderable (it shows a setup notice) until .env.local is filled in.
export const supabase = createClient(url || 'http://localhost:54321', anon || 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true },
  global: { fetch: resilientFetch },
});

/** Turn a Postgres/Supabase error into a sentence for the UI. */
export function errText(e: unknown): string {
  if (!e) return 'Something went wrong';
  if (typeof e === 'string') return e;
  const m = (e as { message?: string }).message;
  return m || 'Something went wrong';
}

/** Call an edge function and surface its { error } body as the thrown message. */
export async function invokeFn<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body: body as Record<string, unknown> });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const msg = ctx && typeof ctx.json === 'function' ? (await ctx.json().catch(() => null))?.error : null;
    throw new Error(msg || error.message);
  }
  return data as T;
}
