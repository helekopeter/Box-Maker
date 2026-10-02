import type { BoxParams, BoxStyle, Dieline, Face, Panel, PieceInfo, Vec2 } from '../types';

export const MARGIN = 5;

export const STYLE_INFO: Record<BoxStyle, { name: string; description: string }> = {
  rsc: {
    name: 'Shipping box',
    description: 'Classic slotted carton (FEFCO 0201). Four walls, one glue tab, flaps fold over top and bottom.',
  },
  tuck: {
    name: 'Tuck-end box',
    description: 'Retail-style box with tuck-in lids and dust flaps at both ends. One glue seam.',
  },
  tray: {
    name: 'Open tray',
    description: 'One-piece open-top tray. Corner tabs are glued inside the side walls.',
  },
  traylid: {
    name: 'Tray + lid',
    description: 'Two-piece telescoping box: a tray and a slightly larger lid that slides over it.',
  },
};

const rect = (x: number, y: number, w: number, h: number): Vec2[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** Quarter-circle points from angle a0 to a1 (radians), excluding the start point. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps = 8): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function glueTabPoly(hx: number, y0: number, y1: number, g: number, dirX: 1 | -1): Vec2[] {
  const c = Math.min(g * 0.8, (y1 - y0) / 4);
  return [
    [hx, y0],
    [hx + dirX * g, y0 + c],
    [hx + dirX * g, y1 - c],
    [hx, y1],
  ];
}

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
// Straight tuck end box
// ---------------------------------------------------------------------------
function tuck(p: BoxParams): Dieline {
  const t = p.thickness;
  const L = p.length + t;
  const W = p.width + t;
  const H = p.height + 2 * t;
  const g = p.glueTab;
  const T = Math.min(Math.max(10, W * 0.6), 40, H * 0.8); // tuck flap depth
  const D = Math.min(L * 0.42, Math.max(10, W * 0.7)); // dust flap depth
  const Y0 = W + T;
  const Y1 = Y0 + H;
  const xs = { front: 0, right: L, back: L + W, left: 2 * L + W, end: 2 * L + 2 * W };

  const panels: Panel[] = [
    { id: 'front', piece: 0, kind: 'face', poly: rect(xs.front, Y0, L, H) },
    {
      id: 'right', piece: 0, kind: 'face', poly: rect(xs.right, Y0, W, H),
      parent: 'front', hinge: [[xs.right, Y0], [xs.right, Y1]], angle: 90, stage: 1,
    },
    {
      id: 'back', piece: 0, kind: 'face', poly: rect(xs.back, Y0, L, H),
      parent: 'right', hinge: [[xs.back, Y0], [xs.back, Y1]], angle: 90, stage: 1,
    },
    {
      id: 'left', piece: 0, kind: 'face', poly: rect(xs.left, Y0, W, H),
      parent: 'back', hinge: [[xs.left, Y0], [xs.left, Y1]], angle: 90, stage: 1,
    },
    {
      id: 'glue', piece: 0, kind: 'glue', poly: glueTabPoly(xs.end, Y0, Y1, g, 1),
      parent: 'left', hinge: [[xs.end, Y0], [xs.end, Y1]], angle: 90, stage: 1, offset: -1,
    },
  ];

  // Dust flaps on both side panels, top and bottom.
  const r = Math.min(t / 2, 1); // small relief so the flap clears the neighbouring hinges
  for (const side of ['right', 'left'] as const) {
    const x = xs[side];
    const s = Math.min(W * 0.25, D * 0.35);
    for (const top of [true, false]) {
      const y = top ? Y0 : Y1;
      const dy = top ? -1 : 1;
      panels.push({
        id: `${side}-dust-${top ? 'top' : 'bottom'}`,
        piece: 0,
        kind: 'flap',
        poly: [
          [x + r, y],
          [x + r, y + dy * D * 0.25],
          [x + s, y + dy * D],
          [x + W - s, y + dy * D],
          [x + W - r, y + dy * D * 0.25],
          [x + W - r, y],
        ],
        parent: side,
        hinge: [[x + r, y], [x + W - r, y]],
        angle: 90,
        stage: 2,
        offset: -1,
      });
    }
  }

  // Lids + tuck flaps, both attached to the back panel.
  const i = Math.min(t, 1.5); // tuck flap side inset so it slides in
  const R = Math.min(T * 0.8, (L - 2 * i) / 3);
  const xb = xs.back;
  for (const top of [true, false]) {
    const name = top ? 'top' : 'bottom';
    const hy = top ? Y0 : Y1; // hinge with the back
    const ly = top ? Y0 - W : Y1 + W; // lid's free edge
    const dy = top ? -1 : 1;
    panels.push({
      id: name, piece: 0, kind: 'face', poly: rect(xb, Math.min(hy, ly), L, W),
      parent: 'back', hinge: [[xb, hy], [xb + L, hy]], angle: 90, stage: 3,
    });
    const tx0 = xb + i;
    const tx1 = xb + L - i;
    const ty = ly + dy * T;
    // Rounded tuck flap. Arc angles are in SVG space (y down).
    const poly: Vec2[] = [[tx0, ly], [tx0, ty - dy * R]];
    if (top) {
      poly.push(...arc(tx0 + R, ty + R, R, Math.PI, Math.PI * 1.5));
      poly.push([tx1 - R, ty]);
      poly.push(...arc(tx1 - R, ty + R, R, Math.PI * 1.5, Math.PI * 2));
    } else {
      poly.push(...arc(tx0 + R, ty - R, R, Math.PI, Math.PI / 2));
      poly.push([tx1 - R, ty]);
      poly.push(...arc(tx1 - R, ty - R, R, Math.PI / 2, 0));
    }
    poly.push([tx1, ly]);
    panels.push({
      id: `${name}-tuck`, piece: 0, kind: 'flap', poly,
      parent: name, hinge: [[tx0, ly], [tx1, ly]], angle: 90, stage: 4, offset: -1,
    });
  }

  const faces: Face[] = [
    { id: 'front', label: 'Front', rect: { x: xs.front, y: Y0, w: L, h: H }, rotation: 0 },
    { id: 'right', label: 'Right', rect: { x: xs.right, y: Y0, w: W, h: H }, rotation: 0 },
    { id: 'back', label: 'Back', rect: { x: xs.back, y: Y0, w: L, h: H }, rotation: 0 },
    { id: 'left', label: 'Left', rect: { x: xs.left, y: Y0, w: W, h: H }, rotation: 0 },
    { id: 'top', label: 'Top', rect: { x: xb, y: Y0 - W, w: L, h: W }, rotation: 180 },
    { id: 'bottom', label: 'Bottom', rect: { x: xb, y: Y1, w: L, h: W }, rotation: 180 },
  ];

  return finish({
    panels,
    faces,
    pieces: [{ index: 0, root: 'front', rotation: [0, 0, 0], role: 'base' }],
    width: xs.end + g,
    height: 2 * (W + T) + H,
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
  const gap = 8;
  const dx = base.width + gap;
  const dy = (base.height - lid.height) / 2;
  for (const pnl of lid.panels) {
    pnl.poly = pnl.poly.map(([x, y]) => [x + dx, y + dy] as Vec2);
    if (pnl.hinge) pnl.hinge = pnl.hinge.map(([x, y]) => [x + dx, y + dy]) as [Vec2, Vec2];
  }
  for (const f of lid.faces) f.rect = { ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy };
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

/** Normalises the layout so it starts at (MARGIN, MARGIN) and records the sheet size. */
function finish(d: Dieline): Dieline {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of d.panels)
    for (const [x, y] of p.poly) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const mv = ([x, y]: Vec2): Vec2 => [x + dx, y + dy];
  for (const p of d.panels) {
    p.poly = p.poly.map(mv);
    if (p.hinge) p.hinge = [mv(p.hinge[0]), mv(p.hinge[1])];
  }
  for (const f of d.faces) f.rect = { ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy };
  d.width = maxX - minX + 2 * MARGIN;
  d.height = maxY - minY + 2 * MARGIN;
  return d;
}

export function generateDieline(p: BoxParams): Dieline {
  switch (p.style) {
    case 'rsc': return rsc(p);
    case 'tuck': return tuck(p);
    case 'tray': return tray(p);
    case 'traylid': return traylid(p);
  }
}
