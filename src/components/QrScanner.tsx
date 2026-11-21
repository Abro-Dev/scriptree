import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './ui';
import { decodeQr } from '../lib/qr';

export interface ScanResult { ok: boolean; text: string }

/**
 * Camera QR reader. Opens the back camera and reads codes until closed.
 * `onCode` handles each code; while it runs (and for a moment after) the same code is ignored, so one
 * booklet held in front of the camera is read once. Return a result to show it under the video.
 * With `once`, reading stops after the first code that isn't refused (a result with ok: false keeps reading).
 */
export function QrScanner({ title, hint, once, onCode, onClose, footer }: {
  title: string;
  hint?: ReactNode;
  once?: boolean;
  onCode: (code: string) => Promise<ScanResult | void> | ScanResult | void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const handler = useRef(onCode);
  handler.current = onCode;
  const [err, setErr] = useState('');
  const [last, setLast] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false, timer = 0, working = false;
    let recent = '', recentAt = 0;

    const tick = async () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && !working) {
        const code = (await decodeQr(v, (scratch.current ??= document.createElement('canvas'))).catch(() => null))?.trim();
        if (code && !(code === recent && Date.now() - recentAt < 4000)) {
          working = true; setBusy(true);
          recent = code; recentAt = Date.now();
          navigator.vibrate?.(60);
          let r: ScanResult | void = undefined;
          try {
            r = await handler.current(code);
            if (r && !stopped) setLast(r);
          } finally {
            working = false; recentAt = Date.now(); setBusy(false);
          }
          if (once && (!r || r.ok)) return; // a refused code keeps the reader open for another try
        }
      }
      if (!stopped) timer = window.setTimeout(tick, 180);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setErr('This browser cannot open the camera. Type the ID instead.'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        tick();
      } catch (e) {
        const n = (e as DOMException).name;
        setErr(n === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this site in the browser settings, or type the ID instead.'
          : n === 'NotFoundError' ? 'No camera found on this device. Type the ID instead.'
          : 'Could not open the camera: ' + (e as Error).message);
      }
    })();
    return () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [once]);

  return (
    <Modal onClose={onClose}>
      <h3>{title}</h3>
      {hint && <div className="small muted" style={{ marginBottom: 10 }}>{hint}</div>}
      {err ? <div className="banner crit">{err}</div>
        : <div className="qr-cam">
            <video ref={video} playsInline muted />
            <div className="qr-aim" aria-hidden />
            {busy && <div className="qr-busy">Checking…</div>}
          </div>}
      {last && <div className={`banner ${last.ok ? 'ok' : 'crit'}`} role="status" style={{ marginTop: 10 }}>{last.text}</div>}
      {footer}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>{once ? 'Cancel' : 'Done'}</button>
      </div>
    </Modal>
  );
}
