import type { BoxParams, Dieline, Face, Panel, Vec2 } from '../types';
import { arc, bounds, edgeTab, glueTabPoly, rect, slot } from './shapes';

/**
 * Folding cartons: four walls in a row joined by a glue seam, with an interchangeable
 * closure at each end. On the sheet the walls run front, right, back, left, then the
 * glue tab. The body spans y = 0..H; the top closure extends to negative y and the bottom
 * closure beyond H (the layout is normalised afterwards).
 */
export type Closure = 'tuck-back' | 'tuck-front' | 'seal' | 'snaplock' | 'autolock' | 'gable';

type Wall = 'front' | 'right' | 'back' | 'left';

interface Body {
  t: number;
  L: number;
  W: number;
  H: number;
  x: Record<Wall | 'end', number>;
  panels: Panel[];
  faces: Face[];
  /** Height added above the walls when assembled (gable roof + handle). */
  extraHeight: number;
}

interface End {
  top: boolean;
  name: 'top' | 'bottom';
  /** Sheet point at x, distance v away from the body edge. */
  at: (x: number, v: number) => Vec2;
  poly: (pts: [number, number][]) => Vec2[];
}

function end(b: Body, top: boolean): End {
  const hy = top ? 0 : b.H;
  const dir = top ? -1 : 1;
  const at = (x: number, v: number): Vec2 => [x, hy + dir * v];
  return { top, name: top ? 'top' : 'bottom', at, poly: (pts) => pts.map(([x, v]) => at(x, v)) };
}

function body(p: BoxParams): Body {
  const t = p.thickness;
  const L = p.length + t;
  const W = p.width + t;
  const H = p.height + 2 * t;
  const x = { front: 0, right: L, back: L + W, left: 2 * L + W, end: 2 * L + 2 * W };
  const walls: [Wall, number, Wall | null][] = [
    ['front', L, null],
    ['right', W, 'front'],
    ['back', L, 'right'],
    ['left', W, 'back'],
  ];
  const panels: Panel[] = [];
  const faces: Face[] = [];
  for (const [id, w, parent] of walls) {
    const x0 = x[id];
    panels.push({
      id,
      piece: 0,
      kind: 'face',
      poly: rect(x0, 0, w, H),
      ...(parent ? { parent, hinge: [[x0, 0], [x0, H]] as [Vec2, Vec2], angle: 90, stage: 1 } : {}),
    });
    faces.push({ id, label: id[0].toUpperCase() + id.slice(1), rect: { x: x0, y: 0, w, h: H }, rotation: 0 });
  }
  panels.push({
    id: 'glue', piece: 0, kind: 'glue', poly: glueTabPoly(x.end, 0, H, p.glueTab, 1),
    parent: 'left', hinge: [[x.end, 0], [x.end, H]], angle: 90, stage: 1, offset: -1,
  });
  return { t, L, W, H, x, panels, faces, extraHeight: 0 };
}

/**
 * Dust flaps on the two side walls, tucked under a lid. At the end next to the wall the
 * tuck flap slides down behind, they stop short to leave room for it.
 */
function dustFlaps(b: Body, e: End, tuckInto: 'front' | 'back') {
  const { L, W, t } = b;
  const D = Math.min(L * 0.42, Math.max(10, W * 0.7));
  const s = Math.min(W * 0.25, D * 0.35);
  const r = Math.min(t / 2, 1); // relief so the flap clears the neighbouring hinges
  const gap = 2.5 * t + 1; // room for the tuck flap between wall and dust flap
  for (const side of ['right', 'left'] as const) {
    const x = b.x[side];
    // On the sheet the right wall starts at the front corner, the left wall at the back.
    const tuckAtStart = (side === 'right') === (tuckInto === 'front');
    const r0 = tuckAtStart ? gap : r;
    const r1 = tuckAtStart ? r : gap;
    b.panels.push({
      id: `${side}-dust-${e.name}`, piece: 0, kind: 'flap',
      poly: e.poly([
        [x + r0, 0], [x + r0, D * 0.25], [x + Math.max(s, r0), D],
        [x + W - Math.max(s, r1), D], [x + W - r1, D * 0.25], [x + W - r1, 0],
      ]),
      parent: side, hinge: [e.at(x + r0, 0), e.at(x + W - r1, 0)], angle: 90, stage: 2, offset: -1,
    });
  }
}

