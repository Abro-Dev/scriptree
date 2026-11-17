import type { Severity } from '../components/ui';

export interface GradeBand { grade: string; min: number }

/** Bands highest first, as the server stores them. Used until grade_bands() answers. */
export const DEFAULT_BANDS: GradeBand[] = [
  { grade: 'A', min: 70 }, { grade: 'B', min: 60 }, { grade: 'C', min: 50 }, { grade: 'D', min: 45 }, { grade: 'E', min: 40 }, { grade: 'F', min: 0 },
];

/** Letter for a percentage. Rounded to one decimal first, so 69.96 % counts as 70 % (A), as it is shown. */
export function letter(pct: number, bands: GradeBand[]): string {
  const p = Math.round(pct * 10) / 10;
  return [...bands].sort((a, b) => b.min - a.min).find((b) => p >= b.min)?.grade ?? '—';
}

/** "67", "55.5", "72.25": no trailing zeros. */
export const fmtScore = (n: number | string | null | undefined) => (n == null ? '—' : String(Number(n)));
export const pct = (score: number, max: number) => (max > 0 ? (Number(score) / Number(max)) * 100 : 0);
export const fmtPct = (p: number) => `${Math.round(p * 10) / 10}%`;

/** A typed score: 0 to max, at most two decimals. Returns the number, or an error sentence. */
export function parseScore(raw: string, max: number): number | string {
  const v = raw.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return 'Enter a number with at most two decimals';
  const n = Number(v);
  if (n > max) return `Score can't be above ${fmtScore(max)}`;
  return n;
}

export interface SheetRow {
  student_id: string; matric_no: string; full_name: string; script_id: string | null; script_code: string | null; custody: string | null;
  present: boolean | null; outcome: string; severity: Severity; resolved: boolean; eligible: boolean; hold_reason: string | null;
  score: number | null; graded_by_name: string | null; graded_at: string | null;
}

export interface ResultsSession {
  id: string; course_code: string; course_title: string; exam_date: string; start_time: string; venue: string;
  max_score: number; results_status: 'draft' | 'published'; results_published_at: string | null;
  scripts: number; eligible: number; graded: number; ungraded: number; withheld: number; avg_pct: number | null;
}

export interface ScoreboardRow {
  session_id: string; course_code: string; course_title: string; exam_date: string; venue: string;
  session_status: 'scheduled' | 'live' | 'closed'; results_status: 'draft' | 'published'; max_score: number;
  script_code: string | null; outcome: string; severity: Severity; eligible: boolean; hold_reason: string | null;
  score: number | null; graded_by_name: string | null; graded_at: string | null;
}

export type ResultState = 'graded' | 'withheld' | 'awaiting' | 'absent' | 'no_script' | 'not_released';
export interface MyResult {
  session_id: string; course_code: string; course_title: string; exam_date: string; script_code: string | null;
  max_score: number; score: number | null; state: ResultState; published_at: string | null;
}

/** What a student sees for a result that has no score. Internal reasons stay with the exams office. */
export const STATE_LABEL: Record<Exclude<ResultState, 'graded'>, [Severity, string]> = {
  not_released: ['pend', 'Not released yet'],
  awaiting: ['pend', 'Being graded'],
  withheld: ['med', 'Withheld: under review'],
  absent: ['info', 'Absent'],
  no_script: ['high', 'No script on record'],
};

/** Course totals: sum of scores over sum of maximums across the course's released, graded papers. */
export interface CourseTotal { course_code: string; course_title: string; papers: MyResult[]; score: number; max: number; counted: number }
export function courseTotals(rows: MyResult[]): CourseTotal[] {
  const by = new Map<string, CourseTotal>();
  for (const r of rows) {
    const c = by.get(r.course_code) ?? { course_code: r.course_code, course_title: r.course_title, papers: [], score: 0, max: 0, counted: 0 };
    c.papers.push(r);
    if (r.state === 'graded' && r.score != null) { c.score += Number(r.score); c.max += Number(r.max_score); c.counted++; }
    by.set(r.course_code, c);
  }
  return [...by.values()];
}
