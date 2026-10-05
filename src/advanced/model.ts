import { sanitizeDecals, sanitizeTexture } from '../decals';
import { Matrix4, Vector3 } from 'three';
import { foldedBounds, localMatrices } from '../geometry/fold';
import { sampleBez } from '../geometry/shapes';
import { finish } from '../geometry/styles';
import { pointInPoly } from '../geometry/surface';
import type { Bez, Decal, Dieline, Face, Panel, PanelKind, PieceInfo, Texture, Vec2 } from '../types';

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
  /** A painted texture over the whole sheet (see Texture). */
  texture?: Texture;
  /** Further pieces cut from the same sheet: a lid, a sleeve, an insert… */
  pieces?: ExtraPiece[];
}

/** How an extra piece goes together with the main one. */
export type PieceRole = 'lid' | 'sleeve' | 'insert';

/**
 * A separate piece with its own base panel (other panels hang off it as usual). Its base
 * has its own (u, v) frame whose origin sits at `at` on the sheet.
 */
export interface ExtraPiece {
  /** The id of this piece's base panel. */
  id: string;
  name?: string;
  base: BasePanel;
  at: Vec2;
  /** How its base sits once assembled (Euler degrees). */
  rotation: [number, number, number];
  role: PieceRole;
  /**
   * Insert only: glued against panel `anchor` (of the main piece), with point `from` (in
   * this base's frame) landing on point `to` (in the anchor's frame), `z` mm out from it.
   */
  place?: { anchor: string; from: Vec2; to: Vec2; z: number };
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

/**
 * A curve handle on a corner of a free-form outline: offsets (in the panel's frame) from the
 * corner to the control points of the curve leaving it (`out`) and arriving at it (`in`).
 * Without a handle on either end an edge is straight.
 */
export interface Handle {
  in?: Vec2;
  out?: Vec2;
}

export interface BasePanel {
  width: number;
  height: number;
  /** Custom outline in sheet coordinates; replaces width × height when set. */
  points?: Vec2[];
  /** Curve handles for `points` (same order). */
  handles?: (Handle | null)[];
  /** Curved parts of the cut-outs (e.g. a rounded slot), in the same frame as `holes`. */
  holeCurves?: Bez[];
  holes: Vec2[][];
  face?: FaceSpec;
}

export type CustomKind = 'wall' | 'flap' | 'glue';

export type ChildShape =
  | { type: 'rect'; depth: number; taper0: number; taper1: number }
  /** Outline after the hinge, from the hinge's end back round to its start, in (u, v). */
  | { type: 'custom'; points: Vec2[]; handles?: (Handle | null)[] };

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
  /** Fold path over the whole animation (see Panel.timeline); dropped when the angle is edited. */
  timeline?: [number, number][];
  /** Hinged lid: extra angle when opened in the preview (see Panel.open). */
  open?: number;
  /** Cut-outs, in the panel's (u, v) frame. */
  holes: Vec2[][];
  /** Curved parts of the cut-outs, in the same frame. */
  holeCurves?: Bez[];
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
  /** The base panel of the piece this panel belongs to. */
  root: string;
  /** The outline with its curves drawn out as points (`poly` is just the corners). */
  shape: Vec2[];
  /** Its curves (outline and cut-outs), on the sheet. */
  curves: Bez[];
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

/** Whether `id` is a base panel: the main one or an extra piece's. */
export function isRoot(d: AdvancedDesign, id: string): boolean {
  return id === BASE_ID || !!d.pieces?.some((p) => p.id === id);
}

/** The base panel with id `id` (main or extra piece). */
export function rootBase(d: AdvancedDesign, id: string): BasePanel | undefined {
  return id === BASE_ID ? d.base : d.pieces?.find((p) => p.id === id)?.base;
}

/** Bases in order: the main one, then the extra pieces. */
function roots(d: AdvancedDesign): { id: string; base: BasePanel; at: Vec2 }[] {
  return [{ id: BASE_ID, base: d.base, at: [0, 0] }, ...(d.pieces ?? []).map((p) => ({ id: p.id, base: p.base, at: p.at }))];
}

export function basePoly(b: BasePanel): Vec2[] {
  return b.points ?? [[0, 0], [b.width, 0], [b.width, b.height], [0, b.height]];
}

/** Curve handles of an outline's corners, by corner (null where there's none). */
export function cornerHandles(d: AdvancedDesign, id: string, corners: number): (Handle | null)[] {
  const root = rootBase(d, id);
  const p = root ? null : d.panels.find((x) => x.id === id);
  const list = root ? (root.points ? root.handles : undefined) : p?.shape.type === 'custom' ? p.shape.handles : undefined;
  const offset = root ? 0 : 2; // a panel's first two corners are its hinge
  return Array.from({ length: corners }, (_, k) => (k >= offset ? list?.[k - offset] ?? null : null));
}

/**
 * Draws out a closed outline with curves: the points along it (corners included) and the
 * curves themselves. Edge k is curved if corner k has an `out` handle or corner k + 1 an
 * `in` one.
 */
export function curvedOutline(corners: Vec2[], handles: (Handle | null)[]): { pts: Vec2[]; bez: Bez[] } {
  const pts: Vec2[] = [];
  const bez: Bez[] = [];
  const n = corners.length;
  for (let k = 0; k < n; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % n];
    pts.push(a);
    const out = handles[k]?.out;
    const inn = handles[(k + 1) % n]?.in;
    if (!out && !inn) continue;
    const c: Bez = [a, out ? add(a, out) : a, inn ? add(b, inn) : b, b];
    bez.push(c);
    pts.push(...sampleBez(c).slice(0, -1));
  }
  return { pts, bez };
}

