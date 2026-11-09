import { useState } from 'react';
import { PageTop } from '../../components/Shell';
import { AlertRow } from '../../components/officer';
import { useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import type { Alert } from '../../lib/officer';

type Filter = 'open' | 'crit' | 'high' | 'med' | 'all';

export function Alerts() {
  const [f, setF] = useState<Filter>('open');
  const toast = useToast();
  const { data: all, error, reload } = useLoad(async () => must(await supabase.rpc('current_alerts', { p_include_acked: true })) as Alert[], []);

  async function ack(a: Alert) {
    const { error } = await supabase.rpc('ack_alert', { p_key: a.alert_key, p_title: a.title });
    if (error) toast(errText(error)); else toast('Alert acknowledged');
    reload();
    window.dispatchEvent(new Event('alerts-changed'));
  }

  const open = (all ?? []).filter((a) => !a.acked_by);
  const c = (s: string) => open.filter((a) => a.severity === s).length;
  const list = (all ?? []).filter((a) => (f === 'open' ? !a.acked_by : f === 'all' ? true : a.severity === f && !a.acked_by));
  const chips: [Filter, string][] = [['open', 'Open'], ['crit', `Critical (${c('crit')})`], ['high', `High (${c('high')})`], ['med', `Medium (${c('med')})`], ['all', 'All incl. acknowledged']];

  return (
    <>
      <PageTop title="Alerts" sub="Exceptions that need attention" />
      <div className="content">
        {error && <div className="banner crit">{error}</div>}
        <div className="row" style={{ marginBottom: 14 }}>
          {chips.map(([k, l]) => <button key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l}</button>)}
        </div>
        <div className="card">
          {!all && !error && <div className="muted">Loading…</div>}
          {list.map((a) => <AlertRow key={a.alert_key} a={a} onAck={ack} />)}
          {all && !list.length && <div className="muted">Nothing here.</div>}
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          Alerts are generated from reconciliation results, live session counts, integrity checks and the document queue.
          Acknowledging only hides an alert; resolving the discrepancy in its session clears it.
        </div>
      </div>
    </>
  );
}
