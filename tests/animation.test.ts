import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { foldMatrices } from '../src/geometry/fold';
import { generateDieline } from '../src/geometry/styles';
import type { BoxParams, BoxStyle, Dieline, Vec2 } from '../src/types';
import { overlaps, toDieline } from '../src/advanced/model';
import { EXAMPLES } from '../src/universe/examples';

const styles: BoxStyle[] = ['rsc', 'tuck', 'rte', 'snaplock', 'autolock', 'sealend', 'gable', 'tray', 'traylid', 'sleeve'];

function pointInPoly([x, y]: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a polygon's boundary (sheet coordinates). */
function edgeDistance([x, y]: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay;
    const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - k * dx, y - ay - k * dy));
  }
  return best;
}

interface Crossing {
  moving: string;
  through: string;
  progress: number;
}

/**
 * Samples the fold animation and reports any panel corner that goes from one side of
 * another panel to the other while over that panel (rather than around its edge).
 */
function findCrossings(d: Dieline, t: number, steps = 400): Crossing[] {
  const out: Crossing[] = [];
  const mid = -t / 2;
  const tol = t * 0.45;
  // Last side (+1 outside / -1 inside) each corner was clearly on, per pair of panels.
  const side = new Map<string, number>();
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    const mats = foldMatrices(d, progress, { thickness: t });
    for (const B of d.panels) {
      const inv = mats.get(B.id)!.clone().invert();
      for (const A of d.panels) {
        if (A === B || A.piece !== B.piece) continue;
        if (A.parent === B.id || B.parent === A.id) continue;
        const m = mats.get(A.id)!.clone().premultiply(inv);
        A.poly.forEach((pt, k) => {
          const q = new Vector3(pt[0], -pt[1], mid).applyMatrix4(m);
          const z = q.z - mid;
          const hit: Vec2 = [q.x, -q.y];
          const key = `${A.id}|${B.id}|${k}`;
          // Only count positions that are over B itself, away from its edges.
          const over = pointInPoly(hit, B.poly) && edgeDistance(hit, B.poly) > 1;
          if (Math.abs(z) < tol) return;
          const s = Math.sign(z);
          const was = side.get(key);
          if (over && was !== undefined && was !== s) out.push({ moving: A.id, through: B.id, progress });
          // Leaving B's footprint forgets the side, so going around B is fine.
          if (over) side.set(key, s);
          else side.delete(key);
        });
      }
    }
  }
  return out;
}

// A cube plus a few awkward proportions and board thicknesses.
const sizes: [number, number, number, number][] = [
  [100, 100, 100, 1.5],
  [200, 60, 150, 3],
  [60, 150, 40, 3],
  [300, 200, 100, 4],
];

describe.each(styles)('%s fold animation', (style) => {
  it.each(sizes)('never passes one panel through another (%s×%s×%s, %s mm)', (length, width, height, thickness) => {
    const p: BoxParams = { style, length, width, height, thickness, glueTab: 15, lidHeight: 30, lidClearance: 1 };
    const crossings = findCrossings(generateDieline(p), p.thickness);
    const unique = [...new Map(crossings.map((c) => [`${c.moving}→${c.through}`, c])).values()];
    expect(unique.map((c) => `${c.moving} through ${c.through} at ${c.progress.toFixed(3)}`)).toEqual([]);
  });
});


describe('Box Universe examples', () => {
  it.each(EXAMPLES.filter((e) => e.data.kind === 'advanced').map((e) => [e.name, e] as const))(
    '%s cuts from one piece and folds cleanly',
    (_name, ex) => {
      if (ex.data.kind !== 'advanced') return;
      const design = ex.data.design;
      expect(overlaps(design)).toEqual([]);
      const crossings = findCrossings(toDieline(design), design.thickness);
      expect(crossings.map((c) => `${c.moving} through ${c.through}`)).toEqual([]);
    },
  );
});
