import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { fetchSettings } from './queries';
import type { Severity } from '../components/ui';

export type AttMode = 'start' | 'end' | 'submission';
export const ATT_MODES: Record<AttMode, string> = { start: 'At the start', end: 'At the end', submission: 'At script submission' };

export interface ExamSession {
  id: string;
  course_code: string;
  course_title: string;
  exam_date: string;
  start_time: string;
  venue: string;
  status: 'scheduled' | 'live' | 'closed';
  attendance_mode: AttMode;
  headcount: number | null;
  invigilator_id: string | null;
}

export interface ReconRow {
  student_id: string;
  matric_no: string;   // the student ID, e.g. BU/24C/IT/10778
  full_name: string;
  is_registered: boolean;
  present: boolean | null;
  has_physical: boolean;
  n_scans: number;
  integrity_bad: boolean;
  outcome: string;
  severity: Severity;
  resolved: boolean;
  script_code: string | null;
}

export interface Counts { registered: number; present: number; physical: number; scanned: number; headcount: number | null }
export interface AttMark { student_id: string; present: boolean; mode: AttMode; marked_at: string }
export interface RecentScript { script_code: string; created_at: string; students: { full_name: string; matric_no: string } | null }

export interface HallData {
  session: ExamSession;
  counts: Counts;
  rows: ReconRow[];
  marks: Record<string, AttMark>;
  recent: RecentScript[];
  settings: { allow_pdf_upload: boolean; allow_photo_snaps: boolean; max_file_mb: number };
}

async function fetchHall(id: string): Promise<HallData> {
  const [s, c, r, a, rec, st] = await Promise.all([
    supabase.from('exam_sessions').select('*').eq('id', id).single<ExamSession>(),
    supabase.rpc('session_counts', { p_session: id }).single<Counts>(),
    supabase.rpc('reconcile_session', { p_session: id }),
    supabase.from('attendance').select('student_id, present, mode, marked_at').eq('session_id', id).returns<AttMark[]>(),
    supabase.from('scripts').select('script_code, created_at, students(full_name, matric_no)').eq('session_id', id)
      .order('created_at', { ascending: false }).limit(6).returns<RecentScript[]>(),
    fetchSettings(),
  ]);
  for (const x of [s, c, r, a, rec]) if (x.error) throw x.error;
  return {
    session: s.data!, counts: c.data!, rows: (r.data as ReconRow[] | null) ?? [], recent: rec.data ?? [],
    marks: Object.fromEntries((a.data ?? []).map((m) => [m.student_id, m])),
    settings: st,
  };
}

const POLL_MS = 15_000;

/**
 * Loads a hall and re-polls about every 15 s, so a separate scan-station device shows up in the counts.
 * Polls are jittered (±20%) so hall devices opened together don't hit the database in lockstep. They
 * never overlap, pause while the tab is hidden, and catch up as soon as it's visible again.
 */
export function useHall(id: string | undefined) {
  const [data, setData] = useState<HallData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastAt = useRef(0);

  const queued = useRef<Promise<void> | null>(null);

  /** One fetch at a time. A call made mid-fetch (e.g. right after marking attendance) gets one fresh fetch queued behind it, never the stale result. */
  const reload = useCallback((): Promise<void> => {
    if (!id) return Promise.resolve();
    if (inFlight.current) {
      queued.current ??= inFlight.current.then(() => { queued.current = null; return reload(); });
      return queued.current;
    }
    const p = (async () => {
      try {
        const d = await fetchHall(id);
        if (live.current) { setData(d); setError(null); }
      } catch (e) {
        if (live.current) setError((e as Error).message);
      } finally {
        lastAt.current = Date.now();
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, [id]);

  useEffect(() => {
    live.current = true;
    let active = true; // per run: a previous run's pending callbacks must not restart polling
    let t: number | undefined;
    const schedule = () => {
      window.clearTimeout(t);
      t = window.setTimeout(tick, POLL_MS * (0.8 + Math.random() * 0.4));
    };
    const tick = () => {
      if (document.visibilityState === 'visible') reload().finally(() => { if (active) schedule(); });
      // hidden: stop here; the visibility handler restarts polling
    };
    const onVisible = () => {
      if (!active || document.visibilityState !== 'visible') return;
      if (Date.now() - lastAt.current > POLL_MS / 3) reload();
      schedule();
    };
    reload().finally(() => { if (active) schedule(); });
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; live.current = false; window.clearTimeout(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [reload]);

  return { data, error, reload };
}

// Live search over hall rows. IDs match ignoring case, spaces, slashes and dashes ("bu24cit10778"
// finds "BU/24C/IT/10778"); names match when every typed word starts a word in the name, in any order.
const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
export function matchRow(r: Pick<ReconRow, 'matric_no' | 'full_name' | 'script_code'>, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const s = squash(t);
  if (s && [r.matric_no, r.script_code ?? ''].some((id) => squash(id).includes(s))) return true;
  const words = r.full_name.toLowerCase().split(/\s+/);
  return t.split(/\s+/).every((w) => words.some((nw) => nw.startsWith(w)));
}

export const fmtTime =(iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
