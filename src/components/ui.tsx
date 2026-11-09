import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Severity = 'crit' | 'high' | 'med' | 'ok' | 'pend' | 'info';
const SEV: Record<Severity, [string, string]> = {
  crit: ['Critical', 'p-crit'], high: ['High', 'p-high'], med: ['Medium', 'p-med'],
  ok: ['OK', 'p-ok'], pend: ['Pending', 'p-pend'], info: ['Info', 'p-info'],
};
export function Pill({ sev, children }: { sev: Severity; children?: ReactNode }) {
  return <span className={`pill ${SEV[sev][1]}`}>{children ?? SEV[sev][0]}</span>;
}

/* Toasts */
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m); window.clearTimeout(t.current); t.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite">{msg && <div className="toast">{msg}</div>}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* Modal: portalled to <body>: a glass ancestor's backdrop-filter would otherwise trap position:fixed inside it */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">{children}</div>
    </div>,
    document.body,
  );
}
