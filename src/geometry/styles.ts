import type { BoxParams, BoxStyle, Dieline, Face, Panel, PieceInfo, Vec2 } from '../types';
import { carton } from './cartons';
import { cigarette, hexBox, mailer, matchbox } from './extra';
import { glueTabPoly, rect } from './shapes';

export const MARGIN = 5;

export const STYLE_INFO: Record<BoxStyle, { name: string; description: string }> = {
  rsc: {
    name: 'Shipping box',
    description: 'Classic slotted carton (FEFCO 0201). Four walls, one glue tab, flaps fold over top and bottom.',
  },
  tuck: {
    name: 'Straight tuck end',
    description: 'Both tuck lids fold to the back, leaving a clean, uninterrupted front. One glue seam.',
  },
  rte: {
    name: 'Reverse tuck end',
    description: 'Top lid tucks in from the back, bottom lid from the front. The everyday retail carton.',
  },
  snaplock: {
    name: 'Snap-lock bottom',
    description: 'Tuck top with a 1-2-3 bottom: fold the sides, then the back, then push the front tongue in. Holds heavier items without glue.',
  },
  autolock: {
    name: 'Auto-lock bottom',
    description: 'Crash-lock bottom. Glue the two marked triangles once; after that the bottom snaps into place as you open the box.',
  },
  sealend: {
    name: 'Seal end',
    description: 'Cereal-box style. Side flaps fold in, then the end flaps are glued shut at top and bottom.',
  },
  gable: {
    name: 'Gable top',
    description: 'Rooftop carton with a built-in carry handle and a snap-lock bottom.',
  },
  tray: {
    name: 'Open tray',
    description: 'One-piece open-top tray. Corner tabs are glued inside the side walls.',
  },
  traylid: {
    name: 'Tray + lid',
    description: 'Two-piece telescoping box: a tray and a slightly larger lid that slides over it.',
  },
  sleeve: {
    name: 'Tray + sleeve',
    description: 'Two pieces: an open tray that slides into an outer sleeve, open at both ends.',
  },
  mailer: {
    name: 'Pizza box',
    description: 'One-piece mailer (FEFCO 0427 style). Double side walls lock the corners, the lid tucks in at the front. No glue.',
  },
  matchbox: {
    name: 'Matchbox',
    description: 'A drawer that slides out of a sleeve. The drawer has double side walls and needs no glue; thumb notches at both ends.',
  },
  hexagon: {
    name: 'Hexagonal gift box',
    description: 'Six-sided box with tuck lids at top and bottom. Length is the inside width across the flat sides.',
  },
  cigarette: {
    name: 'Cigarette box',
    description: 'Flip-top pack: the lid opens on a fold at the back and closes over an inner collar glued inside the front.',
  },
  shape: {
    name: 'Shape Builder',
    description: 'Build your own shape: pick a base, extrude it in levels that narrow, widen or come to a point, and get the box for it.',
  },
};

