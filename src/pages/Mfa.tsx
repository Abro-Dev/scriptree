import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase, errText } from '../lib/supabase';
import { isOtp } from '../lib/validate';
import { Hero } from './Login';

/**
 * Two-factor step for admin and exams officer.
 * First sign-in: enrol an authenticator app (QR code). Later: enter the 6-digit code.
 * Until this passes, the database treats the account as having no role (app_role() needs AAL2).
 */
type Setup = { factorId: string; enrol: { qr: string; secret: string } | null };

// Shared across mounts: React StrictMode (and quick remounts) would otherwise run two
// enrolments at once, and the auth server rejects the second with a generic 500.
let pending: Promise<Setup> | null = null;

async function prepareFactor(): Promise<Setup> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  const verified = data.totp.find((f) => f.status === 'verified');
  if (verified) return { factorId: verified.id, enrol: null };
  // clear half-finished enrolments, then start a fresh one
  for (const f of data.all.filter((x) => x.status !== 'verified')) await supabase.auth.mfa.unenroll({ factorId: f.id });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const en = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `ScripTree ${stamp} ${Math.random().toString(36).slice(2, 6)}` });
  if (en.error) throw en.error;
  return { factorId: en.data.id, enrol: { qr: en.data.totp.qr_code, secret: en.data.totp.secret } };
}

export function MfaPage() {
  const { profile, completeMfa, signOut } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrol, setEnrol] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [setupFailed, setSetupFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErr(''); setSetupFailed(false);
    pending ??= prepareFactor().finally(() => { pending = null; });
    pending.then(
      (s) => { if (!cancelled) { setFactorId(s.factorId); setEnrol(s.enrol); } },
      (e) => { if (!cancelled) { setErr(errText(e)); setSetupFailed(true); } },
    );
    return () => { cancelled = true; };
  }, [attempt]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    const c = code.replace(/\s/g, '');
    if (!isOtp(c)) { setErr('Enter the 6-digit code from your authenticator app.'); return; }
    if (!factorId) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: c });
      if (error) throw new Error(error.message.includes('Invalid') ? 'That code is wrong or expired. Try the current one.' : error.message);
      await completeMfa();
    } catch (ex) {
      setErr(errText(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <Hero />
      <div className="side-r"><div className="signin">
        <h2 style={{ fontSize: 24 }}>Two-factor check</h2>
        <div className="small muted" style={{ marginBottom: 14 }}>{profile?.full_name} · {profile?.email}</div>
        {enrol && <div className="card" style={{ marginBottom: 16 }}>
          <b>Set up your authenticator app</b>
          <div className="small muted">Admin and exams officer accounts must use two-factor. Scan this with Google Authenticator, Microsoft Authenticator or similar.</div>
          <img className="qr" src={enrol.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <div className="small muted">Can't scan? Enter this key: <span className="hash" style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{enrol.secret}</span></div>
        </div>}
        <form onSubmit={submit} noValidate>
          <label className="form-label" htmlFor="otp">6-digit code</label>
          <input className="input form-input mono" id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={7}
            value={code} onChange={(e) => setCode(e.target.value)} autoFocus style={{ fontSize: 18, letterSpacing: 4 }} />
          <div className="err" role="alert">{err}</div>
          <div className="row between" style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => void signOut()}>Cancel</button>
            {setupFailed
              ? <button type="button" className="btn pri" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
              : <button className="btn pri" disabled={busy || !factorId}>{busy ? 'Checking…' : 'Verify'}</button>}
          </div>
        </form>
      </div></div>
    </div>
  );
}