/** Whether edge k of a panel's outline is curved. */
export function edgeCurved(handles: (Handle | null)[], k: number): boolean {
  return !!(handles[k]?.out || handles[(k + 1) % handles.length]?.in);
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
  for (const r of roots(d)) {
    const mv = ([x, y]: Vec2): Vec2 => [x + r.at[0], y + r.at[1]];
    out.set(r.id, {
      id: r.id, poly: basePoly(r.base).map(mv), holes: r.base.holes.map((h) => h.map(mv)), origin: r.at, U: [1, 0], V: [0, 1], hinge: 0, depth: 0, root: r.id,
      shape: [], curves: [],
    });
    withShape(d, out.get(r.id)!, r.base.holeCurves);
  }
  const children = new Map<string, CustomPanel[]>();
  for (const p of d.panels) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  const queue = roots(d).map((r) => r.id);
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
        id: p.id, poly: [], holes: [], origin: add(a, mul(U, p.inset0)), U, V, hinge, depth: parent.depth + 1, panel: p, root: parent.root,
        shape: [], curves: [],
      };
      placed.poly = localPoly(p, hinge).map((q) => toSheet(placed, q));
      placed.holes = p.holes.map((h) => h.map((q) => toSheet(placed, q)));
      withShape(d, placed, p.holeCurves);
      out.set(p.id, placed);
      queue.push(p.id);
    }
  }
  return out;
}

/** Fills in a placed panel's drawn-out outline and its curves (on the sheet). */
function withShape(d: AdvancedDesign, pl: Placed, holeCurves?: Bez[]) {
  // Handles are offsets, so they turn with the panel's frame but don't move with it.
  const turn = ([u, v]: Vec2): Vec2 => add(mul(pl.U, u), mul(pl.V, v));
  const handles = cornerHandles(d, pl.id, pl.poly.length).map((h) => (h ? { ...(h.in ? { in: turn(h.in) } : {}), ...(h.out ? { out: turn(h.out) } : {}) } : null));
  const { pts, bez } = curvedOutline(pl.poly, handles);
  pl.shape = pts;
  pl.curves = [...bez, ...(holeCurves ?? []).map((c) => c.map((q) => toSheet(pl, q)) as Bez)];
}

const KIND: Record<CustomKind, PanelKind> = { wall: 'face', flap: 'flap', glue: 'glue' };

/** Panels in layout coordinates (base at the origin), before the sheet is normalised. */
export function rawPanels(d: AdvancedDesign): Panel[] {
  const panels: Panel[] = [];
  const pieceOf = new Map(roots(d).map((r, i) => [r.id, i]));
  for (const pl of layout(d).values()) {
    const p = pl.panel;
    panels.push({
      id: pl.id,
      piece: pieceOf.get(pl.root) ?? 0,
      kind: p ? KIND[p.kind] : 'face',
      poly: pl.shape.map((q) => [q[0], q[1]] as Vec2),
      ...(pl.holes.length ? { holes: pl.holes.map((h) => h.map((q) => [q[0], q[1]] as Vec2)) } : {}),
      ...(pl.curves.length ? { curves: pl.curves.map((c) => c.map((q) => [q[0], q[1]] as Vec2) as Bez) } : {}),
      ...(p
        ? {
            parent: p.parent,
            hinge: [pl.origin, toSheet(pl, [pl.hinge, 0])] as [Vec2, Vec2],
            angle: p.angle,
            stage: Math.max(1, Math.round(p.order)),
            offset: p.layer,
            ...(p.motion ? { motion: p.motion } : {}),
            ...(p.timeline ? { timeline: p.timeline } : {}),
            ...(p.open ? { open: p.open } : {}),
          }
        : {}),
    });
  }
  return panels;
}

/** Converts a design into a dieline the 3D preview and exporters understand. */
export function toDieline(d: AdvancedDesign): Dieline {
  const panels = rawPanels(d);
  applyLayers(panels, d.thickness);
  const placed = layout(d);
  const extra: PieceInfo[] = (d.pieces ?? []).map((pc, i) => {
    const anchor = pc.place && placed.get(pc.place.anchor);
    return {
      index: i + 1, root: pc.id, rotation: pc.rotation, role: pc.role,
      ...(pc.place && anchor
        ? { place: { anchor: pc.place.anchor, from: toSheet(placed.get(pc.id)!, pc.place.from), to: toSheet(anchor, pc.place.to), z: pc.place.z, arrive: [0.4, 0.7] as [number, number] } }
        : {}),
    };
  });
  const dl = finish({
    panels,
    faces: designFaces(d),
    // The base lies on the ground, walls fold up.
    pieces: [{ index: 0, root: BASE_ID, rotation: d.rotation ?? [90, 0, 0], role: 'base' }, ...extra],
    width: 0,
    height: 0,
    outer: [0, 0, 0],
  });
  const box = foldedBounds(dl, 1, { thickness: d.thickness });
  dl.outer = [box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y];
  return dl;
}