// ---------------------------------------------------------------------------
// Regular slotted container (FEFCO 0201)
// ---------------------------------------------------------------------------
function rsc(p: BoxParams): Dieline {
  const t = p.thickness;
  const L = p.length + t;
  const W = p.width + t;
  const H = p.height + 2 * t;
  const F = W / 2;
  const g = p.glueTab;
  const s = Math.max(2, t); // slot width between flaps

  const x0 = g;
  const walls = [
    { id: 'front', label: 'Front', w: L, major: true },
    { id: 'right', label: 'Right', w: W, major: false },
    { id: 'back', label: 'Back', w: L, major: true },
    { id: 'left', label: 'Left', w: W, major: false },
  ];
  const panels: Panel[] = [];
  const faces: Face[] = [];
  let x = x0;
  walls.forEach((wall, i) => {
    const prev = walls[i - 1];
    panels.push({
      id: wall.id,
      piece: 0,
      kind: 'face',
      poly: rect(x, F, wall.w, H),
      ...(prev
        ? { parent: prev.id, hinge: [[x, F], [x, F + H]] as [Vec2, Vec2], angle: 90, stage: 1 }
        : {}),
    });
    faces.push({ id: wall.id, label: wall.label, rect: { x, y: F, w: wall.w, h: H }, rotation: 0 });

    const fx0 = x + s / 2;
    const fx1 = x + wall.w - s / 2;
    const flap = {
      piece: 0,
      kind: 'flap' as const,
      parent: wall.id,
      angle: 90,
      stage: wall.major ? 3 : 2,
      offset: wall.major ? 0 : -1,
    };
    panels.push({ ...flap, id: `${wall.id}-top`, poly: rect(fx0, 0, fx1 - fx0, F), hinge: [[fx0, F], [fx1, F]] });
    panels.push({
      ...flap,
      id: `${wall.id}-bottom`,
      poly: rect(fx0, F + H, fx1 - fx0, F),
      hinge: [[fx0, F + H], [fx1, F + H]],
    });
    // The outer (major) flaps form the visible top and bottom, half each.
    if (wall.major) {
      const front = wall.id === 'front';
      faces.push({
        id: `${wall.id}-top`, label: `Top (${wall.id} half)`,
        rect: { x: fx0, y: 0, w: fx1 - fx0, h: F }, rotation: front ? 0 : 180,
      });
      faces.push({
        id: `${wall.id}-bottom`, label: `Bottom (${wall.id} half)`,
        rect: { x: fx0, y: F + H, w: fx1 - fx0, h: F }, rotation: front ? 0 : 180,
      });
    }
    x += wall.w;
  });

  panels.push({
    id: 'glue',
    piece: 0,
    kind: 'glue',
    poly: glueTabPoly(x0, F, F + H, g, -1),
    parent: 'front',
    hinge: [[x0, F], [x0, F + H]],
    angle: 90,
    stage: 1,
    offset: -1,
  });

  return finish({
    panels,
    faces,
    pieces: [{ index: 0, root: 'front', rotation: [0, 0, 0], role: 'base' }],
    width: x,
    height: 2 * F + H,
    outer: [L + t, W + t, H],
  });
}

// ---------------------------------------------------------------------------
// Open tray with glued corner tabs
// ---------------------------------------------------------------------------
interface TrayOut {
  panels: Panel[];
  faces: Face[];
  width: number;
  height: number;
  outer: [number, number, number];
}

function trayPiece(
  innerL: number,
  innerW: number,
  innerH: number,
  t: number,
  g: number,
  piece: number,
  prefix: string,
  labelPrefix: string,
  isLid: boolean,
): TrayOut {
  const L = innerL + 2 * t;
  const W = innerW + 2 * t;
  const H = innerH + t;
  const tabW = Math.min(g, W * 0.45);
  // The front/back walls carry corner tabs which stick out sideways by tabW.
  // Walls are as tall as H; side walls make the sheet H wide on each side.
  const X0 = H;
  const Y0 = H;
  const id = (s: string) => prefix + s;
  const panels: Panel[] = [{ id: id('bottom'), piece, kind: 'face', poly: rect(X0, Y0, L, W) }];

  // Front wall sits above the bottom on the sheet, back wall below.
  const walls = [
    { name: 'front', poly: rect(X0, Y0 - H, L, H), hinge: [[X0, Y0], [X0 + L, Y0]] as [Vec2, Vec2], free: Y0 - H, base: Y0 },
    { name: 'back', poly: rect(X0, Y0 + W, L, H), hinge: [[X0, Y0 + W], [X0 + L, Y0 + W]] as [Vec2, Vec2], free: Y0 + W + H, base: Y0 + W },
  ];
  for (const w of walls) {
    panels.push({ id: id(w.name), piece, kind: 'face', poly: w.poly, parent: id('bottom'), hinge: w.hinge, angle: 90, stage: 1 });
    // Corner tabs, shortened at the base so they clear the bottom panel.
    const dir = Math.sign(w.base - w.free); // +1 if base is below free edge on the sheet
    const yFree = w.free + dir * Math.min(t, 1);
    const yBase = w.base - dir * t;
    const ya = Math.min(yFree, yBase);
    const yb = Math.max(yFree, yBase);
    for (const [side, hx, dirX] of [['l', X0, -1], ['r', X0 + L, 1]] as const) {
      panels.push({
        id: id(`${w.name}-tab-${side}`),
        piece,
        kind: 'glue',
        poly: glueTabPoly(hx, ya, yb, tabW, dirX),
        parent: id(w.name),
        hinge: [[hx, ya], [hx, yb]],
        angle: 90,
        stage: 2,
        offset: -1,
      });
    }
  }
  panels.push({
    id: id('left'), piece, kind: 'face', poly: rect(X0 - H, Y0, H, W),
    parent: id('bottom'), hinge: [[X0, Y0], [X0, Y0 + W]], angle: 90, stage: 3,
  });
  panels.push({
    id: id('right'), piece, kind: 'face', poly: rect(X0 + L, Y0, H, W),
    parent: id('bottom'), hinge: [[X0 + L, Y0], [X0 + L, Y0 + W]], angle: 90, stage: 3,
  });

  // Face orientation. The tray is assembled bottom-down with the sheet's top wall facing
  // the viewer; the lid is assembled upside down, which mirrors its wall orientation.
  const rot = isLid
    ? { front: 0, back: 180, left: 90, right: -90, bottom: 0 }
    : { front: 0, back: 180, left: -90, right: 90, bottom: 0 };
  const frontRect = isLid ? { x: X0, y: Y0 + W, w: L, h: H } : { x: X0, y: Y0 - H, w: L, h: H };
  const backRect = isLid ? { x: X0, y: Y0 - H, w: L, h: H } : { x: X0, y: Y0 + W, w: L, h: H };
  const faces: Face[] = [
    { id: id('front'), label: `${labelPrefix}Front`, rect: frontRect, rotation: rot.front },
    { id: id('back'), label: `${labelPrefix}Back`, rect: backRect, rotation: rot.back },
    { id: id('left'), label: `${labelPrefix}Left`, rect: { x: X0 - H, y: Y0, w: H, h: W }, rotation: rot.left },
    { id: id('right'), label: `${labelPrefix}Right`, rect: { x: X0 + L, y: Y0, w: H, h: W }, rotation: rot.right },
    { id: id('bottom'), label: isLid ? 'Lid top' : `${labelPrefix}Bottom`, rect: { x: X0, y: Y0, w: L, h: W }, rotation: rot.bottom },
  ];
  return { panels, faces, width: 2 * H + L, height: 2 * H + W, outer: [L, W, H] };
}

