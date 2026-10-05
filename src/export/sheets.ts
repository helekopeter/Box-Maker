import { MARGIN } from '../geometry/styles';
import type { Appearance, Dieline, Face, Panel, Texture, Vec2 } from '../types';

/** Where one piece of one copy goes on a sheet. */
interface Placement {
  copy: number;
  piece: number;
  /** Turned a quarter turn clockwise. */
  turned: boolean;
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLayout {
  /** One entry per sheet, ready for the SVG/PDF exporters. */
  sheets: { dieline: Dieline; look: Appearance }[];
  /** How many whole copies fit on one sheet (0 if one doesn't fit on the bed at all). */
  perSheet: number;
}

const GAP = 3; // between pieces, mm

/** Bounding box of each separate cut piece. */
function pieceBoxes(d: Dieline): Map<number, Rect> {
  const out = new Map<number, Rect>();
  for (const pc of d.pieces) {
    const pts = d.panels.filter((p) => p.piece === pc.index).flatMap((p) => p.poly);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    out.set(pc.index, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
  }
  return out;
}

/**
 * MaxRects packing (best short side fit, both orientations) of pieces onto sheets the size
 * of the laser bed. Pieces too big for the bed get a sheet of their own, sized to fit.
 */
function pack(items: { copy: number; piece: number; w: number; h: number }[], bedW: number, bedH: number) {
  const W = bedW - 2 * MARGIN + GAP;
  const H = bedH - 2 * MARGIN + GAP;
  const sheets: { free: Rect[]; placed: Placement[]; w: number; h: number }[] = [];
  const newSheet = (w = W, h = H) => {
    const s = { free: [{ x: 0, y: 0, w, h }], placed: [] as Placement[], w, h };
    sheets.push(s);
    return s;
  };
  const tryPlace = (s: (typeof sheets)[number], w: number, h: number) => {
    let best: { r: Rect; turned: boolean; score: number } | null = null;
    for (const f of s.free)
      for (const [iw, ih, turned] of [[w, h, false], [h, w, true]] as const) {
        if (iw > f.w + 1e-9 || ih > f.h + 1e-9) continue;
        const score = Math.min(f.w - iw, f.h - ih);
        if (!best || score < best.score) best = { r: { x: f.x, y: f.y, w: iw, h: ih }, turned, score };
      }
    return best;
  };
  const cut = (s: (typeof sheets)[number], used: Rect) => {
    const next: Rect[] = [];
    for (const f of s.free) {
      if (used.x >= f.x + f.w || used.x + used.w <= f.x || used.y >= f.y + f.h || used.y + used.h <= f.y) {
        next.push(f);
        continue;
      }
      if (used.x > f.x) next.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
      if (used.x + used.w < f.x + f.w) next.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - used.x - used.w, h: f.h });
      if (used.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
      if (used.y + used.h < f.y + f.h) next.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - used.y - used.h });
    }
    // Drop free rectangles that lie inside another one (keeping one of identical twins).
    const within = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    s.free = next.filter((a, i) => !next.some((b, j) => j !== i && within(a, b) && (!within(b, a) || j < i)));
  };
  for (const it of items) {
    const w = it.w + GAP;
    const h = it.h + GAP;
    let spot = null;
    let sheet = null;
    for (const s of sheets) {
      if (s.w !== W || s.h !== H) continue;
      spot = tryPlace(s, w, h);
      if (spot) {
        sheet = s;
        break;
      }
    }
    if (!spot) {
      const fits = (w <= W && h <= H) || (h <= W && w <= H);
      sheet = fits ? newSheet() : newSheet(w, h);
      spot = tryPlace(sheet, w, h)!;
    }
    sheet!.placed.push({ copy: it.copy, piece: it.piece, turned: spot.turned, x: spot.r.x, y: spot.r.y });
    cut(sheet!, spot.r);
  }
  return sheets;
}

/**
 * Lays out `copies` copies of a box on as few laser-bed-sized sheets as possible, turning
 * pieces where that fits more in. Each sheet comes back as its own dieline (panel and face
 * ids get a copy suffix) with the decals repeated on every copy.
 */
