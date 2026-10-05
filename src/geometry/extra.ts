import type { BoxParams, Bez, Dieline, Face, Panel, Vec2 } from '../types';
import { tuckMotion } from './cartons';
import { arcCurve, bounds, glueTabPoly, mapCurve, rect } from './shapes';

/**
 * A tray with double side walls and no glue: the front and back walls carry corner ears
 * that fold in against the side walls, and each side wall has an inner panel that folds
 * over its top and down inside, trapping the ears. The base of the pizza box and of the
 * matchbox drawer.
 */
export function doubleTray(l: number, w: number, h: number, t: number, piece = 0, prefix = '') {
  // The side walls are three layers thick (wall, ear, inner panel).
  const L = l + 6 * t;
  const W = w + 2 * t;
  const H = h + t;
  // Side walls stop a board's thickness short of the top, so a lid can rest on them; the
  // inner panels stop just above the base.
  const Hs = H - t;
  // In a tall, narrow box they also stop short of reaching across it as they fold over.
  const Hi = Math.max(3, Math.min(Hs - t - 0.5, L - 6 * t - 2));
  const X0 = 2 * H;
  const Y0 = H;
  const id = (s: string) => prefix + s;
  const panels: Panel[] = [{ id: id('bottom'), piece, kind: 'face', poly: rect(X0, Y0, L, W) }];
  const earD = Math.max(4, Math.min(W * 0.4, (W - 2 * t) / 2 - 1));
  const walls = [
    { name: 'front', poly: rect(X0, Y0 - H, L, H), hinge: [[X0, Y0], [X0 + L, Y0]] as [Vec2, Vec2], free: Y0 - H, base: Y0 },
    { name: 'back', poly: rect(X0, Y0 + W, L, H), hinge: [[X0, Y0 + W], [X0 + L, Y0 + W]] as [Vec2, Vec2], free: Y0 + W + H, base: Y0 + W },
  ];
  for (const wl of walls) {
    panels.push({ id: id(wl.name), piece, kind: 'face', poly: wl.poly, parent: id('bottom'), hinge: wl.hinge, angle: 90, stage: 1 });
    // Ears, shortened at the base so they clear the bottom panel.
    const dir = Math.sign(wl.base - wl.free);
    const yFree = wl.free + dir * (t + Math.max(t, 1));
    const yBase = wl.base - dir * t;
    const [ya, yb] = [Math.min(yFree, yBase), Math.max(yFree, yBase)];
    for (const [side, hx, dirX] of [['l', X0, -1], ['r', X0 + L, 1]] as const) {
      panels.push({
        id: id(`${wl.name}-ear-${side}`), piece, kind: 'flap', poly: glueTabPoly(hx, ya, yb, earD, dirX),
        parent: id(wl.name), hinge: [[hx, ya], [hx, yb]], angle: 90, stage: 2, offset: -1,
      });
    }
  }
  const i = t + 0.5; // inner panels fit between the front and back walls
  for (const [side, hx, dirX, stage] of [['left', X0, -1, 4], ['right', X0 + L, 1, 5]] as const) {
    const wx = dirX < 0 ? hx - Hs : hx;
    panels.push({
      id: id(side), piece, kind: 'face', poly: rect(wx, Y0, Hs, W),
      parent: id('bottom'), hinge: [[hx, Y0], [hx, Y0 + W]], angle: 90, stage: 3,
    });
    const top = hx + dirX * Hs;
    panels.push({
      id: id(`${side}-inner`), piece, kind: 'flap', poly: rect(dirX < 0 ? top - Hi : top, Y0 + i, Hi, W - 2 * i),
      // Folds right over (180°) and sits inside the ears: wall, ear, then this.
      // One side at a time, so the two don't meet over the middle.
      parent: id(side), hinge: [[top, Y0 + i], [top, Y0 + W - i]], angle: 180, stage, offset: 3,
    });
  }
  const faces: Face[] = [
    { id: id('front'), label: 'Front', rect: { x: X0, y: Y0 - H, w: L, h: H }, rotation: 0 },
    { id: id('back'), label: 'Back', rect: { x: X0, y: Y0 + W, w: L, h: H }, rotation: 180 },
    { id: id('left'), label: 'Left', rect: { x: X0 - Hs, y: Y0, w: Hs, h: W }, rotation: -90 },
    { id: id('right'), label: 'Right', rect: { x: X0 + L, y: Y0, w: Hs, h: W }, rotation: 90 },
    { id: id('bottom'), label: 'Bottom', rect: { x: X0, y: Y0, w: L, h: W }, rotation: 0 },
  ];
  return { panels, faces, L, W, H, X0, Y0, outer: [L, W, H] as [number, number, number] };
}

