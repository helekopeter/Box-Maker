/** A 2D point in dieline (sheet) coordinates. Units are millimetres, y points down (like SVG). */
export type Vec2 = [number, number];

export type BoxStyle =
  | 'rsc'
  | 'tuck'
  | 'rte'
  | 'snaplock'
  | 'autolock'
  | 'sealend'
  | 'gable'
  | 'tray'
  | 'traylid'
  | 'sleeve'
  | 'shape';

export interface BoxParams {
  style: BoxStyle;
  /** Inner dimensions in mm. Length runs left-right across the front, width is front-to-back. */
  length: number;
  width: number;
  height: number;
  /** Material thickness in mm. */
  thickness: number;
  /** Width of glue tabs in mm. */
  glueTab: number;
  /** Lid height in mm (tray + lid only). */
  lidHeight: number;
  /** Extra room between tray and lid or sleeve, in mm. */
  lidClearance: number;
}

export type PanelKind = 'face' | 'flap' | 'glue';

/**
 * One rigid panel of the dieline. Panels form a tree: every non-root panel is
 * attached to its parent by a hinge (a fold line) and rotates about it when folded.
 */
export interface Panel {
  id: string;
  /** Index of the separate cut piece this panel belongs to (e.g. tray vs lid). */
  piece: number;
  kind: PanelKind;
  /** Outline polygon in sheet coordinates. */
  poly: Vec2[];
  /** Cut-outs inside the panel (e.g. a handle hole). */
  holes?: Vec2[][];
  parent?: string;
  /** Fold line shared with the parent. */
  hinge?: [Vec2, Vec2];
  /** Fully-folded angle in degrees. Positive folds towards the inside of the box, negative outwards. */
  angle?: number;
  /** Fold order; panels with a lower stage fold first. */
  stage?: number;
  /**
   * Custom fold path within the panel's stage as [time 0..1, angle in degrees] keyframes,
   * interpolated linearly, e.g. so a tuck flap slides in behind a wall as its lid closes.
   * Overrides `angle`; the last keyframe is the folded angle.
   */
  motion?: [number, number][];
  /**
   * Layering nudge applied when folded, in multiples of the material thickness
   * along the panel's outside normal. Keeps overlapping flaps from z-fighting.
   */
  offset?: number;
}

/** A printable face of the box that decals can be placed on. */
export interface Face {
  id: string;
  label: string;
  /** Region of the sheet covered by this face. */
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise rotation (deg) that turns the sheet's "up" into the face's upright direction. */
  rotation: number;
}

export interface PieceInfo {
  index: number;
  root: string;
  /** Final orientation of the root panel as Euler angles in degrees (XYZ). */
  rotation: [number, number, number];
  /** base: stands on the ground. lid: sits on top of the base. sleeve: slides over the base. */
  role: 'base' | 'lid' | 'sleeve';
}

export interface Dieline {
  panels: Panel[];
  faces: Face[];
  pieces: PieceInfo[];
  /** Overall sheet size in mm, including margin. */
  width: number;
  height: number;
  /** Outer dimensions of the assembled box (length, width, height) in mm. */
  outer: [number, number, number];
}

export interface Decal {
  id: string;
  type: 'text' | 'image';
  face: string;
  /** Centre position within the face, 0..1 (0,0 = top-left). */
  x: number;
  y: number;
  /** Image: width as a fraction of the face width. Text: font size as a fraction of the face height. */
  size: number;
  /** Rotation in degrees, clockwise. */
  rotation: number;
  text?: string;
  color?: string;
  font?: string;
  bold?: boolean;
  /** Image data URL. */
  src?: string;
  /** Image height / width. */
  aspect?: number;
}

export interface Appearance {
  color: string;
  decals: Decal[];
}

export type FoldMode = 'score' | 'perforate';

export interface ExportOptions {
  foldMode: FoldMode;
  includeArtwork: boolean;
  includeGlue: boolean;
}
