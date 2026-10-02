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
const styles: BoxStyle[] = ['rsc', 'tuck', 'rte', 'snaplock', 'autolock', 'sealend', 'gable', 'tray', 'traylid', 'sleeve'];
const twoPiece = (s: BoxStyle) => s === 'traylid' || s === 'sleeve';

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
    // For two-piece boxes piece 0 is the tray; the lid or sleeve is checked separately.
    const [L, W, H] = twoPiece(style) ? [p.length + 2 * t, p.width + 2 * t, p.height + t] : d.outer;
    const size = box.max.clone().sub(box.min);
    const tol = 3 * t;
    expect(size.x).toBeGreaterThan(p.length);
    expect(Math.abs(size.x - L)).toBeLessThan(tol);
    expect(Math.abs(size.z - W)).toBeLessThan(tol);
    expect(Math.abs(size.y - H)).toBeLessThan(tol);
    // Sits on the ground (or on the sleeve's bottom panel), centred.
    expect(box.min.y).toBeCloseTo(style === 'sleeve' ? t : 0, 3);
    expect(Math.abs(box.min.x + box.max.x)).toBeLessThan(1e-6);
  });

  it('lies flat at progress 0', () => {
    const box = foldedBounds(d, 0, { thickness: p.thickness });
    expect(box.max.y - box.min.y).toBeCloseTo(p.thickness, 3);
  });

  it('cuts form closed loops', () => {
    const { cuts, folds } = computeLines(d);
    // Every hinge becomes fold line (collinear neighbours may merge into one line).
    const len = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const hingeLen = d.panels.reduce((n, x) => n + (x.hinge ? len(x.hinge[0], x.hinge[1]) : 0), 0);
    expect(folds.reduce((n, f) => n + len(f.a, f.b), 0)).toBeCloseTo(hingeLen, 3);
    const chains = chainSegments(cuts);
    const holes = d.panels.reduce((n, x) => n + (x.holes?.length ?? 0), 0);
    expect(chains.length).toBe(d.pieces.length + holes);
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

describe('sleeve', () => {
  it('wraps around the tray with the ends open', () => {
    const d = generateDieline({ ...base, style: 'sleeve' });
    const tray = foldedBounds(d, 1, { thickness: 3 }, 0);
    const sl = foldedBounds(d, 1, { thickness: 3 }, 1);
    // Same length, encloses the tray across its width and height.
    expect(sl.max.x - sl.min.x).toBeCloseTo(tray.max.x - tray.min.x, 3);
    expect(sl.min.z).toBeLessThan(tray.min.z);
    expect(sl.max.z).toBeGreaterThan(tray.max.z);
    expect(sl.min.y).toBeCloseTo(0, 3);
    expect(sl.max.y).toBeGreaterThan(tray.max.y);
  });
});

describe('gable', () => {
  it('has a handle hole in both handle panels', () => {
    const d = generateDieline({ ...base, style: 'gable' });
    expect(d.panels.filter((x) => x.holes?.length).map((x) => x.id).sort()).toEqual(['handle-back', 'handle-front']);
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
