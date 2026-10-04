import { Vector3 } from 'three';
import { BASE_ID, overlaps, type AdvancedDesign, type CustomPanel } from '../advanced/model';
import type { Vec2 } from '../types';

/**
 * Shape Builder: a simple solid made by extruding a basic shape in one or more levels,
 * each of which can narrow or widen. `toDesign` unfolds it into an Advanced design.
 */
export type BaseShape = 'rect' | 'triangle' | 'pentagon' | 'hexagon' | 'octagon' | 'round';

export interface Level {
  /** Height of this level in mm. */
  height: number;
  /** Size of the top of this level, in % of its bottom (0 = a point). */
  scale: number;
}

export interface ShapeSpec {
  version: 1;
  shape: BaseShape;
  /** Rectangle size in mm. */
  width: number;
  depth: number;
  /** Polygons and round shapes: diameter of the circle they fit in, in mm. */
  size: number;
  /** Round shapes: number of sides. */
  sides: number;
  levels: Level[];
  top: 'closed' | 'open';
  thickness: number;
  color: string;
  /** Glue tab width in mm. */
  tab: number;
}

export const SHAPE_INFO: Record<BaseShape, { name: string; sides: number }> = {
  rect: { name: 'Rectangle', sides: 4 },
  triangle: { name: 'Triangle', sides: 3 },
  pentagon: { name: 'Pentagon', sides: 5 },
  hexagon: { name: 'Hexagon', sides: 6 },
  octagon: { name: 'Octagon', sides: 8 },
  round: { name: 'Round', sides: 16 },
};

export function newShape(): ShapeSpec {
  return {
    version: 1,
    shape: 'hexagon',
    width: 100,
    depth: 80,
    size: 100,
    sides: 16,
    levels: [{ height: 80, scale: 100 }],
    top: 'closed',
    thickness: 1.5,
    color: '#c9a46b',
    tab: 12,
  };
}

/** The base outline, counter-clockwise, centred on the origin, with a flat bottom edge. */
export function profile(s: ShapeSpec): Vec2[] {
  if (s.shape === 'rect') {
    const w = s.width / 2;
    const d = s.depth / 2;
    return [[-w, -d], [w, -d], [w, d], [-w, d]];
  }
  const n = s.shape === 'round' ? Math.max(6, Math.min(48, Math.round(s.sides))) : SHAPE_INFO[s.shape].sides;
  const r = s.size / 2;
  const start = -Math.PI / 2 - Math.PI / n; // first edge horizontal
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i * 2 * Math.PI) / n;
    return [r * Math.cos(a), r * Math.sin(a)] as Vec2;
  });
}

/** Rings of 3D vertices: ring 0 is the base outline, ring k the top of level k. */
export function rings(s: ShapeSpec): Vector3[][] {
  const base = profile(s);
  const out: Vector3[][] = [];
  let scale = 1;
  let z = 0;
  out.push(base.map(([x, y]) => new Vector3(x, y, 0)));
  for (const lv of s.levels) {
    scale *= Math.max(0, lv.scale) / 100;
    z += lv.height;
    out.push(base.map(([x, y]) => new Vector3(x * scale, y * scale, z)));
    if (scale === 0) break; // nothing can sit on a point
  }
  return out;
}

/** A face of the solid: a planar polygon with an outward normal. */
interface SolidFace {
  id: string;
  kind: 'base' | 'side' | 'top';
  level: number;
  side: number;
  verts: Vector3[];
  normal: Vector3;
}

function centroid(v: Vector3[]) {
  return v.reduce((a, p) => a.add(p), new Vector3()).divideScalar(v.length);
}

/** All faces of the solid; degenerate (zero-length) edges are removed. */
export function faces(s: ShapeSpec): SolidFace[] {
  const R = rings(s);
  const n = R[0].length;
  const out: SolidFace[] = [];
  const centre = (z: number) => new Vector3(0, 0, z);
  out.push({ id: BASE_ID, kind: 'base', level: -1, side: -1, verts: R[0], normal: new Vector3(0, 0, -1) });
  for (let k = 0; k + 1 < R.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const raw = [R[k][i], R[k][j], R[k + 1][j], R[k + 1][i]];
      const verts = raw.filter((p, idx) => p.distanceTo(raw[(idx + 1) % raw.length]) > 1e-6);
      if (verts.length < 3) continue;
      const c = centroid(verts);
      const nrm = new Vector3().subVectors(verts[1], verts[0]).cross(new Vector3().subVectors(verts[verts.length - 1], verts[0])).normalize();
      if (nrm.dot(c.clone().sub(centre(c.z))) < 0) nrm.negate();
      out.push({ id: `s${k}-${i}`, kind: 'side', level: k, side: i, verts, normal: nrm });
    }
  }
  const top = R[R.length - 1];
  if (s.top === 'closed' && top[0].distanceTo(top[1]) > 1e-6) {
    out.push({ id: 'top', kind: 'top', level: R.length - 1, side: -1, verts: top, normal: new Vector3(0, 0, 1) });
  }
  return out;
}

const same = (a: Vector3, b: Vector3) => a.distanceTo(b) < 1e-6;

