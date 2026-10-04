import { sanitizeDecals } from '../decals';
import { foldedBounds } from '../geometry/fold';
import { finish } from '../geometry/styles';
import { pointInPoly } from '../geometry/surface';
import type { Decal, Dieline, Face, Panel, PanelKind, Vec2 } from '../types';

/**
 * A box drawn from scratch in the Advanced tab.
 *
 * It starts from one base panel. Every other panel hangs off an edge of its parent and is
 * described in the parent edge's local frame: u runs along the edge, v points away from the
 * parent. So resizing or reshaping a parent carries its children along with it.
 */
export interface AdvancedDesign {
  version: 1;
  name: string;
  thickness: number;
  color: string;
  base: BasePanel;
  panels: CustomPanel[];
  /** How the base panel sits once assembled (Euler degrees). Default: lying on the ground. */
  rotation?: [number, number, number];
  decals?: Decal[];
}

/**
 * Makes a panel printable (decals can go on it). Walls get one automatically. `rect` is
 * the printable area in the panel's (u, v) frame (default: the whole panel, which must then
 * be a rectangle), `rotation` which way is up (default: away from the parent).
 */
export interface FaceSpec {
  label?: string;
  rotation?: number;
  rect?: [number, number, number, number];
}

export interface BasePanel {
  width: number;
  height: number;
  /** Custom outline in sheet coordinates; replaces width × height when set. */
  points?: Vec2[];
  holes: Vec2[][];
  face?: FaceSpec;
}

export type CustomKind = 'wall' | 'flap' | 'glue';

export type ChildShape =
  | { type: 'rect'; depth: number; taper0: number; taper1: number }
  /** Outline after the hinge, from the hinge's end back round to its start, in (u, v). */
  | { type: 'custom'; points: Vec2[] };

export interface CustomPanel {
  id: string;
  parent: string;
  /** Edge index on the parent's outline (edge k runs from vertex k to vertex k+1). */
  edge: number;
  kind: CustomKind;
  /** Hinge placement: distance from the start and end of the parent edge, in mm. */
  inset0: number;
  inset1: number;
  shape: ChildShape;
  /** Fold angle in degrees; positive folds inwards. */
  angle: number;
  /** Fold order: lower numbers fold first. */
  order: number;
  /** Layering when panels overlap, in board thicknesses (+ = outside). */
  layer: number;
  face?: FaceSpec;
  /** Optional custom fold path (see Panel.motion); dropped when the angle is edited. */
  motion?: [number, number][];
  /** Cut-outs, in the panel's (u, v) frame. */
  holes: Vec2[][];
}

export const BASE_ID = 'base';

export function newDesign(): AdvancedDesign {
  return {
    version: 1,
    name: 'My box',
    thickness: 1.5,
    color: '#c9a46b',
    base: { width: 100, height: 100, holes: [] },
    panels: [],
  };
}

/** A panel's placement on the sheet: its outline and its local frame. */
export interface Placed {
  id: string;
  poly: Vec2[];
  holes: Vec2[][];
  /** Local frame: sheet = origin + u·U + v·V. */
  origin: Vec2;
  U: Vec2;
  V: Vec2;
  /** Hinge length (0 for the base). */
  hinge: number;
  depth: number;
  panel?: CustomPanel;
}

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);

export function toSheet(p: Placed, [u, v]: Vec2): Vec2 {
  return add(p.origin, add(mul(p.U, u), mul(p.V, v)));
}

export function toLocal(p: Placed, s: Vec2): Vec2 {
  const d = sub(s, p.origin);
  return [dot(d, p.U), dot(d, p.V)];
}

export function basePoly(b: BasePanel): Vec2[] {
  return b.points ?? [[0, 0], [b.width, 0], [b.width, b.height], [0, b.height]];
}

