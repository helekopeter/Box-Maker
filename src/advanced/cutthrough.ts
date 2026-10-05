import { difference, intersection, union, type MultiPolygon, type Pair, type Ring } from 'polygon-clipping';
import { Vector3 } from 'three';
import { localMatrices } from '../geometry/fold';
import type { Dieline, Vec2 } from '../types';
import { basePoly, layout, localPoly, rawPanels, rootBase, toLocal, type AdvancedDesign } from './model';

export interface CutThroughResult {
  /** How many openings were cut (holes inside the panel plus notches in its edge). */
  openings: number;
  /** Why nothing was cut, if nothing was. */
  problem?: string;
}

const CLEARANCE = 0.2; // mm around whatever passes through

const area = (r: Pair[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
};
const mpArea = (mp: MultiPolygon) => mp.reduce((s, poly) => s + poly.reduce((t, ring, i) => t + (i ? -1 : 1) * Math.abs(area(ring)), 0), 0);
const close = (r: Vec2[]): Ring => [...r.map((p) => [p[0], p[1]] as Pair), [r[0][0], r[0][1]]];
const open = (r: Pair[]): Vec2[] => {
  const pts = r.map((p) => [p[0], p[1]] as Vec2);
  const [a, b] = [pts[0], pts[pts.length - 1]];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 ? pts.slice(0, -1) : pts;
};

/** Convex hull (monotone chain). */
function hull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Keeps the part of a 3D polygon with lo ≤ z ≤ hi (Sutherland–Hodgman on two planes). */
function clipSlab(poly: Vector3[], lo: number, hi: number): Vector3[] {
  const clip = (pts: Vector3[], inside: (v: Vector3) => boolean, z: number) => {
    const out: Vector3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(a.clone().lerp(b, (z - a.z) / (b.z - a.z)));
    }
    return out;
  };
  return clip(clip(poly, (v) => v.z >= lo, lo), (v) => v.z <= hi, hi);
}

/**
 * Cuts openings in a panel wherever other panels pass through it once folded (the legs of
 * a table through a shelf, a divider through a lid…), exactly their size plus a little
 * clearance. Openings inside the panel become holes; ones at its edge become notches.
 * Panels attached to it, and ones lying flat against it, don't count.
 */