export function layoutCopies(d: Dieline, look: Appearance, copies: number, bed: [number, number]): SheetLayout {
  const boxes = pieceBoxes(d);
  const items = [];
  for (let c = 0; c < copies; c++)
    for (const pc of d.pieces) {
      const b = boxes.get(pc.index)!;
      items.push({ copy: c, piece: pc.index, w: b.w, h: b.h });
    }
  // Big pieces first packs tighter.
  items.sort((a, b) => b.w * b.h - a.w * a.h || a.copy - b.copy);
  const packed = pack(items, bed[0], bed[1]);

  // Which piece each face belongs to (the piece whose panel contains its centre).
  const facePiece = new Map<string, number>();
  for (const f of d.faces) {
    const c: Vec2 = [f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2];
    const owner = d.panels.find((p) => p.id === f.id) ?? d.panels.find((p) => inside(c, p.poly));
    facePiece.set(f.id, owner?.piece ?? 0);
  }

  const sheets = packed.map((s) => {
    const panels: Panel[] = [];
    const faces: Face[] = [];
    const decals: Appearance['decals'] = [];
    const pieces: Dieline['pieces'] = [];
    const parts: NonNullable<Texture['parts']> = [];
    for (const pl of s.placed) {
      const b = boxes.get(pl.piece)!;
      const sfx = (id: string) => `${id}~${pl.copy}`;
      // Piece-local (from its box corner), then a quarter turn, then onto the sheet.
      const tf = ([x, y]: Vec2): Vec2 => {
        const u = x - b.x, v = y - b.y;
        return pl.turned ? [MARGIN + pl.x + (b.h - v), MARGIN + pl.y + u] : [MARGIN + pl.x + u, MARGIN + pl.y + v];
      };
      for (const p of d.panels) {
        if (p.piece !== pl.piece) continue;
        panels.push({
          ...p,
          id: sfx(p.id),
          ...(p.parent ? { parent: sfx(p.parent) } : {}),
          poly: p.poly.map(tf),
          ...(p.holes ? { holes: p.holes.map((h) => h.map(tf)) } : {}),
          ...(p.hinge ? { hinge: [tf(p.hinge[0]), tf(p.hinge[1])] as [Vec2, Vec2] } : {}),
          ...(p.creases ? { creases: p.creases.map(([a, b]) => [tf(a), tf(b)] as [Vec2, Vec2]) } : {}),
        });
      }
      for (const f of d.faces) {
        if (facePiece.get(f.id) !== pl.piece) continue;
        const a = tf([f.rect.x, f.rect.y]);
        const c = tf([f.rect.x + f.rect.w, f.rect.y + f.rect.h]);
        const rect = { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]) };
        faces.push({ ...f, id: sfx(f.id), rect, rotation: pl.turned ? f.rotation + 90 : f.rotation });
      }
      for (const dc of look.decals) if (facePiece.get(dc.face) === pl.piece) decals.push({ ...dc, id: sfx(dc.id), face: sfx(dc.face) });
      // The same move as `tf`, for the texture (canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f).
      const ox = MARGIN + pl.x, oy = MARGIN + pl.y;
      parts.push({
        matrix: pl.turned ? [0, 1, -1, 0, ox + b.h + b.y, oy - b.x] : [1, 0, 0, 1, ox - b.x, oy - b.y],
        size: [d.width, d.height],
        panels: d.panels.filter((p) => p.piece === pl.piece).map((p) => sfx(p.id)),
      });
      const pc = d.pieces.find((x) => x.index === pl.piece)!;
      pieces.push({ ...pc, root: sfx(pc.root) });
    }
    const dieline: Dieline = { panels, faces, pieces, width: s.w + 2 * MARGIN - GAP, height: s.h + 2 * MARGIN - GAP, outer: d.outer };
    return { dieline, look: { color: look.color, decals, ...(look.texture ? { texture: { ...look.texture, parts } } : {}) } };
  });

  // Whole copies per (bed-sized) sheet: the most that still pack onto one.
  const onOne = (n: number) => {
    const trial = [];
    for (let c = 0; c < n; c++) for (const [piece, b] of boxes) trial.push({ copy: c, piece, w: b.w, h: b.h });
    trial.sort((a, b) => b.w * b.h - a.w * a.h);
    const sh = pack(trial, bed[0], bed[1]);
    return sh.length === 1 && sh[0].w === bed[0] - 2 * MARGIN + GAP;
  };
  let perSheet = 0;
  if (onOne(1)) {
    let lo = 1, hi = 2;
    while (hi <= 512 && onOne(hi)) (lo = hi), (hi *= 2);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (onOne(mid)) lo = mid;
      else hi = mid;
    }
    perSheet = lo;
  }
  return { sheets, perSheet };
}

function inside([x, y]: Vec2, poly: Vec2[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}