/** The child's outline in its own (u, v) frame, hinge first. */
export function localPoly(p: CustomPanel, hinge: number): Vec2[] {
  if (p.shape.type === 'rect') {
    const { depth, taper0, taper1 } = p.shape;
    return [[0, 0], [hinge, 0], [hinge - taper1, depth], [taper0, depth]];
  }
  return [[0, 0], [hinge, 0], ...p.shape.points];
}

export function edgeOf(poly: Vec2[], k: number): [Vec2, Vec2] {
  return [poly[k], poly[(k + 1) % poly.length]];
}

/** Unit normal of edge k pointing away from the polygon's interior. */
export function outwardNormal(poly: Vec2[], k: number): Vec2 {
  const [a, b] = edgeOf(poly, k);
  const l = len(sub(b, a)) || 1;
  const U: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  const n: Vec2 = [-U[1], U[0]];
  const mid = mul(add(a, b), 0.5);
  const probe = add(mid, mul(n, Math.max(0.05, l * 1e-3)));
  return pointInPoly(probe, poly) ? [-n[0], -n[1]] : n;
}

/**
 * Lays out every panel on the sheet (parents before children). Panels whose parent is
 * missing, whose edge no longer exists or whose hinge has no length are skipped.
 */
export function layout(d: AdvancedDesign): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const bp = basePoly(d.base);
  out.set(BASE_ID, {
    id: BASE_ID, poly: bp, holes: d.base.holes, origin: [0, 0], U: [1, 0], V: [0, 1], hinge: 0, depth: 0,
  });
  const children = new Map<string, CustomPanel[]>();
  for (const p of d.panels) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  const queue = [BASE_ID];
  while (queue.length) {
    const parentId = queue.shift()!;
    const parent = out.get(parentId)!;
    for (const p of children.get(parentId) ?? []) {
      if (p.edge < 0 || p.edge >= parent.poly.length) continue;
      const [a, b] = edgeOf(parent.poly, p.edge);
      const edgeLen = len(sub(b, a));
      const hinge = edgeLen - p.inset0 - p.inset1;
      if (hinge < 0.5) continue;
      const U = mul(sub(b, a), 1 / edgeLen);
      const V = outwardNormal(parent.poly, p.edge);
      const placed: Placed = {
        id: p.id, poly: [], holes: [], origin: add(a, mul(U, p.inset0)), U, V, hinge, depth: parent.depth + 1, panel: p,
      };
      placed.poly = localPoly(p, hinge).map((q) => toSheet(placed, q));
      placed.holes = p.holes.map((h) => h.map((q) => toSheet(placed, q)));
      out.set(p.id, placed);
      queue.push(p.id);
    }
  }
  return out;
}

const KIND: Record<CustomKind, PanelKind> = { wall: 'face', flap: 'flap', glue: 'glue' };

/** Panels in layout coordinates (base at the origin), before the sheet is normalised. */
export function rawPanels(d: AdvancedDesign): Panel[] {
  const panels: Panel[] = [];
  for (const pl of layout(d).values()) {
    const p = pl.panel;
    panels.push({
      id: pl.id,
      piece: 0,
      kind: p ? KIND[p.kind] : 'face',
      poly: pl.poly.map((q) => [q[0], q[1]] as Vec2),
      ...(pl.holes.length ? { holes: pl.holes.map((h) => h.map((q) => [q[0], q[1]] as Vec2)) } : {}),
      ...(p
        ? {
            parent: p.parent,
            hinge: [pl.origin, toSheet(pl, [pl.hinge, 0])] as [Vec2, Vec2],
            angle: p.angle,
            stage: Math.max(1, Math.round(p.order)),
            offset: p.layer,
            ...(p.motion ? { motion: p.motion } : {}),
          }
        : {}),
    });
  }
  return panels;
}

/** Converts a design into a dieline the 3D preview and exporters understand. */
export function toDieline(d: AdvancedDesign): Dieline {
  const panels = rawPanels(d);
  const dl = finish({
    panels,
    faces: designFaces(d),
    // The base lies on the ground, walls fold up.
    pieces: [{ index: 0, root: BASE_ID, rotation: d.rotation ?? [90, 0, 0], role: 'base' }],
    width: 0,
    height: 0,
    outer: [0, 0, 0],
  });
  const box = foldedBounds(dl, 1, { thickness: d.thickness });
  dl.outer = [box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y];
  return dl;
}

