/** Small DOM helpers shared by the tabs. */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  e.append(...kids);
  return e;
};

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/** Parses a number input, clamped; null when empty or invalid. */
export function num(inp: HTMLInputElement, min: number, max: number): number | null {
  const v = parseFloat(inp.value);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

export function download(blob: Blob, name: string) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Reads an image file as a data URL, downscaling large bitmaps to keep files small. */
export async function readImage(file: File): Promise<string> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  if (file.type === 'image/svg+xml') return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const max = 1600;
  if (Math.max(img.naturalWidth, img.naturalHeight) <= max) return url;
  const k = max / Math.max(img.naturalWidth, img.naturalHeight);
  const c = el('canvas', { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/**
 * Reads a painted texture as a data URL: up to 4096 px across, JPEG unless the picture has
 * see-through parts (then PNG, so the box colour shows through).
 */
export async function readTexture(file: File): Promise<{ src: string; aspect: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = el('canvas', { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let alpha = false;
    for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 250) (alpha = true), (i = px.length);
    return { src: alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9), aspect: img.naturalHeight / img.naturalWidth };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const SWATCHES: [string, string][] = [
  ['Brown', '#c9a46b'], ['White', '#f4f1ea'], ['Black', '#222222'], ['Red', '#c0392b'],
  ['Orange', '#e67e22'], ['Yellow', '#f1c40f'], ['Green', '#3f8f4f'], ['Teal', '#2f6f8f'],
  ['Blue', '#2c4f9e'], ['Purple', '#7d4a9e'], ['Pink', '#ff94ec'],
];

/** Fills a swatch row; calls `pick` with the chosen colour. */
export function buildSwatches(wrap: HTMLElement, pick: (c: string) => void) {
  wrap.innerHTML = '';
  for (const [name, color] of SWATCHES) {
    const b = el('button', { className: 'swatch', title: name });
    b.dataset.color = color;
    b.style.background = color;
    b.onclick = () => pick(color);
    wrap.append(b);
  }
}

export function syncSwatches(wrap: HTMLElement, color: string) {
  wrap.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color?.toLowerCase() === color.toLowerCase()));
}

/** A small transient message at the bottom of the screen. */
export function toast(message: string, ms = 3500) {
  let host = document.querySelector<HTMLElement>('.toast');
  if (!host) {
    host = el('div', { className: 'toast', role: 'status' });
    document.body.append(host);
  }
  host.textContent = message;
  host.classList.add('show');
  clearTimeout(Number(host.dataset.timer));
  host.dataset.timer = String(window.setTimeout(() => host!.classList.remove('show'), ms));
}
