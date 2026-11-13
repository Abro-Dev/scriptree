/**
 * Inactivity sign-out. The last-activity time lives in localStorage, so every open tab shares one clock:
 * working in one tab keeps the others signed in, and a timeout signs them all out together. Because it's
 * a wall-clock timestamp (not a timer), it also catches a laptop that slept, or a browser that was closed
 * and reopened later with the session still stored.
 */
export const IDLE_MS = 15 * 60_000;
/** The "still there?" warning shows for the last minute. */
export const WARN_MS = 60_000;

/** While a live exam hall is on screen the device sits untouched for long stretches (the paper is being written). */
export const HALL_IDLE_MS = 3 * 60 * 60_000;

const ACTIVE_KEY = 'scriptree:last-active';
const HALL_KEY = 'scriptree:hall-open';
const FLAG_KEY = 'scriptree:idle-signout';

export function markActive() {
  try { localStorage.setItem(ACTIVE_KEY, String(Date.now())); } catch { /* storage blocked: timer still works in this tab */ }
}

export function clearActivity() {
  try { localStorage.removeItem(ACTIVE_KEY); localStorage.removeItem(HALL_KEY); } catch { /* ignore */ }
}

/** Called by the hall screen: on while a live session is showing, off when it closes or the screen is left. */
export function setHallOpen(on: boolean) {
  try { if (on) localStorage.setItem(HALL_KEY, String(Date.now())); else localStorage.removeItem(HALL_KEY); } catch { /* ignore */ }
}

/** The inactivity limit that applies right now: longer while a live hall is open, 15 minutes otherwise. */
export function idleLimit(): number {
  let t = 0;
  try { t = Number(localStorage.getItem(HALL_KEY)) || 0; } catch { /* ignore */ }
  // the flag itself expires, so a hall tab that crashed can't leave the long limit on for good
  return t && Date.now() - t < 12 * 60 * 60_000 ? HALL_IDLE_MS : IDLE_MS;
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
