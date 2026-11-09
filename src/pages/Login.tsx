import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { configured, supabase } from '../lib/supabase';
import type { Role } from '../lib/types';
import { isEmail, isMatric, isStudentCode } from '../lib/validate';
import { Logo } from '../components/Logo';
import { clearIdleFlag, readIdleFlag } from '../lib/idle';

const PORTALS: Record<Role, { t: string; d: string; idLabel: string; col: [string, string] }> = {
  admin: { t: 'Admin', d: 'User accounts, roles, system settings and the audit log.', idLabel: 'Staff email', col: ['#efeafe', '#5b3fb6'] },
  officer: { t: 'Exams Officer', d: 'Dashboard, sessions, reconciliation, archive and student documents.', idLabel: 'Staff email', col: ['#e8edff', '#2340a8'] },
  invigilator: { t: 'Invigilator', d: 'Attendance, script check-in and scan capture for live sessions.', idLabel: 'Staff email', col: ['#fff5d6', '#8d6400'] },
  student: { t: 'Student', d: 'Exams sat, script status and your document vault.', idLabel: 'Matric number or student ID code', col: ['#ffe9e5', '#c4321d'] },
};

function Scene() {
  return (
    <svg viewBox="0 0 560 230" role="img" aria-label="A script moves from the exam hall to the scan station to the records room">
      <path d="M120 186 C 190 214, 230 214, 282 186 S 380 158, 452 186" fill="none" stroke="#ffc83d" strokeWidth="3" strokeDasharray="2 9" strokeLinecap="round" />
      <g transform="translate(46 34) rotate(-6 60 75)">
        <rect width="120" height="150" rx="12" fill="#fff" /><rect width="20" height="150" rx="10" fill="#ffc83d" /><rect x="10" width="10" height="150" fill="#ffc83d" />
        <rect x="34" y="18" width="70" height="26" rx="6" fill="#e8edff" /><rect x="42" y="26" width="40" height="5" rx="2.5" fill="#2340a8" /><rect x="42" y="35" width="28" height="4" rx="2" fill="#8da2ee" />
        <g stroke="#dfe5f7" strokeWidth="2"><line x1="34" y1="62" x2="106" y2="62" /><line x1="34" y1="78" x2="106" y2="78" /><line x1="34" y1="94" x2="106" y2="94" /><line x1="34" y1="110" x2="106" y2="110" /><line x1="34" y1="126" x2="90" y2="126" /></g>
        <line x1="30" y1="54" x2="30" y2="140" stroke="#ff6b57" strokeWidth="2" />
      </g>
      <g transform="translate(212 74)">
        <rect x="0" y="34" width="140" height="66" rx="16" fill="#e8edff" /><rect x="12" y="0" width="116" height="42" rx="12" fill="#fff" />
        <rect x="24" y="12" width="92" height="7" rx="3.5" fill="#ffc83d" /><rect x="24" y="24" width="60" height="5" rx="2.5" fill="#c9d4ff" />
        <rect x="16" y="52" width="58" height="10" rx="5" fill="#2340a8" /><circle cx="114" cy="57" r="8" fill="#21a67a" /><circle cx="92" cy="57" r="5" fill="#c9d4ff" />
        <rect x="26" y="74" width="88" height="16" rx="5" fill="#fff" /><rect x="32" y="79" width="40" height="5" rx="2.5" fill="#8da2ee" />
      </g>
      <g transform="translate(392 56)">
        <rect x="0" y="40" width="130" height="92" rx="12" fill="#ff6b57" /><rect x="-6" y="24" width="142" height="26" rx="10" fill="#ff8b7a" />
        <rect x="38" y="66" width="54" height="30" rx="7" fill="#fff" /><rect x="46" y="74" width="38" height="5" rx="2.5" fill="#ff6b57" /><rect x="46" y="84" width="24" height="4" rx="2" fill="#ffb3a8" />
        <circle cx="122" cy="26" r="22" fill="#ffc83d" /><path d="M111 26 l7 7 l14 -15" fill="none" stroke="#18203a" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g fontFamily="Rubik, sans-serif" fontWeight="700" fontSize="13" fill="#fff">
        <text x="70" y="222">Exam hall</text><text x="238" y="222">Scan + hash</text><text x="414" y="222">Records room</text>
      </g>
    </svg>
  );
}

