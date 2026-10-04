import { toDieline, type AdvancedDesign } from '../advanced/model';
import { renderArtwork } from '../artwork';
import { buildSvg } from '../export/svg';
import { BoxPreview } from '../preview3d';
import type { Dieline, ExportOptions } from '../types';
import { $, buildSwatches, download, el, syncSwatches } from '../ui';
import { newShape, profile, sanitizeShape, SHAPE_INFO, toDesign, type BaseShape, type NetResult, type ShapeSpec } from './model';

const STORAGE_KEY = 'box-maker:shape:v1';
const EXPORT: ExportOptions = { foldMode: 'score', includeArtwork: false, includeGlue: true };

function loadSaved(): ShapeSpec {
  try {
    return sanitizeShape(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? newShape();
  } catch {
    return newShape();
  }
}

/** Top-view icon of a base shape. */
function shapeIcon(shape: BaseShape): string {
  const s = { ...newShape(), shape, width: 52, depth: 40, size: 52, sides: 16 };
  const pts = profile(s).map(([x, y]) => `${(32 + x).toFixed(1)},${(32 - y).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><polygon points="${pts}"/></svg>`;
}

/**
 * The Shape Maker tab: build a simple solid by extruding a basic shape, see it folded in
 * 3D with its cutting layout, and send the unfolded net to the Advanced editor.
 */
export class ShapeTab {
  spec = loadSaved();
  preview: BoxPreview;
  result: NetResult;
  dieline: Dieline;
  onMakeBox: (design: AdvancedDesign) => void = () => {};
  private queued = false;
  private saveTimer = 0;
  private framedSize = 0;
  private fold = 1;
  private artCanvas = document.createElement('canvas');

  constructor() {
    this.result = toDesign(this.spec);
    this.dieline = toDieline(this.result.design);
    this.preview = new BoxPreview($('#shape-viewer'));
    this.buildCards();
    this.bind();
    this.sync();
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private buildCards() {
    const wrap = $('#shape-cards');
    wrap.innerHTML = '';
    for (const shape of Object.keys(SHAPE_INFO) as BaseShape[]) {
      const b = el('button', { className: 'style-card shape-card', title: SHAPE_INFO[shape].name });
      b.dataset.shape = shape;
      b.innerHTML = `${shapeIcon(shape)}<span>${SHAPE_INFO[shape].name}</span>`;
      b.addEventListener('click', () => {
        this.spec.shape = shape;
        this.changed(true);
      });
      wrap.append(b);
    }
  }

  private bind() {
    const numInput = (id: string, key: 'width' | 'depth' | 'size' | 'sides' | 'tab', min: number, max: number) =>
      $<HTMLInputElement>(id).addEventListener('input', (e) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!Number.isFinite(v)) return;
        this.spec[key] = Math.min(max, Math.max(min, v));
        this.changed();
      });
    numInput('#shape-width', 'width', 5, 2000);
    numInput('#shape-depth', 'depth', 5, 2000);
    numInput('#shape-size', 'size', 5, 2000);
    numInput('#shape-sides', 'sides', 6, 48);
    numInput('#shape-tab', 'tab', 4, 40);
    $('#shape-add-level').addEventListener('click', () => {
      const last = this.spec.levels[this.spec.levels.length - 1];
      this.spec.levels.push({ height: Math.round(last.height / 2) || 20, scale: 100 });
      this.changed(true);
    });
    document.querySelectorAll<HTMLButtonElement>('#shape-top button').forEach((b) =>
      b.addEventListener('click', () => {
        this.spec.top = b.dataset.top as 'open' | 'closed';
        this.changed(true);
      }),
    );
    $<HTMLSelectElement>('#shape-material').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      $('#shape-thickness-row').hidden = v !== 'custom';
      if (v !== 'custom') {
        this.spec.thickness = parseFloat(v);
        this.changed();
      }
    });
    $<HTMLInputElement>('#shape-thickness').addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (!Number.isFinite(v)) return;
      this.spec.thickness = Math.min(10, Math.max(0.2, v));
      this.changed();
    });
    buildSwatches($('#shape-swatches'), (c) => this.setColor(c));
    $<HTMLInputElement>('#shape-color').addEventListener('input', (e) => this.setColor((e.target as HTMLInputElement).value));
    $('#shape-make').addEventListener('click', () => this.onMakeBox(this.result.design));

    const foldInput = $<HTMLInputElement>('#shape-fold');
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
    $('#shape-play').addEventListener('click', () => this.preview.animateTo(this.fold > 0.5 ? 0 : 1));
    $<HTMLInputElement>('#shape-spin').addEventListener('change', (e) => (this.preview.autoRotate = (e.target as HTMLInputElement).checked));
    this.syncPlay();
  }

  private syncPlay() {
    $('#shape-play').textContent = this.fold > 0.5 ? '⟲' : '▶';
  }

  private setColor(c: string) {
    this.spec.color = c;
    this.changed();
  }

  /** Updates inputs to match the spec. */
  private sync() {
    const s = this.spec;
    document.querySelectorAll<HTMLButtonElement>('.shape-card').forEach((b) => b.classList.toggle('on', b.dataset.shape === s.shape));
    $('#shape-rect-size').hidden = s.shape !== 'rect';
    $('#shape-poly-size').hidden = s.shape === 'rect';
    $('#shape-sides-row').hidden = s.shape !== 'round';
    $<HTMLInputElement>('#shape-width').value = String(s.width);
    $<HTMLInputElement>('#shape-depth').value = String(s.depth);
    $<HTMLInputElement>('#shape-size').value = String(s.size);
    $<HTMLInputElement>('#shape-sides').value = String(s.sides);
    $<HTMLInputElement>('#shape-tab').value = String(s.tab);
    document.querySelectorAll<HTMLButtonElement>('#shape-top button').forEach((b) => b.classList.toggle('on', b.dataset.top === s.top));
    const preset = ['0.3', '1', '1.5', '2', '3', '4'].find((m) => parseFloat(m) === s.thickness);
    $<HTMLSelectElement>('#shape-material').value = preset ?? 'custom';
    $('#shape-thickness-row').hidden = !!preset;
    $<HTMLInputElement>('#shape-thickness').value = String(s.thickness);
    $<HTMLInputElement>('#shape-color').value = s.color;
    syncSwatches($('#shape-swatches'), s.color);
    this.renderLevels();
  }

  /** One row per extrusion level. */
  private renderLevels() {
    const host = $('#shape-levels');
    host.innerHTML = '';
    const levels = this.spec.levels;
    levels.forEach((lv, i) => {
      const last = i === levels.length - 1;
      const row = el('div', { className: 'level' });
      const del = el('button', { className: 'icon', title: 'Remove this level', textContent: '✕', disabled: levels.length === 1 });
      del.addEventListener('click', () => {
        levels.splice(i, 1);
        this.changed(true);
      });
      row.append(el('div', { className: 'level-head' }, el('b', { textContent: `Level ${i + 1}` }), del));

      const height = el('input', { type: 'number', min: '1', step: '1', value: String(lv.height) });
      height.addEventListener('input', () => {
        const v = parseFloat(height.value);
        if (!Number.isFinite(v)) return;
        lv.height = Math.min(2000, Math.max(1, v));
        this.changed();
      });
      row.append(el('label', { className: 'row' }, 'Height (mm)', height));

      // Only the last level may come to a point (nothing can sit on top of a point).
      const min = last ? 0 : 5;
      const range = el('input', { type: 'range', min: String(min), max: '200', step: '1', value: String(lv.scale) });
      const pct = el('input', { type: 'number', min: String(min), max: '200', step: '1', value: String(lv.scale) });
      const set = (v: number) => {
        lv.scale = Math.min(200, Math.max(min, v));
        this.changed(lv.scale === 0 || v === 0);
      };
      range.addEventListener('input', () => {
        pct.value = range.value;
        set(parseFloat(range.value));
      });
      pct.addEventListener('input', () => {
        const v = parseFloat(pct.value);
        if (!Number.isFinite(v)) return;
        range.value = String(v);
        set(v);
      });
      row.append(el('label', { className: 'row' }, 'Top size (%)', pct), el('div', { className: 'angle-row' }, range));
      host.append(row);
    });
    const pointy = levels[levels.length - 1].scale === 0;
    const add = $<HTMLButtonElement>('#shape-add-level');
    add.disabled = pointy || levels.length >= 6;
    add.title = pointy ? 'The top comes to a point, so nothing can go on top' : '';
    $('#shape-top-panel').hidden = pointy;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Schedules a rebuild; `structure` also redraws the controls. */
  private changed(structure = false) {
    if (structure) this.sync();
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.rebuild();
      this.save();
    });
  }

  private rebuild() {
    this.result = toDesign(this.spec);
    this.dieline = toDieline(this.result.design);
    const size = Math.max(this.dieline.width, this.dieline.height, ...this.dieline.outer);
    const ratio = size / (this.framedSize || size);
    const reframe = !this.framedSize || ratio > 1.35 || ratio < 0.6;
    this.preview.setDieline(this.dieline, this.spec.thickness, reframe);
    if (reframe) this.framedSize = size;
    this.preview.setProgress(this.fold);
    this.renderArt();
    $('#shape-dieline').innerHTML = buildSvg(this.dieline, { color: this.spec.color, decals: [] }, { ...EXPORT, includeArtwork: true, preview: true });
    this.renderStats();
  }

  private async renderArt() {
    const dl = this.dieline;
    const scale = Math.min(4, 4096 / Math.max(dl.width, dl.height));
    await renderArtwork(dl, { color: this.spec.color, decals: [] }, { scale, preview: true }, this.artCanvas);
    this.preview.setArtwork(this.artCanvas);
  }

  private renderStats() {
    const [L, W, H] = this.dieline.outer.map((v) => Math.round(v));
    const r = this.result;
    const how = r.layout === 'star' ? 'walls around the base' : 'walls in a strip (they would overlap around the base)';
    $('#shape-stats').innerHTML = '';
    $('#shape-stats').append(
      el('div', {}, el('span', { textContent: 'Size' }), el('b', { textContent: `${L} × ${W} × ${H} mm` })),
      el('div', {}, el('span', { textContent: 'Sheet' }), el('b', { textContent: `${Math.round(this.dieline.width)} × ${Math.round(this.dieline.height)} mm` })),
      el('div', {}, el('span', { textContent: 'Panels' }), el('b', { textContent: String(r.design.panels.length + 1) })),
      el('p', { className: 'hint', textContent: `Unfolded with ${how}. Glue tabs are added on every seam.` }),
    );
    if (r.overlaps) {
      $('#shape-stats').append(
        el('div', { className: 'warn', textContent: '⚠ Some panels overlap on the sheet, so this can’t be cut from one piece yet. Try a smaller change in size between levels, or fix it up in Advanced.' }),
      );
    }
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.spec));
      } catch {
        /* storage unavailable */
      }
    }, 300);
  }

  // -------------------------------------------------------------------------
  // Tab API
  // -------------------------------------------------------------------------

  shown() {
    requestAnimationFrame(() => this.preview.frame());
  }

  reset() {
    if (!confirm('Start a new shape?')) return;
    this.spec = newShape();
    this.framedSize = 0;
    this.changed(true);
  }

  private baseName() {
    const [L, W, H] = this.dieline.outer.map((v) => Math.round(v));
    return `box-${this.spec.shape}-${L}x${W}x${H}mm`;
  }

  downloadSvg() {
    const svg = buildSvg(this.dieline, { color: this.spec.color, decals: [] }, EXPORT);
    download(new Blob([svg], { type: 'image/svg+xml' }), `${this.baseName()}.svg`);
  }

  async downloadPdf() {
    const { buildPdf } = await import('../export/pdf');
    download(await buildPdf(this.dieline, { color: this.spec.color, decals: [] }, EXPORT), `${this.baseName()}.pdf`);
  }

  get design(): AdvancedDesign {
    return this.result.design;
  }
}
