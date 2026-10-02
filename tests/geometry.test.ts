import { describe, expect, it } from 'vitest';
import { generateDieline } from '../src/geometry/styles';
import { foldedBounds } from '../src/geometry/fold';
import { chainSegments, computeLines, dashSegments } from '../src/geometry/lines';
import type { BoxParams, BoxStyle } from '../src/types';

const base: BoxParams = {
  style: 'rsc',
  length: 200,
  width: 120,
  height: 80,
  thickness: 3,
  glueTab: 20,
  lidHeight: 30,
  lidClearance: 1,
};
const styles: BoxStyle[] = ['rsc', 'tuck', 'tray', 'traylid'];

describe.each(styles)('%s', (style) => {
  const p = { ...base, style };
  const d = generateDieline(p);

  it('produces finite geometry inside the sheet', () => {
    for (const panel of d.panels) {
      for (const [x, y] of panel.poly) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(d.width);
        expect(y).toBeLessThanOrEqual(d.height);
      }
    }
  });

  it('has unique panel ids and valid parents', () => {
    const ids = new Set(d.panels.map((x) => x.id));
    expect(ids.size).toBe(d.panels.length);
    for (const panel of d.panels) if (panel.parent) expect(ids.has(panel.parent)).toBe(true);
    for (const pc of d.pieces) expect(ids.has(pc.root)).toBe(true);
  });

  it('folds into a box of the expected outer size', () => {
    const t = p.thickness;
    const box = foldedBounds(d, 1, { thickness: t }, 0);
    const [L, W, H] = d.outer;
    const size = box.max.clone().sub(box.min);
    const tol = 3 * t;
    expect(size.x).toBeGreaterThan(p.length);
    expect(Math.abs(size.x - L)).toBeLessThan(tol);
    expect(Math.abs(size.z - W)).toBeLessThan(tol);
    // Lid of the two-piece box is a separate piece; the base is the tray only.
    const baseH = style === 'traylid' ? p.height + t : H;
    expect(Math.abs(size.y - baseH)).toBeLessThan(tol);
    // Sits on the ground, centred.
    expect(box.min.y).toBeCloseTo(0, 3);
    expect(Math.abs(box.min.x + box.max.x)).toBeLessThan(1e-6);
  });

  it('lies flat at progress 0', () => {
    const box = foldedBounds(d, 0, { thickness: p.thickness });
    expect(box.max.y - box.min.y).toBeCloseTo(p.thickness, 3);
  });

  it('cuts form closed loops', () => {
    const { cuts, folds } = computeLines(d);
    expect(folds.length).toBe(d.panels.filter((x) => x.hinge).length);
    const chains = chainSegments(cuts);
    expect(chains.length).toBe(d.pieces.length);
    for (const c of chains) {
      const a = c[0];
      const b = c[c.length - 1];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-3);
    }
  });
});

describe('traylid', () => {
  it('lid sits on top of and covers the tray', () => {
    const d = generateDieline({ ...base, style: 'traylid' });
    const tray = foldedBounds(d, 1, { thickness: 3 }, 0);
    const lid = foldedBounds(d, 1, { thickness: 3 }, 1);
    expect(lid.max.y).toBeCloseTo(tray.max.y + 3, 3);
    expect(lid.max.x).toBeGreaterThan(tray.max.x);
    expect(lid.min.z).toBeLessThan(tray.min.z);
  });
});

describe('dashSegments', () => {
  it('keeps dashes within the segment', () => {
    const dashes = dashSegments([{ a: [0, 0], b: [30, 0] }], 4, 2);
    expect(dashes.length).toBe(4);
    expect(dashes[0].a[0]).toBeGreaterThan(0);
    expect(dashes[dashes.length - 1].b[0]).toBeLessThan(30);
  });
});