/**
 * Pizza box (FEFCO 0427 style mailer): one piece, no glue. A double-walled tray with the
 * lid on the back wall; the lid's side flaps drop inside the side walls and its front
 * tuck slides down behind the front wall.
 */
export function mailer(p: BoxParams): Dieline {
  const t = p.thickness;
  const tr = doubleTray(p.length, p.width, p.height, t);
  const { L, W, H, X0, Y0, panels, faces } = tr;
  const yl = Y0 + W + H; // the lid's hinge on the sheet
  const lid = rect(X0, yl, L, W);
  panels.push({ id: 'lid', piece: 0, kind: 'face', poly: lid, parent: 'back', hinge: [[X0, yl], [X0 + L, yl]], angle: 90, stage: 7 });
  faces.push({ id: 'lid', label: 'Lid', rect: bounds(lid), rotation: 0 });
  // Side flaps: triangles, deep at the back and running out before the front wall, so they
  // swing in past it as the lid closes. Innermost layer, inside the double side walls.
  const u0 = 2 * t + 0.5;
  const c = 2 * t + 1;
  const D = Math.max(3, Math.min(H - t - 1, (W - c - u0) * 0.9, 80));
  for (const [side, hx, dirX] of [['left', X0, -1], ['right', X0 + L, 1]] as const) {
    panels.push({
      id: `lid-${side}`, piece: 0, kind: 'flap',
      poly: [[hx, yl + u0], [hx + dirX * D, yl + u0], [hx, yl + W - c]],
      parent: 'lid', hinge: [[hx, yl + u0], [hx, yl + W - c]], angle: 90, stage: 6, offset: -3,
    });
  }
  // Rounded tuck on the front of the lid, between the side flaps.
  const T = Math.max(6, Math.min(Math.max(10, H * 0.6), H - 2 * t - 1, 40));
  const i = 4 * t + 0.8;
  const R = Math.min(T * 0.8, (L - 2 * i) / 3);
  const yf = yl + W;
  const tx0 = X0 + i;
  const tx1 = X0 + L - i;
  const motion = tuckMotion(W, T, t);
  const c0 = arcCurve(tx0 + R, yf + T - R, R, Math.PI, Math.PI / 2);
  const c1 = arcCurve(tx1 - R, yf + T - R, R, Math.PI / 2, 0);
  panels.push({
    id: 'lid-tuck', piece: 0, kind: 'flap',
    poly: [[tx0, yf], [tx0, yf + T - R], ...c0.pts, [tx1 - R, yf + T], ...c1.pts, [tx1, yf]],
    curves: [...c0.bez, ...c1.bez],
    parent: 'lid', hinge: [[tx0, yf], [tx1, yf]], stage: 7, offset: -1, motion: motion.keys,
  });
  return {
    panels, faces,
    pieces: [{ index: 0, root: 'bottom', rotation: [90, 0, 0], role: 'base' }],
    width: 0, height: 0,
    outer: [L, W, H],
  };
}

/** Thumb notches (half circles) cut into both open ends of a sleeve panel. */
function notch(poly: Vec2[], r: number): { poly: Vec2[]; curves: Bez[] } {
  const [[x0, y0], [x1], , [, y1]] = poly;
  const cx = (x0 + x1) / 2;
  const top = arcCurve(cx, y0, r, Math.PI, 0);
  const bottom = arcCurve(cx, y1, r, 0, -Math.PI);
  return {
    poly: [[x0, y0], [cx - r, y0], ...top.pts, [x1, y0], [x1, y1], [cx + r, y1], ...bottom.pts, [x0, y1]],
    curves: [...top.bez, ...bottom.bez],
  };
}

/**
 * Matchbox: a double-walled drawer (no glue) and a sleeve it slides through, optionally with
 * thumb notches at both ends of the sleeve for pushing the drawer out.
 */
