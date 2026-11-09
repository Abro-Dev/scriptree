import { useState } from 'react';
import { PageTop } from '../../components/Shell';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp } from '../../lib/officer';

interface Entry { id: number; at: string; actor_name: string; action: string; detail: string; prev_hash: string; hash: string }
const PAGE = 200;

export function Audit() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [chain, setChain] = useState<{ ok: boolean; entries: number; broken_at: number | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [chainErr, setChainErr] = useState('');
  const { data, error } = useLoad(async () => {
    let r = supabase.from('audit_log').select('*', { count: 'exact' }).order('id', { ascending: false }).limit(PAGE);
    const term = applied.replace(/[%,()]/g, ' ').trim();
    if (term) r = r.or(`action.ilike.%${term}%,detail.ilike.%${term}%,actor_name.ilike.%${term}%`);
    const res = await r;
    return { rows: must(res) as Entry[], total: res.count ?? 0 };
  }, [applied]);

  async function verify() {
    setChecking(true); setChainErr('');
    const { data: r, error: e } = await supabase.rpc('verify_audit_chain').single<{ ok: boolean; entries: number; broken_at: number | null }>();
    setChecking(false);
    if (e) setChainErr(errText(e)); else setChain(r);
  }

  return (
    <>
      <PageTop title="Audit log" sub="Append-only, hash-chained record of every action"
        actions={<button className="btn pri" disabled={checking} onClick={verify}>{checking ? 'Verifying…' : 'Verify audit chain'}</button>} />
      <div className="content">
        {chainErr && <div className="banner crit" style={{ marginBottom: 16 }}>{chainErr}</div>}
        {chain && <div className={`banner ${chain.ok ? 'ok' : 'crit'}`} style={{ marginBottom: 16 }}>
          {chain.ok ? <><b>Chain intact.</b> All {chain.entries} entries re-hashed on the server and linked correctly.</>
            : <><b>Chain broken at entry #{chain.broken_at}.</b> That entry was altered after it was written — its hash no longer matches, so every later link is suspect. Report this to the system admin.</>}
        </div>}
        {error && <div className="banner crit">{error}</div>}
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <div className="small muted">Each entry stores the hash of the one before it. Editing or deleting any past entry breaks the chain from that point on. The database refuses edits and deletions outright.</div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); setApplied(q); }}>
              <input className="input" placeholder="Search action, detail or person" value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} aria-label="Search audit log" />
              <button className="btn sm">Search</button>
            </form>
          </div>
          <table>
            <thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th><th>Prev hash</th><th>Entry hash</th></tr></thead>
            <tbody>
              {(data?.rows ?? []).map((e) => (
                <tr key={e.id} style={chain && !chain.ok && chain.broken_at != null && e.id >= chain.broken_at ? { background: 'var(--row-bad)' } : undefined}>
                  <td>{e.id}</td><td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtStamp(e.at)}</td>
                  <td className="small">{e.actor_name}</td><td><b className="small">{e.action}</b></td><td className="small">{e.detail}</td>
                  <td><span className="hash" title={e.prev_hash}>{e.prev_hash.slice(0, 8)}</span></td>
                  <td><span className="hash" title={e.hash}>{e.hash.slice(0, 8)}</span></td>
                </tr>
              ))}
              {data && !data.rows.length && <tr><td colSpan={7} className="muted">No entries{applied ? ' match' : ''}.</td></tr>}
            </tbody>
          </table>
          {data && data.total > PAGE && <div className="legend" style={{ marginTop: 8 }}>Showing newest {PAGE} of {data.total}</div>}
        </div>
      </div>
    </>
  );
}
