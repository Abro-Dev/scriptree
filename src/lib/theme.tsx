import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'glass' | 'classic';
export interface Backdrop { id: string; name: string; group: 'Academic' | 'Nature' }

/** Photos live in public/bg (1920px) with 160×104 previews in public/bg/thumbs. All from Unsplash (free licence). */
export const BACKDROPS: Backdrop[] = [
  { id: 'library-lights', name: 'Library lights', group: 'Academic' },
  { id: 'exam-hall', name: 'Exam hall', group: 'Academic' },
  { id: 'curved-library', name: 'Curved library', group: 'Academic' },
  { id: 'library-wall', name: 'Library wall', group: 'Academic' },
  { id: 'campus', name: 'Campus', group: 'Academic' },
  { id: 'graduation', name: 'Graduation', group: 'Academic' },
  { id: 'open-books', name: 'Open books', group: 'Academic' },
  { id: 'study-desk', name: 'Study desk', group: 'Academic' },
  { id: 'floating-book', name: 'Floating book', group: 'Academic' },
  { id: 'sunset-reader', name: 'Sunset reader', group: 'Academic' },
  { id: 'alpine-dawn', name: 'Alpine dawn', group: 'Nature' },
  { id: 'violet-shore', name: 'Violet shore', group: 'Nature' },
  { id: 'emerald-lake', name: 'Emerald lake', group: 'Nature' },
  { id: 'misty-valley', name: 'Misty valley', group: 'Nature' },
  { id: 'forest-path', name: 'Forest path', group: 'Nature' },
  { id: 'golden-hills', name: 'Golden hills', group: 'Nature' },
  { id: 'tropical-beach', name: 'Tropical beach', group: 'Nature' },
  { id: 'calm-water', name: 'Calm water', group: 'Nature' },
  { id: 'waterfall', name: 'Waterfall', group: 'Nature' },
  { id: 'granite-meadow', name: 'Granite meadow', group: 'Nature' },
];
const DEFAULT_BACKDROP: string = 'library-lights';

export const bgUrl = (id: string) => `/bg/${id}.jpg`;
export const thumbUrl = (id: string) => `/bg/thumbs/${id}.jpg`;

interface ThemeState { theme: Theme; backdrop: string; setTheme: (t: Theme) => void; setBackdrop: (id: string) => void }
const ThemeCtx = createContext<ThemeState | null>(null);

function stored<T extends string>(key: string, ok: (v: string) => boolean, fallback: T): T {
  try { const v = localStorage.getItem(key); return v && ok(v) ? (v as T) : fallback; } catch { return fallback; }
}

/** Appearance is a per-device preference, so it lives in localStorage rather than the user's profile. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => stored('st-theme', (v) => v === 'glass' || v === 'classic', 'glass'));
  const [backdrop, setBackdrop] = useState<string>(() => stored('st-backdrop', (v) => BACKDROPS.some((b) => b.id === v), DEFAULT_BACKDROP));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('st-theme', theme); } catch { /* private mode */ }
  }, [theme]);
  useEffect(() => { try { localStorage.setItem('st-backdrop', backdrop); } catch { /* private mode */ } }, [backdrop]);

  return (
    <ThemeCtx.Provider value={{ theme, backdrop, setTheme, setBackdrop }}>
      {theme === 'glass' && <BackdropLayer id={backdrop} />}
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  const v = useContext(ThemeCtx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}

/** Two stacked layers so a new photo crossfades in only after it has fully loaded. */
function BackdropLayer({ id }: { id: string }) {
  const [state, setState] = useState<{ layers: [string | null, string | null]; front: number }>({ layers: [null, null], front: 0 });
  const { layers, front } = state;

  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      setState((s) => {
        if (s.layers[s.front] === id) return s;
        const next = 1 - s.front;
        const l: [string | null, string | null] = [...s.layers];
        l[next] = id;
        return { layers: l, front: next };
      });
    };
    img.src = bgUrl(id);
    return () => { alive = false; };
  }, [id]);

  return (
    <div className="backdrop" aria-hidden="true">
      {layers.map((l, i) => (
        <div key={i} className={`backdrop-photo${i === front && l ? ' show' : ''}`} style={l ? { backgroundImage: `url(${bgUrl(l)})` } : undefined} />
      ))}
      <div className="backdrop-scrim" />
    </div>
  );
}
