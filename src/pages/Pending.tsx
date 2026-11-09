import { PageTop } from '../components/Shell';

/** Screens not built yet. Each names the phase that delivers it, so pending work stays visible. */
const PENDING: Record<string, { title: string; sub: string; phase: string }> = {
  '/users': { title: 'Users & roles', sub: 'Every role signs in separately', phase: 'Phase 5 — Admin' },
  '/settings': { title: 'System settings', sub: 'Defaults applied to new exam sessions', phase: 'Phase 5 — Admin' },
};

export function Pending({ path }: { path: string }) {
  const p = PENDING[path];
  return (
    <>
      <PageTop title={p.title} sub={p.sub} />
      <div className="content">
        <div className="banner info"><b>Coming in {p.phase}.</b> The database functions and access rules for this screen are already in place.</div>
      </div>
    </>
  );
}
