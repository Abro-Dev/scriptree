import type { Role } from './lib/types';

export type NavItem = { section: string } | { path: string; label: string; badge?: 'alerts' };

export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { section: 'Overview' },
    { path: '/overview', label: 'Overview', badge: 'alerts' },
    { section: 'Administration' },
    { path: '/users', label: 'Users & roles' },
    { path: '/settings', label: 'System settings' },
    { section: 'Governance' },
    { path: '/audit', label: 'Audit log' },
  ],
  officer: [
    { section: 'Overview' },
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/alerts', label: 'Alerts', badge: 'alerts' },
    { section: 'Track & reconcile' },
    { path: '/sessions', label: 'Exam sessions' },
    { path: '/tracker', label: 'Script tracker' },
    { section: 'Preserve' },
    { path: '/archive', label: 'Digital archive' },
    { path: '/documents', label: 'Student documents' },
    { section: 'Governance' },
    { path: '/audit', label: 'Audit log' },
  ],
  invigilator: [
    { section: 'Today' },
    { path: '/hall', label: 'Exam hall' },
    { section: 'Tools' },
    { path: '/tracker', label: 'Script lookup' },
  ],
  student: [
    { section: 'My records' },
    { path: '/my/exams', label: 'My exams' },
    { path: '/my/documents', label: 'My documents' },
  ],
};

export const HOME: Record<Role, string> = {
  admin: '/overview', officer: '/dashboard', invigilator: '/hall', student: '/my/exams',
};

/** Which roles may open each route. Database RLS enforces the same thing server-side. */
export const ROUTE_ROLES: Record<string, Role[]> = {
  '/overview': ['admin'], '/users': ['admin'], '/settings': ['admin'], '/audit': ['admin', 'officer'],
  '/dashboard': ['officer'], '/alerts': ['officer'], '/sessions': ['officer'], '/sessions/:id': ['officer'], '/archive': ['officer'], '/documents': ['officer'],
  '/tracker': ['officer', 'invigilator'], '/hall': ['invigilator'], '/hall/:id': ['invigilator', 'officer'],
  '/my/exams': ['student'], '/my/documents': ['student'],
};
