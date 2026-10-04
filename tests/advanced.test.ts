import { describe, expect, it } from 'vitest';
import {
  BASE_ID, clone, deleteVertex, insertVertex, layout, makeChild, makeCustom, moveVertex, newDesign, overlaps,
  removePanel, sanitizeDesign, toDieline, type AdvancedDesign,
} from '../src/advanced/model';
import { foldedBounds } from '../src/geometry/fold';
import { chainSegments, computeLines } from '../src/geometry/lines';

/** A base with a wall on every side: an open tray. */
function tray(): AdvancedDesign {
  const d = newDesign();
  for (let e = 0; e < 4; e++) {
    const p = makeChild(d, BASE_ID, e)!;
    if (p.shape.type === 'rect') p.shape.depth = 50;
    d.panels.push(p);
  }
  return d;
}

describe('advanced model', () => {
  it('folds a base with four walls into an open tray', () => {
    const d = tray();
    const dl = toDieline(d);
    expect(dl.panels.length).toBe(5);
    const box = foldedBounds(dl, 1, { thickness: d.thickness });
    expect(box.max.x - box.min.x).toBeCloseTo(100, 0);
    expect(box.max.z - box.min.z).toBeCloseTo(100, 0);
    expect(box.max.y - box.min.y).toBeCloseTo(50, 0);
    const { cuts } = computeLines(dl);
    expect(chainSegments(cuts).length).toBe(1);
  });

  it('attaches children along the outward side of the parent edge', () => {
    const d = tray();
    const pl = layout(d);
    const top = pl.get(d.panels[0].id)!; // edge 0 = top edge of the base (y = 0)
    expect(Math.max(...top.poly.map((q) => q[1]))).toBeCloseTo(0, 6);
    expect(Math.min(...top.poly.map((q) => q[1]))).toBeCloseTo(-50, 6);
  });

  it('moves children with their parent', () => {
    const d = tray();
    const flap = makeChild(d, d.panels[1].id, 1)!; // on the right wall's side edge
    d.panels.push(flap);
    const before = layout(d).get(flap.id)!.poly;
    d.base.width = 150;
    const after = layout(d).get(flap.id)!.poly;
    expect(after[0][0] - before[0][0]).toBeCloseTo(50, 6);
  });

  it('detects panels that overlap on the sheet', () => {
    const d = tray();
    expect(overlaps(d)).toEqual([]);
    // Wide flaps on two walls that meet at the same corner collide.
    for (const w of [d.panels[0], d.panels[1]]) {
      const f = makeChild(d, w.id, w === d.panels[0] ? 1 : 3)!;
      if (f.shape.type === 'rect') Object.assign(f.shape, { depth: 60, taper0: 0, taper1: 0 });
      d.panels.push(f);
    }
    expect(overlaps(d).length).toBeGreaterThan(0);
  });

  it('removes a panel together with everything attached to it', () => {
    const d = tray();
    const wall = d.panels[1];
    d.panels.push(makeChild(d, wall.id, 2)!);
    removePanel(d, wall.id);
    expect(d.panels.some((p) => p.parent === wall.id || p.id === wall.id)).toBe(false);
  });

  it('edits corners and keeps children on the right edges', () => {
    const d = tray();
    const right = d.panels[1]; // on base edge 1
    const bottom = d.panels[2]; // on base edge 2
    makeCustom(d, BASE_ID);
    insertVertex(d, BASE_ID, 0, [50, -20]); // a peak on the top edge
    expect(d.base.points!.length).toBe(5);
    expect(right.edge).toBe(2);
    expect(bottom.edge).toBe(3);
    moveVertex(d, BASE_ID, 1, [50, -30]);
    expect(d.base.points![1]).toEqual([50, -30]);
    deleteVertex(d, BASE_ID, 1);
    expect(right.edge).toBe(1);
    expect(toDieline(d).panels.length).toBe(5); // every wall still attached
  });

  it('round-trips through sanitizeDesign and rejects junk', () => {
    const d = tray();
    d.panels[0].holes.push([[10, 10], [20, 10], [20, 20]]);
    expect(sanitizeDesign(clone(d))).toEqual(d);
    expect(sanitizeDesign('nope')).toBeNull();
    const evil = sanitizeDesign({ name: 'x'.repeat(1000), color: 'red;background:url(x)', thickness: 1e9, panels: [{ angle: 'a' }] })!;
    expect(evil.name.length).toBe(80);
    expect(evil.color).toBe('#c9a46b');
    expect(evil.thickness).toBe(10);
    expect(evil.panels[0].angle).toBe(90);
  });
});

describe('converting Simple boxes to Advanced designs', () => {
  const styles = ['rsc', 'tuck', 'rte', 'snaplock', 'autolock', 'sealend', 'gable', 'tray', 'traylid', 'sleeve'] as const;
  it.each(styles)('%s keeps every panel and folds to the same shape', async (style) => {
    const { generateDieline } = await import('../src/geometry/styles');
    const { fromDieline } = await import('../src/advanced/convert');
    const params = { style, length: 120, width: 80, height: 60, thickness: 2, glueTab: 15, lidHeight: 30, lidClearance: 1 };
    const original = generateDieline(params);
    const { design, skipped } = fromDieline(original, { name: style, thickness: 2, color: '#c9a46b' });
    expect(skipped).toBe(0);
    const converted = toDieline(design);
    const firstPiece = original.panels.filter((p) => p.piece === 0);
    expect(converted.panels.length).toBe(firstPiece.length);
    // Same assembled size as the original's first piece.
    const a = foldedBounds(original, 1, { thickness: 2 }, 0);
    const b = foldedBounds(converted, 1, { thickness: 2 });
    for (const k of ['x', 'y', 'z'] as const) expect(b.max[k] - b.min[k]).toBeCloseTo(a.max[k] - a.min[k], 1);
    // Same total cut and fold length.
    const total = (dl: typeof original) => {
      const { cuts, folds } = computeLines({ ...dl, panels: dl.panels.filter((p) => p.piece === 0) });
      const L = (s: { a: number[]; b: number[] }) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      return [cuts.reduce((n, s) => n + L(s), 0), folds.reduce((n, s) => n + L(s), 0)];
    };
    const [c0, f0] = total(original);
    const [c1, f1] = total(converted);
    expect(c1).toBeCloseTo(c0, 1);
    expect(f1).toBeCloseTo(f0, 1);
  });
});

describe('carrying decals over', () => {
  it.each(['tuck', 'rsc', 'gable', 'tray'] as const)('%s keeps every printable face', async (style) => {
    const { generateDieline } = await import('../src/geometry/styles');
    const { fromDieline } = await import('../src/advanced/convert');
    const original = generateDieline({ style, length: 120, width: 80, height: 60, thickness: 2, glueTab: 15, lidHeight: 30, lidClearance: 1 });
    const { design, faceIds } = fromDieline(original, { name: style, thickness: 2, color: '#c9a46b' });
    const converted = toDieline(design);
    expect(converted.faces.length).toBe(original.faces.length);
    for (const f of original.faces) {
      const g = converted.faces.find((x) => x.id === faceIds.get(f.id))!;
      expect(g.label).toBe(f.label);
      expect(g.rotation).toBe(f.rotation);
      expect(g.rect.w).toBeCloseTo(f.rect.w, 3);
      expect(g.rect.h).toBeCloseTo(f.rect.h, 3);
    }
  });
});