/**
 * A panel's layer only matters where it ends up lying against another panel once folded
 * (a glue tab inside a wall, flaps stacked under a lid). Elsewhere a layer would just
 * shift it off the edge it is hinged to, so it is ignored.
 */
function applyLayers(panels: Panel[], thickness: number) {
  const mats = localMatrices({ panels } as Dieline, 1);
  const tol = Math.max(thickness * 1.5, 0.5);
  // (Only within a piece: each piece's frames are relative to its own base.)
  const frames = new Map(panels.map((p) => [p.id, { m: mats.get(p.id)!, inv: mats.get(p.id)!.clone().invert() }]));
  for (const A of panels) {
    if (!A.offset) continue;
    // Sample points well inside A, so touching along an edge doesn't count.
    const c: Vec2 = [A.poly.reduce((n, q) => n + q[0], 0) / A.poly.length, A.poly.reduce((n, q) => n + q[1], 0) / A.poly.length];
    const samples: Vec2[] = [c, ...A.poly.map((q) => [c[0] + (q[0] - c[0]) * 0.7, c[1] + (q[1] - c[1]) * 0.7] as Vec2)];
    const fa = frames.get(A.id)!;
    const overlapsSomething = panels.some((B) => {
      if (B === A || B.piece !== A.piece) return false;
      const fb = frames.get(B.id)!;
      return samples.some((s) => {
        const w = new Vector3(s[0], -s[1], 0).applyMatrix4(fa.m).applyMatrix4(fb.inv);
        return Math.abs(w.z) < tol && pointInPoly([w.x, -w.y], B.poly);
      });
    });
    if (!overlapsSomething) A.offset = 0;
  }
}

