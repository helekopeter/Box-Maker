import type { Dieline, Panel, PanelKind, Vec2 } from '../types';
import { BASE_ID, outwardNormal, type AdvancedDesign, type ChildShape, type CustomKind, type CustomPanel } from './model';

const KIND: Record<PanelKind, CustomKind> = { face: 'wall', flap: 'flap', glue: 'glue' };
const EPS = 0.01;

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const near = (a: Vec2, b: Vec2, tol = EPS * 10) => len(sub(a, b)) < tol;

/** Distance of p from segment ab and its position along it (in mm from a). */
function onSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; along: number; L: number } {
  const ab = sub(b, a);
  const L = len(ab);
  const along = dot(sub(p, a), ab) / (L || 1);
  const foot: Vec2 = [a[0] + (ab[0] * along) / (L || 1), a[1] + (ab[1] * along) / (L || 1)];
  return { dist: len(sub(p, foot)), along, L };
}

/** Adds the hinge's end points to a polygon as vertices if they sit in the middle of an edge. */
function withVertices(poly: Vec2[], pts: Vec2[]): Vec2[] {
  let out = poly.slice();
  for (const p of pts) {
    if (out.some((q) => near(q, p))) continue;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const s = onSegment(p, a, b);
      if (s.dist < EPS * 10 && s.along > 0 && s.along < s.L) {
        out = [...out.slice(0, i + 1), p, ...out.slice(i + 1)];
        break;
      }
    }
  }
  return out;
}

/**
 * Converts a dieline from the Simple tab into an Advanced design, so a ready-made box can
 * be edited freehand. Every hinged panel becomes a panel on its parent's edge; the outlines
 * are kept exactly, and rectangular ones are recognised so their handles work.
 *
 * Only the first piece is converted (Advanced designs are a single piece). Returns the
 * design and the number of panels that couldn't be carried over.
 */
export function fromDieline(
  dl: Dieline,
  opts: { name: string; thickness: number; color: string },
): { design: AdvancedDesign; skipped: number; droppedPieces: number; faceIds: Map<string, string> } {
  const pieceInfo = dl.pieces[0];
  const panels = dl.panels.filter((p) => p.piece === pieceInfo.index);
  const byId = new Map(panels.map((p) => [p.id, p]));
  const root = byId.get(pieceInfo.root)!;

  // Put the base's top-left corner at the origin.
  const xs = root.poly.map((q) => q[0]);
  const ys = root.poly.map((q) => q[1]);
  const off: Vec2 = [Math.min(...xs), Math.min(...ys)];
  const mv = (q: Vec2): Vec2 => [q[0] - off[0], q[1] - off[1]];

  const rootPoly = root.poly.map(mv);
  const W = Math.max(...xs) - off[0];
  const H = Math.max(...ys) - off[1];
  const isRect =
    rootPoly.length === 4 &&
    near(rootPoly[0], [0, 0]) && near(rootPoly[1], [W, 0]) && near(rootPoly[2], [W, H]) && near(rootPoly[3], [0, H]);

  const design: AdvancedDesign = {
    version: 1,
    name: opts.name,
    thickness: opts.thickness,
    color: opts.color,
    base: { width: W, height: H, ...(isRect ? {} : { points: rootPoly }), holes: (root.holes ?? []).map((h) => h.map(mv)) },
    panels: [],
    rotation: pieceInfo.rotation,
  };

  // Outline of each converted panel in sheet coordinates, in the vertex order the
  // Advanced model will rebuild it with (so edge indices line up).
  const outlines = new Map<string, Vec2[]>([[root.id, isRect ? [[0, 0], [W, 0], [W, H], [0, H]] : rootPoly]]);
  const idMap = new Map<string, string>([[root.id, BASE_ID]]);
  // Sheet → panel (u, v) frame for every converted panel (the base's frame is the sheet).
  const frames = new Map<string, (q: Vec2) => Vec2>([[root.id, (q) => q]]);
  const children = new Map<string, Panel[]>();
  for (const p of panels) if (p.parent) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);

  let skipped = 0;
  const queue = [root.id];
  while (queue.length) {
    const parentId = queue.shift()!;
    const parentOutline = outlines.get(parentId)!;
    for (const p of children.get(parentId) ?? []) {
      const converted = convertChild(p, parentOutline, idMap.get(parentId)!, mv);
      if (!converted) {
        skipped++;
        continue;
      }
      design.panels.push(converted.panel);
      outlines.set(p.id, converted.outline);
      frames.set(p.id, converted.toLocal);
      idMap.set(p.id, converted.panel.id);
      queue.push(p.id);
    }
  }
  // Carry the printable faces over, keeping their names and which way is up.
  const faceIds = new Map<string, string>();
  for (const f of dl.faces) {
    const centre: Vec2 = [f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2];
    const owner = byId.get(f.id) ?? panels.find((p) => p.kind !== 'glue' && inPoly(centre, p.poly));
    const frame = owner && frames.get(owner.id);
    if (!owner || !frame) continue;
    const local = [[f.rect.x, f.rect.y], [f.rect.x + f.rect.w, f.rect.y + f.rect.h]].map((q) => frame(mv(q as Vec2)));
    const spec = {
      label: f.label,
      rotation: f.rotation,
      rect: [
        Math.min(local[0][0], local[1][0]), Math.min(local[0][1], local[1][1]),
        Math.max(local[0][0], local[1][0]), Math.max(local[0][1], local[1][1]),
      ] as [number, number, number, number],
    };
    const id = idMap.get(owner.id)!;
    if (id === BASE_ID) design.base.face = spec;
    else design.panels.find((p) => p.id === id)!.face = spec;
    faceIds.set(f.id, id);
  }
  // Only walls carry other panels in Advanced designs.
  for (const p of design.panels) if (p.kind !== 'wall' && design.panels.some((c) => c.parent === p.id)) p.kind = 'wall';
  return { design, skipped, droppedPieces: dl.pieces.length - 1, faceIds };
}

