import { lazy, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './components/ui';
import { ThemeProvider } from './lib/theme';
import { Shell } from './components/Shell';
import { IdleGuard } from './components/IdleGuard';
import { LoginPage } from './pages/Login';
import { MfaPage } from './pages/Mfa';
import { SetPasswordPage } from './pages/SetPassword';
import { Pending } from './pages/Pending';
import { HOME, ROUTE_ROLES } from './nav';
import type { Role } from './lib/types';

type Loader = () => Promise<ComponentType>;
const named = <M,>(load: () => Promise<M>, name: keyof M): Loader => () => load().then((m) => m[name] as ComponentType);

/**
 * Built screens, each in its own chunk so a student never downloads officer code and the first paint stays small.
 * Any route in ROUTE_ROLES without an entry here shows its Pending placeholder.
 */
const LOADERS: Record<string, Loader> = {
  '/hall': named(() => import('./pages/hall/HallList'), 'HallList'),
  '/hall/:id': named(() => import('./pages/hall/Hall'), 'Hall'),
  '/dashboard': named(() => import('./pages/officer/Dashboard'), 'Dashboard'),
  '/alerts': named(() => import('./pages/officer/Alerts'), 'Alerts'),
  '/sessions': named(() => import('./pages/officer/Sessions'), 'Sessions'),
  '/sessions/:id': named(() => import('./pages/officer/SessionDetail'), 'SessionDetail'),
  '/tracker': named(() => import('./pages/officer/Tracker'), 'Tracker'),
  '/archive': named(() => import('./pages/officer/Archive'), 'Archive'),
  '/documents': named(() => import('./pages/officer/Documents'), 'Documents'),
  '/audit': named(() => import('./pages/officer/Audit'), 'Audit'),
  '/my/exams': named(() => import('./pages/student/MyExams'), 'MyExams'),
  '/my/documents': named(() => import('./pages/student/MyDocuments'), 'MyDocuments'),
  '/overview': named(() => import('./pages/admin/Overview'), 'Overview'),
  '/users': named(() => import('./pages/admin/Users'), 'Users'),
  '/settings': named(() => import('./pages/admin/Settings'), 'Settings'),
};
const SCREENS: Record<string, LazyExoticComponent<ComponentType>> = Object.fromEntries(
  Object.entries(LOADERS).map(([p, load]) => [p, lazy(() => load().then((C) => ({ default: C })))]));

/** Once signed in, fetch the rest of the role's screens in idle time so later navigation is instant. */
function usePrefetch(role: Role | undefined) {
  useEffect(() => {
    if (!role) return;
    const go = () => {
      for (const [p, roles] of Object.entries(ROUTE_ROLES)) if (roles.includes(role)) LOADERS[p]?.().catch(() => {});
    };
    if ('requestIdleCallback' in window) {
      const h = window.requestIdleCallback(go, { timeout: 4000 });
      return () => window.cancelIdleCallback(h);
    }
    const t = setTimeout(go, 1500);
    return () => clearTimeout(t);
  }, [role]);
}

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { profile } = useAuth();
  if (!profile) return null;
  return roles.includes(profile.role) ? children : <Navigate to={HOME[profile.role]} replace />;
}

function Screen({ path }: { path: string }) {
  const C = SCREENS[path];
  return C ? <C /> : <Pending path={path} />;
}

function AppRoutes() {
  const { stage, profile } = useAuth();
  usePrefetch(stage === 'ready' ? profile?.role : undefined);
  if (stage === 'loading') return <div className="center-screen muted">Loading…</div>;
  if (stage === 'signed-out') return <LoginPage />;
  if (stage === 'set-password') return <SetPasswordPage />;
  if (stage === 'needs-mfa') return <MfaPage />;
  return (
    <Routes>
      <Route element={<Shell />}>
        {Object.entries(ROUTE_ROLES).map(([path, roles]) => (
          <Route key={path} path={path} element={<Guard roles={roles}><Screen path={path} /></Guard>} />
        ))}
        <Route path="*" element={<Navigate to={HOME[profile!.role]} replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <IdleGuard />
            <AppRoutes />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
