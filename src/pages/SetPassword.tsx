import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { Hero } from './Login';

export const PASSWORD_MIN = 10;

/** Shown after an invite or reset link, or a first sign-in with an admin-issued temporary password. */
export function SetPasswordPage() {
  const { profile, student, setPassword, signOut } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (pw.length < PASSWORD_MIN) return setErr(`Use at least ${PASSWORD_MIN} characters.`);
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return setErr('Use letters and at least one number.');
    if (pw !== pw2) return setErr('The two passwords don’t match.');
    setBusy(true);
    try { await setPassword(pw); } catch (ex) { setErr((ex as Error).message); } finally { setBusy(false); }
  }

  const who = student ? `${student.full_name} · ${student.matric_no}` : `${profile?.full_name} · ${profile?.email}`;
  return (
    <div className="login">
      <Hero />
      <div className="side-r"><div className="signin">
        <h2 style={{ fontSize: 24 }}>Choose your password</h2>
        <div className="small muted" style={{ marginBottom: 14 }}>{who}</div>
        {profile?.must_change_password && <div className="banner info" style={{ marginBottom: 14 }}>You signed in with a temporary password. Choose your own to continue — the temporary one stops working.</div>}
        <form onSubmit={submit} noValidate>
          <label className="form-label" htmlFor="np">New password</label>
          <input className="input form-input" id="np" type="password" autoComplete="new-password" maxLength={128} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <label className="form-label" htmlFor="np2">Repeat it</label>
          <input className="input form-input" id="np2" type="password" autoComplete="new-password" maxLength={128} value={pw2} onChange={(e) => setPw2(e.target.value)} />
          <div className="legend" style={{ marginBottom: 8 }}>At least {PASSWORD_MIN} characters, with letters and a number.</div>
          <div className="err" role="alert">{err}</div>
          <div className="row between" style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => void signOut()}>Cancel</button>
            <button className="btn pri" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
          </div>
        </form>
      </div></div>
    </div>
  );
}
