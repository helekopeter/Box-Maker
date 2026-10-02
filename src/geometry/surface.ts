import { Matrix4, Vector3 } from 'three';
import type { Dieline, Face, Vec2 } from '../types';
import { localMatrices } from './fold';

/**
 * 2D affine transform in canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f.
 * Used to map between the sheet coordinates of different faces.
 */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function apply(m: Affine, [x, y]: Vec2): Vec2 {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the rotation part (for direction vectors). */
export function applyLinear(m: Affine, [x, y]: Vec2): Vec2 {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

/** m ∘ n: applies n first, then m. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

/** Clockwise rotation in degrees (sheet y points down). */
export function rotate(deg: number): Affine {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

/** Rotation angle (deg) of an affine transform. */
export function angleOf(m: Affine): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

/** Proper rigid transform taking a1 → b1 and a2 → b2 (the pairs are equally far apart). */
function rigid(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Affine {
  const ang = Math.atan2(b2[1] - b1[1], b2[0] - b1[0]) - Math.atan2(a2[1] - a1[1], a2[0] - a1[0]);
  const c = Math.cos(ang), s = Math.sin(ang);
  return [c, s, -s, c, b1[0] - (c * a1[0] - s * a1[1]), b1[1] - (s * a1[0] + c * a1[1])];
}

export function pointInPoly([x, y]: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inRect([x, y]: Vec2, r: Face['rect'], tol = 1e-6): boolean {
  return x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol;
}

interface FaceNode {
  face: Face;
  panel: string;
  piece: number;
  /** World-space edges of the face rectangle on the assembled box. */
  edges: [Vector3, Vector3][];
  centre: Vector3;
  /** Outward (printed side) normal on the assembled box. */
  normal: Vector3;
  inv: Matrix4;
  neighbours: { id: string; map: Affine }[];
}

const graphs = new WeakMap<Dieline, Map<string, FaceNode>>();

const toSheet = (v: Vector3): Vec2 => [v.x, -v.y];

/**
 * Works out which faces touch on the assembled box, and for each pair the 2D transform
 * that "unfolds" one face next to the other across their shared edge. Faces that are
 * neighbours on the flat sheet get the identity; faces that only meet once folded (across
 * a glue seam, a lid edge, two flaps meeting in the middle…) get a real transform, which is
 * what lets a decal wrap around a corner and be split on the sheet.
 */
export function faceGraph(d: Dieline): Map<string, FaceNode> {
  const cached = graphs.get(d);
  if (cached) return cached;
  const mats = localMatrices(d, 1);
  const nodes = new Map<string, FaceNode>();
  for (const face of d.faces) {
    const c: Vec2 = [face.rect.x + face.rect.w / 2, face.rect.y + face.rect.h / 2];
    const panel = d.panels.find((p) => p.kind !== 'glue' && pointInPoly(c, p.poly));
    if (!panel) continue;
    const m = mats.get(panel.id)!;
    const { x, y, w, h } = face.rect;
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) =>
      new Vector3(px, -py, 0).applyMatrix4(m),
    );
    nodes.set(face.id, {
      face,
      panel: panel.id,
      piece: panel.piece,
      edges: corners.map((p, i) => [p, corners[(i + 1) % 4]] as [Vector3, Vector3]),
      centre: corners.reduce((acc, p) => acc.add(p), new Vector3()).divideScalar(4),
      normal: new Vector3(0, 0, 1).transformDirection(m),
      inv: m.clone().invert(),
      neighbours: [],
    });
  }

  const list = [...nodes.values()];
  for (const A of list) {
    for (const edge of A.edges) {
      const candidates: { B: FaceNode; shared: [Vector3, Vector3] }[] = [];
      for (const B of list) {
        if (A === B || A.piece !== B.piece) continue;
        const shared = sharedEdge(edge, B);
        if (shared) candidates.push({ B, shared });
      }
      const next = continuation(A, edge, candidates);
      if (!next) continue;
      const [w1, w2] = next.shared;
      const a1 = toSheet(w1.clone().applyMatrix4(A.inv));
      const a2 = toSheet(w2.clone().applyMatrix4(A.inv));
      const b1 = toSheet(w1.clone().applyMatrix4(next.B.inv));
      const b2 = toSheet(w2.clone().applyMatrix4(next.B.inv));
      A.neighbours.push({ id: next.B.face.id, map: rigid(a1, a2, b1, b2) });
    }
  }
  graphs.set(d, nodes);
  return nodes;
}

/**
 * Several faces can meet along one edge (e.g. two roof panels and a double-layer handle
 * at a gable's ridge). The printed surface continues onto the first face reached by
 * sweeping around the edge through the outside, provided that face's printed side looks
 * back at the sweep. Anything else would mean passing through the cardboard.
 */
function continuation<T extends { B: FaceNode }>(A: FaceNode, [p0, p1]: [Vector3, Vector3], candidates: T[]): T | null {
  if (!candidates.length) return null;
  const e = p1.clone().sub(p0).normalize();
  const inward = (c: Vector3) => {
    const v = c.clone().sub(p0);
    return v.addScaledVector(e, -v.dot(e)).normalize();
  };
  const u = inward(A.centre);
  const v = A.normal.clone().addScaledVector(e, -A.normal.dot(e)).normalize();
  const scored = candidates.map((c) => {
    const dB = inward(c.B.centre);
    const x = dB.dot(u);
    const y = dB.dot(v);
    let phi = Math.atan2(y, x);
    if (phi <= 1e-6) phi += Math.PI * 2;
    // Sweep direction at B; B's printed side must face back against it.
    const sweep = u.clone().multiplyScalar(-y).addScaledVector(v, x);
    return { c, phi, facesBack: c.B.normal.dot(sweep) < 0 };
  });
  const first = Math.min(...scored.map((s) => s.phi));
  const hit = scored.find((s) => s.phi - first < 1e-3 && s.facesBack);
  return hit ? hit.c : null;
}

/** The part of face B's edges that overlaps the given (world space) edge, if any. */
function sharedEdge([p0, p1]: [Vector3, Vector3], B: FaceNode): [Vector3, Vector3] | null {
  const len = p0.distanceTo(p1);
  if (len < 1e-6) return null;
  const u = p1.clone().sub(p0).divideScalar(len);
  for (const [q0, q1] of B.edges) {
    const off0 = q0.clone().sub(p0);
    const off1 = q1.clone().sub(p0);
    const t0 = off0.dot(u);
    const t1 = off1.dot(u);
    // Both endpoints of B's edge must lie on A's edge line.
    if (off0.clone().addScaledVector(u, -t0).length() > 0.05) continue;
    if (off1.clone().addScaledVector(u, -t1).length() > 0.05) continue;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(len, Math.max(t0, t1));
    if (hi - lo < 0.5) continue;
    return [p0.clone().addScaledVector(u, lo), p0.clone().addScaledVector(u, hi)];
  }
  return null;
}

/**
 * Transforms from the sheet coordinates of `anchor` into the sheet coordinates of every
 * face reachable from it, unfolding across shared edges (breadth first, so each face is
 * reached the shortest way round).
 */
export function unfoldFrom(d: Dieline, anchor: string): Map<string, Affine> {
  const g = faceGraph(d);
  const out = new Map<string, Affine>();
  if (!g.has(anchor)) return out;
  out.set(anchor, IDENTITY);
  const queue = [anchor];
  while (queue.length) {
    const id = queue.shift()!;
    const t = out.get(id)!;
    for (const n of g.get(id)!.neighbours) {
      if (out.has(n.id)) continue;
      out.set(n.id, multiply(n.map, t));
      queue.push(n.id);
    }
  }
  return out;
}

/** The face containing a sheet point on the given panel. */
export function faceAt(d: Dieline, panel: string, p: Vec2): Face | null {
  const g = faceGraph(d);
  for (const n of g.values()) if (n.panel === panel && inRect(p, n.face.rect, 0.01)) return n.face;
  return null;
}

/**
 * Given a point in the sheet coordinates of `anchor` (possibly outside it), finds the face
 * the point actually lands on once wrapped around the box.
 */
export function wrapPoint(d: Dieline, anchor: string, p: Vec2): { face: string; point: Vec2 } {
  const maps = unfoldFrom(d, anchor);
  const faces = new Map(d.faces.map((f) => [f.id, f]));
  for (const [id, m] of maps) {
    const q = apply(m, p);
    if (inRect(q, faces.get(id)!.rect)) return { face: id, point: q };
  }
  return { face: anchor, point: p };
}
