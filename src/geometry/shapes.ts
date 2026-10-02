import type { Vec2 } from '../types';

export const rect = (x: number, y: number, w: number, h: number): Vec2[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** Points along a circular arc from angle a0 to a1 (radians), excluding the start point. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps = 8): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** A tapered glue tab hinged on the vertical line x = hx, sticking out towards dirX. */
export function glueTabPoly(hx: number, y0: number, y1: number, g: number, dirX: 1 | -1): Vec2[] {
  const c = Math.min(g * 0.8, (y1 - y0) / 4);
  return [
    [hx, y0],
    [hx + dirX * g, y0 + c],
    [hx + dirX * g, y1 - c],
    [hx, y1],
  ];
}

/** A tapered tab hinged on the edge p0→p1, sticking out away from `inside`. */
export function edgeTab(p0: Vec2, p1: Vec2, depth: number, inside: Vec2): Vec2[] {
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const u: Vec2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
  let n: Vec2 = [-u[1], u[0]];
  if (n[0] * (p0[0] - inside[0]) + n[1] * (p0[1] - inside[1]) < 0) n = [-n[0], -n[1]];
  // Steeper than 45° so the tab's corners stay clear of neighbouring panels' edges.
  const c = Math.min(depth * 1.5, len / 3);
  return [
    p0,
    p1,
    [p1[0] + n[0] * depth - u[0] * c, p1[1] + n[1] * depth - u[1] * c],
    [p0[0] + n[0] * depth + u[0] * c, p0[1] + n[1] * depth + u[1] * c],
  ];
}

/** A rounded slot (stadium) centred on (cx, cy). */
export function slot(cx: number, cy: number, w: number, h: number): Vec2[] {
  const r = h / 2;
  return [
    [cx - w / 2 + r, cy - r],
    [cx + w / 2 - r, cy - r],
    ...arc(cx + w / 2 - r, cy, r, -Math.PI / 2, Math.PI / 2, 10),
    [cx - w / 2 + r, cy + r],
    ...arc(cx - w / 2 + r, cy, r, Math.PI / 2, Math.PI * 1.5, 10).slice(0, -1),
  ];
}

export function bounds(poly: Vec2[]) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
