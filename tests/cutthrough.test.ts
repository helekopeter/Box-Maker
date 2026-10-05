import { describe, expect, it } from 'vitest';
import { cutThrough } from '../src/advanced/cutthrough';
import { BASE_ID, layout, makeChild, newDesign, overlaps, sanitizeDesign, toDieline } from '../src/advanced/model';
import table from './fixtures/table.json';

describe('cut where panels pass through', () => {
  it('notches the corners of a table shelf where the legs go through', () => {
    const d = sanitizeDesign(table)!;
    const shelf = 'khd65jh';
    const res = cutThrough(d, shelf);
    expect(res).toEqual({ openings: 4 });
    const p = d.panels.find((x) => x.id === shelf)!;
    // Each corner loses a leg-sized square (10 mm plus clearance); the fold gets shorter.
    expect(p.shape.type).toBe('custom');
    expect(p.inset0).toBeCloseTo(10.2, 6);
    expect(p.inset1).toBeCloseTo(10.2, 6);
    expect(layout(d).get(shelf)!.poly.length).toBe(12);
    expect(overlaps(d)).toEqual([]);
    expect(() => toDieline(d)).not.toThrow();
    // Done: nothing left in the way.
    expect(cutThrough(d, shelf).openings).toBe(0);
  });

  it("leaves a panel alone when things only touch it (the table's top)", () => {
    const d = sanitizeDesign(table)!;
    expect(cutThrough(d, BASE_ID)).toEqual({ openings: 0, problem: 'Nothing passes through this panel when folded.' });
  });

  it('cuts a slot for a post passing through a lid', () => {
    // A tray with a taller left wall. An arm folds in from its top and a post hangs down from
    // the arm, through the lid that folds over from the back wall.
    const d = newDesign();
    const walls = [40, 40, 40, 60].map((depth, e) => {
      const w = makeChild(d, BASE_ID, e)!;
      w.shape = { type: 'rect', depth, taper0: 0, taper1: 0 };
      d.panels.push(w);
      return w;
    });
    const rect = (depth: number) => ({ type: 'rect' as const, depth, taper0: 0, taper1: 0 });
    const lid = { ...makeChild(d, walls[2].id, 2)!, kind: 'wall' as const, shape: rect(100), order: 2 };
    d.panels.push(lid);
    const arm = { ...makeChild(d, walls[3].id, 2, [30, 70])!, kind: 'wall' as const, shape: rect(50), angle: 90, order: 2 };
    d.panels.push(arm);
    const post = { ...makeChild(d, arm.id, 2)!, kind: 'wall' as const, shape: rect(50), angle: 90, order: 3 };
    d.panels.push(post);
    const res = cutThrough(d, lid.id);
    // The post's slot, and a strip along the edge where the taller left wall goes through.
    expect(res).toEqual({ openings: 2 });
    const holes = d.panels.find((x) => x.id === lid.id)!.holes;
    expect(holes.length).toBe(1);
    const xs = holes[0].map((q) => q[0]);
    const ys = holes[0].map((q) => q[1]);
    // As long as the post is wide (40 mm) and as thin as the board, plus clearance.
    const [w, h] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    expect(Math.max(w, h)).toBeCloseTo(40.4, 1);
    expect(Math.min(w, h)).toBeCloseTo(d.thickness + 0.4, 1);
  });
});
