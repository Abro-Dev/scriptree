import { useEffect, useState } from 'react';
import { PageTop } from '../../components/Shell';
import { useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { ATT_MODES, type AttMode } from '../../lib/hall';
import { fmtStamp } from '../../lib/officer';
import { isEmail } from '../../lib/validate';
import type { GradeBand } from '../../lib/grading';

interface JobStatus { pending: number; failing: number; last_sent_at: string | null; last_error: string | null; nightly_job: boolean; sender_job: boolean; secrets_ready: boolean }

interface SettingsRow {
  default_att_mode: AttMode; allow_pdf_upload: boolean; allow_photo_snaps: boolean; max_file_mb: number;
  nightly_check_at: string; alert_email: string | null; updated_at: string; grade_bands: GradeBand[];
}
type BandDraft = { grade: string; min: string };

/** Same rules as the database (check_grade_bands), so mistakes show before saving. */
function checkBands(bands: BandDraft[]): string {
  if (bands.length < 2 || bands.length > 12) return 'Keep between 2 and 12 grade bands.';
  const names = new Set<string>(), mins = new Set<number>();
  for (const b of bands) {
    const g = b.grade.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9+-]{0,2}$/.test(g)) return 'Grade names are 1 to 3 characters, e.g. A, B+ or F.';
    if (names.has(g)) return `Grade ${g} is listed twice.`;
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(b.min.trim()) || Number(b.min) > 100) return `Grade ${g}: the lowest mark must be a number from 0 to 100.`;
    if (mins.has(Number(b.min))) return `Two grades start at ${Number(b.min)}%.`;
    names.add(g); mins.add(Number(b.min));
  }
  if (!mins.has(0)) return 'The lowest grade must start at 0%.';
  return '';
}