/** Printable faces: axis-aligned rectangles on the sheet (decals need those). */
function designFaces(d: AdvancedDesign): Face[] {
  const faces: Face[] = [];
  let walls = 0;
  for (const pl of layout(d).values()) {
    const p = pl.panel;
    const spec = p ? p.face : d.base.face;
    if (p && !spec && p.kind !== 'wall') continue;
    if (p) walls++;
    let corners: Vec2[];
    if (spec?.rect) {
      const [u0, v0, u1, v1] = spec.rect;
      corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map((q) => toSheet(pl, q as Vec2));
    } else {
      if (pl.poly.length !== 4) continue;
      corners = pl.poly;
    }
    const xs = corners.map((q) => q[0]);
    const ys = corners.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    // Every corner must sit on the bounding box's corners, i.e. an axis-aligned rectangle.
    const onCorner = (q: Vec2) =>
      (Math.abs(q[0] - x) < 0.01 || Math.abs(q[0] - x - w) < 0.01) && (Math.abs(q[1] - y) < 0.01 || Math.abs(q[1] - y - h) < 0.01);
    if (w < 1 || h < 1 || !corners.every(onCorner)) continue;
    const auto = p ? Math.round((Math.atan2(pl.V[0], -pl.V[1]) * 180) / Math.PI / 90) * 90 : 0;
    faces.push({
      id: pl.id,
      label: spec?.label ?? (p ? `${p.kind === 'wall' ? 'Wall' : 'Panel'} ${walls}` : 'Base'),
      rect: { x, y, w, h },
      rotation: spec?.rotation ?? auto,
    });
  }
  return faces;
}

// ---------------------------------------------------------------------------
// Overlap check
// ---------------------------------------------------------------------------

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return false;
  const q = sub(c, a);
  const t = (q[0] * s[1] - q[1] * s[0]) / den;
  const u = (q[0] * r[1] - q[1] * r[0]) / den;
  const e = 1e-4;
  return t > e && t < 1 - e && u > e && u < 1 - e;
}

function distToPoly(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = edgeOf(poly, i);
    const ab = sub(b, a);
    const k = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
    best = Math.min(best, len(sub(p, add(a, mul(ab, k)))));
  }
  return best;
}