export function matchbox(p: BoxParams, sleevePiece: SleeveBuilder, shift: Shifter): Dieline {
  const t = p.thickness;
  const tr = doubleTray(p.length, p.width, p.height, t);
  const c = p.lidClearance;
  const [L, W, H] = tr.outer;
  const sl = sleevePiece(W + 2 * c, H + c, L, t, p.glueTab, 1);
  const r = Math.min((W + 2 * c) * 0.18, L * 0.2, 14);
  for (const id of p.notches === false ? [] : ['sleeve-top', 'sleeve-bottom']) {
    const panel = sl.panels.find((q) => q.id === id)!;
    Object.assign(panel, notch(panel.poly, r));
  }
  const all = tr.panels.flatMap((q) => q.poly);
  const right = Math.max(...all.map((q) => q[0]));
  const top = Math.min(...all.map((q) => q[1]));
  const height = Math.max(...all.map((q) => q[1])) - top;
  shift(sl.panels, sl.faces, right + 8, top + (height - sl.height) / 2);
  return {
    panels: [...tr.panels, ...sl.panels],
    faces: [...tr.faces, ...sl.faces],
    pieces: [
      { index: 0, root: 'bottom', rotation: [90, 0, 0], role: 'base' },
      { index: 1, root: 'sleeve-top', rotation: [-90, 0, 90], role: 'sleeve' },
    ],
    width: 0, height: 0,
    outer: [sl.outer[0], sl.outer[1], sl.outer[2]],
  };
}

export type SleeveBuilder = (innerW: number, innerH: number, length: number, t: number, g: number, piece: number) => {
  panels: Panel[]; faces: Face[]; width: number; height: number; outer: [number, number, number];
};
export type Shifter = (panels: Panel[], faces: Face[], dx: number, dy: number) => void;

/**
 * Hexagonal gift box: six walls in a ring with a glue seam, and a hexagonal tuck lid at
 * the top and bottom (both on the first wall). Two small dust flaps under each lid.
 * `length` is the inside width across the flats.
 */
export function hexBox(p: BoxParams): Dieline {
  const t = p.thickness;
  const s = (p.length + t) / Math.sqrt(3); // side length
  const a = (s * Math.sqrt(3)) / 2; // apothem
  const H = p.height + 2 * t;
  const panels: Panel[] = [];
  const faces: Face[] = [];
  // The lids hinge on the first wall; the others stop a board's thickness short at both
  // ends so the lids can close over them.
  // Without a lid the top is open and the walls all go right up.
  const lid = p.lid !== false;
  const top0 = (k: number) => (k && lid ? t : 0);
  const bot0 = (k: number) => (k ? t : 0);
  for (let k = 0; k < 6; k++) {
    const x = k * s;
    const h = H - top0(k) - bot0(k);
    panels.push({
      id: `side-${k + 1}`, piece: 0, kind: 'face', poly: rect(x, top0(k), s, h),
      ...(k ? { parent: `side-${k}`, hinge: [[x, lid ? t : 0], [x, H - t]] as [Vec2, Vec2], angle: 60, stage: 1 } : {}),
    });
    faces.push({ id: `side-${k + 1}`, label: `Side ${k + 1}`, rect: { x, y: top0(k), w: s, h }, rotation: 0 });
  }
  panels.push({
    // Stops short of the top and bottom so it stays clear of the lids.
    id: 'glue', piece: 0, kind: 'glue', poly: glueTabPoly(6 * s, t + 0.5, H - t - 0.5, Math.min(p.glueTab, s * 0.6), 1),
    parent: 'side-6', hinge: [[6 * s, t + 0.5], [6 * s, H - t - 0.5]], angle: 60, stage: 1, offset: -1,
  });

  const T = Math.max(6, Math.min(Math.max(10, a), 40, H * 0.6));
  const motion = tuckMotion(2 * a, T, t);
  const i = Math.min(t, 1.5);
  const R = Math.min(T * 0.8, (s - 2 * i) / 3);
  const d = Math.min(a * 0.55, H * 0.4); // dust flap depth
  for (const top of lid ? [true, false] : [false]) {
    const name = top ? 'top' : 'bottom';
    // Sheet point at x, v away from the walls' top (or bottom) edge.
    const at = (x: number, v: number): Vec2 => [x, top ? -v : H + v];
    const lid = [at(0, 0), at(s, 0), at(1.5 * s, a), at(s, 2 * a), at(0, 2 * a), at(-0.5 * s, a)];
    panels.push({ id: name, piece: 0, kind: 'face', poly: lid, parent: 'side-1', hinge: [at(0, 0), at(s, 0)], angle: 90, stage: 3 });
    const band = [at(0, 0), at(s, 2 * a)];
    faces.push({ id: name, label: top ? 'Top' : 'Bottom', rect: bounds(band), rotation: 0 });
    const tx0 = i;
    const tx1 = s - i;
    const y = 2 * a;
    const c0 = mapCurve(arcCurve(tx1 - R, y + T - R, R, 0, Math.PI / 2), ([x, v]) => at(x, v));
    const c1 = mapCurve(arcCurve(tx0 + R, y + T - R, R, Math.PI / 2, Math.PI), ([x, v]) => at(x, v));
    panels.push({
      id: `${name}-tuck`, piece: 0, kind: 'flap',
      poly: [at(tx1, y), at(tx1, y + T - R), ...c0.pts, at(tx0 + R, y + T), ...c1.pts, at(tx0, y)],
      curves: [...c0.bez, ...c1.bez],
      parent: name, hinge: [at(tx1, y), at(tx0, y)], stage: 3, offset: -1, motion: motion.keys,
    });
    // Dust flaps on the walls either side of the first: hexagon sectors, so they lie side
    // by side under the lid.
    // (Their walls are a thickness lower, so they already sit just under the lid.)
    for (const k of [1, 5]) {
      const x = k * s;
      const e = d / Math.sqrt(3);
      panels.push({
        id: `side-${k + 1}-dust-${name}`, piece: 0, kind: 'flap',
        poly: [at(x, -t), at(x + e, d - t), at(x + s - e, d - t), at(x + s, -t)],
        parent: `side-${k + 1}`, hinge: [at(x, -t), at(x + s, -t)], angle: 90, stage: 2,
      });
    }
  }
  return {
    panels, faces,
    pieces: [{ index: 0, root: 'side-1', rotation: [0, 0, 0], role: 'base' }],
    width: 0, height: 0,
    outer: [2 * s, 2 * a, H],
  };
}

