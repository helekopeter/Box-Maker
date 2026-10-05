import type { Bez, Vec2 } from '../types';

export const rect = (x: number, y: number, w: number, h: number): Vec2[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** A stretch of outline made of curves: points along it (excluding its start) and the curves. */
export interface Curve {
  pts: Vec2[];
  bez: Bez[];
}

/** Points along a Bézier, excluding its start, close enough that chords stay within `tol` mm. */
export function sampleBez(b: Bez, tol = 0.05): Vec2[] {
  const [p0, c1, c2, p3] = b;
  const hull = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p3[0] - c2[0], p3[1] - c2[1]);
  const n = Math.max(2, Math.min(96, Math.ceil(Math.sqrt(hull / tol) * 0.6)));
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = 1 - t;
    const k0 = s * s * s, k1 = 3 * s * s * t, k2 = 3 * s * t * t, k3 = t * t * t;
    out.push([k0 * p0[0] + k1 * c1[0] + k2 * c2[0] + k3 * p3[0], k0 * p0[1] + k1 * c1[1] + k2 * c2[1] + k3 * p3[1]]);
  }
  out[out.length - 1] = [p3[0], p3[1]];
  return out;
}

/** A circular arc from angle a0 to a1 (radians) as Béziers (one per quarter turn at most). */
export function arcCurve(cx: number, cy: number, r: number, a0: number, a1: number): Curve {
  const parts = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (a: number): Vec2 => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const bez: Bez[] = [];
  for (let i = 0; i < parts; i++) {
    const s = a0 + step * i;
    const e = s + step;
    const p0 = at(s);
    const p3 = at(e);
    bez.push([p0, [p0[0] - Math.sin(s) * r * k, p0[1] + Math.cos(s) * r * k], [p3[0] + Math.sin(e) * r * k, p3[1] - Math.cos(e) * r * k], p3]);
  }
  return { pts: bez.flatMap((b) => sampleBez(b)), bez };
}

/** Moves a curve with an affine map (translations, mirrors and rotations keep Béziers exact). */
export function mapCurve(c: Curve, f: (p: Vec2) => Vec2): Curve {
  return { pts: c.pts.map(f), bez: c.bez.map((b) => b.map(f) as Bez) };
}

/** Points along a circular arc from angle a0 to a1 (radians), excluding the start point. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number): Vec2[] {
  return arcCurve(cx, cy, r, a0, a1).pts;
}

/** A tapered glue tab hinged on the vertical line x = hx, sticking out towards dirX. */
export function glueTabPoly(hx: number, y0: number, y1: number, g: number, dirX: 1 | -1): Vec2[] {
  const c = Math.min(g * 0.8, (y1 - y0) / 4);
  return [
    [hx, y0],
    [hx + dirX * g, y0 + c],
    [hx + dirX * g, y1 - c],
    [hx, y1],
  ];
}

/** A tapered tab hinged on the edge p0→p1, sticking out away from `inside`. */
export function edgeTab(p0: Vec2, p1: Vec2, depth: number, inside: Vec2): Vec2[] {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const u: Vec2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
  let n: Vec2 = [-u[1], u[0]];
  if (n[0] * (p0[0] - inside[0]) + n[1] * (p0[1] - inside[1]) < 0) n = [-n[0], -n[1]];
  // Steeper than 45° so the tab's corners stay clear of neighbouring panels' edges.
  const c = Math.min(depth * 1.5, len / 3);
  return [
    p0,
    p1,
    [p1[0] + n[0] * depth - u[0] * c, p1[1] + n[1] * depth - u[1] * c],
    [p0[0] + n[0] * depth + u[0] * c, p0[1] + n[1] * depth + u[1] * c],
  ];
}

/** A rounded slot (stadium) centred on (cx, cy). */
export function slot(cx: number, cy: number, w: number, h: number): Curve {
  const r = h / 2;
  const right = arcCurve(cx + w / 2 - r, cy, r, -Math.PI / 2, Math.PI / 2);
  const left = arcCurve(cx - w / 2 + r, cy, r, Math.PI / 2, Math.PI * 1.5);
  return {
    pts: [[cx - w / 2 + r, cy - r], [cx + w / 2 - r, cy - r], ...right.pts, [cx - w / 2 + r, cy + r], ...left.pts.slice(0, -1)],
    bez: [...right.bez, ...left.bez],
  };
}

export function bounds(poly: Vec2[]) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