/** Tuck lid hinged on the back (or front) wall, with a rounded tuck flap and dust flaps. */
function tuckEnd(b: Body, e: End, attach: 'back' | 'front') {
  const { L, W, H, t } = b;
  const T = Math.min(Math.max(10, W * 0.6), 40, H * 0.8);
  const i = Math.min(t, 1.5); // side inset so the tuck slides in
  const R = Math.min(T * 0.8, (L - 2 * i) / 3);
  const x0 = b.x[attach];
  dustFlaps(b, e, attach === 'back' ? 'front' : 'back');
  const lid = e.poly([[x0, 0], [x0 + L, 0], [x0 + L, W], [x0, W]]);
  b.panels.push({
    id: e.name, piece: 0, kind: 'face', poly: lid,
    parent: attach, hinge: [e.at(x0, 0), e.at(x0 + L, 0)], angle: 90, stage: 3,
  });
  // Rounded tuck flap, drawn in (x, v) space where v grows away from the body.
  const tx0 = x0 + i;
  const tx1 = x0 + L - i;
  const pts: [number, number][] = [
    [tx0, W],
    [tx0, W + T - R],
    ...arc(tx0 + R, W + T - R, R, Math.PI, Math.PI / 2),
    [tx1 - R, W + T],
    ...arc(tx1 - R, W + T - R, R, Math.PI / 2, 0),
    [tx1, W],
  ];
  b.panels.push({
    id: `${e.name}-tuck`, piece: 0, kind: 'flap', poly: e.poly(pts),
    parent: e.name, hinge: [e.at(tx0, W), e.at(tx1, W)], stage: 3, offset: -1,
    motion: tuckMotion(W, T, t),
  });
  // A lid on the back reads upside down on the sheet; one on the front doesn't.
  b.faces.push({
    id: e.name, label: e.top ? 'Top' : 'Bottom', rect: bounds(lid), rotation: attach === 'back' ? 180 : 0,
  });
}

/**
 * Fold path for a tuck flap that closes together with its lid (same stage, lid angle
 * 90°·ease(t)). Once the flap's tip would dip below the top of the walls, its angle is
 * chosen so the tip slides down just behind the inside of the opposite wall, which is how
 * the flap goes in when you close the lid by hand. Before that it bends in gradually.
 */
function tuckMotion(W: number, T: number, t: number): [number, number][] {
  const rad = Math.PI / 180;
  const c = 1.25 * t + 0.25; // how far behind the wall's outer face the tip slides
  const ease = (x: number) => x * x * (3 - 2 * x);
  // Tuck angle (relative to the lid, deg) that puts the tip at depth c, or null if the
  // lid is still too far open for the tip to reach that plane.
  const sliding = (a: number): number | null => {
    const cosPhi = (W * (1 - Math.sin(a * rad)) - c) / T;
    if (cosPhi >= 1) return null;
    const phi = Math.acos(Math.max(-1, cosPhi)) / rad;
    // phi is the tuck's direction below horizontal-forward; tip height relative to the walls:
    const tipY = W * Math.cos(a * rad) - T * Math.sin(phi * rad);
    return tipY < 0 ? phi - a + 90 : null;
  };
  const N = 48;
  const samples = Array.from({ length: N + 1 }, (_, i) => i / N);
  const a0Index = samples.findIndex((s) => sliding(90 * ease(s)) !== null);
  const a0 = a0Index < 0 ? 90 : 90 * ease(samples[a0Index]);
  const theta0 = a0Index < 0 ? 90 : sliding(a0)!;
  const keys = samples.map((s): [number, number] => {
    const a = 90 * ease(s);
    const theta = a < a0 ? theta0 * ease(a / a0) : sliding(a) ?? theta0;
    return [s, theta];
  });
  keys[keys.length - 1] = [1, 90];
  return keys;
}

