import type { Vec2 } from '../types';

/**
 * A point drawn with the pen or cut-out tool. `h` is its handle, the offset from the point
 * towards where the curve leaves it (it arrives from the opposite side), so the curve
 * runs smoothly through the point. No handle: a sharp corner.
 */
export interface PathPoint {
  p: Vec2;
  h?: Vec2;
}

/** Points along the cubic Bézier a → b with control points c1, c2, excluding a. */
function bezier(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, tolerance: number): Vec2[] {
  // Enough steps that chords stay within roughly `tolerance` of the curve.
  const hull = Math.hypot(c1[0] - a[0], c1[1] - a[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(b[0] - c2[0], b[1] - c2[1]);
  const n = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(hull / tolerance))));
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = 1 - t;
    const k0 = s * s * s, k1 = 3 * s * s * t, k2 = 3 * s * t * t, k3 = t * t * t;
    out.push([k0 * a[0] + k1 * c1[0] + k2 * c2[0] + k3 * b[0], k0 * a[1] + k1 * c1[1] + k2 * c2[1] + k3 * b[1]]);
  }
  return out;
}

/** Whether the segment from a to b is curved (either end has a handle). */
const curved = (a: PathPoint, b: PathPoint) => !!(a.h || b.h);

/** The segment a → b as points, excluding a. */
function segment(a: PathPoint, b: PathPoint, tolerance: number): Vec2[] {
  if (!curved(a, b)) return [b.p];
  const c1: Vec2 = a.h ? [a.p[0] + a.h[0], a.p[1] + a.h[1]] : a.p;
  const c2: Vec2 = b.h ? [b.p[0] - b.h[0], b.p[1] - b.h[1]] : b.p;
  return bezier(a.p, c1, c2, b.p, tolerance);
}

/**
 * Turns drawn points into the polyline that gets cut: straight between corners, curves
 * through points with handles. `closed` joins the last point back to the first.
 */
export function flattenPath(pts: PathPoint[], closed = false, tolerance = 0.25): Vec2[] {
  if (!pts.length) return [];
  const out: Vec2[] = [pts[0].p];
  for (let i = 1; i < pts.length; i++) out.push(...segment(pts[i - 1], pts[i], tolerance));
  if (closed && pts.length > 2) {
    out.push(...segment(pts[pts.length - 1], pts[0], tolerance));
    out.pop(); // back at the first point
  }
  return out.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Vec2);
}

/** SVG path data for drawn points (curves as real Béziers, for the on-screen draft). */
export function pathData(pts: PathPoint[], fmt: (v: number) => string): string {
  if (!pts.length) return '';
  let d = `M${fmt(pts[0].p[0])} ${fmt(pts[0].p[1])}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!curved(a, b)) {
      d += `L${fmt(b.p[0])} ${fmt(b.p[1])}`;
      continue;
    }
    const c1 = a.h ? [a.p[0] + a.h[0], a.p[1] + a.h[1]] : a.p;
    const c2 = b.h ? [b.p[0] - b.h[0], b.p[1] - b.h[1]] : b.p;
    d += `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(b.p[0])} ${fmt(b.p[1])}`;
  }
  return d;
}