export function Settings() {
  const toast = useToast();
  const { data, error, reload } = useLoad(async () => must(await supabase.from('settings').select('*').single()) as SettingsRow, []);
  const { data: jobs, reload: reloadJobs } = useLoad(async () => must(await supabase.rpc('notification_status').single()) as JobStatus, []);
  const [testing, setTesting] = useState(false);
  const [f, setF] = useState<SettingsRow | null>(null);
  const [bands, setBands] = useState<BandDraft[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    setF({ ...data, nightly_check_at: data.nightly_check_at.slice(0, 5) });
    setBands((data.grade_bands ?? []).map((b) => ({ grade: b.grade, min: String(b.min) })));
  }, [data]);

  if (error) return <><PageTop title="System settings" /><div className="content"><div className="banner crit">{error}</div></div></>;
  if (!f) return <><PageTop title="System settings" sub="Defaults applied to new exam sessions" /><div className="content muted">Loading…</div></>;

  async function save() {
    if (!f) return;
    setErr('');
    if (!f.allow_pdf_upload && !f.allow_photo_snaps) return setErr('Keep at least one way to capture scripts.');
    if (!Number.isInteger(f.max_file_mb) || f.max_file_mb < 1 || f.max_file_mb > 50) return setErr('Maximum file size must be 1–50 MB.');
    if (!/^\d{2}:\d{2}$/.test(f.nightly_check_at)) return setErr('Enter the nightly check time as HH:MM.');
    if (f.alert_email && !isEmail(f.alert_email)) return setErr('Enter a valid alert email, or leave it empty.');
    const bandErr = checkBands(bands);
    if (bandErr) return setErr(bandErr);
    setBusy(true);
    const { error } = await supabase.rpc('update_settings', { p: {
      default_att_mode: f.default_att_mode, allow_pdf_upload: f.allow_pdf_upload, allow_photo_snaps: f.allow_photo_snaps,
      max_file_mb: f.max_file_mb, nightly_check_at: f.nightly_check_at, alert_email: f.alert_email?.trim() ?? '',
      grade_bands: bands.map((b) => ({ grade: b.grade.trim().toUpperCase(), min: Number(b.min) })),
    } });
    setBusy(false);
    if (error) return setErr(errText(error));
    toast('Settings saved'); reload(); reloadJobs();
  }

  async function testEmail() {
    setTesting(true);
    const { error } = await supabase.rpc('send_test_email');
    setTesting(false);
    if (error) toast(errText(error)); else { toast('Test email queued — it goes out within 5 minutes'); reloadJobs(); }
  }

  const set = <K extends keyof SettingsRow>(k: K, v: SettingsRow[K]) => setF({ ...f, [k]: v });
  return (
    <>
      <PageTop title="System settings" sub="Defaults applied to new exam sessions" />
      <div className="content">
        <div className="card" style={{ maxWidth: 720 }}>
          <h3>Exam sessions</h3>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Default attendance timing</div>
          <div className="seg" style={{ marginBottom: 6 }}>
            {(Object.keys(ATT_MODES) as AttMode[]).map((k) => <button key={k} className={f.default_att_mode === k ? 'on' : ''} onClick={() => set('default_att_mode', k)}>{ATT_MODES[k]}</button>)}
          </div>
          <div className="legend" style={{ marginBottom: 18 }}>Exams officers can change this per session; invigilators see it in the exam hall.</div>

          <h3>Script capture</h3>
          <label className="row small" style={{ gap: 8, marginBottom: 6 }}><input type="checkbox" checked={f.allow_pdf_upload} onChange={(e) => set('allow_pdf_upload', e.target.checked)} /> Direct PDF upload from scanner</label>
          <label className="row small" style={{ gap: 8, marginBottom: 10 }}><input type="checkbox" checked={f.allow_photo_snaps} onChange={(e) => set('allow_photo_snaps', e.target.checked)} /> Photo snaps merged into one PDF</label>
          <div className="row small" style={{ marginBottom: 18 }}>Maximum file size
            <input className="input" type="number" min={1} max={50} style={{ width: 80 }} value={f.max_file_mb} onChange={(e) => set('max_file_mb', Math.trunc(Number(e.target.value)))} aria-label="Maximum file size in MB" /> MB
            <span className="muted">(applies to scans and student documents)</span></div>

          <h3>Integrity and alerts</h3>
          <div className="row small" style={{ marginBottom: 8 }}>Nightly integrity check at
            <input className="input" type="time" style={{ width: 110 }} value={f.nightly_check_at} onChange={(e) => set('nightly_check_at', e.target.value)} aria-label="Nightly check time" />
            <span className="muted">(server time, UTC)</span></div>
          <div className="row small" style={{ marginBottom: 18 }}>Send alert emails to
            <input className="input" style={{ flex: 1 }} type="email" maxLength={120} value={f.alert_email ?? ''} onChange={(e) => set('alert_email', e.target.value)} placeholder="exams.office@school.edu.ng" aria-label="Alert email" /></div>
          {jobs && <div className={`banner ${!jobs.secrets_ready || jobs.last_error ? 'warn' : 'ok'}`} style={{ marginBottom: 10 }}>
            {!jobs.secrets_ready
              ? <><b>Scheduled jobs can't run yet.</b> The project URL Vault secret is missing (see the setup guide), or the cron-secret migration hasn't been applied.</>
              : <><b>Nightly check {jobs.nightly_job ? 'scheduled' : 'not scheduled'} · alert sender {jobs.sender_job ? 'running every 5 min' : 'not scheduled'}.</b></>}
            <div className="small" style={{ marginTop: 4 }}>
              {jobs.pending} email{jobs.pending === 1 ? '' : 's'} waiting · last sent {fmtStamp(jobs.last_sent_at)}
              {jobs.last_error && <> · <span style={{ color: 'var(--crit)' }}>last problem: {jobs.last_error}</span></>}
            </div>
          </div>}
          <div className="row" style={{ marginBottom: 18 }}>
            <button className="btn sm" disabled={testing || !data?.alert_email} onClick={testEmail}>{testing ? 'Queuing…' : 'Send test email'}</button>
            <span className="small muted">{data?.alert_email ? `to ${data.alert_email} (save changes first)` : 'Save an alert email first'}</span>
          </div>

          <h3>Grading</h3>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Grade bands (lowest percentage for each grade)</div>
          <div style={{ marginBottom: 6 }}>
            {bands.map((b, i) => (
              <div key={i} className="row small" style={{ gap: 6, marginBottom: 6 }}>
                <input className="input" style={{ width: 70 }} maxLength={3} value={b.grade} aria-label={`Grade ${i + 1} name`}
                  onChange={(e) => setBands(bands.map((x, j) => j === i ? { ...x, grade: e.target.value } : x))} />
                <span>from</span>
                <input className="input" style={{ width: 80 }} inputMode="decimal" value={b.min} aria-label={`Grade ${i + 1} lowest percentage`}
                  onChange={(e) => setBands(bands.map((x, j) => j === i ? { ...x, min: e.target.value } : x))} />
                <span>%</span>
                <button type="button" className="btn sm" disabled={bands.length <= 2} onClick={() => setBands(bands.filter((_, j) => j !== i))} aria-label={`Remove grade ${b.grade || i + 1}`}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn sm" disabled={bands.length >= 12} onClick={() => setBands([...bands, { grade: '', min: '' }])}>Add grade</button>
          </div>
          <div className="legend" style={{ marginBottom: 18 }}>A score's percentage gets the highest grade it reaches. The lowest grade must start at 0. Students see these grades on My results.</div>

          <h3>Hosting</h3>
          <div className="small muted" style={{ marginBottom: 18 }}>To be decided — currently Supabase cloud.</div>
          <div className="err" role="alert">{err}</div>
          <div className="row between">
            <span className="small muted">Last saved {fmtStamp(data!.updated_at)}</span>
            <button className="btn pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </div>
      </div>
    </>
  );
}
