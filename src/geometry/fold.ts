import { Box3, Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Dieline, Panel, Vec2 } from '../types';

/**
 * Sheet → 3D mapping: sheet (x, y) becomes (x, -y, 0). The printed outside of the sheet
 * faces +z and panels extrude towards -z (the inside), so folds rotate towards -z.
 */
export const to3 = ([x, y]: Vec2) => new Vector3(x, -y, 0);

const ease = (t: number) => t * t * (3 - 2 * t);

export function maxStage(d: Dieline): number {
  return d.panels.reduce((m, p) => Math.max(m, p.stage ?? 0), 1);
}

/** Time (0..1) within a panel's own stage at overall progress p (0..1). */
function stageTime(panel: Panel, progress: number, stages: number): number {
  if (!panel.stage) return 1;
  return MathUtils.clamp(progress * stages - (panel.stage - 1), 0, 1);
}

/** Fold amount (0..1) of a panel at overall progress p (0..1). */
export function panelProgress(panel: Panel, progress: number, stages: number): number {
  return ease(stageTime(panel, progress, stages));
}

/** Fold angle (deg) of a panel at overall progress p, following its keyframes if it has any. */
export function panelAngle(panel: Panel, progress: number, stages: number): number {
  if (panel.timeline) return keyframes(panel.timeline, progress);
  const keys = panel.motion;
  if (!keys) return (panel.angle ?? 90) * panelProgress(panel, progress, stages);
  const t = stageTime(panel, progress, stages);
  let prev: [number, number] = [0, 0];
  for (const k of keys) {
    if (t <= k[0]) {
      const span = k[0] - prev[0];
      return prev[1] + (k[1] - prev[1]) * (span > 0 ? (t - prev[0]) / span : 1);
    }
    prev = k;
  }
  return prev[1];
}

/** Linear interpolation through [time, value] keyframes. */
function keyframes(keys: [number, number][], t: number): number {
  let prev = keys[0];
  for (const k of keys) {
    if (t <= k[0]) {
      const span = k[0] - prev[0];
      return prev[1] + (k[1] - prev[1]) * (span > 0 ? (t - prev[0]) / span : 1);
    }
    prev = k;
  }
  return prev[1];
}

function centroid(poly: Vec2[]): Vec2 {
  const n = poly.length;
  return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
}

/** Sign of rotation about a hinge that moves the child panel towards -z (inwards). */
function foldSign(p: Panel): number {
  const [a, b] = p.hinge!;
  const axis = to3(b).sub(to3(a)).normalize();
  const c = to3(centroid(p.poly)).sub(to3(a));
  const moved = c.applyAxisAngle(axis, 0.1);
  return moved.z < 0 ? 1 : -1;
}

/** Hinge transforms of every panel relative to its piece root (no layering offset). At progress 1 this is the assembled box. */
export function localMatrices(d: Dieline, progress: number, open = 0): Map<string, Matrix4> {
  const stages = maxStage(d);
  const byId = new Map(d.panels.map((p) => [p.id, p]));
  const out = new Map<string, Matrix4>();
  const resolve = (p: Panel): Matrix4 => {
    const cached = out.get(p.id);
    if (cached) return cached;
    let m = new Matrix4();
    if (p.parent && p.hinge) {
      const parent = byId.get(p.parent);
      if (!parent) throw new Error(`Unknown parent ${p.parent}`);
      const a = to3(p.hinge[0]);
      const axis = to3(p.hinge[1]).sub(a).normalize();
      const angle = MathUtils.degToRad(panelAngle(p, progress, stages) + (p.open ?? 0) * open) * foldSign(p);
      m = resolve(parent)
        .clone()
        .multiply(new Matrix4().makeTranslation(a.x, a.y, a.z))
        .multiply(new Matrix4().makeRotationAxis(axis, angle))
        .multiply(new Matrix4().makeTranslation(-a.x, -a.y, -a.z));
    }
    out.set(p.id, m);
    return m;
  };
  d.panels.forEach(resolve);
  return out;
}

function pieceQuat(rotation: [number, number, number]): Quaternion {
  return new Quaternion().setFromEuler(
    new Euler(...(rotation.map((r) => MathUtils.degToRad(r)) as [number, number, number]), 'XYZ'),
  );
}

/** Flat orientation: sheet lying on the ground, printed side down. */
const FLAT = pieceQuat([90, 0, 0]);

function bounds(d: Dieline, mats: Map<string, Matrix4>, thickness: number, pre: Matrix4, piece?: number) {
  const box = new Box3();
  const v = new Vector3();
  for (const p of d.panels) {
    if (piece !== undefined && p.piece !== piece) continue;
    const m = pre.clone().multiply(mats.get(p.id)!);
    for (const pt of p.poly) {
      for (const z of [0, -thickness]) {
        v.set(pt[0], -pt[1], z).applyMatrix4(m);
        box.expandByPoint(v);
      }
    }
  }
  return box;
}

export interface FoldOptions {
  thickness: number;
  /** Extra height of the lid above the base, in mm. */
  lidLift?: number;
  /** How far hinged lids are opened, 0..1 (see Panel.open). */
  open?: number;
}

/**
 * World matrices of every panel at a given fold progress. At progress 0 the sheet lies
 * flat on the ground (y = 0 plane); at 1 the box stands assembled on the ground,
 * centred on the origin.
 */