/** Seal end: side flaps fold in, then the back and front flaps fold over and are glued. */
function sealEnd(b: Body, e: End) {
  const { L, W } = b;
  const Dm = Math.min(W * 0.5, L * 0.45);
  const s = Math.min(Dm * 0.4, W * 0.15);
  for (const side of ['right', 'left'] as const) {
    const x = b.x[side];
    b.panels.push({
      id: `${side}-minor-${e.name}`, piece: 0, kind: 'flap',
      poly: e.poly([[x, 0], [x + s, Dm], [x + W - s, Dm], [x + W, 0]]),
      parent: side, hinge: [e.at(x, 0), e.at(x + W, 0)], angle: 90, stage: 2, offset: -2,
    });
  }
  const xb = b.x.back;
  // The inner (back) flap is fully covered by the outer one: glue goes on all of it.
  b.panels.push({
    id: `back-major-${e.name}`, piece: 0, kind: 'glue', poly: e.poly([[xb, 0], [xb + L, 0], [xb + L, W], [xb, W]]),
    parent: 'back', hinge: [e.at(xb, 0), e.at(xb + L, 0)], angle: 90, stage: 3, offset: -1,
  });
  const front = e.poly([[0, 0], [L, 0], [L, W], [0, W]]);
  b.panels.push({
    id: e.name, piece: 0, kind: 'face', poly: front,
    parent: 'front', hinge: [e.at(0, 0), e.at(L, 0)], angle: 90, stage: 4,
  });
  b.faces.push({ id: e.name, label: e.top ? 'Top' : 'Bottom', rect: bounds(front), rotation: 0 });
}

/**
 * 1-2-3 snap-lock bottom: (1) side flaps fold in, (2) the notched back flap folds over
 * them, (3) the front flap's tongue is pushed through the notch to lock it. No glue.
 */
function snapLock(b: Body, e: End) {
  const { L, W, t } = b;
  const Ds = Math.min(L * 0.35, W * 0.5);
  const s = Math.min(Ds * 0.5, W * 0.2);
  for (const side of ['right', 'left'] as const) {
    const x = b.x[side];
    b.panels.push({
      id: `${side}-lock-${e.name}`, piece: 0, kind: 'flap',
      poly: e.poly([[x, 0], [x + s, Ds], [x + W - s, Ds], [x + W, 0]]),
      parent: side, hinge: [e.at(x, 0), e.at(x + W, 0)], angle: 90, stage: 2, offset: -2,
    });
  }
  const i = t;
  const tw = L * 0.34;
  // (2) back flap with a notch the tongue slips through.
  const xb = b.x.back;
  const dB = W * 0.55;
  const nw = tw + 2 * t;
  const nd = Math.min(W * 0.2, dB * 0.5);
  const xc = xb + L / 2;
  b.panels.push({
    id: `back-lock-${e.name}`, piece: 0, kind: 'flap',
    poly: e.poly([
      [xb + i, 0], [xb + i, dB], [xc - nw / 2, dB], [xc - nw / 2, dB - nd],
      [xc + nw / 2, dB - nd], [xc + nw / 2, dB], [xb + L - i, dB], [xb + L - i, 0],
    ]),
    parent: 'back', hinge: [e.at(xb + i, 0), e.at(xb + L - i, 0)], angle: 90, stage: 3, offset: -1,
  });
  // (3) front flap with the locking tongue.
  const dF = W * 0.5;
  const tl = W * 0.3;
  const c = Math.min(tl * 0.4, tw * 0.2);
  const mid = L / 2;
  b.panels.push({
    id: `front-lock-${e.name}`, piece: 0, kind: 'flap',
    poly: e.poly([
      [i, 0], [i, dF], [mid - tw / 2, dF], [mid - tw / 2, dF + tl - c], [mid - tw / 2 + c, dF + tl],
      [mid + tw / 2 - c, dF + tl], [mid + tw / 2, dF + tl - c], [mid + tw / 2, dF], [L - i, dF], [L - i, 0],
    ]),
    parent: 'front', hinge: [e.at(i, 0), e.at(L - i, 0)], angle: 90, stage: 4,
  });
}

/**
 * Auto-lock (crash-lock) bottom. The front and back flaps each carry a glue triangle
 * behind a 45° fold; glue it onto the side flap next to it once, and afterwards the
 * bottom folds flat with the box and snaps into place when the box is opened.
 */