function tray(p: BoxParams): Dieline {
  const t = p.thickness;
  const piece = trayPiece(p.length, p.width, p.height, t, p.glueTab, 0, '', '', false);
  return finish({
    panels: piece.panels,
    faces: piece.faces,
    pieces: [{ index: 0, root: 'bottom', rotation: [90, 0, 0], role: 'base' }],
    width: piece.width,
    height: piece.height,
    outer: piece.outer,
  });
}

function traylid(p: BoxParams): Dieline {
  const t = p.thickness;
  const base = trayPiece(p.length, p.width, p.height, t, p.glueTab, 0, '', '', false);
  const c = p.lidClearance;
  const lidH = Math.min(p.lidHeight, p.height + t);
  const lid = trayPiece(base.outer[0] + 2 * c, base.outer[1] + 2 * c, lidH, t, p.glueTab, 1, 'lid-', 'Lid ', true);
  const dx = base.width + 8;
  const dy = (base.height - lid.height) / 2;
  shift(lid.panels, lid.faces, dx, dy);
  const pieces: PieceInfo[] = [
    { index: 0, root: 'bottom', rotation: [90, 0, 0], role: 'base' },
    { index: 1, root: 'lid-bottom', rotation: [-90, 0, 0], role: 'lid' },
  ];
  return finish({
    panels: [...base.panels, ...lid.panels],
    faces: [...base.faces, ...lid.faces],
    pieces,
    width: dx + lid.width,
    height: Math.max(base.height, lid.height + Math.max(0, dy)),
    outer: [lid.outer[0], lid.outer[1], base.outer[2] + t],
  });
}

function shift(panels: Panel[], faces: Face[], dx: number, dy: number) {
  const mv = ([x, y]: Vec2): Vec2 => [x + dx, y + dy];
  for (const p of panels) {
    p.poly = p.poly.map(mv);
    if (p.holes) p.holes = p.holes.map((h) => h.map(mv));
    if (p.hinge) p.hinge = [mv(p.hinge[0]), mv(p.hinge[1])];
  }
  for (const f of faces) f.rect = { ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy };
}

// ---------------------------------------------------------------------------
// Tray + sleeve
// ---------------------------------------------------------------------------