/**
 * A seal-end closure across the top (dir -1, towards negative y) or bottom (dir +1) edge
 * y = edge of four walls: side flaps fold in, the back flap is glued over them, and the
 * panel on the front closes it.
 */
function sealClosure(panels: Panel[], faces: Face[], walls: { front: string; right: string; back: string; left: string }, x: Record<'front' | 'right' | 'back' | 'left', number>, L: number, W: number, edge: number, dir: 1 | -1, name: string) {
  const at = (px: number, v: number): Vec2 => [px, edge + dir * v];
  const Dm = Math.min(W * 0.5, L * 0.45);
  const s = Math.min(Dm * 0.4, W * 0.15);
  for (const side of ['right', 'left'] as const) {
    const x0 = x[side];
    panels.push({
      id: `${walls[side]}-${name}`, piece: 0, kind: 'flap', poly: [at(x0, 0), at(x0 + s, Dm), at(x0 + W - s, Dm), at(x0 + W, 0)],
      parent: walls[side], hinge: [at(x0, 0), at(x0 + W, 0)], angle: 90, stage: 2, offset: -2,
    });
  }
  const xb = x.back;
  panels.push({
    id: `${walls.back}-${name}`, piece: 0, kind: 'glue', poly: [at(xb, 0), at(xb + L, 0), at(xb + L, W), at(xb, W)],
    parent: walls.back, hinge: [at(xb, 0), at(xb + L, 0)], angle: 90, stage: 3, offset: -1,
  });
  const lid = [at(0, 0), at(L, 0), at(L, W), at(0, W)];
  panels.push({ id: name, piece: 0, kind: 'face', poly: lid, parent: walls.front, hinge: [at(0, 0), at(L, 0)], angle: 90, stage: 4 });
  faces.push({ id: name, label: name === 'top' ? 'Top' : 'Bottom', rect: bounds(lid), rotation: 0 });
}

/**
 * Cigarette box (hinge-lid / flip-top pack): a glued carton cut across near the top, so the
 * top part opens as a lid on a fold at the back, plus an inner collar glued inside the
 * front that stands up above the cut and holds the lid shut.
 */
