import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { fetchAlerts } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { NAV } from '../nav';
import { Logo } from './Logo';
import { AppearanceButton } from './Appearance';

const ROLE_LABEL = { admin: 'System Admin', officer: 'Exams Officer', invigilator: 'Invigilator', student: 'Student' } as const;

export function Shell() {
  const { profile, student, signOut } = useAuth();
  const alerts = useAlertCount(profile?.role === 'officer' || profile?.role === 'admin');
  const drawer = useDrawer();
  if (!profile) return null;
  const subtitle = profile.role === 'student' && student
    ? `Student · ${student.matric_no}`
    : profile.title || ROLE_LABEL[profile.role];
  return (
    <div className={`app${drawer.open ? ' drawer-open' : ''}`}>
      <aside className="side" id="sidebar" aria-label="Sidebar" inert={drawer.mobile && !drawer.open ? true : undefined}>
        <div className="brand"><Logo />ScripTree
          <button ref={drawer.closeRef} className="drawer-close" onClick={drawer.close} aria-label="Close menu">✕</button>
        </div>
        <div className="pillars">Every script accounted for</div>
        <nav className="nav" aria-label="Main">
          {NAV[profile.role].map((n, i) => 'section' in n
            ? <div className="sec" key={i}>{n.section}</div>
            : <NavLink key={n.path} to={n.path} className={({ isActive }) => (isActive ? 'on' : '')} style={{ textDecoration: 'none' }}>
                {n.label}{n.badge === 'alerts' && alerts > 0 && <span className="badge">{alerts}</span>}
              </NavLink>)}
        </nav>
        <div className="who">
          <b>{profile.full_name}</b>{subtitle}
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            <AppearanceButton />
            <button onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      </aside>
      {drawer.open && <div className="drawer-scrim" onClick={drawer.close} aria-hidden="true" />}
      <main className="main" inert={drawer.open ? true : undefined}>
        <header className="mobile-bar">
          <button ref={drawer.openRef} className="menu-btn" onClick={drawer.toggle} aria-label={alerts > 0 ? `Open menu, ${alerts} open alerts` : 'Open menu'}
            aria-expanded={drawer.open} aria-controls="sidebar">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            {alerts > 0 && <span className="menu-dot" aria-hidden="true">{alerts}</span>}
          </button>
          <div className="brand"><Logo />ScripTree</div>
        </header>
        <Suspense fallback={<div className="content muted">Loading…</div>}><Outlet /></Suspense>
      </main>
    </div>
  );
}

/** Page header used by every view. */
export function PageTop({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="top">
      <div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

const MOBILE = '(max-width: 700px)';

/** Phone-width sidebar as a slide-out drawer: closes on navigation, Escape, scrim tap or widening the window; moves focus in and back out. */
function useDrawer() {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE).matches);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const loc = useLocation();
  const wasOpen = useRef(false);

  useEffect(() => { setOpen(false); }, [loc.pathname]);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE);
    const on = () => { setMobile(mq.matches); if (!mq.matches) setOpen(false); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (open) {
      closeRef.current?.focus();
      document.body.style.overflow = 'hidden';
      const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
      window.addEventListener('keydown', esc);
      return () => { window.removeEventListener('keydown', esc); document.body.style.overflow = ''; };
    }
    if (wasOpen.current && mobile) openRef.current?.focus();
  }, [open, mobile]);
  useEffect(() => { wasOpen.current = open; }, [open]);

  return { open, mobile, openRef, closeRef, close: () => setOpen(false), toggle: () => setOpen((o) => !o) };
}

/** Open-alert count for the sidebar badge; refreshes on navigation and when a page signals a change. Served from the shared cache, so navigating doesn't re-run alert reconciliation every time. */
function useAlertCount(enabled: boolean) {
  const [n, setN] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => fetchAlerts().then((a) => { if (alive) setN(a.length); }, () => {});
    load();
    window.addEventListener('alerts-changed', load);
    return () => { alive = false; window.removeEventListener('alerts-changed', load); };
  }, [enabled, loc.pathname]);
  return n;
}
