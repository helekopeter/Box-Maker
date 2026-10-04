import { renderArtwork } from '../artwork';
import { DecalLayer } from '../decals';
import { buildSvg } from '../export/svg';
import { BoxPreview } from '../preview3d';
import type { Decal, Dieline, ExportOptions, FoldMode, Vec2 } from '../types';
import { $, buildSwatches, download, el, syncSwatches } from '../ui';
import { Editor, type Tool } from './editor';
import {
  BASE_ID, clone, layout, makeCustom, newDesign, overlaps, sanitizeDesign, toDieline, type AdvancedDesign,
  type CustomKind, type CustomPanel,
} from './model';

const STORAGE_KEY = 'box-maker:adv:v1';

interface Saved {
  design: AdvancedDesign;
  exp: ExportOptions;
}

function loadSaved(): Saved {
  const fallback: Saved = { design: newDesign(), exp: { foldMode: 'score', includeArtwork: false, includeGlue: true } };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<Saved>;
    const design = sanitizeDesign(s.design);
    return { design: design ?? fallback.design, exp: { ...fallback.exp, ...s.exp } };
  } catch {
    return fallback;
  }
}

/** What the Advanced tab saves to the Box Universe. */
export interface AdvancedShare {
  kind: 'advanced';
  design: AdvancedDesign;
}

const KIND_LABEL: Record<CustomKind, string> = { wall: 'Wall', flap: 'Flap', glue: 'Glue tab' };

/**
 * The Advanced tab: draw a box from scratch on a 2D editor, with a live 3D fold preview.
 */
export class AdvancedTab {
  editor: Editor;
  preview: BoxPreview;
  decals: DecalLayer;
  dieline: Dieline;
  private exp: ExportOptions;
  private fold = 1;
  private queued = false;
  private saveTimer = 0;
  private artCanvas = document.createElement('canvas');
  private artToken = 0;
  private reframe = true;
  private framedSize = 0;
  /** Narrow start/end move together. */
  private linkTaper = true;

  constructor() {
    const saved = loadSaved();
    this.exp = saved.exp;
    this.dieline = toDieline(saved.design);
    this.preview = new BoxPreview($('#adv-viewer'));
    this.editor = new Editor($('#adv-editor'), saved.design);
    this.decals = new DecalLayer({
      list: $('#adv-decals'),
      empty: $('#adv-decal-empty'),
      help: $('#adv-decal-help'),
      addText: $('#adv-add-text'),
      addImage: $<HTMLInputElement>('#adv-add-image'),
      preview: this.preview,
      dieline: () => this.dieline,
      decals: () => (this.design.decals ??= []),
      changed: () => this.queue(),
    });
    this.editor.onChange = () => this.queue(true);
    this.editor.onSelect = () => this.renderInspector();
    this.editor.onToolHint = (h) => ($('#adv-tool-hint').textContent = h);
    this.bind();
    this.editor.setTool('select');
    this.rebuild();
    this.renderInspector();
    this.decals.render();
  }

