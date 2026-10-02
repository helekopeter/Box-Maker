import { describe, expect, it } from 'vitest';
import { decalPieces, setDecalCenter } from '../src/artwork';
import { generateDieline } from '../src/geometry/styles';
import { angleOf, apply, faceGraph, unfoldFrom, wrapPoint } from '../src/geometry/surface';
import type { BoxParams, BoxStyle, Decal } from '../src/types';

const params = (style: BoxStyle): BoxParams => ({
  style, length: 100, width: 80, height: 60, thickness: 2, glueTab: 15, lidHeight: 30, lidClearance: 1,
});
const neighbours = (style: BoxStyle, id: string) =>
  faceGraph(generateDieline(params(style))).get(id)!.neighbours.map((n) => n.id).sort();

describe('face graph', () => {
  it('connects every wall of a tuck box, including across the glue seam and lid edges', () => {
    expect(neighbours('tuck', 'front')).toEqual(['bottom', 'left', 'right', 'top']);
    expect(neighbours('tuck', 'top')).toEqual(['back', 'front', 'left', 'right']);
  });

  it('connects the two halves of a shipping box top', () => {
    expect(neighbours('rsc', 'front-top')).toContain('back-top');
    expect(neighbours('rsc', 'front-top')).toContain('front');
  });

  it('connects tray walls at the corners and keeps the lid separate', () => {
    expect(neighbours('traylid', 'front')).toEqual(['bottom', 'left', 'right']);
    expect(neighbours('traylid', 'lid-bottom')).toEqual(['lid-back', 'lid-front', 'lid-left', 'lid-right']);
  });

  it('unfolds sheet neighbours with the identity and folded neighbours with a real transform', () => {
    const d = generateDieline(params('tuck'));
    const maps = unfoldFrom(d, 'front');
    expect(maps.get('right')).toEqual([1, 0, 0, 1, 0, 0]);
    const front = d.faces.find((f) => f.id === 'front')!;
    const left = d.faces.find((f) => f.id === 'left')!;
    // Just left of the front panel is the right-hand edge of the left panel.
    const p = apply(maps.get('left')!, [front.rect.x - 1, front.rect.y + 10]);
    expect(p[0]).toBeCloseTo(left.rect.x + left.rect.w - 1, 6);
    expect(p[1]).toBeCloseTo(front.rect.y + 10, 6);
    // The lid is attached to the back, so seen from the front it is upside down on the sheet.
    expect(Math.abs(angleOf(maps.get('top')!))).toBeCloseTo(180, 6);
  });
});

describe('wrapping decals', () => {
  it('splits a decal across the glue seam', () => {
    const d = generateDieline(params('tuck'));
    const front = d.faces.find((f) => f.id === 'front')!;
    const dc: Decal = { id: 'a', type: 'image', face: 'front', x: 0, y: 0.5, size: 30, rotation: 0, aspect: 1, src: 'x' };
    setDecalCenter(front, dc, [front.rect.x, front.rect.y + front.rect.h / 2]);
    expect(decalPieces(d, dc).map((p) => p.face.id).sort()).toEqual(['front', 'left']);
  });

  it('moves a point past the edge onto the neighbouring face', () => {
    const d = generateDieline(params('tuck'));
    const front = d.faces.find((f) => f.id === 'front')!;
    const w = wrapPoint(d, 'front', [front.rect.x + 20, front.rect.y - 5]);
    expect(w.face).toBe('top');
  });
});
