import type { Appearance, Decal, Dieline, Face, Vec2 } from './types';

export const KRAFT = '#c9a46b';

/** Width/height of a face as seen upright on the assembled box. */
export function faceSize(f: Face): { w: number; h: number } {
  const sideways = Math.abs(f.rotation) % 180 === 90;
  return sideways ? { w: f.rect.h, h: f.rect.w } : { w: f.rect.w, h: f.rect.h };
}

export interface DecalPlacement {
  /** Translation, rotation (deg) and box of the decal in its local frame. */
  cx: number;
  cy: number;
  faceRotation: number;
  lx: number;
  ly: number;
  rotation: number;
  w: number;
  h: number;
  fontSize: number;
}

export function placeDecal(f: Face, dc: Decal): DecalPlacement {
  const { w: fw, h: fh } = faceSize(f);
  const w = dc.size * fw;
  return {
    cx: f.rect.x + f.rect.w / 2,
    cy: f.rect.y + f.rect.h / 2,
    faceRotation: f.rotation,
    lx: (dc.x - 0.5) * fw,
    ly: (dc.y - 0.5) * fh,
    rotation: dc.rotation,
    w,
    h: w * (dc.aspect ?? 1),
    fontSize: dc.size * fh,
  };
}

export function fontStack(font?: string): string {
  switch (font) {
    case 'serif': return 'Georgia, "Times New Roman", serif';
    case 'mono': return '"Courier New", ui-monospace, monospace';
    case 'display': return 'Impact, "Arial Black", sans-serif';
    case 'script': return '"Brush Script MT", "Segoe Script", cursive';
    default: return 'Helvetica, Arial, sans-serif';
  }
}

const imageCache = new Map<string, HTMLImageElement>();

/** Loads (and caches) a decal image. Resolves once it can be drawn. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached?.complete && cached.naturalWidth) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = cached ?? new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (!cached) {
      img.src = src;
      imageCache.set(src, img);
    }
  });
}

function tracePoly(ctx: CanvasRenderingContext2D, poly: Vec2[]) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

export interface RenderOptions {
  /** Pixels per mm. */
  scale: number;
  /** Draw unprinted board and glue hatching too (used for the 3D texture). */
  preview: boolean;
}

/** Renders the printed outside of the sheet: background colour plus decals. */
export async function renderArtwork(
  d: Dieline,
  look: Appearance,
  opts: RenderOptions,
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): Promise<HTMLCanvasElement> {
  // Load images before touching the canvas so a redraw never shows a half-finished state.
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(
    look.decals
      .filter((dc) => dc.type === 'image' && dc.src)
      .map(async (dc) => {
        try {
          images.set(dc.src!, await loadImage(dc.src!));
        } catch {
          /* broken image: skip */
        }
      }),
  );

  canvas.width = Math.max(1, Math.round(d.width * opts.scale));
  canvas.height = Math.max(1, Math.round(d.height * opts.scale));
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(opts.scale, 0, 0, opts.scale, 0, 0);
  ctx.clearRect(0, 0, d.width, d.height);

  if (opts.preview) {
    ctx.fillStyle = KRAFT;
    ctx.fillRect(0, 0, d.width, d.height);
  }
  ctx.fillStyle = look.color;
  for (const p of d.panels) {
    if (p.kind === 'glue') continue;
    tracePoly(ctx, p.poly);
    ctx.fill();
  }
  if (opts.preview) {
    for (const p of d.panels) {
      if (p.kind !== 'glue') continue;
      ctx.save();
      tracePoly(ctx, p.poly);
      ctx.clip();
      ctx.strokeStyle = 'rgba(30,140,60,0.55)';
      ctx.lineWidth = 0.8;
      for (let k = -d.height; k < d.width; k += 4) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k + d.height, d.height);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  const faces = new Map(d.faces.map((f) => [f.id, f]));
  for (const dc of look.decals) {
    const f = faces.get(dc.face);
    if (!f) continue;
    const pl = placeDecal(f, dc);
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.rect.x, f.rect.y, f.rect.w, f.rect.h);
    ctx.clip();
    ctx.translate(pl.cx, pl.cy);
    ctx.rotate((pl.faceRotation * Math.PI) / 180);
    ctx.translate(pl.lx, pl.ly);
    ctx.rotate((pl.rotation * Math.PI) / 180);
    if (dc.type === 'text' && dc.text) {
      ctx.fillStyle = dc.color ?? '#000';
      ctx.font = `${dc.bold ? 'bold ' : ''}${pl.fontSize}px ${fontStack(dc.font)}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      dc.text.split('\n').forEach((line, i, all) => {
        ctx.fillText(line, 0, (i - (all.length - 1) / 2) * pl.fontSize * 1.15);
      });
    } else if (dc.type === 'image' && dc.src) {
      const img = images.get(dc.src);
      if (img) ctx.drawImage(img, -pl.w / 2, -pl.h / 2, pl.w, pl.h);
    }
    ctx.restore();
  }
  return canvas;
}
