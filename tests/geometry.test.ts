import { describe, expect, it } from 'vitest';
import { generateDieline } from '../src/geometry/styles';
import { Vector3 } from 'three';
import { foldedBounds, foldMatrices } from '../src/geometry/fold';
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
const styles: BoxStyle[] = ['rsc', 'tuck', 'rte', 'snaplock', 'autolock', 'sealend', 'gable', 'tray', 'traylid', 'mailer', 'matchbox', 'hexagon', 'cigarette'];
const twoPiece = (s: BoxStyle) => s === 'traylid' || s === 'matchbox';

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
    // (The matchbox drawer's side walls are double: wall, ear and inner panel.)
    const [L, W, H] = twoPiece(style) ? [p.length + (style === 'matchbox' ? 6 : 2) * t, p.width + 2 * t, p.height + t] : d.outer;
    const size = box.max.clone().sub(box.min);
    const tol = 3 * t;
    expect(size.x).toBeGreaterThan(p.length);
    expect(Math.abs(size.x - L)).toBeLessThan(tol);
    expect(Math.abs(size.z - W)).toBeLessThan(tol);
    expect(Math.abs(size.y - H)).toBeLessThan(tol);
    // Sits on the ground (or on the sleeve's bottom panel), centred.
    expect(box.min.y).toBeCloseTo(style === 'matchbox' ? t : 0, 3);
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
    const closed = (c: number[][]) => Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 1e-3;
    if (chains.every(closed)) {
      expect(chains.length).toBe(d.pieces.length + holes);
    } else {
      // A cut inside a piece (like a flip-top lid's) runs from the outline to a fold or
      // another cut: every loose end meets another line.
      expect(chains.length).toBeGreaterThan(d.pieces.length + holes);
      const onSegment = (a: number[], b: number[], p: number[]) => {
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(a[0] + k * dx - p[0], a[1] + k * dy - p[1]) < 1e-3;
      };
      const meets = (c: number[][], end: number[]) =>
        folds.some((f) => onSegment(f.a, f.b, end)) ||
        chains.some((o) => o.some((q, i) => i > 0 && (o !== c || (i > 1 && i < o.length - 1)) && onSegment(o[i - 1], q, end)));
      for (const c of chains.filter((c) => !closed(c))) for (const end of [c[0], c[c.length - 1]]) expect(meets(c, end)).toBe(true);
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

describe('matchbox sleeve', () => {
  it('wraps around the drawer with the ends open', () => {
    const d = generateDieline({ ...base, style: 'matchbox' });
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

describe('matchbox', () => {
  it('has a drawer that fits inside the sleeve, and thumb notches', () => {
    const d = generateDieline({ ...base, style: 'matchbox' });
    const drawer = foldedBounds(d, 1, { thickness: 3 }, 0);
    const sl = foldedBounds(d, 1, { thickness: 3 }, 1);
    expect(sl.min.z).toBeLessThan(drawer.min.z);
    expect(sl.max.z).toBeGreaterThan(drawer.max.z);
    expect(sl.max.y).toBeGreaterThan(drawer.max.y);
    expect(d.panels.find((x) => x.id === 'sleeve-top')!.poly.length).toBeGreaterThan(4);
  });

  it('can leave out the thumb notches', () => {
    const d = generateDieline({ ...base, style: 'matchbox', notches: false });
    expect(d.panels.find((x) => x.id === 'sleeve-top')!.poly.length).toBe(4);
    expect(d.panels.find((x) => x.id === 'sleeve-bottom')!.poly.length).toBe(4);
  });
});

describe('hexagon', () => {
  it('has six equal sides and a hexagonal lid', () => {
    const d = generateDieline({ ...base, style: 'hexagon' });
    const box = foldedBounds(d, 1, { thickness: 3 });
    const size = box.max.clone().sub(box.min);
    // Across the corners is 2/√3 times across the flats.
    expect(size.x / size.z).toBeCloseTo(2 / Math.sqrt(3), 1);
    expect(d.panels.find((x) => x.id === 'top')!.poly.length).toBe(6);
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

describe('cigarette', () => {
  const d = generateDieline({ ...base, style: 'cigarette' });
  it('has a lid cut across the front and sides, hinged at the back', () => {
    const lidBack = d.panels.find((x) => x.id === 'lid-back')!;
    expect(lidBack.parent).toBe('back');
    expect(lidBack.open).toBeLessThan(0);
    // Closed at the end of the animation, folded flat at the start.
    expect(lidBack.timeline![0][1]).toBe(0);
    expect(lidBack.timeline![lidBack.timeline!.length - 1][1]).toBe(0);
    expect(d.panels.find((x) => x.id === 'lid-front')!.parent).toBe('lid-right');
  });

  it('glues the collar inside the front, standing up into the lid', () => {
    const t = base.thickness;
    const shell = foldedBounds(d, 1, { thickness: t }, 0);
    const collar = foldedBounds(d, 1, { thickness: t }, 1);
    // Inside the shell, behind the front, and reaching above the body (into the lid).
    expect(collar.min.x).toBeGreaterThan(shell.min.x);
    expect(collar.max.x).toBeLessThan(shell.max.x);
    expect(collar.max.y).toBeLessThan(shell.max.y);
    // Its top is above the bottom edge of the lid's front.
    const m = foldMatrices(d, 1, { thickness: t }).get('lid-front')!;
    const lidBottom = Math.min(...d.panels.find((x) => x.id === 'lid-front')!.poly.map(([x, y]) => new Vector3(x, -y, 0).applyMatrix4(m).y));
    expect(collar.max.y).toBeGreaterThan(lidBottom + 1);
    expect(collar.max.z).toBeLessThan(shell.max.z);
  });
});
