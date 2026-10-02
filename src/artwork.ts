import { apply, invert, multiply, rotate, translate, unfoldFrom, type Affine } from './geometry/surface';
import type { Appearance, Decal, Dieline, Face, Panel, Vec2 } from './types';

export const KRAFT = '#c9a46b';
export const SELECT_COLOR = '#ff7a00';

/** Width/height of a face as seen upright on the assembled box. */
export function faceSize(f: Face): { w: number; h: number } {
  const sideways = Math.abs(f.rotation) % 180 === 90;
  return sideways ? { w: f.rect.h, h: f.rect.w } : { w: f.rect.w, h: f.rect.h };
}

/** Face-local frame: origin at the face centre, x right and y down as seen upright on the box. */
export function faceFrame(f: Face): Affine {
  return multiply(translate(f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2), rotate(f.rotation));
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Size of a decal in mm. Images: `size` is the width. Text: `size` is the font size. */
export function decalExtent(dc: Decal): { w: number; h: number } {
  if (dc.type === 'image') return { w: dc.size, h: dc.size * (dc.aspect ?? 1) };
  const lines = (dc.text ?? '').split('\n');
  if (measureCtx === undefined) {
    measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  let w = 0;
  for (const line of lines) {
    if (measureCtx) {
      measureCtx.font = `${dc.bold ? 'bold ' : ''}100px ${fontStack(dc.font)}`;
      w = Math.max(w, (measureCtx.measureText(line).width / 100) * dc.size);
    } else {
      w = Math.max(w, line.length * dc.size * 0.6);
    }
  }
  return { w, h: lines.length * dc.size * 1.15 };
}

/** Decal centre in the sheet coordinates of its anchor face. */
export function decalCenter(f: Face, dc: Decal): Vec2 {
  const { w, h } = faceSize(f);
  return apply(faceFrame(f), [(dc.x - 0.5) * w, (dc.y - 0.5) * h]);
}

/** Moves a decal so its centre sits at a sheet point (given in the anchor face's coordinates). */
export function setDecalCenter(f: Face, dc: Decal, p: Vec2) {
  const { w, h } = faceSize(f);
  const [u, v] = apply(invert(faceFrame(f)), p);
  dc.x = u / w + 0.5;
  dc.y = v / h + 0.5;
}

/** Decal-local (centred, unrotated) → anchor face sheet coordinates. */
export function decalMatrix(f: Face, dc: Decal): Affine {
  const [cx, cy] = decalCenter(f, dc);
  return multiply(translate(cx, cy), rotate(f.rotation + dc.rotation));
}

export interface DecalPiece {
  face: Face;
  /** Anchor sheet → this face's sheet coordinates. */
  map: Affine;
  /** Decal-local → this face's sheet coordinates. */
  matrix: Affine;
}

/**
 * Every face a decal shows up on. A decal hanging over the edge of its face continues onto
 * the neighbouring face as if the box were unfolded there, so on the flat sheet it is split
 * whenever those faces aren't next to each other.
 */
export function decalPieces(d: Dieline, dc: Decal): DecalPiece[] {
  const faces = new Map(d.faces.map((f) => [f.id, f]));
  const anchor = faces.get(dc.face);
  if (!anchor) return [];
  const local = decalMatrix(anchor, dc);
  const { w, h } = decalExtent(dc);
  const pad = 0.5;
  const corners: Vec2[] = [[-w / 2 - pad, -h / 2 - pad], [w / 2 + pad, -h / 2 - pad], [w / 2 + pad, h / 2 + pad], [-w / 2 - pad, h / 2 + pad]];
  const out: DecalPiece[] = [];
  for (const [id, map] of unfoldFrom(d, dc.face)) {
    const face = faces.get(id)!;
    const matrix = multiply(map, local);
    const pts = corners.map((c) => apply(matrix, c));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const r = face.rect;
    if (Math.max(...xs) < r.x || Math.min(...xs) > r.x + r.w || Math.max(...ys) < r.y || Math.min(...ys) > r.y + r.h) continue;
    out.push({ face, map, matrix });
  }
  return out;
}

/** Topmost decal under a sheet point on a face, or -1. */
export function hitDecal(d: Dieline, decals: Decal[], face: string, p: Vec2): number {
  for (let i = decals.length - 1; i >= 0; i--) {
    const dc = decals[i];
    const piece = decalPieces(d, dc).find((pc) => pc.face.id === face);
    if (!piece) continue;
    const [x, y] = apply(invert(piece.matrix), p);
    const { w, h } = decalExtent(dc);
    const tol = 2;
    if (Math.abs(x) <= w / 2 + tol && Math.abs(y) <= h / 2 + tol) return i;
  }
  return -1;
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

/** Traces a panel outline plus its holes; fill or clip with 'evenodd'. */
function tracePanel(ctx: CanvasRenderingContext2D, p: Panel) {
  ctx.beginPath();
  for (const loop of [p.poly, ...(p.holes ?? [])]) {
    loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
}

export interface RenderOptions {
  /** Pixels per mm. */
  scale: number;
  /** Draw unprinted board and glue hatching too (used for the 3D texture). */
  preview: boolean;
  /** Id of a decal to outline (preview only). */
  selected?: string | null;
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
    tracePanel(ctx, p);
    ctx.fill('evenodd');
  }
  if (opts.preview) {
    for (const p of d.panels) {
      if (p.kind !== 'glue') continue;
      ctx.save();
      tracePanel(ctx, p);
      ctx.clip('evenodd');
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

  for (const dc of look.decals) {
    const { w, h } = decalExtent(dc);
    for (const pc of decalPieces(d, dc)) {
      const r = pc.face.rect;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.transform(...pc.matrix);
      if (dc.type === 'text' && dc.text) {
        ctx.fillStyle = dc.color ?? '#000';
        ctx.font = `${dc.bold ? 'bold ' : ''}${dc.size}px ${fontStack(dc.font)}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        dc.text.split('\n').forEach((line, i, all) => {
          ctx.fillText(line, 0, (i - (all.length - 1) / 2) * dc.size * 1.15);
        });
      } else if (dc.type === 'image' && dc.src) {
        const img = images.get(dc.src);
        if (img) ctx.drawImage(img, -w / 2, -h / 2, w, h);
      }
      if (opts.preview && opts.selected === dc.id) {
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = Math.max(0.6, 1.5 / opts.scale);
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(-w / 2 - 1.5, -h / 2 - 1.5, w + 3, h + 3);
      }
      ctx.restore();
    }
  }
  return canvas;
}