  get design(): AdvancedDesign {
    return this.editor.design;
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  private geometryDirty = true;

  /** Coalesces redraws to one per frame. */
  private queue(geometry = false) {
    if (geometry) this.geometryDirty = true;
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (this.geometryDirty) this.rebuild();
      else this.renderArt();
      this.save();
    });
  }

  private rebuild() {
    this.geometryDirty = false;
    this.dieline = toDieline(this.design);
    // Re-aim the camera when the design changes size a lot (not on every small edit).
    const size = Math.max(this.dieline.width, this.dieline.height, ...this.dieline.outer);
    const ratio = size / (this.framedSize || size);
    if (ratio > 1.35 || ratio < 0.6) this.reframe = true;
    this.preview.setDieline(this.dieline, this.design.thickness, this.reframe);
    if (this.reframe) this.framedSize = size;
    this.reframe = false;
    this.preview.setProgress(this.fold);
    this.decals.validate();
    this.renderArt();
    this.renderStats();
    this.syncLook();
  }

  private async renderArt() {
    const token = ++this.artToken;
    const dl = this.dieline;
    const scale = Math.min(4, 4096 / Math.max(dl.width, dl.height));
    const off = document.createElement('canvas');
    await renderArtwork(dl, { color: this.design.color, decals: this.design.decals ?? [] }, { scale, preview: true, selected: this.decals.selected }, off);
    if (token !== this.artToken) return;
    this.artCanvas.width = off.width;
    this.artCanvas.height = off.height;
    this.artCanvas.getContext('2d')!.drawImage(off, 0, 0);
    this.preview.setArtwork(this.artCanvas);
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ design: this.design, exp: this.exp }));
      } catch {
        /* storage full or unavailable */
      }
    }, 400);
  }

  private renderStats() {
    const [L, W, H] = this.dieline.outer;
    const bad = overlaps(this.design);
    const r = (v: number) => Math.round(v);
    $('#adv-stats').innerHTML =
      `<div><span>Folded size</span><b>${r(L)} × ${r(W)} × ${r(H)} mm</b></div>` +
      `<div><span>Sheet</span><b>${r(this.dieline.width)} × ${r(this.dieline.height)} mm</b></div>` +
      `<div><span>Panels</span><b>${this.design.panels.length + 1}</b></div>` +
      (bad.length
        ? `<div class="warn">⚠ ${bad.length === 1 ? 'Two panels overlap' : `${bad.length} pairs of panels overlap`} on the sheet (shown in red), so this can't be cut from one piece. Make them smaller, narrow them with taper, or move them to another edge.</div>`
        : '');
  }

  // -------------------------------------------------------------------------
  // Sidebar
  // -------------------------------------------------------------------------

  private bind() {
    document.querySelectorAll<HTMLButtonElement>('#adv-tools button[data-tool]').forEach((b) =>
      b.addEventListener('click', () => this.setTool(b.dataset.tool as Tool)),
    );
    $('#adv-fit').addEventListener('click', () => this.editor.fit());
    $('#adv-zoom-in').addEventListener('click', () => this.editor.zoomBy(1.25));
    $('#adv-zoom-out').addEventListener('click', () => this.editor.zoomBy(0.8));
    $<HTMLSelectElement>('#adv-snap').addEventListener('change', (e) => (this.editor.snap = parseFloat((e.target as HTMLSelectElement).value)));

    $<HTMLSelectElement>('#adv-material').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      $('#adv-thickness-row').hidden = v !== 'custom';
      if (v !== 'custom') this.setThickness(parseFloat(v));
    });
    $<HTMLInputElement>('#adv-thickness').addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) this.setThickness(Math.min(10, Math.max(0.2, v)));
    });
    buildSwatches($('#adv-swatches'), (c) => this.setColor(c));
    $<HTMLInputElement>('#adv-color').addEventListener('input', (e) => this.setColor((e.target as HTMLInputElement).value));

    document.querySelectorAll<HTMLInputElement>('input[name=advFoldMode]').forEach((r) => {
      r.checked = r.value === this.exp.foldMode;
      r.addEventListener('change', () => {
        this.exp.foldMode = r.value as FoldMode;
        this.save();
      });
    });
    $<HTMLInputElement>('#adv-includeGlue').checked = this.exp.includeGlue;
    $<HTMLInputElement>('#adv-includeGlue').addEventListener('change', (e) => (this.exp.includeGlue = (e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('#adv-includeArtwork').checked = this.exp.includeArtwork;
    $<HTMLInputElement>('#adv-includeArtwork').addEventListener('change', (e) => (this.exp.includeArtwork = (e.target as HTMLInputElement).checked));
    $('#adv-dl-svg').addEventListener('click', () => this.downloadSvg());
    $('#adv-dl-pdf').addEventListener('click', () => this.downloadPdf());

    const foldInput = $<HTMLInputElement>('#adv-fold');
    foldInput.value = String(this.fold);
    foldInput.addEventListener('input', () => {
      this.preview.stopAnimation();
      this.fold = parseFloat(foldInput.value);
      this.preview.setProgress(this.fold);
      this.syncPlay();
    });
    this.preview.onProgress = (p) => {
      this.fold = p;
      foldInput.value = String(p);
      this.syncPlay();
    };
    $('#adv-play').addEventListener('click', () => this.preview.animateTo(this.fold > 0.5 ? 0 : 1));
    $<HTMLInputElement>('#adv-spin').addEventListener('change', (e) => (this.preview.autoRotate = (e.target as HTMLInputElement).checked));
    this.syncPlay();
  }

  private syncPlay() {
    $('#adv-play').textContent = this.fold > 0.5 ? '⟲' : '▶';
  }

  setTool(t: Tool) {
    this.editor.setTool(t);
    document.querySelectorAll<HTMLButtonElement>('#adv-tools button[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  }

  private setThickness(t: number) {
    this.editor.checkpoint('thickness');
    this.design.thickness = t;
    this.editor.changed();
  }

  private setColor(c: string) {
    this.editor.checkpoint('color');
    this.design.color = c;
    this.syncLook();
    this.queue();
  }

  private syncLook() {
    $<HTMLInputElement>('#adv-color').value = this.design.color;
    syncSwatches($('#adv-swatches'), this.design.color);
    const preset = ['0.3', '1', '1.5', '2', '3', '4'].find((m) => parseFloat(m) === this.design.thickness);
    $<HTMLSelectElement>('#adv-material').value = preset ?? 'custom';
    $('#adv-thickness-row').hidden = !!preset;
    $<HTMLInputElement>('#adv-thickness').value = String(this.design.thickness);
  }

  /** Builds the panel inspector for the current selection. */
  renderInspector() {
    const host = $('#adv-inspector');
    host.innerHTML = '';
    const id = this.editor.selected;
    if (!id) {
      host.append(el('h2', { textContent: 'Nothing selected' }), el('p', { className: 'hint', textContent: 'Click a panel to edit it, or click + on any free edge to add a wall or flap.' }));
      return;
    }
    const pl = layout(this.design).get(id);
    if (!pl) return;
    const edit = (key: string, fn: () => void) => {
      this.editor.checkpoint(`${id}:${key}`);
      fn();
      this.editor.changed();
    };
    const field = (label: string, value: number, key: string, set: (v: number) => void, opts: { min?: number; max?: number; step?: number; unit?: string } = {}) => {
      const inp = el('input', { type: 'number', value: String(Math.round(value * 100) / 100), step: String(opts.step ?? 1) });
      if (opts.min !== undefined) inp.min = String(opts.min);
      if (opts.max !== undefined) inp.max = String(opts.max);
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        edit(key, () => set(Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, v))));
      });
      return el('label', { className: 'row' }, `${label}${opts.unit ? ` (${opts.unit})` : ''}`, inp);
    };
    const button = (text: string, onClick: () => void, cls = 'btn small') => {
      const b = el('button', { className: cls, textContent: text });
      b.addEventListener('click', onClick);
      return b;
    };

    if (id === BASE_ID) {
      const b = this.design.base;
      host.append(el('h2', { textContent: 'Base' }));
      if (!b.points) {
        host.append(
          field('Width', b.width, 'w', (v) => (b.width = v), { min: 5, unit: 'mm' }),
          field('Height', b.height, 'h', (v) => (b.height = v), { min: 5, unit: 'mm' }),
        );
        host.append(el('div', { className: 'btn-row' }, button('Free-form shape', () => edit('shape', () => makeCustom(this.design, BASE_ID)))));
      } else {
        host.append(el('p', { className: 'hint', textContent: 'Drag the corners. Double-click an edge to add a corner; select a corner and press Delete to remove it.' }));
      }
      if (b.holes.length) host.append(el('div', { className: 'btn-row' }, button(`Remove cut-outs (${b.holes.length})`, () => edit('holes', () => (b.holes = [])))));
      host.append(el('p', { className: 'hint', textContent: 'The base lies on the table; walls fold up from it.' }));
      this.renderPanelList(host);
      return;
    }

    const p = this.design.panels.find((x) => x.id === id)!;
    host.append(el('h2', { textContent: KIND_LABEL[p.kind] }));

    const kinds = el('div', { className: 'seg wide' });
    for (const k of ['wall', 'flap', 'glue'] as CustomKind[]) {
      const b = button(KIND_LABEL[k], () => {
        edit('kind', () => {
          // Glue tabs normally lie inside a neighbouring wall; other panels sit in place.
          if (k === 'glue' && p.layer === 0) p.layer = -1;
          if (k !== 'glue' && p.kind === 'glue' && p.layer === -1) p.layer = 0;
          p.kind = k;
        });
        this.renderInspector();
      }, k === p.kind ? 'on' : '');
      kinds.append(b);
    }
    host.append(kinds);

    if (p.shape.type === 'rect') {
      const s = p.shape;
      // Narrowing is symmetric unless unlinked (or Shift is held while dragging a handle).
      const t0 = field('Narrow start', s.taper0, 't0', (v) => {
        s.taper0 = v;
        if (this.linkTaper) {
          s.taper1 = v;
          t1.querySelector('input')!.value = String(Math.round(v * 100) / 100);
        }
      }, { unit: 'mm' });
      const t1 = field('Narrow end', s.taper1, 't0', (v) => {
        s.taper1 = v;
        if (this.linkTaper) {
          s.taper0 = v;
          t0.querySelector('input')!.value = String(Math.round(v * 100) / 100);
        }
      }, { unit: 'mm' });
      const link = el('input', { type: 'checkbox', checked: this.linkTaper });
      link.addEventListener('change', () => (this.linkTaper = link.checked));
      host.append(
        field('Depth', s.depth, 'depth', (v) => (s.depth = v), { min: 1, unit: 'mm' }),
        t0,
        t1,
        el('label', { className: 'check', title: 'Hold Shift while dragging a corner handle to move one side only' }, link, 'Same on both ends'),
      );
    } else {
      host.append(el('p', { className: 'hint', textContent: 'Free-form panel: drag its corners. Double-click an edge to add a corner; select a corner and press Delete to remove it.' }));
    }
    host.append(
      field('Inset start', p.inset0, 'i0', (v) => (p.inset0 = v), { min: 0, unit: 'mm' }),
      field('Inset end', p.inset1, 'i1', (v) => (p.inset1 = v), { min: 0, unit: 'mm' }),
    );

    // Fold angle
    const angle = el('input', { type: 'range', min: '-180', max: '180', step: '1', value: String(p.angle) });
    const angleNum = el('input', { type: 'number', min: '-180', max: '180', step: '1', value: String(Math.round(p.angle)) });
    const setAngle = (v: number) =>
      edit('angle', () => {
        p.angle = v;
        delete p.motion; // a custom fold path no longer matches the new angle
      });
    angle.addEventListener('input', () => {
      angleNum.value = angle.value;
      setAngle(parseFloat(angle.value));
    });
    angleNum.addEventListener('input', () => {
      const v = parseFloat(angleNum.value);
      if (!Number.isFinite(v)) return;
      angle.value = String(v);
      setAngle(Math.max(-180, Math.min(180, v)));
    });
    const presets = el('div', { className: 'btn-row presets' });
    for (const [label, v] of [['In 90°', 90], ['Out 90°', -90], ['Flat', 0], ['Over 180°', 180]] as [string, number][]) {
      presets.append(button(label, () => {
        angle.value = angleNum.value = String(v);
        setAngle(v);
        this.renderInspector();
      }));
    }
    host.append(
      el('label', { className: 'row' }, 'Fold angle (°)', angleNum),
      el('div', { className: 'angle-row' }, angle),
      presets,
      field('Fold order', p.order, 'order', (v) => (p.order = Math.round(v)), { min: 1, max: 50 }),
      field('Layer', p.layer, 'layer', (v) => (p.layer = Math.round(v)), { min: -5, max: 5 }),
      el('p', { className: 'hint', textContent: 'Positive angles fold inwards. Lower fold order folds first. Layer: panels that overlap when folded stack by layer (higher is further outside).' }),
    );

    const actions = el('div', { className: 'btn-row' });
    if (p.shape.type === 'rect') actions.append(button('Free-form shape', () => edit('shape', () => makeCustom(this.design, p.id))));
    else actions.append(button('Make rectangular', () => edit('shape', () => toRect(p))));
    if (p.holes.length) actions.append(button(`Remove cut-outs (${p.holes.length})`, () => edit('holes', () => (p.holes = []))));
    actions.append(button('Delete panel', () => this.editor.deleteSelection(), 'btn small danger'));
    host.append(actions);
    this.renderPanelList(host);
  }

  /** A compact list of all panels, for selecting ones that are hard to click. */
  private renderPanelList(host: HTMLElement) {
    if (!this.design.panels.length) return;
    const list = el('details', { className: 'panel-list' }, el('summary', { textContent: `All panels (${this.design.panels.length + 1})` }));
    const add = (id: string, label: string, depth: number) => {
      const b = el('button', { className: `pl-item${id === this.editor.selected ? ' on' : ''}`, textContent: label });
      b.style.paddingLeft = `${8 + depth * 12}px`;
      b.addEventListener('click', () => this.editor.select(id));
      list.append(b);
    };
    const pls = layout(this.design);
    add(BASE_ID, 'Base', 0);
    const walk = (parent: string, depth: number) => {
      for (const p of this.design.panels.filter((x) => x.parent === parent)) {
        if (!pls.has(p.id)) continue;
        add(p.id, `${KIND_LABEL[p.kind]} · ${Math.round(p.angle)}°`, depth);
        walk(p.id, depth + 1);
      }
    };
    walk(BASE_ID, 1);
    host.append(list);
  }

  // -------------------------------------------------------------------------
  // Tab API
  // -------------------------------------------------------------------------

  /** Replaces the design (undoable). */
  open(design: AdvancedDesign, decals?: Decal[]) {
    this.editor.checkpoint();
    const d = clone(design);
    if (decals) d.decals = clone(decals);
    this.reframe = true;
    this.editor.setDesign(d);
    this.editor.select(BASE_ID);
    this.decals.render();
    this.fold = 0;
    this.preview.setProgress(0);
    this.queue(true);
    requestAnimationFrame(() => this.preview.animateTo(1, 2600));
  }

  reset() {
    if (!confirm('Start again from a single square? (You can undo this.)')) return;
    this.open(newDesign());
  }

  key(e: KeyboardEvent) {
    return this.editor.key(e);
  }

  /** Call when the tab becomes visible (sizes were zero while hidden). */
  shown() {
    requestAnimationFrame(() => {
      this.editor.fit();
      this.preview.frame();
    });
  }

  private baseName() {
    const [L, W, H] = this.dieline.outer.map((v) => Math.round(v));
    return `box-custom-${L}x${W}x${H}mm`;
  }

  downloadSvg() {
    const svg = buildSvg(this.dieline, { color: this.design.color, decals: this.design.decals ?? [] }, this.exp);
    download(new Blob([svg], { type: 'image/svg+xml' }), `${this.baseName()}.svg`);
  }

  async downloadPdf() {
    const { buildPdf } = await import('../export/pdf');
    const blob = await buildPdf(this.dieline, { color: this.design.color, decals: this.design.decals ?? [] }, this.exp);
    download(blob, `${this.baseName()}.pdf`);
  }

  share(): AdvancedShare {
    return { kind: 'advanced', design: clone(this.design) };
  }
}

/** Turns a free-form panel back into a rectangle as deep as its furthest corner. */
function toRect(p: CustomPanel) {
  if (p.shape.type !== 'custom') return;
  const depth = Math.max(1, ...p.shape.points.map((q: Vec2) => q[1]));
  p.shape = { type: 'rect', depth, taper0: 0, taper1: 0 };
}