export function cutThrough(d: AdvancedDesign, id: string): CutThroughResult {
  const placed = layout(d);
  const W = placed.get(id);
  if (!W) return { openings: 0, problem: 'Panel not found.' };
  const t = d.thickness;
  const panels = rawPanels(d).map((p) => ({ ...p, offset: 0 }));
  const mats = localMatrices({ panels } as Dieline, 1);
  const winv = mats.get(id)!.clone().invert();
  const self = d.panels.find((p) => p.id === id);
  const skip = new Set([id, ...(self ? [self.parent] : []), ...d.panels.filter((p) => p.parent === id).map((p) => p.id)]);

  // Each other panel's footprint in this panel's board (sheet coordinates).
  const shapes: MultiPolygon = [];
  for (const A of panels) {
    if (skip.has(A.id)) continue;
    const m = mats.get(A.id)!.clone().premultiply(winv);
    const normal = new Vector3(0, 0, 1).transformDirection(m);
    if (Math.abs(normal.z) > 0.5) continue; // lies flat against it: not passing through
    const pts: Vec2[] = [];
    let [zmin, zmax] = [Infinity, -Infinity];
    for (const z of [0, -t]) {
      const poly = A.poly.map(([x, y]) => new Vector3(x, -y, z).applyMatrix4(m));
      for (const v of poly) [zmin, zmax] = [Math.min(zmin, v.z), Math.max(zmax, v.z)];
      for (const v of clipSlab(poly, -t - 0.05, 0.05)) pts.push([v.x, -v.y]);
    }
    // It has to come out on both sides; one that just ends against the board doesn't count.
    if (zmin > -t - 0.3 || zmax < 0.3) continue;
    if (pts.length < 3) continue;
    // Grown by the clearance (a square around each point keeps it convex and simple).
    const grown = pts.flatMap(([x, y]): Vec2[] => [[x - CLEARANCE, y - CLEARANCE], [x + CLEARANCE, y - CLEARANCE], [x + CLEARANCE, y + CLEARANCE], [x - CLEARANCE, y + CLEARANCE]]);
    shapes.push([close(hull(grown))]);
  }
  if (!shapes.length) return { openings: 0, problem: 'Nothing passes through this panel when folded.' };

  const outline = close(W.poly);
  const before: MultiPolygon = [[outline, ...W.holes.map(close)]];
  // Joined footprints. Three or more walls together (a leg, a tube) open up their whole
  // cross-section; one or two (a divider, a cross) keep their own shape.
  const regions: MultiPolygon = union(shapes[0], ...shapes.slice(1))
    .map((poly) => {
      const ring = open(poly[0]);
      const parts = shapes.filter((sh) => mpArea(intersection([poly[0]], sh)) > 1e-6).length;
      return [close(parts >= 3 ? hull(ring) : ring)] as Ring[];
    })
    // Only what really overlaps the panel (not a neighbour merely touching its edge).
    .filter((poly) => mpArea(intersection([outline], poly)) > 2 * t);
  if (!regions.length) return { openings: 0, problem: 'Nothing passes through this panel when folded.' };

  const after = difference(before, ...regions.map((p) => [p] as MultiPolygon));
  if (after.length !== 1) return { openings: 0, problem: 'The openings would cut this panel into separate pieces.' };
  const [ring, ...holeRings] = after[0];
  let newOutline = open(ring);
  const newHoles = holeRings.map(open);
  // Keep the outline running the same way round as before.
  if (Math.sign(area(close(newOutline))) !== Math.sign(area(outline))) newOutline = newOutline.reverse();

  const changed = newOutline.length !== W.poly.length || newOutline.some((p) => !W.poly.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6));
  const openings = regions.length;

  const root = rootBase(d, id);
  if (root) {
    // A base: its frame is the sheet, moved to where the piece sits.
    const outlineLocal = newOutline.map((q) => toLocal(W, q));
    if (changed && !remapChildren(d, id, basePoly(root), outlineLocal)) return { openings: 0, problem: 'An opening would cut through an edge that has panels attached.' };
    if (changed) root.points = outlineLocal;
    root.holes = newHoles.map((h) => h.map((q) => toLocal(W, q)));
    return { openings };
  }

  const p = self!;
  const local = newOutline.map((q) => toLocal(W, q));
  let shift = 0;
  if (changed) {
    // The fold this panel hangs from must stay one edge, along v = 0 and running the same
    // way. Notches at its ends just make it shorter.
    const onFold = local
      .map((q, k) => [k, q, local[(k + 1) % local.length]] as const)
      .filter(([, a, b]) => Math.abs(a[1]) < 1e-4 && Math.abs(b[1]) < 1e-4 && b[0] - a[0] > 1e-4 && a[0] > -1e-4 && b[0] < W.hinge + 1e-4);
    if (onFold.length !== 1) return { openings: 0, problem: 'An opening would cut into the middle of the fold this panel hangs from.' };
    const [i, a, b] = onFold[0];
    shift = a[0];
    const rotated = [...local.slice(i), ...local.slice(0, i)].map(([u, v]) => [u - shift, v] as Vec2);
    const oldLocal = localPoly(p, W.hinge).map(([u, v]) => [u - shift, v] as Vec2);
    if (!remapChildren(d, id, oldLocal, rotated)) return { openings: 0, problem: 'An opening would cut through an edge that has panels attached.' };
    p.inset0 += a[0];
    p.inset1 += W.hinge - b[0];
    p.shape = { type: 'custom', points: rotated.slice(2) };
  }
  p.holes = newHoles.map((h) => h.map((q) => {
    const [u, v] = toLocal(W, q);
    return [u - shift, v] as Vec2;
  }));
  return { openings };
}

/**
 * After a panel's outline changes, points each attached panel at the new edge its hinge
 * lies on. False if a hinge no longer lies along a single edge.
 */
function remapChildren(d: AdvancedDesign, id: string, oldPoly: Vec2[], newPoly: Vec2[]): boolean {
  const updates: [string, number, number, number][] = [];
  for (const c of d.panels.filter((x) => x.parent === id)) {
    const a = oldPoly[c.edge];
    const b = oldPoly[(c.edge + 1) % oldPoly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const p0: Vec2 = [a[0] + u[0] * c.inset0, a[1] + u[1] * c.inset0];
    const p1: Vec2 = [b[0] - u[0] * c.inset1, b[1] - u[1] * c.inset1];
    let found = -1;
    for (let k = 0; k < newPoly.length && found < 0; k++) {
      const s = newPoly[k];
      const e = newPoly[(k + 1) % newPoly.length];
      const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
      if (len < 1e-6) continue;
      const v: Vec2 = [(e[0] - s[0]) / len, (e[1] - s[1]) / len];
      if (v[0] * u[0] + v[1] * u[1] < 0.9999) continue;
      const along = (q: Vec2) => (q[0] - s[0]) * v[0] + (q[1] - s[1]) * v[1];
      const off = (q: Vec2) => Math.abs((q[0] - s[0]) * v[1] - (q[1] - s[1]) * v[0]);
      if (off(p0) > 1e-4 || off(p1) > 1e-4) continue;
      if (along(p0) < -1e-4 || along(p1) > len + 1e-4) continue;
      found = k;
      updates.push([c.id, k, Math.max(0, along(p0)), Math.max(0, len - along(p1))]);
    }
    if (found < 0) return false;
  }
  for (const [cid, edge, i0, i1] of updates) {
    const c = d.panels.find((x) => x.id === cid)!;
    c.edge = edge;
    c.inset0 = i0;
    c.inset1 = i1;
  }
  return true;
}
