import { useState, type FormEvent } from 'react';
import { PageTop } from '../../components/Shell';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp } from '../../lib/officer';

interface Entry { id: number; at: string; actor_name: string; action: string; detail: string; prev_hash: string; hash: string }
const PAGE = 200;
const DAY = 86_400_000;

type Range = '24h' | '7d' | '30d' | 'custom';
interface Filter { term: string; range: Range; from: string; to: string }
const RANGE_LABEL: Record<Range, string> = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', custom: 'the chosen dates' };

/** Today as YYYY-MM-DD in local time, for date inputs. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Turn a filter into an ISO time window. Custom dates are whole local days, both ends inclusive. */
function windowOf(f: Filter): { since: string; until: string | null } {
  if (f.range === 'custom') {
    const since = new Date(`${f.from}T00:00`).toISOString();
    const until = f.to ? new Date(new Date(`${f.to}T00:00`).getTime() + DAY).toISOString() : null;
    return { since, until };
  }
  const days = f.range === '24h' ? 1 : f.range === '7d' ? 7 : 30;
  return { since: new Date(Date.now() - days * DAY).toISOString(), until: null };
}

export function Audit() {
  const [f, setF] = useState<Filter>({ term: '', range: '24h', from: today(), to: today() });
  const [applied, setApplied] = useState<Filter>(f);
  const [formErr, setFormErr] = useState('');
  const [chain, setChain] = useState<{ ok: boolean; entries: number; broken_at: number | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [chainErr, setChainErr] = useState('');
  const { data, error } = useLoad(async () => {
    // Every query is bounded by a time window, so only the period asked for is pulled from the server.
    const { since, until } = windowOf(applied);
    let r = supabase.from('audit_log').select('*', { count: 'exact' }).gte('at', since).order('id', { ascending: false }).limit(PAGE);
    if (until) r = r.lt('at', until);
    const term = applied.term.replace(/[%,()]/g, ' ').trim();
    if (term) r = r.or(`action.ilike.%${term}%,detail.ilike.%${term}%,actor_name.ilike.%${term}%`);
    const res = await r;
    return { rows: must(res) as Entry[], total: res.count ?? 0 };
  }, [applied]);

  function apply(e: FormEvent) {
    e.preventDefault();
    if (f.range === 'custom') {
      if (!f.from) return setFormErr('Choose a start date.');
      if (f.to && f.to < f.from) return setFormErr('The end date is before the start date.');
    }
    setFormErr('');
    setApplied({ ...f }); // new object, so re-applying "last 24 hours" refreshes the window
  }
  const filtered = applied.term.trim() !== '';

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
          {chain.ok ? <><b>Chain intact.</b> {Number(chain.entries).toLocaleString()} entries linked correctly. New entries were re-hashed just now; the whole log is re-hashed every night.</>
            : <><b>Chain broken at entry #{chain.broken_at}.</b> That entry was altered after it was written — its hash no longer matches, so every later link is suspect. Report this to the system admin.</>}
        </div>}
        {error && <div className="banner crit">{error}</div>}
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="small muted" style={{ marginBottom: 10 }}>Each entry stores the hash of the one before it. Editing or deleting any past entry breaks the chain from that point on. The database refuses edits and deletions outright.</div>
          <form className="row" style={{ marginBottom: 10 }} onSubmit={apply}>
            <input className="input" placeholder="Search action, detail or person" value={f.term} maxLength={60}
              onChange={(e) => setF({ ...f, term: e.target.value })} aria-label="Search audit log" />
            <select className="input" value={f.range} onChange={(e) => setF({ ...f, range: e.target.value as Range })} aria-label="Time range">
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom dates</option>
            </select>
            {f.range === 'custom' && <>
              <input className="input" type="date" value={f.from} max={today()} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From date" />
              <span className="small muted">to</span>
              <input className="input" type="date" value={f.to} max={today()} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To date" />
            </>}
            <button className="btn sm">Apply</button>
          </form>
          {formErr && <div className="banner crit" style={{ marginBottom: 10 }}>{formErr}</div>}
          <div className="legend" style={{ marginBottom: 8 }}>
            Showing entries from {applied.range === 'custom'
              ? <>{applied.from}{applied.to && applied.to !== applied.from ? <> to {applied.to}</> : null}</>
              : RANGE_LABEL[applied.range]}{filtered ? <> matching “{applied.term.trim()}”</> : null}.
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
              {data && !data.rows.length && <tr><td colSpan={7} className="muted">No entries in {applied.range === 'custom' ? 'that date range' : RANGE_LABEL[applied.range]}{filtered ? ' match your search' : ''}. Widen the time range to see older entries.</td></tr>}
            </tbody>
          </table>
          {data && data.total > PAGE && <div className="legend" style={{ marginTop: 8 }}>Showing newest {PAGE} of {data.total}. Narrow the dates or search to see the rest.</div>}
        </div>
      </div>
    </>
  );
}
