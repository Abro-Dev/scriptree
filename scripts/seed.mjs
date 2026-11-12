// Seeds a Supabase project with demo accounts and one scheduled exam session.
// Usage:  npm run seed            (reads .env.local)
// Needs:  VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   Optional: SEED_PASSWORD
// Safe to re-run: existing users/students/sessions are reused, not duplicated.
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(1); }
const PASSWORD = process.env.SEED_PASSWORD || 'ScripTree-demo-2026';
const STUDENT_EMAIL_DOMAIN = 'students.scriptree.local';

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const STAFF = [
  { email: 'admin@school.edu.ng', role: 'admin', full_name: 'Mr. Tunde Bakare', title: 'System Admin · ICT' },
  { email: 'a.okoro@school.edu.ng', role: 'officer', full_name: 'Mrs. Adaeze Okoro', title: 'Exams Officer' },
  { email: 'i.danladi@school.edu.ng', role: 'invigilator', full_name: 'Mr. Ibrahim Danladi', title: 'Invigilator · Hall D' },
  { email: 'g.ekwueme@school.edu.ng', role: 'invigilator', full_name: 'Mrs. Grace Ekwueme', title: 'Invigilator' },
];
const FIRST = ['Chinedu', 'Aisha', 'Tunde', 'Ngozi', 'Ibrahim', 'Funmilayo', 'Emeka', 'Zainab', 'Oluwaseun', 'Amaka', 'Musa', 'Blessing', 'Yusuf', 'Chiamaka', 'Babatunde', 'Halima', 'Ifeanyi', 'Temitope', 'Abdullahi', 'Adaeze'];
const LAST = ['Okafor', 'Bello', 'Adeyemi', 'Nwosu', 'Abubakar', 'Okonkwo', 'Balogun', 'Eze', 'Mohammed', 'Olawale', 'Ibekwe', 'Danjuma', 'Ogunleye', 'Chukwu', 'Suleiman'];
const N_STUDENTS = 40;

let allUsers = null;
async function findUser(email) {
  if (!allUsers) {
    allUsers = [];
    for (let page = 1; ; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      allUsers.push(...data.users);
      if (data.users.length < 1000) break;
    }
  }
  return allUsers.find((u) => u.email === email);
}
async function ensureUser(email) {
  const existing = await findUser(email);
  if (existing) return existing.id;
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  return data.user.id;
}
const must = ({ error, data }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

console.log('Staff…');
const staffIds = {};
for (const s of STAFF) {
  const id = await ensureUser(s.email);
  staffIds[s.email] = id;
  must(await db.from('profiles').upsert({ id, role: s.role, full_name: s.full_name, email: s.email, title: s.title }), 'profile ' + s.email);
}

console.log(`Students (${N_STUDENTS})…`);
const studentIds = [];
for (let i = 0; i < N_STUDENTS; i++) {
  const matric = `BU/21A/CS/${10001 + i}`, code = matric.toLowerCase().replace(/\//g, '.');   // sign-in address, as admin-users makes it
  const full_name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
  const uid = await ensureUser(`${code.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`);
  must(await db.from('profiles').upsert({ id: uid, role: 'student', full_name, email: `${code.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}` }), 'student profile');
  const row = must(await db.from('students').upsert({ user_id: uid, matric_no: matric, full_name, department: 'Computer Science', level: '400L' }, { onConflict: 'matric_no' }).select('id').single(), 'student ' + matric);
  studentIds.push(row.id);
}

console.log('Exam session…');
const today = new Date().toISOString().slice(0, 10);
let session = must(await db.from('exam_sessions').select('*').eq('course_code', 'CSC 409').eq('exam_date', today).maybeSingle(), 'find session');
if (!session) {
  session = must(await db.from('exam_sessions').insert({
    course_code: 'CSC 409', course_title: 'Artificial Intelligence', exam_date: today, start_time: '09:00',
    venue: 'Hall D', invigilator_id: staffIds['i.danladi@school.edu.ng'], attendance_mode: 'start', created_by: staffIds['a.okoro@school.edu.ng'],
  }).select('*').single(), 'create session');
  const regs = studentIds.slice(0, 30).map((sid, i) => ({ session_id: session.id, student_id: sid, seq: i + 1 }));
  must(await db.from('registrations').insert(regs), 'registrations');
}

console.log(`
Done. Password for every demo account: ${PASSWORD}
  Admin        admin@school.edu.ng      (two-factor set-up on first sign-in)
  Exams officer a.okoro@school.edu.ng   (two-factor set-up on first sign-in)
  Invigilator  i.danladi@school.edu.ng  (runs CSC 409 today, 30 registered)
  Student      BU/21A/CS/10001
`);
