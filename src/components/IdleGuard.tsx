import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { IDLE_MS, WARN_MS, idleFor, markActive } from '../lib/idle';
import { Modal } from './ui';

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Signs the user out after 15 minutes with no keyboard, mouse, touch or scroll activity in any tab,
 * with a one-minute warning first. Active from sign-in onward, including the password and two-factor steps.
 */
export function IdleGuard() {
  const { stage, signOut } = useAuth();
  const enabled = stage !== 'loading' && stage !== 'signed-out';
  const [left, setLeft] = useState<number | null>(null);
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  useEffect(() => {
    if (!enabled) { setLeft(null); return; }
    markActive();
    let lastWrite = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite > 2000) { lastWrite = now; markActive(); } // throttle: pointermove fires constantly
    };
    let fired = false;
    const check = () => {
      if (fired) return;
      const idle = idleFor();
      if (idle >= IDLE_MS) {
        fired = true;
        setLeft(null);
        void signOutRef.current({ idle: true });
        return;
      }
      const remaining = IDLE_MS - idle;
      setLeft(remaining <= WARN_MS ? Math.ceil(remaining / 1000) : null);
    };
    for (const e of ACTIVITY) window.addEventListener(e, onActivity, { passive: true, capture: true });
    // the check reads the shared wall clock, so a throttled background tab or a slept laptop catches up on return
    document.addEventListener('visibilitychange', check);
    const t = window.setInterval(check, 1000);
    check();
    return () => {
      for (const e of ACTIVITY) window.removeEventListener(e, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(t);
    };
  }, [enabled]);

  if (left == null) return null;
  const stay = () => { markActive(); setLeft(null); };
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
  return (
    <Modal onClose={stay}>
      <h3>Still there?</h3>
      <p className="muted" style={{ margin: '6px 0 18px' }}>
        You've been inactive for a while. For security, you'll be signed out in <b>{mm}:{ss}</b>.
      </p>
      <div className="row between">
        <button className="btn" onClick={() => void signOut()}>Sign out now</button>
        <button className="btn pri" onClick={stay} autoFocus>Stay signed in</button>
      </div>
    </Modal>
  );
}