function inPoly([x, y]: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function convertChild(p: Panel, parentOutline: Vec2[], parentId: string, mv: (q: Vec2) => Vec2) {
  if (!p.hinge) return null;
  const h0 = mv(p.hinge[0]);
  const h1 = mv(p.hinge[1]);

  // Which edge of the parent carries the hinge?
  let edge = -1;
  for (let k = 0; k < parentOutline.length; k++) {
    const a = parentOutline[k];
    const b = parentOutline[(k + 1) % parentOutline.length];
    const s0 = onSegment(h0, a, b);
    const s1 = onSegment(h1, a, b);
    if (s0.dist < 0.05 && s1.dist < 0.05 && Math.min(s0.along, s1.along) > -0.05 && Math.max(s0.along, s1.along) < s0.L + 0.05) {
      edge = k;
      break;
    }
  }
  if (edge < 0) return null;
  const a = parentOutline[edge];
  const b = parentOutline[(edge + 1) % parentOutline.length];
  const L = len(sub(b, a));
  const U: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const V = outwardNormal(parentOutline, edge);
  const t0 = dot(sub(h0, a), U);
  const t1 = dot(sub(h1, a), U);
  const [u0, u1] = t0 < t1 ? [t0, t1] : [t1, t0];
  const hingeLen = u1 - u0;
  const origin: Vec2 = [a[0] + U[0] * u0, a[1] + U[1] * u0];
  const toLocal = (q: Vec2): Vec2 => {
    const d = sub(q, origin);
    return [dot(d, U), dot(d, V)];
  };

  // Rotate the outline so it starts at the hinge's start and runs along the hinge first.
  const start: Vec2 = [origin[0], origin[1]];
  const end: Vec2 = [origin[0] + U[0] * hingeLen, origin[1] + U[1] * hingeLen];
  let poly = withVertices(p.poly.map(mv), [start, end]);
  let i = poly.findIndex((q) => near(q, start));
  if (i < 0) return null;
  const next = poly[(i + 1) % poly.length];
  if (!near(next, end)) {
    poly = poly.slice().reverse();
    i = poly.findIndex((q) => near(q, start));
    if (!near(poly[(i + 1) % poly.length], end)) return null;
  }
  const ordered = [...poly.slice(i), ...poly.slice(0, i)];
  const local = ordered.map(toLocal);
  const rest = local.slice(2);
  if (!rest.length) return null;

  // Recognise rectangles and trapezoids (far edge parallel to the hinge).
  let shape: ChildShape = { type: 'custom', points: rest };
  if (rest.length === 2 && Math.abs(rest[0][1] - rest[1][1]) < EPS && rest[0][1] > 0) {
    shape = { type: 'rect', depth: rest[0][1], taper0: rest[1][0], taper1: hingeLen - rest[0][0] };
  }

  const angle = p.motion?.length ? p.motion[p.motion.length - 1][1] : (p.angle ?? 90);
  const panel: CustomPanel = {
    id: p.id === BASE_ID ? `${p.id}-1` : p.id,
    parent: parentId,
    edge,
    kind: KIND[p.kind],
    inset0: Math.max(0, u0),
    inset1: Math.max(0, L - u1),
    shape,
    angle,
    order: p.stage ?? 1,
    layer: p.offset ?? 0,
    ...(p.motion ? { motion: p.motion.map(([t, v]) => [t, v] as Vec2) } : {}),
    holes: (p.holes ?? []).map((h) => h.map((q) => toLocal(mv(q)))),
  };
  // The Advanced model rebuilds the outline from the frame; keep the same order.
  return { panel, outline: ordered, toLocal };
}
