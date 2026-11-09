/** Small RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export const CANDIDATE_COLUMNS = ['matric_no', 'full_name', 'student_code', 'email', 'department', 'level', 'course_code'] as const;
export type CandidateRow = Partial<Record<(typeof CANDIDATE_COLUMNS)[number], string>>;

export const STUDENT_COLUMNS = ['matric_no', 'full_name', 'student_code', 'email', 'department', 'level'] as const;
export type StudentRow = Partial<Record<(typeof STUDENT_COLUMNS)[number], string>>;

/** Header aliases people commonly use, mapped to our column names. */
function normHeader(h: string) {
  const k = h.trim().toLowerCase().replace(/[\s.\-/]+/g, '_').replace(/^_+|_+$/g, '');
  return ({ matric: 'matric_no', matric_number: 'matric_no', matriculation_number: 'matric_no', name: 'full_name', student_name: 'full_name',
    student_id: 'student_code', id_code: 'student_code', dept: 'department', course: 'course_code',
    email_address: 'email', e_mail: 'email', student_email: 'email', mail: 'email' } as Record<string, string>)[k] ?? k;
}

function mapRows<C extends string>(rows: string[][], cols: readonly C[], required: readonly C[]): { rows: Partial<Record<C, string>>[]; error?: string } {
  if (!rows.length) return { rows: [], error: 'The file is empty.' };
  const head = rows[0].map(normHeader);
  const idx = Object.fromEntries(cols.map((c) => [c, head.indexOf(c)])) as Record<C, number>;
  const missing = required.filter((c) => idx[c] < 0);
  if (missing.length) return { rows: [], error: `Missing column${missing.length > 1 ? 's' : ''} in the header row: ${missing.join(', ')}. Download the template to see the layout.` };
  return { rows: rows.slice(1).map((r) => Object.fromEntries(cols.filter((c) => idx[c] >= 0).map((c) => [c, (r[idx[c]] ?? '').trim()])) as Partial<Record<C, string>>) };
}

/** Map a parsed CSV (with header row) to candidate rows. Header names are case/space-insensitive. */
export const toCandidates = (rows: string[][]) => mapRows(rows, CANDIDATE_COLUMNS, ['matric_no']);
/** Map a parsed CSV to new-student rows; every column is required. */
export const toStudents = (rows: string[][]) => mapRows(rows, STUDENT_COLUMNS, STUDENT_COLUMNS);

/** Save a CSV file built from rows (first row = header). */
export function downloadCsvFile(name: string, rows: string[][]) {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const SAMPLE: string[][] = [
  ['CSC/21/1001', 'Chinedu Okafor', 'ST210001', 'chinedu.okafor@example.com', 'Computer Science', '400L'],
  ['CSC/21/1002', 'Aisha Bello', 'ST210002', 'aisha.bello@example.com', 'Computer Science', '400L'],
  ['MTH/22/0457', 'Ngozi Adeyemi', 'ST220457', 'ngozi.adeyemi@example.com', 'Mathematics', '300L'],
];
export const downloadStudentTemplate = () => downloadCsvFile('scriptree-students-template.csv', [[...STUDENT_COLUMNS], ...SAMPLE]);
export const downloadCandidateTemplate = (courseCode = 'CSC 409') =>
  downloadCsvFile('scriptree-candidates-template.csv', [[...CANDIDATE_COLUMNS], ...SAMPLE.map((r) => [...r, courseCode])]);
