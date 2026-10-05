import { computeLines } from '../geometry/lines';
import type { Dieline, Vec2 } from '../types';
import { flattenPath, pathData, type PathPoint } from './curves';
import {
  BASE_ID, deleteVertex, edgeOf, editablePoints, insertVertex, layout, makeChild, moveVertex,
  canCarry, clone, copySubtree, isRoot, removePiece, rootBase, toSheet, setEdgeLength, flipPanel, mirrorCopy, overlaps, rawPanels, subtree, toLocal, freeSpans,
  type AdvancedDesign, type Placed,
} from './model';

export type Tool = 'select' | 'pen' | 'cut' | 'measure';

interface View {
  scale: number; // px per mm
  tx: number;
  ty: number;
}

type Drag =
  | { kind: 'pan'; start: Vec2; view: View }
  | { kind: 'depth' | 'taper0' | 'taper1' | 'width' | 'height'; id: string }
  | { kind: 'vertex'; id: string; index: number }
  | { kind: 'move'; id: string; grab: Vec2 };

interface PenState {
  parent: string;
  edge: number;
  start: Vec2; // sheet point on the edge
  span: [number, number]; // the free stretch of the edge it started on
  points: PathPoint[];
}

interface CutState {
  panel: string;
  points: PathPoint[];
}

