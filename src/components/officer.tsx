import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Pill } from './ui';
import type { Alert, SessionSummary } from '../lib/officer';

export function Ring({ pct, col, size = 52, w = 7 }: { pct: number; col: string; size?: number; w?: number }) {
  const r = (size - w) / 2, c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: 'var(--chart-grid)' }} strokeWidth={w} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={w} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

const KEYS = ['registered', 'present', 'physical', 'scanned'] as const;
const COLS = ['var(--c-registered)', 'var(--c-present)', 'var(--c-physical)', 'var(--c-scanned)'];

/** Grouped bars per session; red numbers mark present candidates with no physical script / no scan. */
export function ReconChart({ sessions }: { sessions: SessionSummary[] }) {
  const W = 640, H = 230, L = 34, B = 196, top = 18;
  const groups = Math.max(1, sessions.length), gw = (W - L - 10) / groups, bw = Math.max(6, Math.min(22, (gw - 26) / 4));
  const max = Math.max(1, ...sessions.map((s) => s.registered));
  const y = (v: number) => B - (v / max) * (B - top);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Registered, present, physical and scanned counts per session">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const v = Math.round(max * t);
        return <g key={t}><line x1={L} x2={W - 6} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--chart-grid)' }} /><text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" style={{ fill: 'var(--ink3)' }}>{v}</text></g>;
      })}
      {sessions.map((s, i) => {
        const x0 = L + i * gw + 13;
        return (
          <g key={s.id}>
            {KEYS.map((k, j) => {
              const v = s[k], x = x0 + j * (bw + 4), short = j > 1 && v < s.present;
              return (
                <g key={k}>
                  <rect x={x} y={y(v)} width={bw} height={B - y(v)} rx="6" style={{ fill: COLS[j] }}><title>{`${s.course_code} ${k}: ${v}`}</title></rect>
                  {short && <text x={x + bw / 2} y={y(v) - 6} textAnchor="middle" fontSize="11" fontWeight="800" style={{ fill: 'var(--chart-short)' }}>−{s.present - v}</text>}
                </g>
              );
            })}
            <text x={x0 + (4 * bw + 12) / 2} y={B + 20} textAnchor="middle" fontSize="12.5" fontWeight="700" style={{ fill: 'var(--ink)' }} fontFamily="Rubik, sans-serif">{s.course_code}</text>
          </g>
        );
      })}
      <line x1={L} x2={W - 6} y1={B} y2={B} style={{ stroke: 'var(--chart-axis)' }} />
    </svg>
  );
}

export function ChartLegend() {
  return (
    <div className="chart-legend">
      {['Registered', 'Present', 'Physical', 'Scanned'].map((l, i) => <span key={l}><i style={{ background: COLS[i] }} />{l}</span>)}
    </div>
  );
}

export function AlertRow({ a, onAck }: { a: Alert; onAck?: (a: Alert) => void }) {
  const nav = useNavigate();
  return (
    <div className="alertitem">
      <Pill sev={a.severity} />
      <div style={{ minWidth: 0 }}>
        <div><b className="small">{a.title}</b></div>
        <div className="small muted">{a.detail}</div>
        <div className="row" style={{ marginTop: 6, gap: 6 }}>
          {a.session_id && <button className="btn sm" onClick={() => nav(`/sessions/${a.session_id}`)}>Open session</button>}
          {a.alert_key === 'docs-pending' && <button className="btn sm" onClick={() => nav('/documents')}>Review</button>}
          {onAck && (a.acked_by
            ? <span className="small muted">Acknowledged by {a.acked_by}</span>
            : <button className="btn sm" onClick={() => onAck(a)}>Acknowledge</button>)}
        </div>
      </div>
    </div>
  );
}

export function Kpi({ lab, val, note }: { lab: string; val: ReactNode; note: string }) {
  return <div className="kpi"><div className="lab">{lab}</div><div className="val">{val}</div><div className="note">{note}</div></div>;
}