function autoLock(b: Body, e: End) {
  const { L, W } = b;
  const dB = L * 0.5;
  const s = Math.min(W * 0.2, dB * 0.3);
  for (const side of ['right', 'left'] as const) {
    const x = b.x[side];
    b.panels.push({
      id: `${side}-auto-${e.name}`, piece: 0, kind: 'flap',
      poly: e.poly([[x, 0], [x + s, dB], [x + W - s, dB], [x + W, 0]]),
      // Side flaps close last so they end up outermost, over the glue triangles.
      parent: side, hinge: [e.at(x, 0), e.at(x + W, 0)], angle: 90, stage: 3,
    });
  }
  // Inset from the corners so the flaps swing up inside the side flaps hanging below.
  const i = b.t;
  const dA = Math.min(W * 0.6, (L - 2 * i) * 0.6);
  for (const wall of ['front', 'back'] as const) {
    const x0 = b.x[wall] + i;
    const x1 = b.x[wall] + L - i;
    const id = `${wall}-auto-${e.name}`;
    b.panels.push({
      id, piece: 0, kind: 'flap',
      poly: e.poly([[x0, 0], [x1, 0], [x1 - dA, dA], [x0, dA]]),
      parent: wall, hinge: [e.at(x0, 0), e.at(x1, 0)], angle: 90, stage: 2, offset: -1,
    });
    // Glue triangle beyond the diagonal fold; it is glued to the side flap on its right.
    b.panels.push({
      id: `${id}-glue`, piece: 0, kind: 'glue',
      poly: e.poly([[x1, 0], [x1, dA], [x1 - dA, dA]]),
      parent: id, hinge: [e.at(x1, 0), e.at(x1 - dA, dA)], angle: 0, stage: 2, offset: -1,
    });
  }
}

/**
 * Gable top: the side walls rise to a triangular gable, the front and back roof panels
 * lean in at 45° to meet at the ridge, and continue up into a double-layer handle.
 */
function gableTop(b: Body, _e: End) {
  const { L, W } = b;
  const h = W / 2; // ridge height above the walls
  const R = W / Math.SQRT2; // roof slope length
  const Hh = Math.min(Math.max(W * 0.5, 25), 60); // handle height
  const gt = Math.min(12, W * 0.15);
  for (const side of ['right', 'left'] as const) {
    const x = b.x[side];
    const wall = b.panels.find((p) => p.id === side)!;
    const apex: Vec2 = [x + W / 2, -h];
    wall.poly = [[x, 0], apex, [x + W, 0], [x + W, b.H], [x, b.H]];
    const centre: Vec2 = [x + W / 2, -h / 3];
    for (const [k, [p0, p1]] of ([[[x, 0], apex], [apex, [x + W, 0]]] as [Vec2, Vec2][]).entries()) {
      b.panels.push({
        id: `${side}-gable-tab-${k}`, piece: 0, kind: 'glue', poly: edgeTab(p0, p1, gt, centre),
        parent: side, hinge: [p0, p1], angle: 90, stage: 3, offset: -1,
      });
    }
  }
  const hw = Math.max(20, Math.min(L * 0.5, 90, L - 16));
  const hh = Math.min(Hh * 0.4, 22);
  for (const wall of ['front', 'back'] as const) {
    const x = b.x[wall];
    const roof = rect(x, -R, L, R);
    b.panels.push({
      id: `roof-${wall}`, piece: 0, kind: 'face', poly: roof,
      parent: wall, hinge: [[x, 0], [x + L, 0]], angle: 45, stage: 4,
    });
    const handle = rect(x, -R - Hh, L, Hh);
    b.panels.push({
      id: `handle-${wall}`, piece: 0, kind: 'face', poly: handle,
      holes: [slot(x + L / 2, -R - Hh * 0.55, hw, hh)],
      // Folds back out by 45° so the handle stands upright; nudged outwards so the
      // two handle layers sit back to back instead of inside each other.
      parent: `roof-${wall}`, hinge: [[x, -R], [x + L, -R]], angle: -45, stage: 4, offset: 1,
    });
    const label = wall === 'front' ? 'front' : 'back';
    b.faces.push({ id: `roof-${wall}`, label: `Roof (${label})`, rect: bounds(roof), rotation: 0 });
    b.faces.push({ id: `handle-${wall}`, label: `Handle (${label})`, rect: bounds(handle), rotation: 0 });
  }
  b.extraHeight = h + Hh;
}

const CLOSURES: Record<Closure, (b: Body, e: End) => void> = {
  'tuck-back': (b, e) => tuckEnd(b, e, 'back'),
  'tuck-front': (b, e) => tuckEnd(b, e, 'front'),
  seal: sealEnd,
  snaplock: snapLock,
  autolock: autoLock,
  gable: gableTop,
};

/** Builds a carton; the caller normalises the layout. */
export function carton(p: BoxParams, top: Closure, bottom: Closure): Dieline {
  const b = body(p);
  CLOSURES[top](b, end(b, true));
  CLOSURES[bottom](b, end(b, false));
  return {
    panels: b.panels,
    faces: b.faces,
    pieces: [{ index: 0, root: 'front', rotation: [0, 0, 0], role: 'base' }],
    width: 0,
    height: 0,
    outer: [b.L + b.t, b.W + b.t, b.H + b.extraHeight],
  };
}
