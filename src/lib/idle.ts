/**
 * Inactivity sign-out. The last-activity time lives in localStorage, so every open tab shares one clock:
 * working in one tab keeps the others signed in, and a timeout signs them all out together. Because it's
 * a wall-clock timestamp (not a timer), it also catches a laptop that slept, or a browser that was closed
 * and reopened later with the session still stored.
 */
export const IDLE_MS = 15 * 60_000;
/** The "still there?" warning shows for the last minute. */
export const WARN_MS = 60_000;

const ACTIVE_KEY = 'scriptree:last-active';
const FLAG_KEY = 'scriptree:idle-signout';

export function markActive() {
  try { localStorage.setItem(ACTIVE_KEY, String(Date.now())); } catch { /* storage blocked: timer still works in this tab */ }
}

export function clearActivity() {
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
}

/** Milliseconds since the last activity in any tab; 0 when nothing is recorded yet. */
export function idleFor(): number {
  let t = 0;
  try { t = Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch { /* ignore */ }
  return t ? Math.max(0, Date.now() - t) : 0;
}

/** Remember, for the sign-in screen, that this sign-out was for inactivity. */
export function flagIdleSignOut() {
  try { sessionStorage.setItem(FLAG_KEY, '1'); } catch { /* ignore */ }
}

/** True if the last sign-out in this tab was for inactivity. */
export function readIdleFlag(): boolean {
  try { return sessionStorage.getItem(FLAG_KEY) === '1'; } catch { return false; }
}

export function clearIdleFlag() {
  try { sessionStorage.removeItem(FLAG_KEY); } catch { /* ignore */ }
}