export function foldMatrices(d: Dieline, progress: number, opts: FoldOptions): Map<string, Matrix4> {
  const t = opts.thickness;
  const open = opts.open ?? 0;
  const local = localMatrices(d, progress, open);
  const finalLocal = progress === 1 && !open ? local : localMatrices(d, 1);

  const byId = new Map(d.panels.map((p) => [p.id, p]));
  // Each piece rotates about the centre of its root panel.
  const rootCentre = new Map(d.pieces.map((pc) => [pc.index, to3(centroid(byId.get(pc.root)!.poly))]));
  const pre = (q: Quaternion, piece: number) =>
    new Matrix4().makeRotationFromQuaternion(q).multiply(
      new Matrix4().makeTranslation(rootCentre.get(piece)!.clone().negate()),
    );

  // Flat placement: whole sheet centred, lying on the ground.
  const flatRot = new Matrix4().makeRotationFromQuaternion(FLAT);
  const flatBox = bounds(d, localMatrices(d, 0), t, flatRot);
  const flatPos = new Vector3(
    -(flatBox.min.x + flatBox.max.x) / 2,
    -flatBox.min.y,
    -(flatBox.min.z + flatBox.max.z) / 2,
  );

  // Final placement per piece.
  const finalPos = new Map<number, Vector3>();
  let baseTop = 0;
  const sorted = [...d.pieces].sort((a, b) => (a.role === 'base' ? -1 : 1) - (b.role === 'base' ? -1 : 1));
  for (const pc of sorted) {
    if (pc.role === 'insert') continue;
    const box = bounds(d, finalLocal, t, pre(pieceQuat(pc.rotation), pc.index), pc.index);
    const cx = -(box.min.x + box.max.x) / 2;
    const cz = -(box.min.z + box.max.z) / 2;
    if (pc.role === 'base') {
      // Inside a sleeve the base rests on the sleeve's bottom panel.
      const floor = d.pieces.some((x) => x.role === 'sleeve') ? t : 0;
      finalPos.set(pc.index, new Vector3(cx, floor - box.min.y, cz));
      baseTop = box.max.y - box.min.y;
    } else if (pc.role === 'sleeve') {
      // Slides along the length; "lid lift" pulls it off one end.
      finalPos.set(pc.index, new Vector3(cx + (opts.lidLift ?? 0), -box.min.y, cz));
    } else {
      finalPos.set(pc.index, new Vector3(cx, baseTop + t + (opts.lidLift ?? 0) - box.max.y, cz));
    }
  }

  // Inserts: glued against a panel of the base, wherever that ends up.
  const finalQuat = new Map(d.pieces.map((pc) => [pc.index, pieceQuat(pc.rotation)]));
  const base = d.pieces.find((pc) => pc.role === 'base') ?? d.pieces[0];
  for (const pc of d.pieces) {
    if (pc.role !== 'insert' || !pc.place) continue;
    const { anchor, from, to, z } = pc.place;
    const world = new Matrix4()
      .makeTranslation(finalPos.get(base.index)!)
      .multiply(pre(finalQuat.get(base.index)!, base.index))
      .multiply(finalLocal.get(anchor)!)
      .multiply(new Matrix4().makeTranslation(to3(to).sub(to3(from)).setZ(z)));
    const p = new Vector3();
    const q = new Quaternion();
    world.decompose(p, q, new Vector3());
    finalQuat.set(pc.index, q);
    finalPos.set(pc.index, p.add(rootCentre.get(pc.index)!.clone().applyQuaternion(q)));
  }

  // Move from flat to final placement during the first part of the fold (inserts when
  // they're due).
  const pieceMats = new Map<number, Matrix4>();
  for (const pc of d.pieces) {
    const [a0, a1] = pc.role === 'insert' && pc.place ? pc.place.arrive : [0, 0.35];
    const w = ease(MathUtils.clamp((progress - a0) / (a1 - a0), 0, 1));
    const q = FLAT.clone().slerp(finalQuat.get(pc.index)!, w);
    const start = flatPos.clone().add(rootCentre.get(pc.index)!.clone().applyQuaternion(FLAT));
    const pos = start.lerp(finalPos.get(pc.index)!, w);
    // Lift second pieces clear of the base while they turn over.
    if (pc.role !== 'base') pos.y += Math.sin(w * Math.PI) * 0.6 * Math.max(d.outer[0], d.outer[1]);
    pieceMats.set(pc.index, new Matrix4().makeTranslation(pos).multiply(pre(q, pc.index)));
  }

  const stages = maxStage(d);
  const out = new Map<string, Matrix4>();
  for (const p of d.panels) {
    const base = pieceMats.get(p.piece)!;
    const m = base.clone().multiply(local.get(p.id)!);
    if (p.offset) {
      const k = p.offset * t * panelProgress(p, progress, stages);
      m.multiply(new Matrix4().makeTranslation(0, 0, k));
    }
    out.set(p.id, m);
  }
  return out;
}

/** Bounding box of the assembled box (all pieces) — used to frame the camera and in tests. */
export function foldedBounds(d: Dieline, progress: number, opts: FoldOptions, piece?: number): Box3 {
  const mats = foldMatrices(d, progress, opts);
  return bounds(d, mats, opts.thickness, new Matrix4(), piece);
}
