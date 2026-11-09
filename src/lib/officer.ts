import type { Severity } from '../components/ui';

export interface SessionSummary {
  id: string; course_code: string; course_title: string; exam_date: string; start_time: string; venue: string;
  status: 'scheduled' | 'live' | 'closed'; invigilator_name: string | null; last_reconciled_at: string | null;
  registered: number; present: number; physical: number; scanned: number; headcount: number | null;
  complete: number; open_issues: number; pending: number; hc_mismatch: boolean;
}

export interface Alert {
  alert_key: string; severity: Exclude<Severity, 'ok' | 'pend' | 'info'>; kind: string; title: string; detail: string;
  session_id: string | null; student_id: string | null; raised_at: string; acked_by: string | null; acked_at: string | null;
}

export interface DashboardStats {
  scripts_total: number; scripts_by_status: Record<string, number>;
  scan_files: number; files_total: number; files_failed: number; files_checked: number; last_check_at: string | null;
  students_total: number; students_complete: number;
  docs_by_status: Record<string, number>; docs_verified_by_type: Record<string, number>;
}

export interface DocType { id: string; name: string; required: boolean; sort: number }

/** [label, pill class] for a session's status, matching the prototype. */
export function sessionPill(s: SessionSummary): [string, string] {
  if (s.status === 'live') return ['Live', 'p-live'];
  if (s.status === 'scheduled') return ['Scheduled', 'p-pend'];
  const n = s.open_issues + (s.hc_mismatch ? 1 : 0);
  return n ? [`${n} open`, 'p-high'] : ['Reconciled', 'p-ok'];
}

export const fileId = (n: number) => 'F' + String(n).padStart(4, '0');
export const fmtStamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
