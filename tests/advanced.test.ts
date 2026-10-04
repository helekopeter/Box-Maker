import { describe, expect, it } from 'vitest';
import {
  BASE_ID, clone, deleteVertex, freeSpans, insertVertex, layout, makeChild, makeCustom, moveVertex, newDesign, overlaps,
  removePanel, sanitizeDesign, toDieline, type AdvancedDesign,
} from '../src/advanced/model';
import { foldedBounds } from '../src/geometry/fold';
import { chainSegments, computeLines } from '../src/geometry/lines';

import chair from './fixtures/chair.json';

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

describe('layers', () => {
  it('ignores the layer of a panel that does not lie against anything', () => {
    const d = tray();
    // Flaps on top of each wall, folded inwards over the wall tops.
    for (const w of d.panels.slice(0, 4)) {
      const f = makeChild(d, w.id, 2)!;
      f.layer = -1;
      d.panels.push(f);
    }
    const dl = toDieline(d);
    for (const p of dl.panels.filter((x) => x.parent && x.parent !== BASE_ID)) expect(p.offset).toBe(0);
  });

  it('keeps the layer of a glue tab that lies inside a neighbouring wall', async () => {
    const { EXAMPLES } = await import('../src/universe/examples');
    const ex = EXAMPLES.find((e) => e.name === 'Pentagon box')!;
    if (ex.data.kind !== 'advanced') throw new Error();
    const dl = toDieline(ex.data.design);
    const tabs = dl.panels.filter((p) => p.kind === 'glue');
    expect(tabs.length).toBe(5);
    for (const t of tabs) expect(t.offset).toBe(-1);
  });
});

describe('walls vs flaps', () => {
  it('only lets walls and the base carry other panels', () => {
    const d = tray();
    const wall = d.panels[0];
    const flap = makeChild(d, wall.id, 2)!;
    expect(flap.kind).toBe('flap');
    d.panels.push(flap);
    expect(makeChild(d, flap.id, 1)).toBeNull();
    const glue = makeChild(d, wall.id, 1)!;
    glue.kind = 'glue';
    d.panels.push(glue);
    expect(makeChild(d, glue.id, 2)).toBeNull();
    expect(makeChild(d, wall.id, 3)).not.toBeNull();
  });

  it('turns flaps that carry panels into walls when loading or converting', async () => {
    const d = tray();
    const flap = makeChild(d, d.panels[0].id, 2)!;
    d.panels.push(flap);
    d.panels.push({ ...makeChild(d, d.panels[1].id, 2)!, parent: flap.id, edge: 1 });
    expect(sanitizeDesign(clone(d))!.panels.find((p) => p.id === flap.id)!.kind).toBe('wall');
    const { generateDieline } = await import('../src/geometry/styles');
    const { fromDieline } = await import('../src/advanced/convert');
    const { design } = fromDieline(generateDieline({ style: 'autolock', length: 100, width: 80, height: 60, thickness: 2, glueTab: 15, lidHeight: 30, lidClearance: 1 }), { name: 'a', thickness: 2, color: '#c9a46b' });
    for (const p of design.panels) if (design.panels.some((c) => c.parent === p.id)) expect(p.kind).toBe('wall');
  });

  it('fits several panels side by side on one edge (a chair with two legs on one side)', () => {
    // An uploaded chair: a seat rim with one leg drawn on the first 10 mm of its outer edge.
    const d = sanitizeDesign(chair)!;
    const rim = 'w1tvgfk';
    expect(freeSpans(d, rim, 2)).toEqual([[10, 100]]);
    expect(freeSpans(d, rim, 0)).toEqual([]); // its own hinge

    // A second leg at the far end, then a third panel in the gap between them.
    const leg = makeChild(d, rim, 2, [90, 100])!;
    expect([leg.inset0, leg.inset1]).toEqual([90, 0]);
    d.panels.push(leg);
    expect(freeSpans(d, rim, 2)).toEqual([[10, 90]]);
    const mid = makeChild(d, rim, 2, [10, 90])!;
    d.panels.push(mid);
    expect(freeSpans(d, rim, 2)).toEqual([]);

    const placed = layout(d);
    expect(placed.has(leg.id) && placed.has(mid.id)).toBe(true);
    // Every hinge becomes a fold (nothing is cut along the shared edge) and the outline is
    // still one closed cut.
    const length = (segs: { a: number[]; b: number[] }[]) => segs.reduce((t, g) => t + Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]), 0);
    const hinges = [...placed.values()].reduce((t, pl) => t + pl.hinge, 0);
    const { cuts, folds } = computeLines(toDieline(d));
    expect(length(folds)).toBeCloseTo(hinges, 3);
    expect(chainSegments(cuts).length).toBe(1);
  });
});