export function Hero() {
  return (
    <div className="hero">
      <div className="brand"><Logo />ScripTree</div>
      <h1>Every exam script, accounted for.</h1>
      <p className="lead">Follow each answer booklet from the exam hall to the records room, check it against attendance and its scan, and know the moment one goes missing.</p>
      <div className="scene"><Scene /></div>
    </div>
  );
}

function SignInForm({ role, onBack }: { role: Role; onBack: () => void }) {
  const { signInStaff, signInStudent } = useAuth();
  const P = PORTALS[role];
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState('');

  async function forgot() {
    setErr(''); setSent('');
    const v = id.trim().toLowerCase();
    if (!isEmail(v)) { setErr('Enter your staff email first, then choose “Forgot password?”.'); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(v, { redirectTo: window.location.origin });
    // same message either way, so the form doesn't reveal which emails have accounts
    if (error && !/rate|limit/i.test(error.message)) { setErr(error.message); return; }
    setSent(error ? 'Too many requests — wait a minute and try again.' : `If ${v} has an account, a reset link is on its way.`);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    const v = id.trim();
    if (role === 'student' ? !(isMatric(v) || isStudentCode(v)) : !isEmail(v)) {
      setErr(role === 'student' ? 'Enter a matric number (e.g. CSC/21/1034) or student ID (e.g. ST210034).' : 'Enter your staff email.');
      return;
    }
    if (pw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      if (role === 'student') await signInStudent(v, pw);
      else await signInStaff(role, v, pw);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="row" style={{ gap: 14, marginBottom: 18 }}>
        <div className="av" style={{ width: 52, height: 52, borderRadius: 16, display: 'grid', placeItems: 'center', fontFamily: 'var(--display)', fontWeight: 800, fontSize: 20, background: P.col[0], color: P.col[1] }}>{P.t[0]}</div>
        <div><h2 style={{ margin: 0, fontSize: 24 }}>{P.t} sign-in</h2><div className="small muted">{P.d}</div></div>
      </div>
      <form onSubmit={submit} noValidate>
        <label className="form-label" htmlFor="lid">{P.idLabel}</label>
        <input className="input form-input" id="lid" value={id} onChange={(e) => setId(e.target.value)} maxLength={120}
          autoComplete={role === 'student' ? 'username' : 'email'} autoFocus />
        <label className="form-label" htmlFor="lpw">Password</label>
        <input className="input form-input" id="lpw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} maxLength={128} autoComplete="current-password" />
        <div className="err" role="alert">{err}</div>
        {sent && <div className="banner ok" style={{ marginBottom: 8 }}>{sent}</div>}
        <div className="row between" style={{ marginTop: 8 }}>
          <button type="button" className="btn" onClick={onBack}>Choose another role</button>
          <button className="btn pri" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
      <div className="legend" style={{ marginTop: 16 }}>
        {role === 'student'
          ? 'Forgot your password, or never had one? The exams office or ICT admin issues a new one-time password.'
          : <><a href="#" onClick={(e) => { e.preventDefault(); forgot(); }}>Forgot password?</a>{(role === 'admin' || role === 'officer') && ' · You’ll be asked for a two-factor code from your authenticator app next.'}</>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [idle] = useState(readIdleFlag);
  useEffect(clearIdleFlag, []);
  return (
    <div className="login">
      <Hero />
      <div className="side-r">
        {!configured && <div className="banner crit" style={{ marginBottom: 18 }}><b>Supabase is not configured.</b> Copy <span className="mono">.env.example</span> to <span className="mono">.env.local</span> and add your project URL and anon key.</div>}
        {idle && <div className="banner info" role="status" style={{ marginBottom: 18 }}>You were signed out after 15 minutes of inactivity. Sign in again to continue.</div>}
        {role ? <SignInForm role={role} onBack={() => setRole(null)} /> : <>
          <h2>Who's signing in?</h2>
          <div className="muted">Each role has its own sign-in and sees only its own work.</div>
          <div className="roles">
            {(Object.keys(PORTALS) as Role[]).map((k) => (
              <button key={k} className="role" onClick={() => setRole(k)}>
                <div className="av" style={{ background: PORTALS[k].col[0], color: PORTALS[k].col[1] }}>{PORTALS[k].t[0]}</div>
                <div><h4>{PORTALS[k].t}</h4><p>{PORTALS[k].d}</p></div>
                <span className="go">Sign in</span>
              </button>
            ))}
          </div>
          <div className="demo-note">The paper script stays the official original.</div>
        </>}
      </div>
    </div>
  );
}
