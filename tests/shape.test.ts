import { describe, expect, it } from 'vitest';
import { toDieline } from '../src/advanced/model';
import { foldedBounds } from '../src/geometry/fold';
import { chainSegments, computeLines } from '../src/geometry/lines';
import { faces, newShape, rings, sanitizeShape, toDesign, type ShapeSpec } from '../src/shape/model';

const spec = (over: Partial<ShapeSpec>): ShapeSpec => ({ ...newShape(), ...over });

const cases: [string, ShapeSpec, [number, number, number]][] = [
  ['square box', spec({ shape: 'rect', width: 100, depth: 80, levels: [{ height: 60, width: 100, depth: 80, size: 0 }] }), [100, 80, 60]],
  ['hexagon prism', spec({ shape: 'hexagon', size: 100, levels: [{ height: 80, width: 0, depth: 0, size: 100 }] }), [100, 86.6, 80]],
  ['triangle prism', spec({ shape: 'triangle', size: 100, levels: [{ height: 50, width: 0, depth: 0, size: 100 }] }), [86.6, 75, 50]],
  ['pentagon frustum', spec({ shape: 'pentagon', size: 100, levels: [{ height: 60, width: 0, depth: 0, size: 60 }] }), [95.1, 90.5, 60]],
  ['house', spec({ shape: 'rect', width: 80, depth: 80, levels: [{ height: 60, width: 80, depth: 80, size: 0 }, { height: 40, width: 0, depth: 0, size: 0 }] }), [80, 80, 100]],
  ['open bowl', spec({ shape: 'octagon', size: 100, top: 'open', levels: [{ height: 40, width: 0, depth: 0, size: 140 }] }), [129.3, 129.3, 40]], // octagon: flat to flat
  ['round tower', spec({ shape: 'round', size: 80, sides: 12, levels: [{ height: 100, width: 0, depth: 0, size: 80 }] }), [80, 80, 100]],
];

describe.each(cases)('%s', (_name, s, [w, d, h]) => {
  const { design, overlaps } = toDesign(s);
  const dl = toDieline(design);

  it('cuts from one piece', () => {
    expect(overlaps).toBe(0);
    expect(chainSegments(computeLines(dl).cuts).length).toBe(1);
  });

  it('folds back into the shape', () => {
    const box = foldedBounds(dl, 1, { thickness: s.thickness });
    const size = [box.max.x - box.min.x, box.max.z - box.min.z, box.max.y - box.min.y].sort((a, b) => b - a);
    const want = [w, d, h].sort((a, b) => b - a);
    for (let i = 0; i < 3; i++) expect(Math.abs(size[i] - want[i])).toBeLessThan(3 * s.thickness + 1);
  });

  it('has a glue tab on every seam that is not a fold', () => {
    const fs = faces(s);
    const sides = fs.filter((f) => f.kind === 'side').length;
    const hasTop = fs.some((f) => f.kind === 'top');
    // Edges of the solid = faces + vertices - 2 (Euler; an open top removes a face).
    const panels = design.panels.length + 1;
    const tabs = design.panels.filter((p) => p.kind === 'glue').length;
    expect(panels - tabs).toBe(fs.length);
    expect(tabs).toBeGreaterThan(0);
    expect(sides + (hasTop ? 1 : 0) + 1).toBe(fs.length);
  });
});

describe('level sizes', () => {
  it('turns older shapes (top size in % of the level below) into mm', () => {
    const old = sanitizeShape({ shape: 'rect', width: 100, depth: 60, size: 90, levels: [{ height: 50, scale: 80 }, { height: 30, scale: 50 }, { height: 20, scale: 0 }] })!;
    expect(old.levels.map((l) => [l.width, l.depth])).toEqual([[80, 48], [40, 24], [0, 0]]);
    expect(old.levels[1].size).toBeCloseTo(36, 6);
  });

  it('lets a rectangle narrow in width and depth separately, with flat sides', () => {
    const s = { ...newShape(), shape: 'rect' as const, width: 100, depth: 60, levels: [{ height: 50, width: 60, depth: 60, size: 0 }] };
    const top = rings(s)[1];
    const xs = top.map((v) => v.x);
    const ys = top.map((v) => v.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(60, 6);
    const { design } = toDesign(s);
    expect(design.panels.length).toBeGreaterThan(4);
  });
});