function polysOverlap(A: Vec2[], B: Vec2[]): boolean {
  for (let i = 0; i < A.length; i++) {
    const [a, b] = edgeOf(A, i);
    for (let j = 0; j < B.length; j++) {
      const [c, d] = edgeOf(B, j);
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  const inside = (P: Vec2[], Q: Vec2[]) => P.some((p) => pointInPoly(p, Q) && distToPoly(p, Q) > 0.05);
  return inside(A, B) || inside(B, A);
}

/** Pairs of panels that overlap on the sheet (so they couldn't be cut from one piece). */
export function overlaps(d: AdvancedDesign): [string, string][] {
  const list = [...layout(d).values()];
  const out: [string, string][] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (polysOverlap(list[i].poly, list[j].poly)) out.push([list[i].id, list[j].id]);
  return out;
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

export function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

/** Edges of a panel that already have something attached (the hinge counts too). */
export function usedEdges(d: AdvancedDesign, id: string): Set<number> {
  const used = new Set<number>(d.panels.filter((p) => p.parent === id).map((p) => p.edge));
  if (id !== BASE_ID) used.add(0);
  return used;
}

/** A sensible new panel on edge `edge` of `parentId`. */
export function makeChild(d: AdvancedDesign, parentId: string, edge: number): CustomPanel | null {
  const parent = layout(d).get(parentId);
  if (!parent) return null;
  const [a, b] = edgeOf(parent.poly, edge);
  const edgeLen = len(sub(b, a));
  const onBase = parentId === BASE_ID;
  // Walls off the base; smaller tapered flaps off everything else.
  const depth = onBase ? Math.round(Math.min(edgeLen, 100) * 0.8) : Math.round(Math.min(20, edgeLen * 0.4));
  const taper = onBase ? 0 : Math.min(depth, edgeLen / 4);
  return {
    id: uid(),
    parent: parentId,
    edge,
    kind: onBase ? 'wall' : 'flap',
    inset0: 0,
    inset1: 0,
    shape: { type: 'rect', depth, taper0: taper, taper1: taper },
    angle: 90,
    order: parent.depth + 1,
    layer: onBase ? 0 : -1,
    holes: [],
  };
}

/** Removes a panel and everything attached to it. */
export function removePanel(d: AdvancedDesign, id: string) {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of d.panels) if (doomed.has(p.parent) && !doomed.has(p.id)) (doomed.add(p.id), (grew = true));
  }
  d.panels = d.panels.filter((p) => !doomed.has(p.id));
}

/** The editable outline of a panel in its own frame (base: sheet), for vertex editing. */
export function editablePoints(d: AdvancedDesign, id: string): Vec2[] | null {
  if (id === BASE_ID) return basePoly(d.base);
  const p = d.panels.find((x) => x.id === id);
  const pl = layout(d).get(id);
  if (!p || !pl) return null;
  return localPoly(p, pl.hinge);
}

/** Switches a panel to a free-form outline so its corners can be dragged. */
export function makeCustom(d: AdvancedDesign, id: string) {
  if (id === BASE_ID) {
    d.base.points = basePoly(d.base).map((q) => [q[0], q[1]] as Vec2);
    return;
  }
  const p = d.panels.find((x) => x.id === id);
  const pl = layout(d).get(id);
  if (!p || !pl || p.shape.type === 'custom') return;
  p.shape = { type: 'custom', points: localPoly(p, pl.hinge).slice(2) };
}

/**
 * Inserts a corner after vertex `k` of a panel's outline (base: any edge; other panels:
 * not on the hinge) and keeps children attached to the right edges.
 */
export function insertVertex(d: AdvancedDesign, id: string, k: number, at: Vec2) {
  makeCustom(d, id);
  if (id === BASE_ID) {
    d.base.points!.splice(k + 1, 0, at);
  } else {
    const p = d.panels.find((x) => x.id === id)!;
    if (p.shape.type !== 'custom' || k < 1) return;
    // Outline = [hinge start, hinge end, ...points]; vertex k+1 is points[k - 1].
    p.shape.points.splice(k - 1, 0, at);
  }
  for (const c of d.panels) if (c.parent === id && c.edge > k) c.edge += 1;
}

/** Removes corner `k` (never the base's last three or a hinge end). */
export function deleteVertex(d: AdvancedDesign, id: string, k: number) {
  makeCustom(d, id);
  if (id === BASE_ID) {
    if (d.base.points!.length <= 3) return;
    d.base.points!.splice(k, 1);
  } else {
    const p = d.panels.find((x) => x.id === id)!;
    if (p.shape.type !== 'custom' || k < 2 || p.shape.points.length <= 1) return;
    p.shape.points.splice(k - 2, 1);
  }
  // Edges k-1 and k merge into k-1.
  for (const c of d.panels) {
    if (c.parent !== id) continue;
    if (c.edge === k) c.edge = k - 1;
    else if (c.edge > k) c.edge -= 1;
  }
  d.panels = d.panels.filter((c) => c.parent !== id || c.edge >= 0);
}

/** Moves corner `k` of a panel's outline to `to` (in the panel's own frame). */
export function moveVertex(d: AdvancedDesign, id: string, k: number, to: Vec2) {
  makeCustom(d, id);
  if (id === BASE_ID) {
    d.base.points![k] = to;
    return;
  }
  const p = d.panels.find((x) => x.id === id)!;
  if (p.shape.type !== 'custom' || k < 2) return; // hinge corners are fixed by the parent
  p.shape.points[k - 2] = to;
}

/** Deep copy (designs are plain JSON). */
export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** Validates and cleans up a design loaded from a file or the Box Universe. */
export function sanitizeDesign(raw: unknown): AdvancedDesign | null {
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  const pt = (v: unknown): Vec2 | null =>
    Array.isArray(v) && v.length === 2 ? [num(v[0], -5000, 5000, 0), num(v[1], -5000, 5000, 0)] : null;
  const pts = (v: unknown, max = 500): Vec2[] =>
    Array.isArray(v) ? (v.slice(0, max).map(pt).filter(Boolean) as Vec2[]) : [];
  const holes = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50).map((h) => pts(h)).filter((h) => h.length >= 3) : []);
  const faceSpec = (v: unknown): FaceSpec | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const f = v as Record<string, unknown>;
    const out: FaceSpec = {};
    if (typeof f.label === 'string') out.label = f.label.slice(0, 40);
    if (typeof f.rotation === 'number') out.rotation = Math.round(num(f.rotation, -360, 360, 0) / 90) * 90;
    if (Array.isArray(f.rect) && f.rect.length === 4) out.rect = f.rect.map((x) => num(x, -5000, 5000, 0)) as FaceSpec['rect'];
    return out;
  };
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const b = (r.base ?? {}) as Record<string, unknown>;
  const basePts = pts(b.points);
  const design: AdvancedDesign = {
    version: 1,
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Box',
    thickness: num(r.thickness, 0.2, 10, 1.5),
    color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#c9a46b',
    base: {
      width: num(b.width, 1, 3000, 100),
      height: num(b.height, 1, 3000, 100),
      ...(basePts.length >= 3 ? { points: basePts } : {}),
      holes: holes(b.holes),
      ...(faceSpec(b.face) ? { face: faceSpec(b.face) } : {}),
    },
    panels: [],
  };
  if (Array.isArray(r.decals)) design.decals = sanitizeDecals(r.decals);
  if (Array.isArray(r.rotation) && r.rotation.length === 3) {
    design.rotation = r.rotation.map((v) => num(v, -360, 360, 0)) as [number, number, number];
  }
  const list = Array.isArray(r.panels) ? r.panels.slice(0, 500) : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const s = (p.shape ?? {}) as Record<string, unknown>;
    const shape: ChildShape =
      s.type === 'custom'
        ? { type: 'custom', points: pts(s.points) }
        : { type: 'rect', depth: num(s.depth, 0.5, 3000, 20), taper0: num(s.taper0, -3000, 3000, 0), taper1: num(s.taper1, -3000, 3000, 0) };
    if (shape.type === 'custom' && shape.points.length < 1) continue;
    design.panels.push({
      id: typeof p.id === 'string' ? p.id.slice(0, 40) : uid(),
      parent: typeof p.parent === 'string' ? p.parent.slice(0, 40) : BASE_ID,
      edge: Math.round(num(p.edge, 0, 1000, 0)),
      kind: p.kind === 'flap' || p.kind === 'glue' ? p.kind : 'wall',
      inset0: num(p.inset0, 0, 3000, 0),
      inset1: num(p.inset1, 0, 3000, 0),
      shape,
      angle: num(p.angle, -180, 180, 90),
      order: Math.round(num(p.order, 1, 50, 1)),
      layer: Math.round(num(p.layer, -5, 5, 0)),
      ...(faceSpec(p.face) ? { face: faceSpec(p.face) } : {}),
      ...(Array.isArray(p.motion)
        ? { motion: p.motion.slice(0, 200).map((k) => pt(k)).filter((k): k is Vec2 => !!k).map(([a, b]) => [Math.min(1, Math.max(0, a)), Math.min(360, Math.max(-360, b))] as Vec2) }
        : {}),
      holes: holes(p.holes),
    });
  }
  return design;
}
