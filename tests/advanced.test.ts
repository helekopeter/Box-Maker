import { describe, expect, it } from 'vitest';
import {
  addTabJoints, BASE_ID, clone, copySubtree, deleteVertex, flipPanel, freeSpans, mirrorCopy, insertVertex, layout, makeChild, makeCustom, moveVertex, newDesign, overlaps,
  rawPanels, removePanel, sanitizeDesign, setEdgeLength, toDieline, type AdvancedDesign,
} from '../src/advanced/model';
import { Vector3 } from 'three';
import { foldedBounds, localMatrices } from '../src/geometry/fold';
import { pointInPoly } from '../src/geometry/surface';
import type { Dieline } from '../src/types';
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

  it('mirrors a leg (and the walls on it) to the other end of the edge', () => {
    const d = sanitizeDesign(chair)!;
    const before = layout(d);
    const n = d.panels.length;
    const copy = mirrorCopy(d, 'sibonfo')!;
    expect(copy).toBeTruthy();
    expect(d.panels.length).toBe(n + 4);
    // The rim's outer edge runs along x = 108 from y = 100 to y = 0, so mirroring along it
    // maps y to 100 - y. Every corner of the copy matches a mirrored corner of the original.
    const after = layout(d);
    const key = (q: number[]) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`;
    const orig = new Set(['sibonfo', 'ppce5mw', 'wwin6g2', 'iufk89m'].flatMap((id) => before.get(id)!.poly.map((q) => key([q[0], 100 - q[1]]))));
    const copied = new Set(d.panels.slice(n).flatMap((p) => after.get(p.id)!.poly.map(key)));
    expect(copied).toEqual(orig);
    // Nothing left to mirror into: a second mirror copy finds the spot taken.
    expect(mirrorCopy(d, 'sibonfo')).toBeNull();
    expect(overlaps(d)).toEqual([]);
  });

  it('flips in place and duplicates onto another edge', () => {
    const d = sanitizeDesign(chair)!;
    const snapshot = JSON.stringify(layout(d).get('iufk89m')!.poly);
    flipPanel(d, 'sibonfo');
    expect(JSON.stringify(layout(d).get('iufk89m')!.poly)).not.toBe(snapshot);
    flipPanel(d, 'sibonfo');
    const back = layout(d).get('iufk89m')!.poly.map((q) => q.map((v) => Math.round(v * 1000) / 1000));
    expect(back).toEqual(JSON.parse(snapshot).map((q: number[]) => q.map((v) => Math.round(v * 1000) / 1000)));

    const id = copySubtree(d, 'sibonfo', 'w1tvgfk', 2, 45)!;
    const root = d.panels.find((p) => p.id === id)!;
    expect([root.inset0, root.inset1]).toEqual([45, 45]);
    expect(d.panels.filter((p) => p.parent === id).length).toBe(1);
    expect(layout(d).size).toBe(1 + d.panels.length);
  });

  it('sets edge lengths typed into the dimension labels', () => {
    const d = tray();
    const wall = d.panels[0]; // on the base's top edge
    const len = (id: string, k: number) => {
      const poly = layout(d).get(id)!.poly;
      const [a, b] = [poly[k], poly[(k + 1) % poly.length]];
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    expect(setEdgeLength(d, BASE_ID, 0, 120)).toBe(true);
    expect(d.base.width).toBe(120);
    expect(setEdgeLength(d, wall.id, 1, 35)).toBe(true);
    expect(len(wall.id, 1)).toBeCloseTo(35, 6);
    expect(setEdgeLength(d, wall.id, 2, 100)).toBe(true);
    expect(len(wall.id, 2)).toBeCloseTo(100, 6);
    expect(wall.shape.type === 'rect' && wall.shape.depth).toBeCloseTo(35, 6); // narrowing keeps the depth
    expect(setEdgeLength(d, wall.id, 0, 80)).toBe(true);
    expect(len(wall.id, 0)).toBeCloseTo(80, 6);
    makeCustom(d, wall.id);
    expect(setEdgeLength(d, wall.id, 2, 50)).toBe(true);
    expect(len(wall.id, 2)).toBeCloseTo(50, 6);
    expect(setEdgeLength(d, wall.id, 0, 60)).toBe(true);
  });

  it('adds tabs where an edge stands on another panel, with matching slots', () => {
    // A wall, a shelf folding in from its top, and a divider folding down from the shelf's
    // far edge onto the middle of the base.
    const d = newDesign();
    const wall = makeChild(d, BASE_ID, 0)!;
    wall.shape = { type: 'rect', depth: 50, taper0: 0, taper1: 0 };
    d.panels.push(wall);
    const shelf = { ...makeChild(d, wall.id, 2)!, kind: 'wall' as const, shape: { type: 'rect' as const, depth: 50, taper0: 0, taper1: 0 } };
    d.panels.push(shelf);
    const divider = { ...makeChild(d, shelf.id, 2)!, kind: 'wall' as const, shape: { type: 'rect' as const, depth: 50, taper0: 0, taper1: 0 } };
    d.panels.push(divider);
    expect(addTabJoints(d, divider.id)).toBe(2);
    expect(d.base.holes.length).toBe(2);
    // Each tab sticks out of the divider's free edge and, folded, passes through its slot.
    const dl = toDieline(d);
    const { cuts } = computeLines(dl);
    expect(chainSegments(cuts).length).toBe(3); // outline + two slots
    const poly = layout(d).get(divider.id)!.poly;
    expect(poly.length).toBe(4 + 8);
    // The slots sit half way across the base (where the divider stands), 100 mm wide edge.
    for (const h of d.base.holes) {
      const ys = h.map((q) => q[1]);
      expect(Math.min(...ys)).toBeGreaterThan(44);
      expect(Math.max(...ys)).toBeLessThan(56);
    }
    // Folded, the corners of each tab's tip (the divider's outermost points) lie in a slot.
    const mats = localMatrices({ panels: rawPanels(d).map((p) => ({ ...p, offset: 0 })) } as Dieline, 1);
    const inv = mats.get(BASE_ID)!.clone().invert();
    const top = Math.min(...poly.map((q) => q[1]));
    const tips = poly.filter((q) => Math.abs(q[1] - top) < 1e-6);
    expect(tips.length).toBe(4);
    for (const q of tips) {
      const v = new Vector3(q[0], -q[1], 0).applyMatrix4(mats.get(divider.id)!).applyMatrix4(inv);
      expect(d.base.holes.some((h) => pointInPoly([v.x + 0.01, -v.y], h) || pointInPoly([v.x - 0.01, -v.y], h))).toBe(true);
    }
    // Nothing to join on a panel that doesn't stand on anything.
    expect(addTabJoints(d, wall.id)).toBe(0);
  });
});