const SVGNS = 'http://www.w3.org/2000/svg';
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const pathOf = (loops: Vec2[][]) =>
  loops.map((l) => l.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ') + ' Z').join(' ');

/**
 * Interactive 2D editor for an AdvancedDesign, drawn as SVG. It owns selection, tools,
 * history and the view; every change to the design is reported through `onChange`.
 */
export class Editor {
  design: AdvancedDesign;
  selected: string | null = BASE_ID;
  selectedVertex: number | null = null;
  tool: Tool = 'select';
  snap = 1;
  onChange: (d: AdvancedDesign) => void = () => {};
  onSelect: () => void = () => {};
  onToolHint: (hint: string) => void = () => {};
  onTool: (t: Tool) => void = () => {};

  private svg: SVGSVGElement;
  private view: View = { scale: 2, tx: 0, ty: 0 };
  private drag: Drag | null = null;
  private pen: PenState | null = null;
  private cut: CutState | null = null;
  /** A pen or cut-out point being dragged out into a curve (its handle follows the pointer). */
  private bend: PathPoint | null = null;
  /** Points popped by undo while drawing, for redo. */
  private pointRedo: PathPoint[] = [];
  /** A length being typed while drawing (Enter places the next point that far away). */
  private typed = '';
  /** Shift held: drawn segments keep to 15° steps. */
  private shiftHeld = false;
  /** The measure tool's line (kept on screen until the next measurement). */
  private measure: { a: Vec2; b: Vec2; done: boolean } | null = null;
  /** Placing a copy of a panel: click a free edge to drop it there. */
  private placing: { id: string; mirrored: boolean } | null = null;
  private hoverEdge: { panel: string; edge: number; at: Vec2; span?: [number, number] } | null = null;
  private cursor: Vec2 | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCheckpoint = { key: '', time: 0 };
  private placed = new Map<string, Placed>();

  constructor(private host: HTMLElement, design: AdvancedDesign) {
    this.design = design;
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('adv-svg');
    host.append(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onUp(e));
    this.svg.addEventListener('dblclick', (e) => this.onDouble(e));
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.render()).observe(host);
    this.render();
    requestAnimationFrame(() => this.fit());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setDesign(d: AdvancedDesign, resetHistory = false) {
    this.design = d;
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    if (this.selected && !isRoot(d, this.selected) && !d.panels.some((p) => p.id === this.selected)) this.selected = BASE_ID;
    this.changed(false);
    this.fit();
  }

  setTool(t: Tool) {
    this.tool = t;
    this.pen = null;
    this.cut = null;
    this.placing = null;
    this.measure = null;
    this.typed = '';
    this.pointRedo = [];
    this.hint();
    this.render();
    this.onTool(t);
  }

  select(id: string | null) {
    this.selected = id;
    this.selectedVertex = null;
    this.onSelect();
    this.render();
  }

  /** Saves an undo point. Calls with the same key in quick succession share one point. */
  checkpoint(key = '') {
    const now = performance.now();
    if (key && key === this.lastCheckpoint.key && now - this.lastCheckpoint.time < 1200) {
      this.lastCheckpoint.time = now;
      return;
    }
    this.lastCheckpoint = { key, time: now };
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.design = this.restore(prev);
    this.lastCheckpoint = { key: '', time: 0 };
    this.afterHistory();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.design = this.restore(next);
    this.afterHistory();
  }

  /** History entries leave out the texture (it can be megabytes); it stays as it is. */
  private snapshot(d = this.design): string {
    const { texture: _texture, ...rest } = d;
    return JSON.stringify(rest);
  }

  private restore(json: string): AdvancedDesign {
    const d = JSON.parse(json) as AdvancedDesign;
    if (this.design.texture) d.texture = this.design.texture;
    return d;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Call after mutating the design from outside (e.g. the inspector). */
  changed(notify = true) {
    this.placed = layout(this.design);
    this.render();
    if (notify) this.onChange(this.design);
  }

  fit() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pts = [...layout(this.design).values()].flatMap((p) => p.poly);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 50;
    const scale = Math.min((r.width - 2 * pad) / Math.max(x1 - x0, 1), (r.height - 2 * pad) / Math.max(y1 - y0, 1), 8);
    this.view = { scale, tx: r.width / 2 - ((x0 + x1) / 2) * scale, ty: r.height / 2 - ((y0 + y1) / 2) * scale };
    this.render();
  }

  /** Zooms around the centre of the view (for buttons / touch screens). */
  zoomBy(k: number) {
    const r = this.host.getBoundingClientRect();
    const scale = Math.min(40, Math.max(0.1, this.view.scale * k));
    const f = scale / this.view.scale;
    const cx = r.width / 2;
    const cy = r.height / 2;
    this.view = { scale, tx: cx - (cx - this.view.tx) * f, ty: cy - (cy - this.view.ty) * f };
    this.render();
  }

  deleteSelection() {
    if (!this.selected) return;
    if (this.selectedVertex !== null) {
      this.checkpoint();
      deleteVertex(this.design, this.selected, this.selectedVertex);
      this.selectedVertex = null;
      this.changed();
      return;
    }
    if (this.selected === BASE_ID) return;
    if (isRoot(this.design, this.selected)) {
      // An extra piece's base: the whole piece goes.
      this.checkpoint();
      removePiece(this.design, this.selected);
      this.select(BASE_ID);
      this.changed();
      return;
    }
    this.checkpoint();
    const doomed = this.selected;
    const parent = this.design.panels.find((p) => p.id === doomed)?.parent ?? BASE_ID;
    const ids = new Set([doomed]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of this.design.panels) if (ids.has(p.parent) && !ids.has(p.id)) (ids.add(p.id), (grew = true));
    }
    this.design.panels = this.design.panels.filter((p) => !ids.has(p.id));
    this.select(parent);
    this.changed();
  }

  /** Starts placing a copy of the selected panel (and what's on it) on a free edge. */
  startDuplicate(mirrored = false) {
    if (!this.selected || isRoot(this.design, this.selected)) return;
    this.setTool('select');
    this.placing = { id: this.selected, mirrored };
    this.hint();
    this.render();
  }

  /** A mirrored copy at the other end of the selected panel's edge; false if there's no room. */
  mirrorSelected(): boolean {
    if (!this.selected || isRoot(this.design, this.selected)) return false;
    const before = clone(this.design);
    const id = mirrorCopy(this.design, this.selected);
    if (!id) return false;
    this.undoStack.push(this.snapshot(before));
    this.redoStack = [];
    this.selected = id;
    this.changed();
    this.onSelect();
    this.keepInView(id);
    return true;
  }

  /** Flips the selected panel (and what's on it) left to right. */
  flipSelected() {
    if (!this.selected || isRoot(this.design, this.selected)) return;
    this.checkpoint();
    flipPanel(this.design, this.selected);
    this.changed();
  }

  /** Keyboard shortcuts; returns true if the key was handled. */
  key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    // While drawing, undo/redo and typed lengths work on the drawing itself.
    const drawing = this.drawingPoints();
    if (drawing) {
      if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        if (e.key.toLowerCase() === 'y' || e.shiftKey) {
          const q = this.pointRedo.pop();
          if (q) drawing.push(q);
        } else if (drawing.length) {
          this.pointRedo.push(drawing.pop()!);
        } else {
          // Nothing left to take back: stop drawing.
          this.pen = null;
          this.cut = null;
          this.hint();
        }
        this.typed = '';
        this.render();
        return true;
      }
      if (!mod && /^[0-9.,]$/.test(e.key)) {
        this.typed += e.key === ',' ? '.' : e.key;
        this.render();
        return true;
      }
      if (e.key === 'Backspace' && this.typed) {
        this.typed = this.typed.slice(0, -1);
        this.render();
        return true;
      }
      if (e.key === 'Enter' && this.typed) {
        this.placeTyped(e.shiftKey);
        return true;
      }
      if (e.key === 'Escape' && this.typed) {
        this.typed = '';
        this.render();
        return true;
      }
    }
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      this.startDuplicate(e.shiftKey);
      return true;
    }
    if (e.key === 'Escape') {
      if (this.pen || this.cut || this.placing) {
        this.pen = null;
        this.cut = null;
        this.placing = null;
        this.hint();
        this.render();
      } else this.setTool('select');
      return true;
    }
    if (this.placing && e.key.toLowerCase() === 'm' && !mod) {
      this.placing.mirrored = !this.placing.mirrored;
      this.render();
      return true;
    }
    if (e.key === 'Enter' && this.cut) {
      this.finishCut();
      return true;
    }
    if (e.key === 'Backspace' && drawing?.length) {
      this.pointRedo.push(drawing.pop()!);
      this.render();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    const tools: Record<string, Tool> = { v: 'select', p: 'pen', c: 'cut', m: 'measure' };
    if (!mod && tools[e.key.toLowerCase()]) {
      this.setTool(tools[e.key.toLowerCase()]);
      return true;
    }
    return false;
  }

  /** Lines in layout coordinates, for drawing. */
  private lines() {
    return computeLines({ panels: rawPanels(this.design) } as Dieline);
  }

  // -------------------------------------------------------------------------
  // Coordinates & hit testing
  // -------------------------------------------------------------------------

  private toWorld(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.svg.getBoundingClientRect();
    return [(e.clientX - r.left - this.view.tx) / this.view.scale, (e.clientY - r.top - this.view.ty) / this.view.scale];
  }

  private snapPt([x, y]: Vec2): Vec2 {
    if (!this.snap) return [x, y];
    return [Math.round(x / this.snap) * this.snap, Math.round(y / this.snap) * this.snap];
  }

  private snapVal(v: number) {
    return this.snap ? Math.round(v / this.snap) * this.snap : v;
  }

  /**
   * The panel edge nearest to a point (within a few screen pixels), with the point projected
   * onto it. With `freeOnly`, only the free stretches of walls and the base count, and the
   * stretch the point is on comes back as `span`.
   */
  private nearestEdge(p: Vec2, freeOnly: boolean) {
    const tol = 8 / this.view.scale;
    let best: { panel: string; edge: number; at: Vec2; d: number; span?: [number, number] } | null = null;
    for (const pl of this.placed.values()) {
      // Free edges are where something new can go, so only on walls and the base.
      if (freeOnly && !canCarry(this.design, pl.id)) continue;
      for (let k = 0; k < pl.poly.length; k++) {
        const [a, b] = edgeOf(pl.poly, k);
        const ab: Vec2 = [b[0] - a[0], b[1] - a[1]];
        const L2 = ab[0] ** 2 + ab[1] ** 2;
        if (L2 < 1e-6) continue;
        const L = Math.sqrt(L2);
        let lo = 0;
        let hi = L;
        let span: [number, number] | undefined;
        if (freeOnly) {
          // The free stretch nearest to the point along the edge.
          const u = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L;
          const gap = (s: [number, number]) => Math.max(0, s[0] - u, u - s[1]);
          span = freeSpans(this.design, pl.id, k, this.placed).sort((x, y) => gap(x) - gap(y))[0];
          if (!span) continue;
          [lo, hi] = span;
        }
        const u = Math.max(lo, Math.min(hi, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L));
        const at: Vec2 = [a[0] + (ab[0] * u) / L, a[1] + (ab[1] * u) / L];
        const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
        if (d < tol && (!best || d < best.d)) best = { panel: pl.id, edge: k, at, d, span };
      }
    }
    return best;
  }

  /** Snaps a point on edge (panel, k) to the grid along the edge, keeping it within `span`. */
  private snapOnEdge(panel: string, k: number, at: Vec2, span?: [number, number]): Vec2 {
    const pl = this.placed.get(panel)!;
    const [a, b] = edgeOf(pl.poly, k);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const [lo, hi] = span ?? [0, L];
    const t = Math.max(lo, Math.min(hi, this.snapVal(Math.hypot(at[0] - a[0], at[1] - a[1]))));
    return [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
  }

  private panelAt(p: Vec2): string | null {
    // Children are drawn on top, so test them first.
    const list = [...this.placed.values()].reverse();
    for (const pl of list) if (inPoly(p, pl.poly)) return pl.id;
    return null;
  }

  // -------------------------------------------------------------------------
  // Pointer handling
  // -------------------------------------------------------------------------

  private onDown(e: PointerEvent) {
    const p = this.toWorld(e);
    const target = e.target as Element;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      this.startPan(e);
      return;
    }
    if (e.button !== 0) return;

    this.shiftHeld = e.shiftKey;
    if (this.tool === 'pen') return this.penClick(p);
    if (this.tool === 'cut') return this.cutClick(p);
    if (this.placing) return this.placeClick(p);
    if (this.tool === 'measure') {
      const q = this.snapMeasure(p);
      if (!this.measure || this.measure.done) this.measure = { a: q, b: q, done: false };
      else this.measure = { ...this.measure, b: q, done: true };
      this.render();
      return;
    }

    const add = target.closest('[data-add]');
    if (add) {
      const [panel, edge, u0, u1] = add.getAttribute('data-add')!.split(':');
      this.addChild(panel, +edge, [+u0, +u1]);
      return;
    }
    const handle = target.closest('[data-handle]');
    if (handle && this.selected) {
      const kind = handle.getAttribute('data-handle')!;
      this.checkpoint();
      if (kind === 'vertex') {
        const index = +handle.getAttribute('data-index')!;
        this.selectedVertex = index;
        this.drag = { kind: 'vertex', id: this.selected, index };
      } else if (kind === 'move') {
        const pc = this.design.pieces?.find((x) => x.id === this.selected);
        if (pc) this.drag = { kind: 'move', id: pc.id, grab: [p[0] - pc.at[0], p[1] - pc.at[1]] };
      } else {
        this.drag = { kind: kind as 'depth', id: this.selected };
      }
      this.svg.setPointerCapture(e.pointerId);
      this.render();
      return;
    }
    const id = this.panelAt(p);
    if (id) {
      if (id !== this.selected) this.select(id);
      else if (this.selectedVertex !== null) {
        this.selectedVertex = null;
        this.render();
      }
      return;
    }
    this.select(null);
    this.startPan(e);
  }

  private startPan(e: PointerEvent) {
    this.drag = { kind: 'pan', start: [e.clientX, e.clientY], view: { ...this.view } };
    this.svg.setPointerCapture(e.pointerId);
    this.svg.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent) {
    const p = this.toWorld(e);
    this.cursor = p;
    this.shiftHeld = e.shiftKey;
    const d = this.drag;
    if (d?.kind === 'pan') {
      this.view = { ...d.view, tx: d.view.tx + e.clientX - d.start[0], ty: d.view.ty + e.clientY - d.start[1] };
      this.render();
      return;
    }
    if (d) {
      this.dragTo(d, p, e.shiftKey);
      return;
    }
    if (this.bend && e.buttons & 1) {
      const h: Vec2 = [p[0] - this.bend.p[0], p[1] - this.bend.p[1]];
      if (Math.hypot(h[0], h[1]) * this.view.scale > 4) this.bend.h = h;
      else delete this.bend.h;
      this.render();
      return;
    }
    if (this.tool === 'pen' || this.placing) {
      this.hoverEdge = this.pen ? null : this.nearestEdge(p, true);
      this.render();
    } else if (this.tool === 'cut' && this.cut) {
      this.render();
    } else if (this.tool === 'measure') {
      if (this.measure && !this.measure.done) this.measure.b = this.snapMeasure(p);
      this.render();
    }
  }

  private onUp(e: PointerEvent) {
    this.bend = null;
    // Measuring works by dragging as well as by clicking both ends.
    const m = this.measure;
    if (this.tool === 'measure' && m && !m.done && Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) * this.view.scale > 6) {
      m.done = true;
      this.render();
    }
    if (this.drag) {
      if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
      const wasEdit = this.drag.kind !== 'pan';
      this.drag = null;
      this.svg.style.cursor = '';
      if (wasEdit) this.onSelect();
    }
  }

  private onDouble(e: MouseEvent) {
    if (this.tool !== 'select') return;
    // Double-click a fold angle or a length to type a new value. (The SVG is redrawn on
    // every click, so look up what's under the pointer now.)
    const label = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-angle],[data-len]');
    if (label) return this.editLabel(label);
    if (!this.selected) return;
    const p = this.toWorld(e);
    const pl = this.placed.get(this.selected);
    if (!pl) return;
    // Double-click an edge of the selected panel to add a corner there.
    const hit = this.nearestEdge(p, false);
    if (!hit || hit.panel !== this.selected) return;
    if (!isRoot(this.design, this.selected) && hit.edge === 0) return; // the hinge stays straight
    this.checkpoint();
    const local = toLocal(pl, this.snapPt(hit.at));
    insertVertex(this.design, this.selected, hit.edge, local);
    this.selectedVertex = hit.edge + 1;
    this.changed();
    this.onSelect();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.min(40, Math.max(0.1, this.view.scale * k));
    const f = scale / this.view.scale;
    this.view = { scale, tx: sx - (sx - this.view.tx) * f, ty: sy - (sy - this.view.ty) * f };
    this.render();
  }

  /** `shift` lets a narrowing handle move one side only (otherwise both stay symmetric). */
  private dragTo(d: Drag, p: Vec2, shift = false) {
    if (d.kind === 'pan') return;
    if (d.kind === 'move') {
      // Moving a whole extra piece around the sheet.
      const pc = this.design.pieces?.find((x) => x.id === d.id);
      if (pc) pc.at = this.snapPt([p[0] - d.grab[0], p[1] - d.grab[1]]);
      this.changed();
      return;
    }
    const pl = this.placed.get(d.id);
    if (!pl) return;
    const root = rootBase(this.design, d.id);
    if (root) {
      const [u, v] = toLocal(pl, this.snapPt(p));
      if (d.kind === 'width') root.width = Math.max(5, u);
      if (d.kind === 'height') root.height = Math.max(5, v);
      if (d.kind === 'vertex') moveVertex(this.design, d.id, d.index, [u, v]);
      this.changed();
      return;
    }
    const panel = this.design.panels.find((x) => x.id === d.id)!;
    const [u, v] = toLocal(pl, p);
    if (d.kind === 'vertex') {
      const s = this.snapPt(p);
      moveVertex(this.design, d.id, d.index, toLocal(pl, s));
    } else if (panel.shape.type === 'rect') {
      if (d.kind === 'depth') panel.shape.depth = Math.max(1, this.snapVal(v));
      if (d.kind === 'taper0') {
        panel.shape.taper0 = this.snapVal(u);
        if (!shift) panel.shape.taper1 = panel.shape.taper0;
      }
      if (d.kind === 'taper1') {
        panel.shape.taper1 = this.snapVal(pl.hinge - u);
        if (!shift) panel.shape.taper0 = panel.shape.taper1;
      }
    }
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private addChild(parent: string, edge: number, span: [number, number]) {
    const child = makeChild(this.design, parent, edge, span);
    if (!child) return;
    this.checkpoint();
    this.design.panels.push(child);
    this.selected = child.id;
    this.selectedVertex = null;
    this.changed();
    this.onSelect();
    this.keepInView(child.id);
  }

  /** Re-fits the view if a panel ended up (partly) off screen. */
  private keepInView(id: string) {
    const pl = this.placed.get(id);
    const r = this.host.getBoundingClientRect();
    if (!pl || !r.width) return;
    const off = pl.poly.some(([x, y]) => {
      const sx = this.view.tx + x * this.view.scale;
      const sy = this.view.ty + y * this.view.scale;
      return sx < 10 || sy < 10 || sx > r.width - 10 || sy > r.height - 10;
    });
    if (off) this.fit();
  }

  /** Measure tool snapping: corners first, then edges, then the grid. */
  private snapMeasure(p: Vec2): Vec2 {
    const tol = 8 / this.view.scale;
    let best: Vec2 | null = null;
    let bd = tol;
    for (const pl of this.placed.values())
      for (const q of [pl.poly, ...pl.holes].flat()) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bd) (best = q), (bd = d);
      }
    if (best) return [best[0], best[1]];
    const hit = this.nearestEdge(p, false);
    if (hit && hit.d < 6 / this.view.scale) return hit.at;
    return this.snapPt(p);
  }

  /** An input over a label for typing a new fold angle or length. */
  private editLabel(label: Element) {
    const angleId = label.getAttribute('data-angle');
    const k = label.getAttribute('data-len');
    const id = angleId ?? this.selected;
    if (!id) return;
    const panel = this.design.panels.find((x) => x.id === id);
    if (angleId && !panel) return;
    const edgeLen = () => {
      const [a, b] = edgeOf(this.placed.get(id)!.poly, +k!);
      return Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 10) / 10;
    };
    const value = angleId ? Math.round(panel!.angle) : edgeLen();
    const r = label.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'inline-edit';
    input.value = String(value);
    input.style.left = `${r.left + r.width / 2 - host.left}px`;
    input.style.top = `${r.top + r.height / 2 - host.top}px`;
    if (angleId) (input.min = '-180'), (input.max = '180');
    else input.min = '1';
    this.host.append(input);
    input.focus();
    input.select();
    let done = false;
    const close = (commit: boolean) => {
      if (done) return;
      done = true;
      input.remove();
      const v = parseFloat(input.value);
      if (!commit || !Number.isFinite(v) || v === value) return;
      this.checkpoint();
      if (angleId) {
        panel!.angle = Math.max(-180, Math.min(180, v));
        // A custom fold path no longer matches the new angle.
        delete panel!.motion;
        delete panel!.timeline;
      } else if (!setEdgeLength(this.design, id, +k!, v)) {
        this.undoStack.pop();
        return;
      }
      this.changed();
      this.onSelect();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(true);
      if (e.key === 'Escape') close(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => close(true));
  }

  /** Where a copy being placed would start on the hovered free stretch (null: no room). */
  private placement(hit: { panel: string; edge: number; at: Vec2; span?: [number, number] } | null) {
    if (!this.placing || !hit?.span) return null;
    const src = this.placed.get(this.placing.id);
    if (!src) return null;
    const H = src.hinge;
    const [s0, s1] = hit.span;
    if (s1 - s0 < H - 0.01) return null;
    const [a] = edgeOf(this.placed.get(hit.panel)!.poly, hit.edge);
    const u = Math.hypot(hit.at[0] - a[0], hit.at[1] - a[1]);
    return { ...hit, inset0: Math.max(s0, Math.min(s1 - H, this.snapVal(u - H / 2))) };
  }

  private placeClick(p: Vec2) {
    const where = this.placement(this.nearestEdge(p, true));
    if (!where || !this.placing) return;
    this.checkpoint();
    const id = copySubtree(this.design, this.placing.id, where.panel, where.edge, where.inset0, this.placing.mirrored);
    this.placing = null;
    this.hoverEdge = null;
    if (id) this.selected = id;
    this.changed();
    this.onSelect();
    this.hint();
    if (id) this.keepInView(id);
  }

  private penClick(p: Vec2) {
    if (!this.pen) {
      const hit = this.nearestEdge(p, true);
      if (!hit) return;
      this.pen = { parent: hit.panel, edge: hit.edge, span: hit.span!, start: this.snapOnEdge(hit.panel, hit.edge, hit.at, hit.span), points: [] };
      this.hint();
      this.render();
      return;
    }
    // Clicking back on the starting edge finishes the flap. It can't run past the free
    // stretch it started in, so it never lands on a panel already on that edge.
    // (Checked against that edge alone, so a click on its corner, where other edges meet,
    // still counts.)
    if (this.pen.points.length) {
      const [a, b] = edgeOf(this.placed.get(this.pen.parent)!.poly, this.pen.edge);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u = Math.max(this.pen.span[0], Math.min(this.pen.span[1], ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L));
      const at: Vec2 = [a[0] + ((b[0] - a[0]) * u) / L, a[1] + ((b[1] - a[1]) * u) / L];
      if (Math.hypot(p[0] - at[0], p[1] - at[1]) * this.view.scale < 8) {
        this.finishPen(this.snapOnEdge(this.pen.parent, this.pen.edge, at, this.pen.span));
        return;
      }
    }
    this.addPathPoint(this.pen.points, p, this.shiftHeld);
  }

  private finishPen(end: Vec2) {
    const pen = this.pen!;
    const parent = this.placed.get(pen.parent)!;
    const [a, b] = edgeOf(parent.poly, pen.edge);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const along = (q: Vec2) => ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / L;
    let u0 = along(pen.start);
    let u1 = along(end);
    // Curves become short straight pieces (the end points sit on the hinge, so drop them).
    let pts = flattenPath([{ p: pen.start }, ...pen.points, { p: end }]).slice(1, -1);
    if (u0 > u1) {
      [u0, u1] = [u1, u0];
      pts = [...pts].reverse();
    }
    if (u1 - u0 < 1) {
      this.pen = null;
      this.hint();
      this.render();
      return;
    }
    // Express the drawn points in the new panel's frame; the outline runs from the hinge's
    // end back round to its start, so reverse them.
    const child = makeChild(this.design, pen.parent, pen.edge, [u0, u1])!;
    const frame: Placed = {
      ...parent,
      origin: [a[0] + ((b[0] - a[0]) * u0) / L, a[1] + ((b[1] - a[1]) * u0) / L],
      U: [(b[0] - a[0]) / L, (b[1] - a[1]) / L],
      V: outward(parent, pen.edge),
    };
    child.shape = { type: 'custom', points: [...pts].reverse().map((q) => toLocal(frame, q)) };
    this.checkpoint();
    this.design.panels.push(child);
    this.pen = null;
    this.selected = child.id;
    this.changed();
    this.onSelect();
    this.hint();
    this.keepInView(child.id);
  }

  /** The points of the pen or cut-out drawing in progress, if any. */
  private drawingPoints(): PathPoint[] | null {
    return this.pen?.points ?? this.cut?.points ?? null;
  }

  /** The point the next segment starts from. */
  private lastDrawn(): Vec2 | null {
    if (this.pen) return this.pen.points.length ? this.pen.points[this.pen.points.length - 1].p : this.pen.start;
    if (this.cut?.points.length) return this.cut.points[this.cut.points.length - 1].p;
    return null;
  }

  /** Where a click at `p` puts the next point: on the grid, or with Shift at a 15° step. */
  private aimAt(p: Vec2, shift: boolean): Vec2 {
    const from = this.lastDrawn();
    if (!shift || !from) return this.snapPt(p);
    const len = this.snapVal(Math.hypot(p[0] - from[0], p[1] - from[1]));
    const step = Math.PI / 12;
    const a = Math.round(Math.atan2(p[1] - from[1], p[0] - from[0]) / step) * step;
    return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
  }

  /** Places the next point the typed length away, towards the pointer. */
  private placeTyped(shift: boolean) {
    const len = parseFloat(this.typed);
    this.typed = '';
    const from = this.lastDrawn();
    const list = this.drawingPoints();
    if (!from || !list || !this.cursor || !(len > 0)) return this.render();
    const aim = this.aimAt(this.cursor, shift || this.shiftHeld);
    const d = Math.hypot(aim[0] - from[0], aim[1] - from[1]);
    if (d < 1e-6) return this.render();
    list.push({ p: [from[0] + ((aim[0] - from[0]) * len) / d, from[1] + ((aim[1] - from[1]) * len) / d] });
    this.pointRedo = [];
    this.render();
  }

  /** Adds a corner; dragging before letting go pulls it into a curve. */
  private addPathPoint(list: PathPoint[], p: Vec2, shift = false) {
    const pt: PathPoint = { p: this.aimAt(p, shift) };
    this.pointRedo = [];
    list.push(pt);
    this.bend = pt;
    this.render();
  }

  private cutClick(p: Vec2) {
    const s = this.snapPt(p);
    if (!this.cut) {
      const id = this.panelAt(p);
      if (!id) return;
      this.cut = { panel: id, points: [] };
      this.hint();
      this.addPathPoint(this.cut.points, p, this.shiftHeld);
      return;
    }
    const first = this.cut.points[0].p;
    if (this.cut.points.length >= 3 && Math.hypot(s[0] - first[0], s[1] - first[1]) * this.view.scale < 10) {
      this.finishCut();
      return;
    }
    this.addPathPoint(this.cut.points, p, this.shiftHeld);
  }

  private finishCut() {
    const cut = this.cut;
    this.cut = null;
    if (!cut || cut.points.length < 3) return this.render();
    const pl = this.placed.get(cut.panel)!;
    this.checkpoint();
    const loop = flattenPath(cut.points, true);
    (rootBase(this.design, cut.panel) ?? this.design.panels.find((x) => x.id === cut.panel)!).holes.push(loop.map((q) => toLocal(pl, q)));
    this.selected = cut.panel;
    this.changed();
    this.onSelect();
    this.hint();
  }

  private hint() {
    const hints: Record<Tool, string> = {
      select: '+ adds a wall or flap · double-click an angle or length to type it · double-click an edge: add corner · Ctrl+D: duplicate · Ctrl+Z: undo',
      pen: this.pen
        ? 'Click for a corner, drag for a curve, or type a length + Enter. Shift: 15° steps. Click the starting edge to finish. Ctrl+Z: undo a point.'
        : 'Click a free edge of a wall (or the base) to start drawing a flap from it.',
      cut: this.cut
        ? 'Click for a corner, drag for a curve, or type a length + Enter. Shift: 15° steps. Click the first point or press Enter to finish. Ctrl+Z: undo a point.'
        : 'Click inside a panel to start a cut-out.',
      measure: 'Click two points (or drag) to measure. Snaps to corners and edges.',
    };
    this.onToolHint(
      this.placing
        ? 'Click a free edge to place the copy (M: mirror it, Esc: cancel).'
        : hints[this.tool],
    );
  }

  private afterHistory() {
    if (this.selected && !isRoot(this.design, this.selected) && !this.design.panels.some((p) => p.id === this.selected)) this.selected = BASE_ID;
    this.selectedVertex = null;
    this.changed();
    this.onSelect();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  render() {
    const r = this.host.getBoundingClientRect();
    this.svg.setAttribute('width', String(r.width));
    this.svg.setAttribute('height', String(r.height));
    if (!this.placed.size) this.placed = layout(this.design);
    const { scale, tx, ty } = this.view;
    const px = (v: number) => v / scale; // screen px → mm
    const parts: string[] = [];

    // Grid: 10 mm squares, 50 mm emphasised; hidden when too dense.
    const grid = (step: number, cls: string) => {
      if (step * scale < 6) return;
      const x0 = Math.floor(-tx / scale / step) * step;
      const y0 = Math.floor(-ty / scale / step) * step;
      const x1 = (r.width - tx) / scale;
      const y1 = (r.height - ty) / scale;
      let d = '';
      for (let x = x0; x <= x1; x += step) d += `M${n(x)} ${n(y0)}V${n(y1)}`;
      for (let y = y0; y <= y1; y += step) d += `M${n(x0)} ${n(y)}H${n(x1)}`;
      parts.push(`<path class="${cls}" d="${d}"/>`);
    };
    grid(10, 'grid');
    grid(50, 'grid major');

    const bad = new Set(overlaps(this.design).flat());
    for (const pl of this.placed.values()) {
      const kind = pl.panel?.kind ?? 'wall';
      const cls = ['pnl', `k-${kind}`, pl.id === this.selected ? 'sel' : '', bad.has(pl.id) ? 'bad' : ''].join(' ');
      parts.push(`<path class="${cls}" data-panel="${pl.id}" fill-rule="evenodd" d="${pathOf([pl.poly, ...pl.holes])}"/>`);
    }

    const { cuts, folds } = this.lines();
    const segs = (list: typeof cuts) => list.map((s) => `M${n(s.a[0])} ${n(s.a[1])}L${n(s.b[0])} ${n(s.b[1])}`).join('');
    parts.push(`<path class="ln-fold" d="${segs(folds)}"/>`);
    parts.push(`<path class="ln-cut" d="${segs(cuts)}"/>`);

    // Fold angle labels on hinges.
    for (const pl of this.placed.values()) {
      if (!pl.panel) continue;
      const mid: Vec2 = [pl.origin[0] + (pl.U[0] * pl.hinge) / 2, pl.origin[1] + (pl.U[1] * pl.hinge) / 2];
      const off = px(18); // clear of the resize handles that sit on edge midpoints
      const at: Vec2 = [mid[0] + pl.V[0] * off, mid[1] + pl.V[1] * off];
      parts.push(`<text class="angle" data-angle="${pl.id}" x="${n(at[0])}" y="${n(at[1])}" font-size="${n(px(10))}"><title>Double-click to change</title>${Math.round(pl.panel.angle)}°</text>`);
    }

    if (this.tool === 'select' && !this.placing) parts.push(...this.addButtons(px));
    if (this.tool === 'select' && this.selected && !this.placing) parts.push(...this.dimensions(px), ...this.handles(px));
    parts.push(...this.toolOverlay(px));

    this.svg.innerHTML = `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(scale)})">${parts.join('')}</g>`;
    this.svg.style.cursor = this.tool === 'select' && !this.placing ? '' : 'crosshair';
  }

  /** "+" buttons on every free stretch of edge. */
  private addButtons(px: (v: number) => number): string[] {
    const out: string[] = [];
    for (const pl of this.placed.values()) {
      if (!canCarry(this.design, pl.id)) continue;
      for (let k = 0; k < pl.poly.length; k++) {
        const [a, b] = edgeOf(pl.poly, k);
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nrm = outward(pl, k);
        for (const [u0, u1] of freeSpans(this.design, pl.id, k, this.placed)) {
          if ((u1 - u0) * this.view.scale < 18) continue;
          const m = (u0 + u1) / 2 / L;
          const c: Vec2 = [a[0] + (b[0] - a[0]) * m + nrm[0] * px(12), a[1] + (b[1] - a[1]) * m + nrm[1] * px(12)];
          const rr = px(8);
          out.push(
            `<g class="add" data-add="${pl.id}:${k}:${u0}:${u1}"><circle cx="${n(c[0])}" cy="${n(c[1])}" r="${n(rr)}"/>` +
              `<path d="M${n(c[0] - rr * 0.5)} ${n(c[1])}H${n(c[0] + rr * 0.5)}M${n(c[0])} ${n(c[1] - rr * 0.5)}V${n(c[1] + rr * 0.5)}"/></g>`,
          );
        }
      }
    }
    return out;
  }

  /** Edge lengths around the selected panel (double-click one to type a new length). */
  private dimensions(px: (v: number) => number): string[] {
    const pl = this.placed.get(this.selected!);
    if (!pl) return [];
    const out: string[] = [];
    for (let k = 0; k < pl.poly.length; k++) {
      const [a, b] = edgeOf(pl.poly, k);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L * this.view.scale < 28) continue;
      const nrm = outward(pl, k);
      // Inside the panel, clear of the + buttons outside and the handles on the edge. The
      // hinge's label moves along a bit to make room for the fold angle in the middle.
      const hinge = k === 0 && !!pl.panel;
      const t = hinge ? 0.22 : 0.5;
      const off = -px(hinge ? 18 : 16);
      const at: Vec2 = [a[0] + (b[0] - a[0]) * t + nrm[0] * off, a[1] + (b[1] - a[1]) * t + nrm[1] * off];
      out.push(`<text class="dim" data-len="${k}" x="${n(at[0])}" y="${n(at[1])}" font-size="${n(px(10.5))}"><title>Double-click to change</title>${fmt(L)}</text>`);
    }
    return out;
  }

  private measureOverlay(px: (v: number) => number): string[] {
    const m = this.measure;
    const out: string[] = [];
    if (!m) {
      // Show where a click would snap to.
      if (this.cursor) {
        const q = this.snapMeasure(this.cursor);
        out.push(`<circle class="measure-pt" cx="${n(q[0])}" cy="${n(q[1])}" r="${n(px(3.5))}"/>`);
      }
      return out;
    }
    const { a, b } = m;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    out.push(`<path class="measure" d="M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}"/>`);
    for (const q of [a, b]) out.push(`<circle class="measure-pt" cx="${n(q[0])}" cy="${n(q[1])}" r="${n(px(3.5))}"/>`);
    if (L * this.view.scale > 2) {
      const ang = Math.abs((Math.atan2(-dy, dx) * 180) / Math.PI);
      const axis = Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01;
      const text = `${fmt(L)} mm` + (axis ? '' : `  ·  ↔ ${fmt(Math.abs(dx))}  ↕ ${fmt(Math.abs(dy))}  ∠ ${fmt(ang > 90 ? 180 - ang : ang)}°`);
      const nrm: Vec2 = [-dy / L, dx / L];
      const at: Vec2 = [(a[0] + b[0]) / 2 + nrm[0] * px(14), (a[1] + b[1]) / 2 + nrm[1] * px(14)];
      out.push(`<text class="measure-label" x="${n(at[0])}" y="${n(at[1])}" font-size="${n(px(12))}">${text}</text>`);
    }
    return out;
  }

  /** Resize handles (rectangles) or corner handles (free-form shapes) for the selection. */
  private handles(px: (v: number) => number): string[] {
    const id = this.selected!;
    const pl = this.placed.get(id);
    if (!pl) return [];
    const out: string[] = [];
    // Curves are many short pieces; smaller corner handles keep them readable.
    const many = (editablePoints(this.design, id)?.length ?? 0) > 16;
    const dot = (p: Vec2, kind: string, extra = '', cls = '') =>
      out.push(`<circle class="handle ${cls}" data-handle="${kind}" ${extra} cx="${n(p[0])}" cy="${n(p[1])}" r="${n(px(kind === 'vertex' && many ? 3.5 : 6))}"/>`);
    const root = rootBase(this.design, id);
    const custom = root ? !!root.points : pl.panel!.shape.type === 'custom';
    if (root && id !== BASE_ID) {
      // Extra pieces: a square handle at the corner moves the whole piece.
      const c = toSheet(pl, [0, 0]);
      const r = px(6);
      out.push(`<rect class="handle move" data-handle="move" x="${n(c[0] - px(16) - r)}" y="${n(c[1] - px(16) - r)}" width="${n(2 * r)}" height="${n(2 * r)}"><title>Drag to move this piece on the sheet</title></rect>`);
    }
    if (custom) {
      const pts = editablePoints(this.design, id)!;
      pts.forEach((q, i) => {
        if (!root && i < 2) return; // hinge corners follow the parent
        const s = toSheet(pl, q);
        dot(s, 'vertex', `data-index="${i}"`, i === this.selectedVertex ? 'on' : '');
      });
      return out;
    }
    if (root) {
      dot(toSheet(pl, [root.width, root.height / 2]), 'width');
      dot(toSheet(pl, [root.width / 2, root.height]), 'height');
      return out;
    }
    const s = pl.panel!.shape;
    if (s.type !== 'rect') return out;
    const P = (u: number, v: number): Vec2 => [pl.origin[0] + pl.U[0] * u + pl.V[0] * v, pl.origin[1] + pl.U[1] * u + pl.V[1] * v];
    dot(P((s.taper0 + pl.hinge - s.taper1) / 2, s.depth), 'depth');
    dot(P(s.taper0, s.depth), 'taper0', '', 'small');
    dot(P(pl.hinge - s.taper1, s.depth), 'taper1', '', 'small');
    return out;
  }

  /** Highlights the stretch `span` of edge k of a panel (the whole edge without one). */
  private spanPath(panel: string, k: number, span?: [number, number]): string {
    const [a, b] = edgeOf(this.placed.get(panel)!.poly, k);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [u0, u1] = span ?? [0, L];
    const at = (u: number): Vec2 => [a[0] + ((b[0] - a[0]) * u) / L, a[1] + ((b[1] - a[1]) * u) / L];
    const [p, q] = [at(u0), at(u1)];
    return `<path class="edge-hover" d="M${n(p[0])} ${n(p[1])}L${n(q[0])} ${n(q[1])}"/>`;
  }

  /** Length and angle of the segment being drawn, and any typed length, by the pointer. */
  private segmentReadout(px: (v: number) => number): string[] {
    const from = this.lastDrawn();
    if (!from || !this.cursor || this.bend) return [];
    const to = this.aimAt(this.cursor, this.shiftHeld);
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const ang = (Math.atan2(-(to[1] - from[1]), to[0] - from[0]) * 180) / Math.PI;
    const text = this.typed ? `${this.typed}▏mm  ↵` : `${fmt(len)} mm  ∠ ${fmt((ang + 360) % 360)}°`;
    const at: Vec2 = [this.cursor[0] + px(14), this.cursor[1] - px(14)];
    return [`<text class="measure-label readout${this.typed ? ' typing' : ''}" x="${n(at[0])}" y="${n(at[1])}" font-size="${n(px(12))}">${text}</text>`];
  }

  /** Dots for drawn points, and the handles of curved ones. */
  private pathHandles(pts: PathPoint[], px: (v: number) => number, firstBig = false): string[] {
    const out: string[] = [];
    pts.forEach(({ p, h }, i) => {
      if (h) {
        const [a, b] = [[p[0] - h[0], p[1] - h[1]], [p[0] + h[0], p[1] + h[1]]];
        out.push(`<path class="draft-handle" d="M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}"/>`);
        for (const q of [a, b]) out.push(`<circle class="draft-hpt" cx="${n(q[0])}" cy="${n(q[1])}" r="${n(px(2.5))}"/>`);
      }
      const big = firstBig && i === 0;
      out.push(`<circle class="draft-pt ${big ? 'first' : ''}" cx="${n(p[0])}" cy="${n(p[1])}" r="${n(px(big ? 5 : 3.5))}"/>`);
    });
    return out;
  }

  private toolOverlay(px: (v: number) => number): string[] {
    const out: string[] = [];
    const c = this.cursor;
    if (this.tool === 'pen') {
      if (this.hoverEdge && !this.pen) {
        out.push(this.spanPath(this.hoverEdge.panel, this.hoverEdge.edge, this.hoverEdge.span));
      }
      if (this.pen) {
        out.push(this.spanPath(this.pen.parent, this.pen.edge, this.pen.span));
        const pts: PathPoint[] = [{ p: this.pen.start }, ...this.pen.points, ...(c && !this.bend ? [{ p: this.aimAt(c, this.shiftHeld) }] : [])];
        out.push(`<path class="draft" d="${pathData(pts, n)}"/>`);
        out.push(...this.pathHandles([{ p: this.pen.start }, ...this.pen.points], px));
      }
    }
    if (this.placing) {
      const where = this.placement(this.hoverEdge);
      if (where) {
        // A ghost of the copy where it would land.
        const ghost = clone(this.design);
        const id = copySubtree(ghost, this.placing.id, where.panel, where.edge, where.inset0, this.placing.mirrored);
        const pls = layout(ghost);
        const ids = id ? subtree(ghost, id).map((q) => q.id) : [];
        const src = this.placed.get(this.placing.id)!;
        out.push(this.spanPath(where.panel, where.edge, [where.inset0, where.inset0 + src.hinge]));
        for (const g of ids) {
          const pl = pls.get(g);
          if (pl) out.push(`<path class="ghost" d="${pathOf([pl.poly])}"/>`);
        }
      } else if (this.hoverEdge) {
        out.push(this.spanPath(this.hoverEdge.panel, this.hoverEdge.edge, this.hoverEdge.span).replace('edge-hover', 'edge-hover no'));
      }
    }
    if (this.tool === 'measure') out.push(...this.measureOverlay(px));
    out.push(...this.segmentReadout(px));
    if (this.tool === 'cut' && this.cut) {
      const pts: PathPoint[] = [...this.cut.points, ...(c && !this.bend ? [{ p: this.aimAt(c, this.shiftHeld) }] : [])];
      out.push(`<path class="draft cut" d="${pathData(pts, n)}"/>`);
      out.push(...this.pathHandles(this.cut.points, px, true));
    }
    return out;
  }
}

/** A length for labels: whole millimetres, or one decimal when that matters. */
function fmt(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function inPoly([x, y]: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Outward unit normal of edge k of a placed panel. */
function outward(pl: Placed, k: number): Vec2 {
  const [a, b] = edgeOf(pl.poly, k);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nrm: Vec2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  const probe: Vec2 = [(a[0] + b[0]) / 2 + nrm[0] * 0.1, (a[1] + b[1]) / 2 + nrm[1] * 0.1];
  return inPoly(probe, pl.poly) ? [-nrm[0], -nrm[1]] : nrm;
}

