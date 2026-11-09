/** Browser-side file helpers for the scan station. The authoritative SHA-256 is computed on the server. */

export async function readBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function isPdf(bytes: Uint8Array) {
  return bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
}

/** Preview fingerprint, shown before upload and compared with the server's after. */
export async function sha256Hex(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface JpegPage { jpg: Uint8Array; w: number; h: number; thumb: string }

/** Downscale a photo to ≤1600px on the long edge and re-encode as JPEG (white background). */
export async function imageToJpeg(file: File): Promise<JpegPage> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode photo'))), 'image/jpeg', 0.85));
  const t = document.createElement('canvas');
  const ts = 96 / Math.max(w, h);
  t.width = Math.round(w * ts); t.height = Math.round(h * ts);
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  return { jpg: await readBytes(blob), w, h, thumb: t.toDataURL('image/jpeg', 0.7) };
}

/** Minimal PDF 1.4 writer: one JPEG per A4-width page (DCTDecode, no re-compression). */
export function buildPdf(pages: JpegPage[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offs: number[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; chunks.push(u); len += u.length; };
  const open = (id: number) => { offs[id] = len; push(`${id} 0 obj\n`); };
  const close = () => push('\nendobj\n');
  const n = pages.length, total = 3 + 3 * n;

  push(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10])); // %PDF-1.4 + binary marker
  open(1); push('<< /Type /Catalog /Pages 2 0 R >>'); close();
  open(2); push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>`); close();
  pages.forEach((p, i) => {
    const pid = 3 + 3 * i, cid = pid + 1, iid = pid + 2, pw = 595, ph = Math.round((595 * p.h) / p.w);
    const cs = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    open(pid); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`); close();
    open(cid); push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`); close();
    open(iid); push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>\nstream\n`);
    push(p.jpg); push('\nendstream'); close();
  });
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(`${x}trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export const mb = (b: number) => (b / 1048576).toFixed(1) + ' MB';
export const shortHash = (h: string) => h.slice(0, 10) + '…' + h.slice(-6);
