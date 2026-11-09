import { useState } from 'react';
import { Modal } from './ui';
import { BACKDROPS, thumbUrl, useTheme, type Backdrop } from '../lib/theme';

/** Sidebar button + dialog for choosing the theme and (in glass mode) the backdrop photo. */
export function AppearanceButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="appearance-btn" onClick={() => setOpen(true)} aria-haspopup="dialog">Appearance</button>
      {open && <AppearanceDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const { theme, setTheme, backdrop, setBackdrop } = useTheme();
  const current = BACKDROPS.find((b) => b.id === backdrop);
  const [group, setGroup] = useState<Backdrop['group']>(current?.group ?? 'Academic');

  return (
    <Modal onClose={onClose}>
      <div className="row between" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>Appearance</h3>
        <button className="btn sm" onClick={onClose} autoFocus>Done</button>
      </div>

      <div className="form-label" style={{ marginBottom: 8 }}>Theme</div>
      <div className="theme-choice" role="radiogroup" aria-label="Theme">
        {(['glass', 'classic'] as const).map((t) => (
          <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
            <span className={`theme-swatch ${t}`} aria-hidden="true" />
            <b>{t === 'glass' ? 'Glass' : 'Classic'}</b>
            <span className="small muted">{t === 'glass' ? 'Frosted panels over a photo' : 'Bright cobalt, solid cards'}</span>
          </button>
        ))}
      </div>

      {theme === 'glass' && (
        <>
          <div className="row between" style={{ margin: '20px 0 10px' }}>
            <div className="form-label">Backdrop</div>
            <div className="seg">
              {(['Academic', 'Nature'] as const).map((g) => (
                <button key={g} className={group === g ? 'on' : ''} aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>
              ))}
            </div>
          </div>
          <div className="backdrop-grid" role="radiogroup" aria-label="Backdrop photo">
            {BACKDROPS.filter((b) => b.group === group).map((b) => (
              <button key={b.id} role="radio" aria-checked={b.id === backdrop} aria-label={b.name} title={b.name}
                className={b.id === backdrop ? 'on' : ''} onClick={() => setBackdrop(b.id)}
                style={{ backgroundImage: `url(${thumbUrl(b.id)})` }} />
            ))}
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>Saved on this device only.</div>
        </>
      )}
    </Modal>
  );
}