/** Printable faces: axis-aligned rectangles on the sheet (decals need those). */
function designFaces(d: AdvancedDesign): Face[] {
  const faces: Face[] = [];
  let walls = 0;
  for (const pl of layout(d).values()) {
    const p = pl.panel;
    const spec = p ? p.face : rootBase(d, pl.id)?.face;
    if (p && !spec && p.kind !== 'wall') continue;
    if (p) walls++;
    let corners: Vec2[];
    if (spec?.rect) {
      const [u0, v0, u1, v1] = spec.rect;
      corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map((q) => toSheet(pl, q as Vec2));
    } else {
      if (pl.poly.length !== 4 || pl.shape.length !== 4) continue;
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
      label: spec?.label ?? (p ? `${p.kind === 'wall' ? 'Wall' : 'Panel'} ${walls}` : pl.id === BASE_ID ? 'Base' : (d.pieces?.find((x) => x.id === pl.id)?.name ?? 'Piece base')),
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
      if (polysOverlap(list[i].shape, list[j].shape)) out.push([list[i].id, list[j].id]);
  return out;
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

export function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

/**
 * Walls (and the base) are structural: other panels can hang off them. Flaps and glue tabs
 * are end pieces and carry nothing.
 */
export function canCarry(d: AdvancedDesign, id: string): boolean {
  if (isRoot(d, id)) return true;
  return d.panels.find((p) => p.id === id)?.kind === 'wall';
}

/**
 * The free stretches of edge `edge` of panel `id`, as [start, end] distances along the
 * edge: the parts no attached panel's hinge covers. A wall's own hinge (edge 0) is never
 * free. Several panels can share an edge, side by side.
 */
export function freeSpans(d: AdvancedDesign, id: string, edge: number, placed = layout(d)): [number, number][] {
  const pl = placed.get(id);
  if (!pl || (!isRoot(d, id) && edge === 0) || edge < 0 || edge >= pl.poly.length) return [];
  // Nothing can hang off a curved edge.
  if (edgeCurved(cornerHandles(d, id, pl.poly.length), edge)) return [];
  const [a, b] = edgeOf(pl.poly, edge);
  const L = len(sub(b, a));
  const taken = d.panels
    .filter((p) => p.parent === id && p.edge === edge)
    .map((p) => [p.inset0, L - p.inset1] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [u0, u1] of taken) {
    if (u0 - at >= 1) out.push([at, u0]);
    at = Math.max(at, u1);
  }
  if (L - at >= 1) out.push([at, L]);
  return out;
}

/** A sensible new panel on edge `edge` of `parentId` (or on the stretch `span` of it). */
export function makeChild(d: AdvancedDesign, parentId: string, edge: number, span?: [number, number]): CustomPanel | null {
  const parent = layout(d).get(parentId);
  if (!parent || !canCarry(d, parentId)) return null;
  const [a, b] = edgeOf(parent.poly, edge);
  const fullLen = len(sub(b, a));
  const [u0, u1] = span ?? [0, fullLen];
  const edgeLen = u1 - u0;
  const onBase = isRoot(d, parentId);
  // Walls off the base; smaller tapered flaps off everything else.
  const depth = onBase ? Math.round(Math.min(edgeLen, 100) * 0.8) : Math.round(Math.min(20, edgeLen * 0.4));
  const taper = onBase ? 0 : Math.min(depth, edgeLen / 4);
  return {
    id: uid(),
    parent: parentId,
    edge,
    kind: onBase ? 'wall' : 'flap',
    inset0: u0,
    inset1: fullLen - u1,
    shape: { type: 'rect', depth, taper0: taper, taper1: taper },
    angle: 90,
    order: parent.depth + 1,
    layer: 0,
    holes: [],
  };
}

/** A new separate piece (a square base) to the right of everything, sitting on top as a lid. */
export function addPiece(d: AdvancedDesign): ExtraPiece {
  const xs = [...layout(d).values()].flatMap((pl) => pl.poly.map((q) => q[0]));
  const ys = [...layout(d).values()].flatMap((pl) => pl.poly.map((q) => q[1]));
  const n = (d.pieces?.length ?? 0) + 2;
  const piece: ExtraPiece = {
    id: `piece-${uid()}`, name: `Piece ${n}`, base: { width: 100, height: 100, holes: [] },
    at: [Math.max(...xs) + 30, Math.min(...ys)], rotation: [-90, 0, 0], role: 'lid',
  };
  (d.pieces ??= []).push(piece);
  return piece;
}

/** Removes an extra piece and everything on it. */
export function removePiece(d: AdvancedDesign, id: string) {
  removePanel(d, id);
  d.pieces = (d.pieces ?? []).filter((p) => p.id !== id);
  if (!d.pieces.length) delete d.pieces;
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

/** A panel and everything attached to it, parents first. */
export function subtree(d: AdvancedDesign, id: string): CustomPanel[] {
  const out = d.panels.filter((p) => p.id === id);
  for (let i = 0; i < out.length; i++) out.push(...d.panels.filter((p) => p.parent === out[i].id));
  return out;
}

/**
 * Mirrors a panel and everything on it left to right, in place: each panel's outline is
 * flipped along its hinge, and the panels on it move to the matching mirrored edges.
 * `panels` must be a whole subtree (see `subtree`); `hinges` gives each one's hinge length.
 */
function mirrorPanels(panels: CustomPanel[], hinges: Map<string, number>) {
  const ids = new Set(panels.map((p) => p.id));
  for (const p of panels) {
    const H = hinges.get(p.id) ?? 0;
    const m = ([u, v]: Vec2): Vec2 => [H - u, v];
    const N = p.shape.type === 'rect' ? 4 : p.shape.points.length + 2;
    if (p.shape.type === 'rect') [p.shape.taper0, p.shape.taper1] = [p.shape.taper1, p.shape.taper0];
    else {
      p.shape.points = p.shape.points.map(m).reverse();
      // Handles mirror too, and swap ends as the outline now runs the other way.
      const flip = (v?: Vec2): Vec2 | undefined => (v ? [-v[0], v[1]] : undefined);
      if (p.shape.handles) p.shape.handles = p.shape.handles.map((h) => (h ? { ...(h.out ? { in: flip(h.out) } : {}), ...(h.in ? { out: flip(h.in) } : {}) } : null)).reverse();
    }
    p.holes = p.holes.map((h) => h.map(m));
    if (p.holeCurves) p.holeCurves = p.holeCurves.map((c) => c.map(m) as Bez);
    if (p.face?.rect) {
      const [u0, v0, u1, v1] = p.face.rect;
      p.face.rect = [H - u1, v0, H - u0, v1];
    }
    if (p.face?.rotation) p.face.rotation = (360 - p.face.rotation) % 360;
    // Vertex j of the mirrored outline is vertex (1 - j) of the original, so edge k becomes
    // edge (N - k) mod N and runs the other way.
    for (const c of panels) {
      if (c.parent !== p.id || !ids.has(c.id)) continue;
      c.edge = (N - c.edge) % N;
      [c.inset0, c.inset1] = [c.inset1, c.inset0];
    }
  }
}

/** Flips a panel (and what's on it) left to right where it is. */
export function flipPanel(d: AdvancedDesign, id: string) {
  const placed = layout(d);
  const list = subtree(d, id);
  mirrorPanels(list, new Map(list.map((p) => [p.id, placed.get(p.id)?.hinge ?? 0])));
}

/**
 * Copies a panel and everything on it onto edge `edge` of `parent`, starting `inset0` mm
 * along it (the copy keeps its hinge length). Returns the copy's id.
 */
export function copySubtree(d: AdvancedDesign, id: string, parent: string, edge: number, inset0: number, mirrored = false): string | null {
  const placed = layout(d);
  const src = placed.get(id);
  const target = placed.get(parent);
  if (!src || !target || !canCarry(d, parent)) return null;
  const [a, b] = edgeOf(target.poly, edge);
  const L = len(sub(b, a));
  const list = clone(subtree(d, id));
  const hinges = new Map(list.map((p) => [p.id, placed.get(p.id)?.hinge ?? 0]));
  if (mirrored) mirrorPanels(list, hinges);
  const ids = new Map(list.map((p) => [p.id, uid()]));
  for (const p of list) {
    hinges.set(ids.get(p.id)!, hinges.get(p.id)!);
    p.id = ids.get(p.id)!;
    if (ids.has(p.parent)) p.parent = ids.get(p.parent)!;
  }
  const root = list[0];
  root.parent = parent;
  root.edge = edge;
  root.inset0 = inset0;
  root.inset1 = Math.max(0, L - inset0 - src.hinge);
  d.panels.push(...list);
  return root.id;
}

/**
 * A mirrored copy at the other end of the same edge (e.g. a second leg). Null when that
 * spot is taken or is where the panel already is.
 */
export function mirrorCopy(d: AdvancedDesign, id: string): string | null {
  const p = d.panels.find((x) => x.id === id);
  const pl = layout(d).get(id);
  if (!p || !pl) return null;
  const start = p.inset1;
  if (Math.abs(start - p.inset0) < 0.5) return null;
  const free = freeSpans(d, p.parent, p.edge);
  if (!free.some(([s0, s1]) => s0 <= start + 0.01 && s1 >= start + pl.hinge - 0.01)) return null;
  return copySubtree(d, id, p.parent, p.edge, start, true);
}

/** The editable outline of a panel in its own frame (base: sheet), for vertex editing. */
export function editablePoints(d: AdvancedDesign, id: string): Vec2[] | null {
  const root = rootBase(d, id);
  if (root) return basePoly(root);
  const p = d.panels.find((x) => x.id === id);
  const pl = layout(d).get(id);
  if (!p || !pl) return null;
  return localPoly(p, pl.hinge);
}

/** Switches a panel to a free-form outline so its corners can be dragged. */
export function makeCustom(d: AdvancedDesign, id: string) {
  const root = rootBase(d, id);
  if (root) {
    root.points = basePoly(root).map((q) => [q[0], q[1]] as Vec2);
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
  const root = rootBase(d, id);
  if (root) {
    root.points!.splice(k + 1, 0, at);
    root.handles?.splice(k + 1, 0, null);
  } else {
    const p = d.panels.find((x) => x.id === id)!;
    if (p.shape.type !== 'custom' || k < 1) return;
    // Outline = [hinge start, hinge end, ...points]; vertex k+1 is points[k - 1].
    p.shape.points.splice(k - 1, 0, at);
    p.shape.handles?.splice(k - 1, 0, null);
  }
  for (const c of d.panels) if (c.parent === id && c.edge > k) c.edge += 1;
}

/** Removes corner `k` (never the base's last three or a hinge end). */
export function deleteVertex(d: AdvancedDesign, id: string, k: number) {
  makeCustom(d, id);
  const root = rootBase(d, id);
  if (root) {
    if (root.points!.length <= 3) return;
    root.points!.splice(k, 1);
    root.handles?.splice(k, 1);
  } else {
    const p = d.panels.find((x) => x.id === id)!;
    if (p.shape.type !== 'custom' || k < 2 || p.shape.points.length <= 1) return;
    p.shape.points.splice(k - 2, 1);
    p.shape.handles?.splice(k - 2, 1);
  }
  // Edges k-1 and k merge into k-1.
  for (const c of d.panels) {
    if (c.parent !== id) continue;
    if (c.edge === k) c.edge = k - 1;
    else if (c.edge > k) c.edge -= 1;
  }
  d.panels = d.panels.filter((c) => c.parent !== id || c.edge >= 0);
}

/** The handle list of a panel's free-form outline and the index of corner `k` in it. */
function handleSlot(d: AdvancedDesign, id: string, k: number): { list: (Handle | null)[]; i: number } | null {
  makeCustom(d, id);
  const root = rootBase(d, id);
  if (root) {
    const n = root.points!.length;
    root.handles = Array.from({ length: n }, (_, j) => root.handles?.[j] ?? null);
    return { list: root.handles, i: k };
  }
  const p = d.panels.find((x) => x.id === id);
  if (!p || p.shape.type !== 'custom' || k < 2) return null; // the hinge stays straight
  const n = p.shape.points.length;
  p.shape.handles = Array.from({ length: n }, (_, j) => (p.shape.type === 'custom' ? p.shape.handles?.[j] ?? null : null));
  return { list: p.shape.handles, i: k - 2 };
}

/** Sets one side (`in` or `out`) of corner k's curve handle (in the panel's frame), or clears it. */
export function setHandle(d: AdvancedDesign, id: string, k: number, side: 'in' | 'out', v: Vec2 | null) {
  const slot = handleSlot(d, id, k);
  if (!slot) return;
  const h = { ...(slot.list[slot.i] ?? {}) };
  if (v) h[side] = v;
  else delete h[side];
  slot.list[slot.i] = h.in || h.out ? h : null;
}

/**
 * Rounds corner k into a smooth curve (handles along the line between its neighbours), or
 * makes a rounded corner sharp again. Returns whether it is now curved.
 */
export function toggleCurve(d: AdvancedDesign, id: string, k: number): boolean {
  const pts = editablePoints(d, id);
  const slot = handleSlot(d, id, k);
  if (!pts || !slot) return false;
  // A fully rounded corner goes back to sharp; a sharp corner, or one where a curve meets
  // a straight edge, becomes smooth.
  const cur = slot.list[slot.i];
  if (cur?.in && cur?.out) {
    slot.list[slot.i] = null;
    return false;
  }
  const prev = pts[(k - 1 + pts.length) % pts.length];
  const next = pts[(k + 1) % pts.length];
  const dir = sub(next, prev);
  const l = len(dir) || 1;
  const reach = Math.min(len(sub(pts[k], prev)), len(sub(next, pts[k]))) * 0.4;
  const t = mul(dir, reach / l);
  slot.list[slot.i] = { in: mul(t, -1), out: t };
  return true;
}

/** Moves corner `k` of a panel's outline to `to` (in the panel's own frame). */
export function moveVertex(d: AdvancedDesign, id: string, k: number, to: Vec2) {
  makeCustom(d, id);
  const root = rootBase(d, id);
  if (root) {
    root.points![k] = to;
    return;
  }
  const p = d.panels.find((x) => x.id === id)!;
  if (p.shape.type !== 'custom' || k < 2) return; // hinge corners are fixed by the parent
  p.shape.points[k - 2] = to;
}

/**
 * Makes edge `k` of a panel `length` mm long, the way you'd expect from typing a size:
 * the base's width or height, a wall's hinge (by moving its end along the parent edge),
 * its depth (side edges) or how much it narrows (far edge); on free-form outlines the
 * edge's end corner slides along the edge. Returns false if that edge can't be set.
 */
export function setEdgeLength(d: AdvancedDesign, id: string, k: number, length: number): boolean {
  const pl = layout(d).get(id);
  if (!pl || !(length > 0.5)) return false;
  const N = pl.poly.length;
  const root = rootBase(d, id);
  if (root && !root.points) {
    if (k % 2 === 0) root.width = length;
    else root.height = length;
    return true;
  }
  const p = d.panels.find((x) => x.id === id);
  if (p && k === 0) {
    // The hinge: keep its start, move its end (as far as the parent edge allows).
    const parent = layout(d).get(p.parent);
    if (!parent) return false;
    const [a, b] = edgeOf(parent.poly, p.edge);
    p.inset1 = Math.max(0, len(sub(b, a)) - p.inset0 - length);
    return true;
  }
  if (p?.shape.type === 'rect') {
    const s = p.shape;
    if (k === 2) {
      const t = (pl.hinge - length) / 2;
      s.taper0 = s.taper1 = t;
    } else {
      const t = k === 1 ? s.taper1 : s.taper0;
      if (length <= Math.abs(t)) return false;
      s.depth = Math.sqrt(length * length - t * t);
    }
    return true;
  }
  // Free-form: slide one end of the edge along it (never a hinge corner).
  const pts = editablePoints(d, id)!;
  const i = k, j = (k + 1) % N;
  const fixed = root ? [] : [0, 1];
  const [keep, move] = !fixed.includes(j) ? [i, j] : !fixed.includes(i) ? [j, i] : [-1, -1];
  if (move < 0) return false;
  const dir = sub(pts[move], pts[keep]);
  const l = len(dir);
  if (l < 1e-6) return false;
  moveVertex(d, id, move, add(pts[keep], mul(dir, length / l)));
  return true;
}

/**
 * Tab-and-slot joints: wherever an edge of the panel ends up resting against another
 * panel once folded (standing on it at an angle, like a divider on a base), tabs are added
 * along that edge and matching slots are cut where they land, so the joint holds without
 * glue. Returns how many tabs were added (0: no edge meets another panel).
 */
export function addTabJoints(d: AdvancedDesign, id: string): number {
  const placed = layout(d);
  const F = placed.get(id);
  if (!F) return 0;
  const t = d.thickness;
  const panels = rawPanels(d).map((p) => ({ ...p, offset: 0 }));
  const mats = localMatrices({ panels } as Dieline, 1);
  const fm = mats.get(id)!;
  const tol = Math.max(1.5 * t, 1);
  const used = new Set(d.panels.filter((p) => p.parent === id).map((p) => p.edge));
  const plans: { k: number; tabs: [number, number][]; W: Placed; winv: Matrix4 }[] = [];

  for (let k = 0; k < F.poly.length; k++) {
    if ((!isRoot(d, id) && k === 0) || used.has(k)) continue;
    const [A, B] = edgeOf(F.poly, k);
    const L = len(sub(B, A));
    if (L < 8) continue;
    const e = mul(sub(B, A), 1 / L);
    const inward = mul(outwardNormal(F.poly, k), -1);
    let best: { run: [number, number]; W: Placed; winv: Matrix4 } | null = null;
    for (const W of placed.values()) {
      if (W.id === id) continue;
      const winv = mats.get(W.id)!.clone().invert();
      const toW = (q: Vec2) => {
        const v = new Vector3(q[0], -q[1], 0).applyMatrix4(fm).applyMatrix4(winv);
        return { p: [v.x, -v.y] as Vec2, z: v.z };
      };
      // The panel has to stand on W at an angle, not lie flat against it.
      const mid = add(A, mul(sub(B, A), 0.5));
      if (Math.abs(toW(add(mid, mul(inward, Math.min(8, L / 2)))).z) < 3) continue;
      // The longest stretch of the edge lying on W, clear of W's own edges and holes.
      const N = 48;
      let run: [number, number] | null = null;
      let from = -1;
      for (let i = 0; i <= N + 1; i++) {
        let on = false;
        if (i <= N) {
          const q = toW(add(A, mul(e, (L * i) / N)));
          on = Math.abs(q.z) <= tol && pointInPoly(q.p, W.poly) && distToPoly(q.p, W.poly) > t + 1 && !W.holes.some((h) => pointInPoly(q.p, h));
        }
        if (on && from < 0) from = i;
        if (!on && from >= 0) {
          const r: [number, number] = [(L * from) / N, (L * (i - 1)) / N];
          if (!run || r[1] - r[0] > run[1] - run[0]) run = r;
          from = -1;
        }
      }
      if (run && run[1] - run[0] >= 8 && (!best || run[1] - run[0] > best.run[1] - best.run[0])) best = { run, W, winv };
    }
    if (!best) continue;
    // One tab, or two on long edges, kept clear of the ends.
    const margin = Math.min(3, (best.run[1] - best.run[0]) / 6);
    const r0 = best.run[0] + margin;
    const R = best.run[1] - margin - r0;
    const n = R >= 70 ? 2 : 1;
    const w = Math.min(30, Math.max(4, R * (n === 1 ? 0.4 : 0.22)));
    const centres = n === 1 ? [r0 + R / 2] : [r0 + R * 0.25, r0 + R * 0.75];
    plans.push({ k, tabs: centres.map((c) => [c - w / 2, c + w / 2]), W: best.W, winv: best.winv });
  }

  // Slots first (they need the edges where they are now), then the tabs, last edge first
  // so inserting corners doesn't shift the edges still to do.
  const c = 0.2; // clearance around the tab
  const tabLen = Math.max(2 * t, 2);
  for (const plan of plans) {
    const [A, B] = edgeOf(F.poly, plan.k);
    const e = mul(sub(B, A), 1 / len(sub(B, A)));
    const toW = (q: Vec2): Vec2 => {
      const v = new Vector3(q[0], -q[1], 0).applyMatrix4(fm).applyMatrix4(plan.winv);
      return [v.x, -v.y];
    };
    // Which way the board's thickness runs across the slot (panels extrude inwards, -z).
    const dir = new Vector3(0, 0, -1).transformDirection(fm).transformDirection(plan.winv);
    const across: Vec2 = [dir.x, -dir.y];
    const al = len(across);
    for (const [s0, s1] of plan.tabs) {
      const R0 = toW(add(A, mul(e, s0)));
      const R1 = toW(add(A, mul(e, s1)));
      const ew = mul(sub(R1, R0), 1 / (len(sub(R1, R0)) || 1));
      const [q, lo, hi]: [Vec2, number, number] = al > 0.3 ? [mul(across, 1 / al), -c, t + c] : [[-ew[1], ew[0]], -(t / 2 + c), t / 2 + c];
      const a = sub(R0, mul(ew, c));
      const b = add(R1, mul(ew, c));
      const slot = [add(a, mul(q, lo)), add(b, mul(q, lo)), add(b, mul(q, hi)), add(a, mul(q, hi))];
      const W = plan.W;
      const local = slot.map((p) => toLocal(W, p));
      (rootBase(d, W.id) ?? d.panels.find((p) => p.id === W.id)!).holes.push(local);
    }
  }
  let added = 0;
  for (const plan of [...plans].sort((x, y) => y.k - x.k)) {
    const pts = editablePoints(d, id)!;
    const [A, B] = edgeOf(pts, plan.k);
    const e = mul(sub(B, A), 1 / len(sub(B, A)));
    const out = outwardNormal(pts, plan.k);
    plan.tabs.forEach(([s0, s1], i) => {
      const base = plan.k + 4 * i;
      const p0 = add(A, mul(e, s0));
      const p1 = add(A, mul(e, s1));
      const corners = [p0, add(p0, mul(out, tabLen)), add(p1, mul(out, tabLen)), p1];
      corners.forEach((q, j) => insertVertex(d, id, base + j, q));
      added++;
    });
  }
  return added;
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
  const handles = (v: unknown, n: number): (Handle | null)[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = Array.from({ length: n }, (_, i) => {
      const h = v[i] as Record<string, unknown> | null | undefined;
      if (!h || typeof h !== 'object') return null;
      const hin = pt(h.in);
      const hout = pt(h.out);
      return hin || hout ? { ...(hin ? { in: hin } : {}), ...(hout ? { out: hout } : {}) } : null;
    });
    return out.some(Boolean) ? out : undefined;
  };
  const curves = (v: unknown): Bez[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.slice(0, 200).map((c) => (Array.isArray(c) && c.length === 4 ? c.map(pt) : null)).filter((c): c is Bez => !!c && c.every(Boolean));
    return out.length ? out : undefined;
  };
  const faceSpec = (v: unknown): FaceSpec | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const f = v as Record<string, unknown>;
    const out: FaceSpec = {};
    if (typeof f.label === 'string') out.label = f.label.slice(0, 40);
    if (typeof f.rotation === 'number') out.rotation = Math.round(num(f.rotation, -360, 360, 0) / 90) * 90;
    if (Array.isArray(f.rect) && f.rect.length === 4) out.rect = f.rect.map((x) => num(x, -5000, 5000, 0)) as FaceSpec['rect'];
    return out;
  };
  const baseOf = (v: unknown): BasePanel => {
    const b = (v ?? {}) as Record<string, unknown>;
    const basePts = pts(b.points);
    const bh = basePts.length >= 3 ? handles(b.handles, basePts.length) : undefined;
    const hc = curves(b.holeCurves);
    return {
      width: num(b.width, 1, 3000, 100),
      height: num(b.height, 1, 3000, 100),
      ...(basePts.length >= 3 ? { points: basePts } : {}),
      ...(bh ? { handles: bh } : {}),
      ...(hc ? { holeCurves: hc } : {}),
      holes: holes(b.holes),
      ...(faceSpec(b.face) ? { face: faceSpec(b.face) } : {}),
    };
  };
  const keys = (v: unknown) =>
    Array.isArray(v) ? v.slice(0, 200).map((k) => pt(k)).filter((k): k is Vec2 => !!k).map(([a, b]) => [Math.min(1, Math.max(0, a)), Math.min(360, Math.max(-360, b))] as Vec2) : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const design: AdvancedDesign = {
    version: 1,
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Box',
    thickness: num(r.thickness, 0.2, 10, 1.5),
    color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#c9a46b',
    base: baseOf(r.base),
    panels: [],
  };
  if (Array.isArray(r.decals)) design.decals = sanitizeDecals(r.decals);
  if (Array.isArray(r.pieces)) {
    const roles: PieceRole[] = ['lid', 'sleeve', 'insert'];
    design.pieces = r.pieces.slice(0, 8).flatMap((v): ExtraPiece[] => {
      if (!v || typeof v !== 'object') return [];
      const o = v as Record<string, unknown>;
      if (typeof o.id !== 'string' || !o.id || o.id === BASE_ID) return [];
      const rot = Array.isArray(o.rotation) && o.rotation.length === 3 ? (o.rotation.map((x) => num(x, -360, 360, 0)) as [number, number, number]) : ([-90, 0, 0] as [number, number, number]);
      const pl = o.place as Record<string, unknown> | undefined;
      return [{
        id: o.id.slice(0, 40),
        ...(typeof o.name === 'string' ? { name: o.name.slice(0, 40) } : {}),
        base: baseOf(o.base),
        at: pt(o.at) ?? [0, 0],
        rotation: rot,
        role: roles.includes(o.role as PieceRole) ? (o.role as PieceRole) : 'lid',
        ...(pl && typeof pl.anchor === 'string' && pt(pl.from) && pt(pl.to)
          ? { place: { anchor: pl.anchor.slice(0, 40), from: pt(pl.from)!, to: pt(pl.to)!, z: num(pl.z, -50, 50, 0) } }
          : {}),
      }];
    });
    if (!design.pieces.length) delete design.pieces;
  }
  const texture = sanitizeTexture(r.texture);
  if (texture) design.texture = texture;
  if (Array.isArray(r.rotation) && r.rotation.length === 3) {
    design.rotation = r.rotation.map((v) => num(v, -360, 360, 0)) as [number, number, number];
  }
  const list = Array.isArray(r.panels) ? r.panels.slice(0, 500) : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const s = (p.shape ?? {}) as Record<string, unknown>;
    const cpts = pts(s.points);
    const ch = handles(s.handles, cpts.length);
    const shape: ChildShape =
      s.type === 'custom'
        ? { type: 'custom', points: cpts, ...(ch ? { handles: ch } : {}) }
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
      ...(keys(p.motion) ? { motion: keys(p.motion) } : {}),
      ...(keys(p.timeline) ? { timeline: keys(p.timeline) } : {}),
      ...(typeof p.open === 'number' ? { open: num(p.open, -180, 180, 0) } : {}),
      holes: holes(p.holes),
      ...(curves(p.holeCurves) ? { holeCurves: curves(p.holeCurves) } : {}),
    });
  }
  // Only walls carry other panels (older files may have panels hanging off flaps).
  for (const p of design.panels) if (p.kind !== 'wall' && design.panels.some((c) => c.parent === p.id)) p.kind = 'wall';
  return design;
}
