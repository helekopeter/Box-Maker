import { sampleBez } from '../geometry/shapes';
import type { Bez, Dieline, Vec2 } from '../types';

/** One step of a path after its first point: a straight line or a cubic curve to `p`. */
export type PathStep = { p: Vec2; c?: [Vec2, Vec2] };

const TOL = 2e-3;
const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < TOL && Math.abs(a[1] - b[1]) < TOL;

/** All curves of a dieline, each with the first point along it (to tell which way a path runs). */
export function curvesOf(d: Dieline): { bez: Bez; first: Vec2; last: Vec2; inner: Vec2[] }[] {
  return d.panels.flatMap((p) =>
    (p.curves ?? []).map((bez) => {
      const pts = sampleBez(bez);
      return { bez, first: pts[0], last: pts.length > 1 ? pts[pts.length - 2] : bez[0], inner: pts.slice(0, -1) };
    }),
  );
}

/**
 * A closed loop (last point = first) restarted at a point that isn't part way along a
 * curve, so every curve can be recognised whole.
 */
export function restartLoop(pts: Vec2[], curves: ReturnType<typeof curvesOf>): Vec2[] {
  const ring = pts.slice(0, -1);
  const inside = (q: Vec2) => curves.some((c) => c.inner.some((r) => same(q, r)));
  const k = ring.findIndex((q) => !inside(q));
  if (k <= 0) return pts;
  const out = [...ring.slice(k), ...ring.slice(0, k)];
  return [...out, out[0]];
}

/**
 * Turns a polyline from the cut lines into path steps, swapping each run of points that
 * follows one of the dieline's curves for that curve, so cut files get real curves instead
 * of many short lines.
 */
export function stepsOf(pts: Vec2[], curves: ReturnType<typeof curvesOf>): PathStep[] {
  const steps: PathStep[] = [];
  let i = 0;
  while (i < pts.length - 1) {
    const here = pts[i];
    const next = pts[i + 1];
    let matched = false;
    for (const { bez, first, last } of curves) {
      // Forwards (start → end) or backwards along the curve.
      const fwd = same(here, bez[0]) && same(next, first);
      const back = same(here, bez[3]) && same(next, last);
      if (!fwd && !back) continue;
      const end = fwd ? bez[3] : bez[0];
      const j = pts.findIndex((q, k) => k > i && same(q, end));
      if (j < 0) continue;
      steps.push(fwd ? { p: end, c: [bez[1], bez[2]] } : { p: end, c: [bez[2], bez[1]] });
      i = j;
      matched = true;
      break;
    }
    if (!matched) {
      steps.push({ p: next });
      i++;
    }
  }
  return steps;
}