/** An open-ended tube: top, back, bottom and front panels in a row plus a glue tab. */
function sleevePiece(innerW: number, innerH: number, length: number, t: number, g: number, piece: number) {
  const Ws = innerW + 2 * t;
  const Hs = innerH + 2 * t;
  const strip = [
    { id: 'sleeve-top', label: 'Sleeve top', w: Ws, rotation: 90 },
    { id: 'sleeve-back', label: 'Sleeve back', w: Hs, rotation: -90 },
    { id: 'sleeve-bottom', label: 'Sleeve bottom', w: Ws, rotation: 90 },
    { id: 'sleeve-front', label: 'Sleeve front', w: Hs, rotation: 90 },
  ];
  const panels: Panel[] = [];
  const faces: Face[] = [];
  let x = 0;
  strip.forEach((s, i) => {
    panels.push({
      id: s.id, piece, kind: 'face', poly: rect(x, 0, s.w, length),
      ...(i ? { parent: strip[i - 1].id, hinge: [[x, 0], [x, length]] as [Vec2, Vec2], angle: 90, stage: 1 } : {}),
    });
    faces.push({ id: s.id, label: s.label, rect: { x, y: 0, w: s.w, h: length }, rotation: s.rotation });
    x += s.w;
  });
  panels.push({
    id: 'sleeve-glue', piece, kind: 'glue', poly: glueTabPoly(x, 0, length, Math.min(g, Ws * 0.4), 1),
    parent: 'sleeve-front', hinge: [[x, 0], [x, length]], angle: 90, stage: 1, offset: -1,
  });
  return { panels, faces, width: x + g, height: length, outer: [length, Ws, Hs] as [number, number, number] };
}

function sleeve(p: BoxParams): Dieline {
  const t = p.thickness;
  const base = trayPiece(p.length, p.width, p.height, t, p.glueTab, 0, '', '', false);
  const c = p.lidClearance;
  const sl = sleevePiece(base.outer[1] + 2 * c, base.outer[2] + c, base.outer[0], t, p.glueTab, 1);
  shift(sl.panels, sl.faces, base.width + 8, (base.height - sl.height) / 2);
  return finish({
    panels: [...base.panels, ...sl.panels],
    faces: [...base.faces, ...sl.faces],
    pieces: [
      { index: 0, root: 'bottom', rotation: [90, 0, 0], role: 'base' },
      // Lay the sleeve's top panel flat with its length running left-right.
      { index: 1, root: 'sleeve-top', rotation: [-90, 0, 90], role: 'sleeve' },
    ],
    width: 0,
    height: 0,
    outer: [sl.outer[0], sl.outer[1], sl.outer[2]],
  });
}

/** Normalises the layout so it starts at (MARGIN, MARGIN) and records the sheet size. */
export function finish(d: Dieline): Dieline {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of d.panels)
    for (const [x, y] of p.poly) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  shift(d.panels, d.faces, dx, dy);
  d.width = maxX - minX + 2 * MARGIN;
  d.height = maxY - minY + 2 * MARGIN;
  return d;
}

export function generateDieline(p: BoxParams): Dieline {
  switch (p.style) {
    case 'rsc': return rsc(p);
    case 'tuck': return finish(carton(p, 'tuck-back', 'tuck-back'));
    case 'rte': return finish(carton(p, 'tuck-back', 'tuck-front'));
    case 'snaplock': return finish(carton(p, 'tuck-back', 'snaplock'));
    case 'autolock': return finish(carton(p, 'tuck-back', 'autolock'));
    case 'sealend': return finish(carton(p, 'seal', 'seal'));
    case 'gable': return finish(carton(p, 'gable', 'snaplock'));
    case 'tray': return tray(p);
    case 'traylid': return traylid(p);
    case 'sleeve': return sleeve(p);
    case 'mailer': return finish(mailer(p));
    case 'matchbox': return finish(matchbox(p, sleevePiece, shift));
    case 'hexagon': return finish(hexBox(p));
    case 'cigarette': return finish(cigarette(p));
    // Built from a ShapeSpec rather than these parameters; see shapeDieline() in simple.ts.
    case 'shape': throw new Error('Shape Builder boxes are built from a shape, not box parameters');
  }
}
