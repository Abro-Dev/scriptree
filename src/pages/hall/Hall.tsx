import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageTop } from '../../components/Shell';
import { Modal, useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { setHallOpen } from '../../lib/idle';
import { fmtDate, useHall, type HallData } from '../../lib/hall';
import { AttendanceTab } from './AttendanceTab';
import { CheckInTab } from './CheckInTab';
import { ScanTab } from './ScanTab';

type Tab = 'att' | 'checkin' | 'scan';
const TABS: [Tab, string][] = [['att', '1 · Attendance'], ['checkin', '2 · Script check-in'], ['scan', '3 · Scan station']];

export interface TabProps { d: HallData; live: boolean; reload: () => Promise<void> }

function CountStrip({ d, live }: { d: HallData; live: boolean }) {
  const c = d.counts;
  const outPhys = c.present - c.physical, outScan = c.present - c.scanned;
  return (
    <>
      <div className="funnel" style={{ marginBottom: 12 }}>
        <div><div className="lab">Registered</div><div className="val">{c.registered}</div></div>
        <div><div className="lab">Present</div><div className="val">{c.present}</div><div className="gap muted">headcount {c.headcount ?? '—'}</div></div>
        <div><div className="lab">Scripts checked in</div><div className="val">{c.physical}</div>
          {outPhys > 0 ? <div className="gap" style={{ color: 'var(--high)' }}>{outPhys} outstanding</div> : <div className="gap" style={{ color: 'var(--ok)' }}>✓ all in</div>}</div>
        <div><div className="lab">Scanned</div><div className="val">{c.scanned}</div>
          {outScan > 0 ? <div className="gap" style={{ color: 'var(--high)' }}>{outScan} outstanding</div> : <div className="gap" style={{ color: 'var(--ok)' }}>✓ all scanned</div>}</div>
      </div>
      {live && (outScan > 0 || outPhys > 0) && <div className="banner warn" style={{ marginBottom: 16 }}>
        <b>Not every present candidate is accounted for yet.</b> The exams office sees these gaps live; they become discrepancies when you close the session.
      </div>}
    </>
  );
}

export function Hall() {
  const { id } = useParams();
  const { data: d, error, reload } = useHall(id);
  const [tab, setTab] = useState<Tab>('att');
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const { profile } = useAuth();
  const officer = profile?.role === 'officer';
  const home = officer ? (id ? `/sessions/${id}` : '/sessions') : '/hall';
  const homeLabel = officer ? 'Back to session' : 'My sessions';

  // the hall device sits untouched while the paper is written: use the long inactivity limit while it's live
  const isLive = d?.session.status === 'live';
  useEffect(() => { setHallOpen(isLive); return () => setHallOpen(false); }, [isLive]);

  if (error) return <><PageTop title="Exam hall" /><div className="content"><div className="banner crit">{error}</div><p><Link to={home}>{homeLabel}</Link></p></div></>;
  if (!d) return <><PageTop title="Exam hall" /><div className="content muted">Loading…</div></>;

  const s = d.session, live = s.status === 'live';

  async function openSession() {
    setBusy(true);
    const { error } = await supabase.rpc('start_session', { p_session: s.id });
    setBusy(false);
    if (error) { toast(errText(error)); return; }
    toast(`${s.course_code} is live`);
    reload();
  }

  async function close() {
    setBusy(true);
    const { data, error } = await supabase.rpc('close_session', { p_session: s.id });
    setBusy(false);
    setClosing(false);
    if (error) { toast(errText(error)); return; }
    toast(`Session closed · ${data} discrepancies sent to the exams office`);
    reload();
  }

  return (
    <>
      <PageTop title="Exam hall" sub={`${s.course_code} ${s.course_title} · ${s.venue} · ${fmtDate(s.exam_date)}`}
        actions={<>
          <button className="btn" onClick={() => nav(home)}>{homeLabel}</button>
          {live ? <button className="btn pri" onClick={() => setClosing(true)}>Close session &amp; reconcile</button>
            : s.status === 'closed' ? <span className="pill p-ok">Session closed</span>
            : <button className="btn pri" disabled={busy} onClick={() => confirm(`Open ${s.course_code} in ${s.venue} now? Attendance, check-in and scanning start.`) && openSession()}>{busy ? 'Opening…' : 'Open session'}</button>}
        </>} />
      <div className="content">
        {s.status === 'scheduled' && <div className="banner info" style={{ marginBottom: 16 }}>This session hasn't been opened. Choose <b>Open session</b> to start taking attendance.</div>}
        <CountStrip d={d} live={live} />
        <div className="tabs" role="tablist">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'att' && <AttendanceTab d={d} live={live} reload={reload} />}
        {tab === 'checkin' && <CheckInTab d={d} live={live} reload={reload} />}
        {tab === 'scan' && <ScanTab d={d} live={live} reload={reload} />}
      </div>
      {closing && <Modal onClose={() => setClosing(false)}>
        <h3>Close {s.course_code} and reconcile?</h3>
        <p className="small muted">After closing, attendance and check-in are locked. Anyone not yet ticked is recorded absent. Any present candidate still without a script or scan becomes a discrepancy for the exams office.</p>
        {d.counts.headcount == null && <div className="banner warn" style={{ marginTop: 10 }}>You haven't recorded a headcount. It's the cross-check against scripts received.</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={() => setClosing(false)}>Cancel</button>
          <button className="btn pri" disabled={busy} onClick={close}>{busy ? 'Closing…' : 'Close session'}</button>
        </div>
      </Modal>}
    </>
  );
}
