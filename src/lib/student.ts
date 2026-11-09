import type { Severity } from '../components/ui';

export interface MyExam {
  session_id: string; course_code: string; course_title: string; exam_date: string; venue: string;
  status: 'scheduled' | 'live' | 'closed'; script_code: string | null; present: boolean | null;
  has_physical: boolean; n_scans: number; outcome: string; severity: Severity; resolved: boolean;
}

export interface MyDoc {
  doc_id: string; doc_type: string; status: 'pending' | 'verified' | 'rejected'; reason: string | null; uploaded_at: string;
  file_no: number; sha256: string; size_bytes: number; original_name: string; verified_by_name: string | null; verified_at: string | null;
}

/** What a student sees for a record. Internal outcome names (e.g. integrity failure) stay with the exams office. */
export function studentStatus(e: MyExam): [Severity, string] {
  if (e.status === 'scheduled') return ['pend', 'Upcoming'];
  if (e.severity === 'ok') return ['ok', 'Complete'];
  if (e.outcome === 'Absent') return ['info', 'Absent'];
  if (e.severity === 'pend') return ['pend', 'In progress'];
  if (e.resolved) return ['ok', 'Resolved by exams office'];
  return [e.severity, 'Under review by exams office'];
}
