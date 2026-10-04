import { describe, expect, it } from 'vitest';
import { layoutCopies } from '../src/export/sheets';
import { chainSegments, computeLines } from '../src/geometry/lines';
import { generateDieline } from '../src/geometry/styles';
import type { BoxParams, Decal } from '../src/types';

const params: BoxParams = { style: 'tray', length: 100, width: 80, height: 40, thickness: 1.5, glueTab: 15, lidHeight: 30, lidClearance: 1 };
const decal: Decal = { id: 'd1', type: 'text', face: 'front', x: 0.5, y: 0.5, size: 0.2, rotation: 0, text: 'Hi' };

const bbox = (pts: number[][]) => {
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

describe('copies on a sheet', () => {
  it('packs copies onto bed-sized sheets without overlapping', () => {
    const d = generateDieline(params);
    const { sheets, perSheet } = layoutCopies(d, { color: '#c9a46b', decals: [decal] }, 7, [600, 400]);
    expect(perSheet).toBeGreaterThanOrEqual(2);
    expect(sheets.length).toBe(Math.ceil(7 / perSheet));
    let pieces = 0;
    for (const { dieline, look } of sheets) {
      expect(dieline.width).toBeCloseTo(600, 6);
      expect(dieline.height).toBeCloseTo(400, 6);
      const ids = new Set(dieline.panels.map((p) => p.id));
      expect(ids.size).toBe(dieline.panels.length);
      // Every copy is a separate closed outline, inside the sheet, apart from the others.
      const copies = new Map<string, number[][]>();
      for (const p of dieline.panels) {
        const c = p.id.split('~')[1];
        copies.set(c, [...(copies.get(c) ?? []), ...p.poly]);
        for (const [x, y] of p.poly) {
          expect(x).toBeGreaterThanOrEqual(4.99);
          expect(y).toBeGreaterThanOrEqual(4.99);
          expect(x).toBeLessThanOrEqual(595.01);
          expect(y).toBeLessThanOrEqual(395.01);
        }
      }
      const boxes = [...copies.values()].map(bbox);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0).toBe(true);
        }
      expect(chainSegments(computeLines(dieline).cuts).length).toBe(copies.size);
      // The decal is repeated on each copy's front face.
      expect(look.decals.length).toBe(copies.size);
      for (const dc of look.decals) expect(dieline.faces.some((f) => f.id === dc.face)).toBe(true);
      pieces += copies.size;
    }
    expect(pieces).toBe(7);
  });

  it('turns pieces when that fits more on the bed', () => {
    // A long thin box: across a portrait bed it only fits turned.
    const d = generateDieline({ ...params, length: 300, width: 40, height: 20 });
    const { sheets } = layoutCopies(d, { color: '#fff', decals: [] }, 1, [250, 500]);
    const b = bbox(sheets[0].dieline.panels.flatMap((p) => p.poly));
    expect(b.y1 - b.y0).toBeGreaterThan(b.x1 - b.x0);
  });

  it('gives a box too big for the bed a sheet of its own', () => {
    const d = generateDieline({ ...params, length: 700, width: 500 });
    const { sheets, perSheet } = layoutCopies(d, { color: '#fff', decals: [] }, 2, [600, 400]);
    expect(perSheet).toBe(0);
    expect(sheets.length).toBe(2);
    expect(sheets[0].dieline.width).toBeGreaterThan(600);
  });

  it('includes every piece of a two-piece box in each copy', () => {
    const d = generateDieline({ ...params, style: 'traylid' });
    const { sheets } = layoutCopies(d, { color: '#fff', decals: [] }, 3, [800, 600]);
    const all = sheets.flatMap((s) => s.dieline.pieces.map((pc) => pc.root));
    expect(all.filter((r) => r.startsWith('lid-')).length).toBe(3);
    expect(all.length).toBe(6);
  });

  it('moves a painted texture along with each copy', () => {
    const d = generateDieline({ ...params, length: 300, width: 40, height: 20 });
    const texture = { src: 'data:image/png;base64,AAAA', width: d.width, height: d.height };
    // A portrait bed: the copies are turned, so the texture has to turn with them.
    const { sheets } = layoutCopies(d, { color: '#fff', decals: [], texture }, 2, [250, 800]);
    const { dieline, look } = sheets[0];
    expect(look.texture!.parts!.length).toBe(2);
    for (const part of look.texture!.parts!) {
      const [a, b, c, dd, e, f] = part.matrix;
      for (const id of part.panels) {
        const copy = dieline.panels.find((p) => p.id === id)!;
        const orig = d.panels.find((p) => p.id === id.split('~')[0])!;
        orig.poly.forEach(([x, y], i) => {
          expect(a * x + c * y + e).toBeCloseTo(copy.poly[i][0], 6);
          expect(b * x + dd * y + f).toBeCloseTo(copy.poly[i][1], 6);
        });
      }
    }
  });
});