/** Shared edge of two faces as [a, b], or null. */
function sharedEdge(F: SolidFace, G: SolidFace): [Vector3, Vector3] | null {
  for (let i = 0; i < F.verts.length; i++) {
    const a = F.verts[i];
    const b = F.verts[(i + 1) % F.verts.length];
    for (let j = 0; j < G.verts.length; j++) {
      const c = G.verts[j];
      const d = G.verts[(j + 1) % G.verts.length];
      if ((same(a, c) && same(b, d)) || (same(a, d) && same(b, c))) return [a, b];
    }
  }
  return null;
}

/** Fold angle (deg) from face F to face G across their edge: + inwards (convex edge). */
function dihedral(F: SolidFace, G: SolidFace, edge: [Vector3, Vector3]): number {
  const a = (Math.acos(Math.max(-1, Math.min(1, F.normal.dot(G.normal)))) * 180) / Math.PI;
  const convex = centroid(G.verts).sub(edge[0]).dot(F.normal) < 0;
  return convex ? a : -a;
}

/**
 * Lays a face out in the frame of the edge it hangs from: u along the hinge a→b, v away
 * from the hinge inside the face. Returns the outline after the hinge (from b round to a).
 */
function unfoldFace(face: Vector3[], a: Vector3, b: Vector3): Vec2[] {
  let i = face.findIndex((p) => same(p, a));
  let cyc = face;
  if (!same(cyc[(i + 1) % cyc.length], b)) {
    cyc = [...face].reverse();
    i = cyc.findIndex((p) => same(p, a));
  }
  const ordered = [...cyc.slice(i), ...cyc.slice(0, i)];
  const U = b.clone().sub(a).normalize();
  return ordered.slice(2).map((p) => {
    const w = p.clone().sub(a);
    const u = w.dot(U);
    return [u, w.addScaledVector(U, -u).length()] as Vec2;
  });
}

export type NetLayout = 'star' | 'strip';

interface TreeEdge {
  parent: string;
  child: string;
}

/** Which faces hang off which: the spanning tree that becomes the net. */
function tree(fs: SolidFace[], layout: NetLayout): TreeEdge[] {
  const byId = new Map(fs.map((f) => [f.id, f]));
  const sides = fs.filter((f) => f.kind === 'side');
  const n = Math.max(0, ...sides.map((f) => f.side)) + 1;
  const levels = Math.max(0, ...sides.map((f) => f.level)) + 1;
  const edges: TreeEdge[] = [];
  for (let i = 0; i < n; i++) {
    if (!byId.has(`s0-${i}`)) continue;
    // Star: every wall hangs off the base. Strip: walls hang off each other in a row.
    if (layout === 'star' || i === 0) edges.push({ parent: BASE_ID, child: `s0-${i}` });
    else edges.push({ parent: `s0-${i - 1}`, child: `s0-${i}` });
    for (let k = 1; k < levels; k++) if (byId.has(`s${k}-${i}`)) edges.push({ parent: `s${k - 1}-${i}`, child: `s${k}-${i}` });
  }
  if (byId.has('top')) edges.push({ parent: `s${levels - 1}-0`, child: 'top' });
  return edges;
}

export interface NetResult {
  design: AdvancedDesign;
  layout: NetLayout;
  /** Pairs of panels overlapping on the sheet (empty when the net cuts from one piece). */
  overlaps: number;
}