export function cigarette(p: BoxParams): Dieline {
  const t = p.thickness;
  const L = p.length + t;
  const W = p.width + t;
  const H = p.height + 2 * t;
  const Hl = Math.min(Math.max(H * 0.27, 10), H * 0.45); // lid height
  const Hb = H - Hl;
  const g = Math.min(p.glueTab, L * 0.4, W * 0.9);
  const x = { front: 0, right: L, back: L + W, left: 2 * L + W };
  const panels: Panel[] = [];
  const faces: Face[] = [];
  // Two rows of four walls joined by a glue seam: the lid (y 0..Hl) above the body (Hl..H).
  // Only the back walls are joined by a fold; the rest is cut apart.
  const ring = (prefix: string, y0: number, h: number, root: 'front' | 'back', label: string) => {
    const id = (w: string) => prefix + w;
    const order = root === 'front' ? (['front', 'right', 'back', 'left'] as const) : (['back', 'right', 'front', 'left'] as const);
    // Each wall hangs off the previous one in the chain (the lid's chain starts at the back).
    const parentOf: Record<string, string | null> =
      root === 'front' ? { front: null, right: 'front', back: 'right', left: 'back' } : { back: null, right: 'back', front: 'right', left: 'back' };
    for (const w of order) {
      const wid = w === 'front' || w === 'back' ? L : W;
      const par = parentOf[w];
      // The hinge is the edge shared with the parent.
      const hx = par === null ? 0 : Math.max(x[w], x[par as keyof typeof x]);
      panels.push({
        id: id(w), piece: 0, kind: 'face', poly: rect(x[w], y0, wid, h),
        ...(par ? { parent: id(par), hinge: [[hx, y0], [hx, y0 + h]] as [Vec2, Vec2], angle: 90, stage: 1 } : {}),
      });
      faces.push({ id: id(w), label: `${label}${w[0].toUpperCase()}${w.slice(1)}`, rect: { x: x[w], y: y0, w: wid, h }, rotation: 0 });
    }
    // The glue tab stops short of the closure end (the lid's top, the body's bottom).
    const ge = 2 * L + 2 * W;
    const [g0, g1] = root === 'back' ? [y0 + t + 0.5, y0 + h] : [y0, y0 + h - t - 0.5];
    panels.push({
      id: id('glue'), piece: 0, kind: 'glue', poly: glueTabPoly(ge, g0, g1, g, 1),
      parent: id('left'), hinge: [[ge, g0], [ge, g1]], angle: 90, stage: 1, offset: -1,
    });
  };
  ring('', Hl, Hb, 'front', '');
  ring('lid-', 0, Hl, 'back', 'Lid ');
  // The lid's back is folded to the body's back: it swings open after the walls are up so
  // the collar can go in, and closes again at the end.
  const lidBack = panels.find((q) => q.id === 'lid-back')!;
  Object.assign(lidBack, {
    parent: 'back', hinge: [[x.back, Hl], [x.back + L, Hl]] as [Vec2, Vec2], angle: 0, open: -115,
    timeline: [[0, 0], [0.28, 0], [0.42, -115], [0.86, -115], [1, 0]] as [number, number][],
  });
  sealClosure(panels, faces, { front: 'lid-front', right: 'lid-right', back: 'lid-back', left: 'lid-left' }, x, L, W, 0, -1, 'top');
  sealClosure(panels, faces, { front: 'front', right: 'right', back: 'back', left: 'left' }, x, L, W, H, 1, 'bottom');

  // The collar: a front with a finger dip and two sides, glued inside the body's front and
  // sticking up into the lid.
  const P = Math.min(Hl * 0.45, 12); // how far it stands up above the cut
  const Hc = P + Math.min(Hb * 0.5, 40);
  const Lc = L - 2 * t - 0.4;
  const Ds = Math.min(W * 0.45, 25);
  const cx = 2 * L + 2 * W + g + 10 + Ds;
  const cy = Hl - P;
  const r = Math.min(Lc * 0.18, P * 0.8);
  const mid = cx + Lc / 2;
  const dip = arcCurve(mid, cy, r, Math.PI, 0);
  panels.push({
    id: 'collar', piece: 1, kind: 'face',
    poly: [[cx, cy], [mid - r, cy], ...dip.pts, [cx + Lc, cy], [cx + Lc, cy + Hc], [cx, cy + Hc]],
    curves: dip.bez,
  });
  const drop = Math.min(P * 0.6, Hc * 0.3); // sides slope down towards the back
  panels.push({
    id: 'collar-left', piece: 1, kind: 'glue', poly: [[cx, cy], [cx - Ds, cy + drop], [cx - Ds, cy + Hc], [cx, cy + Hc]],
    parent: 'collar', hinge: [[cx, cy], [cx, cy + Hc]], angle: 90, stage: 1,
  });
  panels.push({
    id: 'collar-right', piece: 1, kind: 'glue', poly: [[cx + Lc, cy], [cx + Lc, cy + Hc], [cx + Lc + Ds, cy + Hc], [cx + Lc + Ds, cy + drop]],
    parent: 'collar', hinge: [[cx + Lc, cy], [cx + Lc, cy + Hc]], angle: 90, stage: 1,
  });
  return {
    panels, faces,
    pieces: [
      { index: 0, root: 'front', rotation: [0, 0, 0], role: 'base' },
      {
        index: 1, root: 'collar', rotation: [0, 0, 0], role: 'insert',
        place: { anchor: 'front', from: [cx, cy], to: [(L - Lc) / 2, cy], z: -t, arrive: [0.44, 0.7] },
      },
    ],
    width: 0, height: 0,
    outer: [L + t, W + t, H],
  };
}
