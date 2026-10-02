import type { Dieline, Vec2 } from '../types';

export interface Segment {
  a: Vec2;
  b: Vec2;
}

const EPS = 1e-6;
const round = (v: number, p = 1e4) => Math.round(v * p) / p;

interface LineGroup {
  /** Unit direction of the line. */
  dir: Vec2;
  /** A point on the line (closest to origin). */
  origin: Vec2;
  cuts: [number, number][];
  folds: [number, number][];
}

function lineKey(a: Vec2, b: Vec2): { key: string; dir: Vec2; origin: Vec2 } | null {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  dx /= len;
  dy /= len;
  // Canonical direction so that opposite edges map to the same line.
  if (dx < -EPS || (Math.abs(dx) <= EPS && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  // Signed distance of the line from the origin, along the normal.
  const n: Vec2 = [-dy, dx];
  const d = a[0] * n[0] + a[1] * n[1];
  const key = `${round(dx)},${round(dy)},${round(d, 1e3)}`;
  return { key, dir: [dx, dy], origin: [n[0] * d, n[1] * d] };
}

function param(g: LineGroup, p: Vec2): number {
  return (p[0] - g.origin[0]) * g.dir[0] + (p[1] - g.origin[1]) * g.dir[1];
}

function union(iv: [number, number][]): [number, number][] {
  const s = iv
    .map(([a, b]) => (a < b ? [a, b] : [b, a]) as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const cur of s) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

function subtract(iv: [number, number][], rem: [number, number][]): [number, number][] {
  let cur = iv;
  for (const [r0, r1] of rem) {
    const next: [number, number][] = [];
    for (const [a, b] of cur) {
      if (r1 <= a + 1e-4 || r0 >= b - 1e-4) {
        next.push([a, b]);
        continue;
      }
      if (r0 > a + 1e-4) next.push([a, r0]);
      if (r1 < b - 1e-4) next.push([r1, b]);
    }
    cur = next;
  }
  return cur.filter(([a, b]) => b - a > 1e-3);
}

/**
 * Derives the cut and fold lines of a dieline. Every panel edge is a cut unless it is
 * (part of) a hinge; shared and overlapping edges are merged so nothing is cut twice.
 */
export function computeLines(d: Dieline): { cuts: Segment[]; folds: Segment[] } {
  const groups = new Map<string, LineGroup>();
  const get = (a: Vec2, b: Vec2) => {
    const k = lineKey(a, b);
    if (!k) return null;
    let g = groups.get(k.key);
    if (!g) {
      g = { dir: k.dir, origin: k.origin, cuts: [], folds: [] };
      groups.set(k.key, g);
    }
    return g;
  };

  for (const p of d.panels) {
    for (const loop of [p.poly, ...(p.holes ?? [])]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const g = get(a, b);
        if (g) g.cuts.push([param(g, a), param(g, b)]);
      }
    }
    if (p.hinge) {
      const g = get(p.hinge[0], p.hinge[1]);
      if (g) g.folds.push([param(g, p.hinge[0]), param(g, p.hinge[1])]);
    }
  }

  const cuts: Segment[] = [];
  const folds: Segment[] = [];
  const at = (g: LineGroup, t: number): Vec2 => [
    round(g.origin[0] + g.dir[0] * t),
    round(g.origin[1] + g.dir[1] * t),
  ];
  for (const g of groups.values()) {
    const f = union(g.folds);
    for (const [a, b] of subtract(union(g.cuts), f)) cuts.push({ a: at(g, a), b: at(g, b) });
    for (const [a, b] of f) folds.push({ a: at(g, a), b: at(g, b) });
  }
  return { cuts, folds };
}

/** Joins segments that share endpoints into polylines, so a laser cuts them in one pass. */
export function chainSegments(segs: Segment[], tol = 1e-3): Vec2[][] {
  const remaining = segs.slice();
  const same = (p: Vec2, q: Vec2) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
  const chains: Vec2[][] = [];
  while (remaining.length) {
    const s = remaining.pop()!;
    const chain: Vec2[] = [s.a, s.b];
    let grown = true;
    while (grown) {
      grown = false;
      for (let i = 0; i < remaining.length; i++) {
        const r = remaining[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (same(tail, r.a)) chain.push(r.b);
        else if (same(tail, r.b)) chain.push(r.a);
        else if (same(head, r.b)) chain.unshift(r.a);
        else if (same(head, r.a)) chain.unshift(r.b);
        else continue;
        remaining.splice(i, 1);
        grown = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

/** Splits segments into short dashes (perforated fold lines). */
export function dashSegments(segs: Segment[], dash = 4, gap = 2): Segment[] {
  const out: Segment[] = [];
  for (const { a, b } of segs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    // Centre the pattern so both ends of the fold get a gap (keeps the sheet attached at corners).
    const period = dash + gap;
    const n = Math.max(1, Math.floor((len - gap) / period));
    const start = (len - (n * period - gap)) / 2;
    for (let i = 0; i < n; i++) {
      const t0 = start + i * period;
      const t1 = Math.min(len, t0 + dash);
      out.push({ a: [a[0] + ux * t0, a[1] + uy * t0], b: [a[0] + ux * t1, a[1] + uy * t1] });
    }
  }
  return out;
}

export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}