/** Builds one candidate net. */
function buildNet(s: ShapeSpec, layout: NetLayout, tabScale: number, taperScale: number): AdvancedDesign {
  const fs = faces(s);
  const byId = new Map(fs.map((f) => [f.id, f]));
  const edges = tree(fs, layout);
  const levels = s.levels.length;
  const design: AdvancedDesign = {
    version: 1,
    name: `${SHAPE_INFO[s.shape].name} box`,
    thickness: s.thickness,
    color: s.color,
    base: { width: 0, height: 0, points: profile(s), holes: [] },
    panels: [],
  };
  // Outline of every panel in 3D, in the vertex order the Advanced model rebuilds it with.
  const outline = new Map<string, Vector3[]>([[BASE_ID, byId.get(BASE_ID)!.verts]]);
  const order = (f: SolidFace) => (f.kind === 'top' ? levels + 2 : f.level + 1);

  const attach = (parentId: string, edge: [Vector3, Vector3], panel: Omit<CustomPanel, 'parent' | 'edge' | 'shape' | 'inset0' | 'inset1' | 'holes'>, faceVerts: Vector3[] | null, tab?: { depth: number; taper: number }) => {
    const po = outline.get(parentId)!;
    const k = po.findIndex((p, i) => {
      const q = po[(i + 1) % po.length];
      return (same(p, edge[0]) && same(q, edge[1])) || (same(p, edge[1]) && same(q, edge[0]));
    });
    if (k < 0) return;
    const a = po[k];
    const b = po[(k + 1) % po.length];
    const L = a.distanceTo(b);
    let shape: CustomPanel['shape'];
    if (faceVerts) {
      const pts = unfoldFace(faceVerts, a, b);
      shape = pts.length === 2 && Math.abs(pts[0][1] - pts[1][1]) < 1e-6
        ? { type: 'rect', depth: pts[0][1], taper0: pts[1][0], taper1: L - pts[0][0] }
        : { type: 'custom', points: pts };
      const ordered = (() => {
        let i = faceVerts.findIndex((p) => same(p, a));
        let cyc = faceVerts;
        if (!same(cyc[(i + 1) % cyc.length], b)) {
          cyc = [...faceVerts].reverse();
          i = cyc.findIndex((p) => same(p, a));
        }
        return [...cyc.slice(i), ...cyc.slice(0, i)];
      })();
      outline.set(panel.id, ordered);
    } else {
      // Glue tabs stop a board thickness short of each corner so their ends don't poke
      // into the panels that meet there.
      const inset = Math.min(Math.max(s.thickness, 1), L * 0.2);
      const len = L - 2 * inset;
      const depth = Math.min(tab!.depth, len * 0.45);
      const taper = Math.min(depth * tab!.taper, len * 0.45);
      design.panels.push({ ...panel, parent: parentId, edge: k, inset0: inset, inset1: inset, shape: { type: 'rect', depth, taper0: taper, taper1: taper }, holes: [] });
      return;
    }
    design.panels.push({ ...panel, parent: parentId, edge: k, inset0: 0, inset1: 0, shape, holes: [] });
  };

  // Panels along the tree, parents first.
  const done = new Set([BASE_ID]);
  const pending = [...edges];
  while (pending.length) {
    const idx = pending.findIndex((e) => done.has(e.parent));
    if (idx < 0) break;
    const { parent, child } = pending.splice(idx, 1)[0];
    const P = byId.get(parent)!;
    const C = byId.get(child)!;
    const edge = sharedEdge(P, C);
    if (!edge) continue;
    attach(parent, edge, {
      id: child, kind: 'wall', angle: dihedral(P, C, edge), order: order(C), layer: 0,
      ...(C.kind === 'top' ? { face: { label: 'Top' } } : {}),
    }, C.verts);
    done.add(child);
  }

  // Every other shared edge is a seam: a glue tab on one side folds onto the other face.
  const inTree = new Set(edges.map((e) => [e.parent, e.child].sort().join('|')));
  let tabs = 0;
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const F = fs[i];
      const G = fs[j];
      if (inTree.has([F.id, G.id].sort().join('|'))) continue;
      const edge = sharedEdge(F, G);
      if (!edge) continue;
      // Put the tab on the side face (rather than the base or lid), folding onto the other.
      const [owner, onto] = F.kind === 'side' ? [F, G] : [G, F];
      if (!done.has(owner.id)) continue;
      const angle = dihedral(owner, onto, edge);
      const underLid = onto.kind === 'top';
      attach(owner.id, edge, {
        id: `tab-${++tabs}`, kind: 'glue', angle,
        // Tabs under a lid fold before the lid closes over them. Tabs between walls are
        // creased in first (a stage ahead of their wall, and early in it) so the
        // neighbouring wall closes over them from outside, as when folding by hand.
        order: underLid ? levels + 1 : Math.max(1, order(owner) - 1), layer: -1,
        ...(underLid ? {} : { motion: [[0, 0], [0.5, angle], [1, angle]] as Vec2[] }),
      }, null, { depth: s.tab * tabScale, taper: taperScale });
    }
  }
  return design;
}

/**
 * Unfolds the shape into an Advanced design. Tries walls-around-the-base first, then a
 * strip of walls, with progressively slimmer glue tabs, and returns the first net that
 * cuts from one piece (or the least-overlapping one).
 */
export function toDesign(s: ShapeSpec): NetResult {
  let best: NetResult | null = null;
  for (const layout of ['star', 'strip'] as NetLayout[]) {
    for (const [tabScale, taper] of [[1, 1], [1, 1.8], [0.7, 2.5], [0.5, 3.5]]) {
      const design = buildNet(s, layout, tabScale, taper);
      const count = overlaps(design).length;
      if (!best || count < best.overlaps) best = { design, layout, overlaps: count };
      if (count === 0) return best;
    }
  }
  return best!;
}

/** Validates a shape loaded from storage. */
export function sanitizeShape(raw: unknown): ShapeSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = newShape();
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  const levels = Array.isArray(r.levels)
    ? r.levels.slice(0, 6).map((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        return { height: num(o.height, 1, 2000, 80), scale: num(o.scale, 0, 300, 100) };
      })
    : d.levels;
  return {
    version: 1,
    shape: (Object.keys(SHAPE_INFO) as BaseShape[]).includes(r.shape as BaseShape) ? (r.shape as BaseShape) : d.shape,
    width: num(r.width, 5, 2000, d.width),
    depth: num(r.depth, 5, 2000, d.depth),
    size: num(r.size, 5, 2000, d.size),
    sides: Math.round(num(r.sides, 6, 48, d.sides)),
    levels: levels.length ? levels : d.levels,
    top: r.top === 'open' ? 'open' : 'closed',
    thickness: num(r.thickness, 0.2, 10, d.thickness),
    color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : d.color,
    tab: num(r.tab, 4, 40, d.tab),
  };
}
