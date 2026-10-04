import { describe, expect, it } from 'vitest';
import { flattenPath } from '../src/advanced/curves';

describe('pen curves', () => {
  it('keeps corners as they are', () => {
    expect(flattenPath([{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it('bends through a point with a handle, staying close to a circle arc', () => {
    // Quarter circle of radius 50 from (50, 0) to (0, 50) through a smooth point at 45°,
    // with handles of length 50·k (the standard Bézier circle approximation for 45° arcs).
    const r = 50;
    const k = (4 / 3) * Math.tan(Math.PI / 16);
    const m: [number, number] = [r * Math.SQRT1_2, r * Math.SQRT1_2];
    const tangent: [number, number] = [-Math.SQRT1_2, Math.SQRT1_2];
    const pts = flattenPath([
      { p: [r, 0], h: [0, r * k] },
      { p: m, h: [tangent[0] * r * k, tangent[1] * r * k] },
      { p: [0, r], h: [-r * k, 0] },
    ]);
    expect(pts.length).toBeGreaterThan(8);
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x, y) - r)).toBeLessThan(0.3);
  });

  it('closes a loop without repeating the first point', () => {
    const loop = flattenPath([{ p: [0, 0], h: [5, 0] }, { p: [10, 10], h: [0, 5] }, { p: [0, 20] }], true);
    expect(loop[0]).toEqual([0, 0]);
    expect(loop[loop.length - 1]).not.toEqual([0, 0]);
  });
});
