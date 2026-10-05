import type { Bez, Dieline, Panel, PanelKind, Vec2 } from '../types';
import { restartLoop, stepsOf } from '../export/curves';
import { sampleBez } from '../geometry/shapes';
import { BASE_ID, outwardNormal, type AdvancedDesign, type BasePanel, type ChildShape, type CustomKind, type CustomPanel, type ExtraPiece, type Handle } from './model';

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
 * are kept exactly, and rectangular ones are recognised so their handles work. Further
 * pieces (a lid, a sleeve, an insert) become extra pieces of the design, where they were
 * on the sheet. Returns the design and the number of panels that couldn't be carried over.
 */
export function fromDieline(
  dl: Dieline,
  opts: { name: string; thickness: number; color: string },
): { design: AdvancedDesign; skipped: number; faceIds: Map<string, string> } {
  // The main piece's base has its top-left corner at the origin; everything else keeps its
  // place on the sheet relative to it.
  const main = dl.pieces[0];
  const mainRoot = dl.panels.find((p) => p.id === main.root)!;
  const off: Vec2 = [Math.min(...mainRoot.poly.map((q) => q[0])), Math.min(...mainRoot.poly.map((q) => q[1]))];
  const mv = (q: Vec2): Vec2 => [q[0] - off[0], q[1] - off[1]];

  const design: AdvancedDesign = {
    version: 1,
    name: opts.name,
    thickness: opts.thickness,
    color: opts.color,
    base: { width: 1, height: 1, holes: [] },
    panels: [],
    rotation: main.rotation,
  };

  // Outline of each converted panel (layout coordinates), in the vertex order the Advanced
  // model rebuilds it with, so edge indices line up; and each panel's sheet → (u, v) map.
  const outlines = new Map<string, Vec2[]>();
  const frames = new Map<string, (q: Vec2) => Vec2>();
  const idMap = new Map<string, string>();
  const children = new Map<string, Panel[]>();
  for (const p of dl.panels) if (p.parent) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  let skipped = 0;

  for (const [i, info] of dl.pieces.entries()) {
    const root = dl.panels.find((p) => p.id === info.root);
    if (!root) continue;
    const rootId = i === 0 ? BASE_ID : `piece-${i + 1}`;
    // The base's own frame: its top-left corner, on the sheet at `at`.
    const xs = root.poly.map((q) => mv(q)[0]);
    const ys = root.poly.map((q) => mv(q)[1]);
    const at: Vec2 = [Math.min(...xs), Math.min(...ys)];
    const local = (q: Vec2): Vec2 => [mv(q)[0] - at[0], mv(q)[1] - at[1]];
    const W = Math.max(...xs) - at[0];
    const H = Math.max(...ys) - at[1];
    // Curved stretches come back as corners with handles.
    const rootCurves = (root.curves ?? []).map((c) => c.map(local) as Bez);
    const rootShape = collapse(root.poly.map(local), rootCurves, true);
    const rootPoly = rootShape.corners;
    const isRect = !rootShape.curved && rootPoly.length === 4 && near(rootPoly[0], [0, 0]) && near(rootPoly[1], [W, 0]) && near(rootPoly[2], [W, H]) && near(rootPoly[3], [0, H]);
    const rootHoles = (root.holes ?? []).map((h) => h.map(local));
    const rootHoleCurves = holeCurvesOf(rootCurves, rootHoles);
    const base: BasePanel = {
      width: W, height: H,
      ...(isRect ? {} : { points: rootPoly, ...(rootShape.curved ? { handles: rootShape.handles } : {}) }),
      holes: rootHoles,
      ...(rootHoleCurves.length ? { holeCurves: rootHoleCurves } : {}),
    };
    if (i === 0) design.base = base;
    else {
      const piece: ExtraPiece = {
        id: rootId, name: pieceName(info.role, i), base, at, rotation: info.rotation,
        role: info.role === 'base' ? 'lid' : info.role,
      };
      (design.pieces ??= []).push(piece);
    }
    const outline = (isRect ? ([[0, 0], [W, 0], [W, H], [0, H]] as Vec2[]) : rootPoly).map(([x, y]) => [x + at[0], y + at[1]] as Vec2);
    outlines.set(root.id, outline);
    frames.set(root.id, (q) => [q[0] - at[0], q[1] - at[1]]);
    idMap.set(root.id, rootId);

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
  }

  // Inserts (glued inside the main piece) keep their place, in their own panels' frames.
  for (const [i, info] of dl.pieces.entries()) {
    const piece = design.pieces?.find((x) => x.id === `piece-${i + 1}`);
    const anchor = info.place && idMap.get(info.place.anchor);
    if (!piece || !info.place || !anchor) continue;
    const fromFrame = frames.get(info.root)!;
    const toFrame = frames.get(info.place.anchor)!;
    piece.place = { anchor, from: fromFrame(mv(info.place.from)), to: toFrame(mv(info.place.to)), z: info.place.z };
  }

  // Carry the printable faces over, keeping their names and which way is up.
  const faceIds = new Map<string, string>();
  for (const f of dl.faces) {
    const centre: Vec2 = [f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2];
    const owner = dl.panels.find((p) => p.id === f.id) ?? dl.panels.find((p) => p.kind !== 'glue' && inPoly(centre, p.poly));
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
    const base = id === BASE_ID ? design.base : design.pieces?.find((x) => x.id === id)?.base;
    if (base) base.face = spec;
    else design.panels.find((p) => p.id === id)!.face = spec;
    faceIds.set(f.id, id);
  }
  // Only walls carry other panels in Advanced designs.
  for (const p of design.panels) if (p.kind !== 'wall' && design.panels.some((c) => c.parent === p.id)) p.kind = 'wall';
  return { design, skipped, faceIds };
}

