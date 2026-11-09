import { cached } from './cache';
import { supabase } from './supabase';
import { must } from './useLoad';
import type { Alert, DashboardStats, DocType, SessionSummary } from './officer';

/**
 * Reads shared by several screens, cached briefly (see cache.ts). current_alerts and
 * session_summaries reconcile every session on the server, so they are the costliest calls
 * the app makes. Without the cache, the sidebar badge and the dashboard would each run them on
 * every navigation.
 */
const SHORT = 20_000;

export const fetchAlerts = () =>
  cached('alerts', SHORT, async () => must(await supabase.rpc('current_alerts')) as Alert[]);

export const fetchSummaries = () =>
  cached('summaries', SHORT, async () => must(await supabase.rpc('session_summaries')) as SessionSummary[]);

export const fetchStats = () =>
  cached('stats', SHORT, async () => must(await supabase.rpc('dashboard_stats')) as DashboardStats);

/** Document types barely ever change. */
export const fetchDocTypes = () =>
  cached('doc_types', 5 * 60_000, async () => must(await supabase.from('doc_types').select('*').order('sort')) as DocType[]);

export interface AppSettings {
  default_att_mode: 'start' | 'end' | 'submission';
  allow_pdf_upload: boolean; allow_photo_snaps: boolean; max_file_mb: number;
}

/** Staff-only settings row. The hall re-polls every 15 s, so caching this saves one request per poll on every hall device. */
export const fetchSettings = () =>
  cached('settings', 60_000, async () =>
    must(await supabase.from('settings').select('default_att_mode, allow_pdf_upload, allow_photo_snaps, max_file_mb').single()) as AppSettings);
