/**
 * QR labels on exam booklets. The QR holds the script ID: student ID + course code, e.g. BU/24C/IT/10778-CSC409.
 * Decoding uses the browser's BarcodeDetector where it exists (Chrome, Android) and jsQR everywhere else (iOS Safari).
 * jsQR and pdf.js load only when first needed, so screens that never scan don't download them.
 */
import QRCode from 'qrcode';

export const normCode = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/** The label's QR as an SVG string (crisp at any print size). */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
let detector: Detector | null | undefined;
async function nativeDetector(): Promise<Detector | null> {
  if (detector !== undefined) return detector;
  const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  try {
    detector = BD && (await BD.getSupportedFormats?.())?.includes('qr_code') !== false ? new BD({ formats: ['qr_code'] }) : null;
  } catch { detector = null; }
  return detector;
}

let jsqr: typeof import('jsqr').default | undefined;
async function jsQR() { return (jsqr ??= (await import('jsqr')).default); }

/** Read one QR from an image, video frame or canvas. Returns the text, or null when none is readable. */
export async function decodeQr(src: HTMLCanvasElement | HTMLVideoElement | ImageBitmap, scratch?: HTMLCanvasElement): Promise<string | null> {
  const d = await nativeDetector();
  if (d) {
    try { const r = await d.detect(src); if (r.length) return r[0].rawValue; } catch { /* fall through to jsQR */ }
    if (!(src instanceof HTMLCanvasElement)) return null; // the native detector already looked at this frame
  }
  const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
  const h = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
  if (!w || !h) return null;
  const c = src instanceof HTMLCanvasElement ? src : (scratch ?? document.createElement('canvas'));
  if (c !== src) { c.width = w; c.height = h; c.getContext('2d', { willReadFrequently: true })!.drawImage(src, 0, 0); }
  const img = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  return (await jsQR())(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

/** Draw a source onto a canvas no wider/taller than `max` px (QR labels stay readable; decoding stays fast). */
function fit(src: CanvasImageSource & { width: number; height: number }, max = 1800): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** The first QR found in the photos, checked in page order. */
export async function qrFromImages(files: File[], maxPages = 3): Promise<string | null> {
  for (const f of files.slice(0, maxPages)) {
    const bmp = await createImageBitmap(f);
    try { const v = await decodeQr(fit(bmp)); if (v) return v; } finally { bmp.close(); }
  }
  return null;
}

/** The first QR found on the first pages of a PDF (the label is pasted on the cover). */
export async function qrFromPdf(bytes: Uint8Array, maxPages = 2): Promise<string | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  }
  // pdf.js takes ownership of the buffer: give it a copy. No eval: the site's CSP forbids it.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    for (let i = 1; i <= Math.min(maxPages, doc.numPages); i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 1800 / Math.max(base.width, base.height)) });
      const c = document.createElement('canvas');
      c.width = Math.round(viewport.width); c.height = Math.round(viewport.height);
      await page.render({ canvasContext: c.getContext('2d', { willReadFrequently: true })!, viewport }).promise;
      const v = await decodeQr(c);
      page.cleanup();
      if (v) return v;
    }
    return null;
  } finally {
    await doc.destroy();
  }
}

/** Whatever QR the staged script carries: from its photos when it was snapped, else from the PDF. */
export async function qrFromScript(bytes: Uint8Array, photos?: File[]): Promise<string | null> {
  try {
    return photos?.length ? await qrFromImages(photos) : await qrFromPdf(bytes);
  } catch {
    return null; // an unreadable file is handled like a missing QR: camera or eye check
  }
}