function pieceName(role: string, i: number): string {
  return role === 'lid' ? 'Lid' : role === 'sleeve' ? 'Sleeve' : role === 'insert' ? 'Insert' : `Piece ${i + 1}`;
}

/**
 * Collapses the points along an outline's curves back into corners with curve handles.
 * `loop`: the outline may start part way along a curve (restart it first).
 */
function collapse(ring: Vec2[], curves: Bez[], loop: boolean): { corners: Vec2[]; handles: (Handle | null)[]; curved: boolean } {
  if (!curves.length) return { corners: ring, handles: ring.map(() => null), curved: false };
  const info = curves.map((bez) => {
    const pts = sampleBez(bez);
    return { bez, first: pts[0], last: pts.length > 1 ? pts[pts.length - 2] : bez[0], inner: pts.slice(0, -1) };
  });
  let closed = [...ring, ring[0]];
  if (loop) closed = restartLoop(closed, info);
  const corners: Vec2[] = [closed[0]];
  const handles: (Handle | null)[] = [null];
  let curved = false;
  for (const step of stepsOf(closed, info)) {
    const prev = corners.length - 1;
    const last = corners[prev];
    if (step.c) {
      curved = true;
      handles[prev] = { ...(handles[prev] ?? {}), out: [step.c[0][0] - last[0], step.c[0][1] - last[1]] };
    }
    const back = near(step.p, corners[0]);
    const idx = back ? 0 : corners.length;
    if (!back) {
      corners.push(step.p);
      handles.push(null);
    }
    if (step.c) handles[idx] = { ...(handles[idx] ?? {}), in: [step.c[1][0] - step.p[0], step.c[1][1] - step.p[1]] };
  }
  return { corners, handles, curved };
}

/** The curves that belong to the cut-outs (they start on a hole's outline). */
function holeCurvesOf(curves: Bez[], holes: Vec2[][]): Bez[] {
  return curves.filter((c) => holes.some((h) => h.some((q) => near(q, c[0], 1e-3) || near(q, c[3], 1e-3))));
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
  const curves = (p.curves ?? []).map((c) => c.map((q) => toLocal(mv(q))) as Bez);
  // Curved stretches come back as corners with handles (the outline starts at the hinge,
  // which is never part way along a curve).
  const collapsed = collapse([...poly.slice(i), ...poly.slice(0, i)].map(toLocal), curves, false);
  const local = collapsed.corners;
  const ordered = local.map(([u, v]) => [origin[0] + U[0] * u + V[0] * v, origin[1] + U[1] * u + V[1] * v] as Vec2);
  const rest = local.slice(2);
  if (!rest.length) return null;

  // Recognise rectangles and trapezoids (far edge parallel to the hinge).
  let shape: ChildShape = { type: 'custom', points: rest, ...(collapsed.curved ? { handles: collapsed.handles.slice(2) } : {}) };
  if (!collapsed.curved && rest.length === 2 && Math.abs(rest[0][1] - rest[1][1]) < EPS && rest[0][1] > 0) {
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
    ...(p.timeline ? { timeline: p.timeline.map(([t, v]) => [t, v] as Vec2) } : {}),
    ...(p.open ? { open: p.open } : {}),
    holes: (p.holes ?? []).map((h) => h.map((q) => toLocal(mv(q)))),
  };
  const hc = holeCurvesOf(curves, panel.holes);
  if (hc.length) panel.holeCurves = hc;
  // The Advanced model rebuilds the outline from the frame; keep the same order.
  return { panel, outline: ordered, toLocal };
}
