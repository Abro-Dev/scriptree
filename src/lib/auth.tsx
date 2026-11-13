import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, errText, invokeFn, urlAuthType } from './supabase';
import { MFA_ROLES, type Profile, type Role, type Student } from './types';
import { invalidateCache } from './cache';
import { clearActivity, flagIdleSignOut, idleFor, idleLimit } from './idle';

/**
 * Sign-in states:
 *  loading      — restoring a stored session
 *  signed-out   — show the role picker
 *  set-password — opened an invite/reset link, or signed in with a temporary password
 *  needs-mfa    — admin/officer signed in with password but not yet at AAL2
 *  ready        — fully signed in; profile (and student record) loaded
 */
type Stage = 'loading' | 'signed-out' | 'set-password' | 'needs-mfa' | 'ready';

// an emailed invite/reset link must end in "choose a password", once per page load
let linkPending = urlAuthType === 'invite' || urlAuthType === 'recovery';

interface AuthValue {
  stage: Stage;
  session: Session | null;
  profile: Profile | null;
  student: Student | null;
  signInStaff: (role: Role, email: string, password: string) => Promise<void>;
  signInStudent: (identifier: string, password: string) => Promise<void>;
  completeMfa: () => Promise<void>;
  setPassword: (password: string) => Promise<void>;
  /** idle: signed out for inactivity. Ends only this browser's session, and the sign-in screen says why. */
  signOut: (opts?: { idle?: boolean }) => Promise<void>;
}

const AuthCtx = createContext<AuthValue | null>(null);

async function loadProfile(uid: string) {
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle<Profile>();
  if (error) throw error;
  if (!profile) throw new Error('This account has no ScripTree role. Ask the admin to set one up.');
  if (profile.status !== 'active') throw new Error('This account is suspended. Contact the system admin.');
  let student: Student | null = null;
  if (profile.role === 'student') {
    const r = await supabase.from('students').select('*').eq('user_id', uid).maybeSingle<Student>();
    if (r.error) throw r.error;
    student = r.data;
  }
  return { profile, student };
}

async function needsMfa(role: Role) {
  if (!MFA_ROLES.includes(role)) return false;
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  return data.currentLevel !== 'aal2';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [student, setStudent] = useState<Student | null>(null);

  const reset = useCallback(() => {
    invalidateCache(); clearActivity();
    setSession(null); setProfile(null); setStudent(null); setStage('signed-out');
  }, []);

  /** Work out the stage for the current session. Throws on a bad account (caller signs out). */
  const resolve = useCallback(async (s: Session | null, expectRole?: Role): Promise<Stage> => {
    if (!s) { reset(); return 'signed-out'; }
    const { profile: p, student: st } = await loadProfile(s.user.id);
    if (expectRole && p.role !== expectRole) {
      throw new Error(`This account is not a${/^[aeiou]/i.test(expectRole) ? 'n' : ''} ${expectRole} account. Choose the right portal.`);
    }
    setSession(s); setProfile(p); setStudent(st);
    const next: Stage = linkPending || p.must_change_password ? 'set-password' : (await needsMfa(p.role)) ? 'needs-mfa' : 'ready';
    setStage(next);
    return next;
  }, [reset]);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      // A stored session left idle past the limit (browser closed, laptop asleep) doesn't come back.
      // An invite/reset link is a fresh sign-in, so it's exempt.
      if (data.session && !linkPending && idleFor() >= idleLimit()) {
        flagIdleSignOut();
        await supabase.auth.signOut({ scope: 'local' });
        reset();
        return;
      }
      await resolve(data.session).catch(async () => { await supabase.auth.signOut(); reset(); });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') reset();
      else if (event === 'TOKEN_REFRESHED') setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [resolve, reset]);

  const finishPasswordSignIn = useCallback(async (s: Session | null, role: Role) => {
    try {
      if ((await resolve(s, role)) === 'ready') await supabase.rpc('record_sign_in');
    } catch (e) {
      await supabase.auth.signOut(); reset();
      throw new Error(errText(e));
    }
  }, [resolve, reset]);

  const signInStaff = useCallback(async (role: Role, email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
    await finishPasswordSignIn(data.session, role);
  }, [finishPasswordSignIn]);

  const signInStudent = useCallback(async (identifier: string, password: string) => {
    // Server-side lookup + sign-in with rate limiting; unknown IDs and wrong passwords get the same answer.
    const tokens = await invokeFn<{ access_token: string; refresh_token: string }>('student-login', { identifier: identifier.trim(), password });
    const { data, error } = await supabase.auth.setSession(tokens);
    if (error) throw new Error(error.message);
    await finishPasswordSignIn(data.session, 'student');
  }, [finishPasswordSignIn]);

  const completeMfa = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await resolve(data.session);
    await supabase.rpc('record_sign_in');
  }, [resolve]);

  const setPassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message.includes('different') ? 'Choose a password different from the temporary one.' : error.message);
    const r = await supabase.rpc('password_changed');
    if (r.error) throw new Error(errText(r.error));
    linkPending = false;
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    const { data } = await supabase.auth.getSession();
    if ((await resolve(data.session)) === 'ready') await supabase.rpc('record_sign_in');
  }, [resolve]);

  const signOut = useCallback(async (opts?: { idle?: boolean }) => {
    linkPending = false;
    if (opts?.idle) flagIdleSignOut();
    // An idle timeout on one device shouldn't end the user's session on another (e.g. a scan station).
    await supabase.auth.signOut(opts?.idle ? { scope: 'local' } : undefined).catch(() => {});
    reset();
  }, [reset]);

  const value = useMemo(() => ({ stage, session, profile, student, signInStaff, signInStudent, completeMfa, setPassword, signOut }),
    [stage, session, profile, student, signInStaff, signInStudent, completeMfa, setPassword, signOut]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
