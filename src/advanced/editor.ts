import { computeLines } from '../geometry/lines';
import type { Dieline, Vec2 } from '../types';
import {
  BASE_ID, deleteVertex, edgeOf, editablePoints, insertVertex, layout, makeChild, moveVertex,
  canCarry, overlaps, rawPanels, toLocal, freeSpans, type AdvancedDesign, type Placed,
} from './model';

export type Tool = 'select' | 'pen' | 'cut';

interface View {
  scale: number; // px per mm
  tx: number;
  ty: number;
}

type Drag =
  | { kind: 'pan'; start: Vec2; view: View }
  | { kind: 'depth' | 'taper0' | 'taper1' | 'width' | 'height'; id: string }
  | { kind: 'vertex'; id: string; index: number };

interface PenState {
  parent: string;
  edge: number;
  start: Vec2; // sheet point on the edge
  span: [number, number]; // the free stretch of the edge it started on
  points: Vec2[];
}

interface CutState {
  panel: string;
  points: Vec2[];
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

  private svg: SVGSVGElement;
  private view: View = { scale: 2, tx: 0, ty: 0 };
  private drag: Drag | null = null;
  private pen: PenState | null = null;
  private cut: CutState | null = null;
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
    if (this.selected && this.selected !== BASE_ID && !d.panels.some((p) => p.id === this.selected)) this.selected = BASE_ID;
    this.changed(false);
    this.fit();
  }

  setTool(t: Tool) {
    this.tool = t;
    this.pen = null;
    this.cut = null;
    this.hint();
    this.render();
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
    this.undoStack.push(JSON.stringify(this.design));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.design));
    this.design = JSON.parse(prev);
    this.lastCheckpoint = { key: '', time: 0 };
    this.afterHistory();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.design));
    this.design = JSON.parse(next);
    this.afterHistory();
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

  /** Keyboard shortcuts; returns true if the key was handled. */
  key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    if (e.key === 'Escape') {
      if (this.pen || this.cut) {
        this.pen = null;
        this.cut = null;
        this.hint();
        this.render();
      } else this.setTool('select');
      return true;
    }
    if (e.key === 'Enter' && this.cut) {
      this.finishCut();
      return true;
    }
    if (e.key === 'Backspace' && (this.pen?.points.length || this.cut?.points.length)) {
      (this.pen?.points ?? this.cut!.points).pop();
      this.render();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      return true;
    }
    const tools: Record<string, Tool> = { v: 'select', p: 'pen', c: 'cut' };
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

    if (this.tool === 'pen') return this.penClick(p);
    if (this.tool === 'cut') return this.cutClick(p);

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
    if (this.tool === 'pen') {
      this.hoverEdge = this.pen ? null : this.nearestEdge(p, true);
      this.render();
    } else if (this.tool === 'cut' && this.cut) {
      this.render();
    }
  }

  private onUp(e: PointerEvent) {
    if (this.drag) {
      if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
      const wasEdit = this.drag.kind !== 'pan';
      this.drag = null;
      this.svg.style.cursor = '';
      if (wasEdit) this.onSelect();
    }
  }

  private onDouble(e: MouseEvent) {
    if (this.tool !== 'select' || !this.selected) return;
    const p = this.toWorld(e);
    const pl = this.placed.get(this.selected);
    if (!pl) return;
    // Double-click an edge of the selected panel to add a corner there.
    const hit = this.nearestEdge(p, false);
    if (!hit || hit.panel !== this.selected) return;
    if (this.selected !== BASE_ID && hit.edge === 0) return; // the hinge stays straight
    this.checkpoint();
    const local = this.selected === BASE_ID ? this.snapPt(hit.at) : toLocal(pl, this.snapPt(hit.at));
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
    const pl = this.placed.get(d.id);
    if (!pl) return;
    if (d.id === BASE_ID) {
      const b = this.design.base;
      if (d.kind === 'width') b.width = Math.max(5, this.snapVal(p[0]));
      if (d.kind === 'height') b.height = Math.max(5, this.snapVal(p[1]));
      if (d.kind === 'vertex') moveVertex(this.design, BASE_ID, d.index, this.snapPt(p));
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
    this.pen.points.push(this.snapPt(p));
    this.render();
  }

  private finishPen(end: Vec2) {
    const pen = this.pen!;
    const parent = this.placed.get(pen.parent)!;
    const [a, b] = edgeOf(parent.poly, pen.edge);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const along = (q: Vec2) => ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / L;
    let u0 = along(pen.start);
    let u1 = along(end);
    let pts = pen.points;
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

  private cutClick(p: Vec2) {
    const s = this.snapPt(p);
    if (!this.cut) {
      const id = this.panelAt(p);
      if (!id) return;
      this.cut = { panel: id, points: [s] };
      this.hint();
      this.render();
      return;
    }
    const first = this.cut.points[0];
    if (this.cut.points.length >= 3 && Math.hypot(s[0] - first[0], s[1] - first[1]) * this.view.scale < 10) {
      this.finishCut();
      return;
    }
    this.cut.points.push(s);
    this.render();
  }

  private finishCut() {
    const cut = this.cut;
    this.cut = null;
    if (!cut || cut.points.length < 3) return this.render();
    const pl = this.placed.get(cut.panel)!;
    this.checkpoint();
    if (cut.panel === BASE_ID) this.design.base.holes.push(cut.points);
    else this.design.panels.find((x) => x.id === cut.panel)!.holes.push(cut.points.map((q) => toLocal(pl, q)));
    this.selected = cut.panel;
    this.changed();
    this.onSelect();
    this.hint();
  }

  private hint() {
    const hints: Record<Tool, string> = {
      select: '+ adds a wall or flap (only walls carry panels) · Shift-drag: one side · double-click edge: add corner · Ctrl+Z: undo',
      pen: this.pen
        ? 'Click to add points. Click the starting edge again to finish (Backspace undoes a point, Esc cancels).'
        : 'Click a free edge of a wall (or the base) to start drawing a flap from it.',
      cut: this.cut
        ? 'Click to add points. Click the first point or press Enter to finish the cut-out.'
        : 'Click inside a panel to start a cut-out.',
    };
    this.onToolHint(hints[this.tool]);
  }

  private afterHistory() {
    if (this.selected && this.selected !== BASE_ID && !this.design.panels.some((p) => p.id === this.selected)) this.selected = BASE_ID;
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
      parts.push(`<text class="angle" x="${n(at[0])}" y="${n(at[1])}" font-size="${n(px(10))}">${Math.round(pl.panel.angle)}°</text>`);
    }

    if (this.tool === 'select') parts.push(...this.addButtons(px));
    if (this.tool === 'select' && this.selected) parts.push(...this.handles(px));
    parts.push(...this.toolOverlay(px));

    this.svg.innerHTML = `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(scale)})">${parts.join('')}</g>`;
    this.svg.style.cursor = this.tool === 'select' ? '' : 'crosshair';
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

  /** Resize handles (rectangles) or corner handles (free-form shapes) for the selection. */
  private handles(px: (v: number) => number): string[] {
    const id = this.selected!;
    const pl = this.placed.get(id);
    if (!pl) return [];
    const out: string[] = [];
    const dot = (p: Vec2, kind: string, extra = '', cls = '') =>
      out.push(`<circle class="handle ${cls}" data-handle="${kind}" ${extra} cx="${n(p[0])}" cy="${n(p[1])}" r="${n(px(6))}"/>`);
    const custom = id === BASE_ID ? !!this.design.base.points : pl.panel!.shape.type === 'custom';
    if (custom) {
      const pts = editablePoints(this.design, id)!;
      pts.forEach((q, i) => {
        if (id !== BASE_ID && i < 2) return; // hinge corners follow the parent
        const s = id === BASE_ID ? q : [pl.origin[0] + pl.U[0] * q[0] + pl.V[0] * q[1], pl.origin[1] + pl.U[1] * q[0] + pl.V[1] * q[1]] as Vec2;
        dot(s, 'vertex', `data-index="${i}"`, i === this.selectedVertex ? 'on' : '');
      });
      return out;
    }
    if (id === BASE_ID) {
      const b = this.design.base;
      dot([b.width, b.height / 2], 'width');
      dot([b.width / 2, b.height], 'height');
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

  private toolOverlay(px: (v: number) => number): string[] {
    const out: string[] = [];
    const c = this.cursor;
    if (this.tool === 'pen') {
      if (this.hoverEdge && !this.pen) {
        out.push(this.spanPath(this.hoverEdge.panel, this.hoverEdge.edge, this.hoverEdge.span));
      }
      if (this.pen) {
        out.push(this.spanPath(this.pen.parent, this.pen.edge, this.pen.span));
        const pts = [this.pen.start, ...this.pen.points, ...(c ? [this.snapPt(c)] : [])];
        out.push(`<path class="draft" d="${pts.map((q, i) => `${i ? 'L' : 'M'}${n(q[0])} ${n(q[1])}`).join('')}"/>`);
        for (const q of [this.pen.start, ...this.pen.points]) out.push(`<circle class="draft-pt" cx="${n(q[0])}" cy="${n(q[1])}" r="${n(px(3.5))}"/>`);
      }
    }
    if (this.tool === 'cut' && this.cut) {
      const pts = [...this.cut.points, ...(c ? [this.snapPt(c)] : [])];
      out.push(`<path class="draft cut" d="${pts.map((q, i) => `${i ? 'L' : 'M'}${n(q[0])} ${n(q[1])}`).join('')}"/>`);
      this.cut.points.forEach((q, i) =>
        out.push(`<circle class="draft-pt ${i === 0 ? 'first' : ''}" cx="${n(q[0])}" cy="${n(q[1])}" r="${n(px(i === 0 ? 5 : 3.5))}"/>`),
      );
    }
    return out;
  }
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

