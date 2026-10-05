import { KRAFT, renderArtwork } from './artwork';
import { DecalLayer, sanitizeDecals, sanitizeTexture } from './decals';
import { bindTexture, loadTexture, previewLook, saveTexture } from './texture';
import { bindCopies, copiesIds, downloadBox } from './export/download';
import { buildSvg } from './export/svg';
import { generateDieline, STYLE_INFO } from './geometry/styles';
import { BoxPreview } from './preview3d';
import { toDieline } from './advanced/model';
import { ShapeControls } from './shape/controls';
import { newShape, sanitizeShape, toDesign, type NetResult, type ShapeSpec } from './shape/model';
import type { Appearance, BoxParams, BoxStyle, Decal, Dieline, ExportOptions, FoldMode } from './types';
import { bedWarning, bindBedInputs, fitsBed, onBedChange } from './bed';
import { $, buildSwatches, el, num, syncSwatches } from './ui';

/**
 * The Simple tab: pick a ready-made box style (or build a shape), set its size, colour
 * and decals.
 */
interface State {
  params: BoxParams;
  /** The Shape Builder's shape (used when the style is 'shape'). */
  shape: ShapeSpec;
  look: Appearance;
  exp: ExportOptions;
  units: 'mm' | 'in';
  material: string;
}

/** What the Simple tab saves to the Box Universe. */
export interface SimpleShare {
  kind: 'simple';
  params: BoxParams;
  /** Only for the Shape Builder style. */
  shape?: ShapeSpec;
  look: Appearance;
}

/** Unfolds a Shape Builder shape, using the Simple tab's material and glue tab width. */
export function shapeNet(shape: ShapeSpec, params: BoxParams, color: string): NetResult {
  return toDesign({ ...shape, thickness: params.thickness, color, tab: Math.min(40, Math.max(4, params.glueTab)) });
}

/** The cutting layout for a Simple box (ready-made style or Shape Builder). */
export function dielineFor(params: BoxParams, shape: ShapeSpec | undefined, color: string): Dieline {
  if (params.style === 'shape') return toDieline(shapeNet(shape ?? newShape(), params, color).design);
  return generateDieline(params);
}

/** A shape made in the old Shape Maker tab, so it isn't lost. */
function legacyShape(): ShapeSpec {
  try {
    return sanitizeShape(JSON.parse(localStorage.getItem('box-maker:shape:v1') ?? 'null')) ?? newShape();
  } catch {
    return newShape();
  }
}

const STORAGE_KEY = 'box-maker:v2';
const IN = 25.4;

const defaults = (): State => ({
  params: {
    style: 'tuck',
    length: 100,
    width: 100,
    height: 100,
    thickness: 1.5,
    glueTab: 15,
    lidHeight: 30,
    lidClearance: 1,
  },
  shape: legacyShape(),
  look: { color: KRAFT, decals: [] },
  exp: { foldMode: 'score', includeArtwork: false, includeGlue: true },
  units: 'mm',
  material: '1.5',
});

function load(): State {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<State>;
    const texture = loadTexture(STORAGE_KEY);
    return {
      ...d,
      ...s,
      params: { ...d.params, ...s.params },
      shape: sanitizeShape(s.shape) ?? d.shape,
      look: { ...d.look, ...s.look, ...(texture ? { texture } : {}) },
      exp: { ...d.exp, ...s.exp },
    };
  } catch {
    return d;
  }
}

// Small isometric sketches of each style for the style picker.
const CARTON = '<path d="M18 16 34 10l12 6v38l-16 6-12-6z"/><path d="M18 16l16 6 12-6M34 22v38" class="l"/>';
export const STYLE_ICONS: Record<BoxStyle, string> = {
  rsc: '<path d="M8 20 32 10l24 10v26L32 56 8 46z"/><path d="M8 20l24 10 24-10M32 30v26" class="l"/><path d="M8 20 2 12l24-10 6 8M56 20l6-8-24-10-6 8" class="l"/>',
  tuck: CARTON + '<path d="M18 16l16-6 12 6-16 6z" class="l"/><path d="M34 22l-6-10" class="l"/>',
  rte: CARTON + '<path d="M18 16l16-6 12 6-16 6z" class="l"/><path d="M34 22l-6-10" class="l"/><path d="M18 54l-6 4 12 6 6-4" class="l"/>',
  snaplock: CARTON + '<path d="M18 16l16-6 12 6-16 6z" class="l"/><path d="M22 52l4-6 4 8 4-8 4 6" class="l"/>',
  autolock: CARTON + '<path d="M18 16l16-6 12 6-16 6z" class="l"/><path d="M22 58l10-10M30 60l10-10" class="l"/>',
  sealend: '<path d="M16 14 36 8l12 5v42l-20 7-12-5z"/><path d="M16 14l12 5 20-6M28 19v43" class="l"/><path d="M19 15l12 4 14-4" class="l"/>',
  gable: '<path d="M16 26 34 20l12 6v28l-16 6-14-6z"/><path d="M16 26l14 6 16-6M30 32v28" class="l"/><path d="M16 26l9-12 21 6-16 6" class="l"/><path d="M25 14l-2-8 20 6 3 8" class="l"/><path d="M28 10l12 4" class="l"/>',
  tray: '<path d="M6 30 32 20l26 10v12L32 54 6 42z"/><path d="M6 30l26 10 26-10M32 40v14" class="l"/><path d="M14 30l18-7 18 7-18 7z" class="l"/>',
  traylid: '<path d="M8 38 32 30l24 8v8L32 56 8 46z"/><path d="M8 38l24 8 24-8M32 46v10" class="l"/><path d="M6 18 32 8l26 10v6L32 34 6 24z"/><path d="M6 18l26 10 26-10M32 28v6" class="l"/>',
  // A hexagonal tower with a pointed roof: a shape built from extruded levels.
  shape: '<path d="M14 30l10-5h16l10 5v20l-10 5H24l-10-5z"/><path d="M14 30l10 5h16l10-5M24 35v20M40 35v20" class="l"/><path d="M14 30 32 6l18 24" /><path d="M24 25 32 6l8 19M24 35 32 6l8 29" class="l"/>',
  mailer: '<path d="M6 40 30 32l28 8v8L34 58 6 50z"/><path d="M6 40l28 10 24-10M34 50v8" class="l"/><path d="M6 40 30 32l4-24L10 16z"/><path d="M10 16l24-8 1-5-24 8z" class="l"/>',
  matchbox: '<path d="M4 34 26 26l34 10v10L38 54 4 44z"/><path d="M4 34l34 10 22-8M38 44v10" class="l"/><path d="M16 22l22-8 12 4v14L28 40 16 36z"/><path d="M16 22l12 4 22-8M28 26v14" class="l"/><path d="M24 23.5a5 3 0 0 0 9 2" class="l"/>',
  hexagon: '<path d="M14 18l9-6h18l9 6-9 6H23zM14 18v26l9 6h18l9-6V18"/><path d="M23 24v26M41 24v26M14 18l9 6h18l9-6" class="l"/>',
  cigarette: '<path d="M18 22 34 16l12 6v34l-16 6-12-6z"/><path d="M18 22l16 6 12-6M34 28v34M18 30l16 6 12-6" class="l"/><path d="M18 22 30 4l16 6-12 6" /><path d="M22 23v-6l14 5" class="l"/>',
  sleeve: '<path d="M4 34 26 26l34 10v10L38 54 4 44z"/><path d="M4 34l34 10 22-8M38 44v10" class="l"/><path d="M16 22l22-8 12 4v14L28 40 16 36z"/><path d="M16 22l12 4 22-8M28 26v14" class="l"/>',
};

export class SimpleTab {
  state = load();
  dieline: Dieline;
  preview: BoxPreview;
  decals: DecalLayer;
  private geomKey = '';
  private lastStyle: BoxStyle | null = null;
  private artCanvas = document.createElement('canvas');
  private artToken = 0;
  private fold = 1;
  private saveTimer = 0;
  private artQueued = false;
  private svgTimer = 0;
  private updateQueued = false;
  /** The unfolded net when the style is Shape Builder. */
  shapeResult: NetResult | null = null;
  private shapeControls: ShapeControls;
  private refreshCopies = () => {};
  private syncTexture = () => {};

  constructor() {
    this.dieline = dielineFor(this.state.params, this.state.shape, this.state.look.color);
    this.preview = new BoxPreview($('#viewer'));
    this.decals = new DecalLayer({
      list: $('#decals'),
      empty: $('#decal-empty'),
      help: $('#decal-help'),
      addText: $('#add-text'),
      addImage: $<HTMLInputElement>('#add-image'),
      preview: this.preview,
      dieline: () => this.dieline,
      decals: () => this.state.look.decals,
      changed: (dragging) => this.refreshArt(dragging),
    });
    this.shapeControls = new ShapeControls(() => this.state.shape, () => this.scheduleUpdate());
    this.buildStyleCards();
    this.bindControls();
    this.syncInputs();
    this.update();
    this.decals.render();
    this.setFold(0);
    this.preview.animateTo(1, 2600);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        const { texture, ...look } = this.state.look;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.state, look }));
        saveTexture(STORAGE_KEY, texture);
      } catch {
        // Storage full (large images) or unavailable: the app works fine without it.
      }
    }, 300);
  }

  /** Coalesces rapid edits (e.g. dragging a slider) into one update per frame. */
  private scheduleUpdate() {
    if (this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => {
      this.updateQueued = false;
      this.update();
    });
  }

  update() {
    const p = this.state.params;
    const shaped = p.style === 'shape';
    this.shapeResult = shaped ? shapeNet(this.state.shape, p, this.state.look.color) : null;
    this.dieline = this.shapeResult ? toDieline(this.shapeResult.design) : generateDieline(p);
    const key = JSON.stringify(p) + (shaped ? JSON.stringify(this.state.shape) : '');
    if (key !== this.geomKey) {
      this.preview.setDieline(this.dieline, p.thickness, p.style !== this.lastStyle);
      this.geomKey = key;
      this.lastStyle = p.style;
    }
    this.decals.validate();
    this.renderStats();
    this.refreshCopies();
    this.syncTexture();
    this.renderDieline2D();
    this.renderArt();
    const sliding = p.style === 'sleeve' || p.style === 'matchbox';
    const twoPiece = p.style === 'traylid' || sliding;
    $('#lid-opts').hidden = !twoPiece;
    $('#lid-height-row').hidden = p.style !== 'traylid';
    $('#lift-wrap').hidden = !twoPiece && p.style !== 'cigarette';
    $('#lift-label').textContent = sliding ? 'Slide' : 'Lid';
    // A hexagon has one width: across its flat sides.
    const hex = p.style === 'hexagon';
    $('#width').closest('label')!.hidden = hex;
    $('#length').closest('label')!.firstChild!.textContent = hex ? 'Across' : 'Length';
    $('#size-dims').classList.toggle('two', hex);
    // Shape Builder replaces the box size inputs with its own shape controls.
    $('#shape-builder').hidden = !shaped;
    for (const id of ['#units', '#size-hint', '#size-dims']) $(id).hidden = shaped;
    $('#size-title').textContent = shaped ? 'Material' : 'Size';
    let step = 0;
    document.querySelectorAll<HTMLElement>('#tab-simple .sidebar > .panel').forEach((panel) => {
      const n = panel.querySelector('.step');
      if (n && !panel.hidden) n.textContent = String(++step);
    });
    this.applyLift();
    this.save();
  }

  private async renderArt() {
    const token = ++this.artToken;
    const dl = this.dieline;
    const scale = Math.min(4, 4096 / Math.max(dl.width, dl.height));
    const off = document.createElement('canvas');
    await renderArtwork(dl, this.state.look, { scale, preview: true, selected: this.decals.selected }, off);
    if (token !== this.artToken) return;
    this.artCanvas.width = off.width;
    this.artCanvas.height = off.height;
    this.artCanvas.getContext('2d')!.drawImage(off, 0, 0);
    this.preview.setArtwork(this.artCanvas);
  }

  private renderDieline2D() {
    cancelAnimationFrame(this.svgTimer);
    this.svgTimer = requestAnimationFrame(() => {
      $('#dieline').innerHTML = buildSvg(this.dieline, previewLook(this.state.look), { ...this.state.exp, includeArtwork: true, includeGlue: true, preview: true });
    });
    $('#legend-fold').className = `sw ${this.state.exp.foldMode === 'score' ? 'fold' : 'perf'}`;
  }

  /** Redraws decals only (no geometry change), at most once per frame. */
  private refreshArt(dragging: boolean) {
    if (this.artQueued) return;
    this.artQueued = true;
    requestAnimationFrame(() => {
      this.artQueued = false;
      this.renderArt();
      // Rebuilding the 2D preview every frame of a drag is wasteful; it catches up on release.
      if (!dragging) this.renderDieline2D();
      this.save();
    });
  }

  private fmt = (mm: number) => (this.state.units === 'in' ? `${(mm / IN).toFixed(2)}″` : `${Math.round(mm)} mm`);

  private renderStats() {
    const [L, W, H] = this.dieline.outer;
    const sw = this.dieline.width;
    const sh = this.dieline.height;
    const fits = fitsBed(sw, sh);
    $('#stats').innerHTML =
      `<div><span>Outside</span><b>${this.fmt(L)} × ${this.fmt(W)} × ${this.fmt(H)}</b></div>` +
      `<div><span>Sheet</span><b>${this.fmt(sw)} × ${this.fmt(sh)}</b></div>` +
      (fits ? '' : `<div class="warn">${bedWarning()}</div>`);
    const r = this.shapeResult;
    if (r) {
      $('#stats').append(el('p', {
        className: 'hint',
        textContent: `Unfolded with ${r.layout === 'star' ? 'the walls around the base' : 'the walls in a strip (they would overlap around the base)'}; glue tabs on every seam.`,
      }));
      if (r.overlaps) {
        $('#stats').append(el('div', {
          className: 'warn',
          textContent: '⚠ Some panels overlap on the sheet, so this can’t be cut from one piece yet. Try a smaller change in size between levels, or fix it up in Advanced.',
        }));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private buildStyleCards() {
    const wrap = $('#styles');
    wrap.innerHTML = '';
    for (const style of Object.keys(STYLE_INFO) as BoxStyle[]) {
      const b = el('button', { className: `style-card${style === 'shape' ? ' big' : ''}`, title: STYLE_INFO[style].description });
      b.dataset.style = style;
      b.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true">${STYLE_ICONS[style]}</svg><span>${STYLE_INFO[style].name}</span>`;
      b.onclick = () => {
        this.state.params.style = style;
        this.syncInputs();
        this.preview.stopAnimation();
        this.update();
        this.decals.render();
        // Show the box folding up when switching style.
        this.setFold(0);
        this.preview.animateTo(1, 2600);
      };
      wrap.append(b);
    }
  }

  private static dimIds = ['length', 'width', 'height'] as const;
  private static mmIds = ['glueTab', 'lidHeight', 'lidClearance'] as const;

  syncInputs() {
    const { state } = this;
    const p = state.params;
    document.querySelectorAll<HTMLButtonElement>('.style-card').forEach((b) => b.classList.toggle('on', b.dataset.style === p.style));
    $('#style-desc').textContent = STYLE_INFO[p.style].description;
    this.shapeControls?.sync();
    for (const id of SimpleTab.dimIds) {
      const inp = $<HTMLInputElement>(`#${id}`);
      inp.value = state.units === 'in' ? (+(p[id] / IN).toFixed(3)).toString() : (+p[id].toFixed(1)).toString();
      inp.step = state.units === 'in' ? '0.125' : '1';
    }
    for (const id of SimpleTab.mmIds) $<HTMLInputElement>(`#${id}`).value = String(p[id]);
    $<HTMLInputElement>('#thickness').value = String(p.thickness);
    $<HTMLSelectElement>('#material').value = state.material;
    $('#thickness-row').hidden = state.material !== 'custom';
    document.querySelectorAll<HTMLButtonElement>('#units button').forEach((b) => b.classList.toggle('on', b.dataset.unit === state.units));
    $<HTMLInputElement>('#color').value = state.look.color;
    syncSwatches($('#swatches'), state.look.color);
    document.querySelectorAll<HTMLInputElement>('input[name=foldMode]').forEach((r) => (r.checked = r.value === state.exp.foldMode));
    $<HTMLInputElement>('#includeGlue').checked = state.exp.includeGlue;
    $<HTMLInputElement>('#includeArtwork').checked = state.exp.includeArtwork;
  }

  private bindControls() {
    for (const id of SimpleTab.dimIds) {
      $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
        let v = num(e.target as HTMLInputElement, 0.01, 5000);
        if (v === null) return;
        if (this.state.units === 'in') v *= IN;
        this.state.params[id] = Math.max(5, v);
        this.update();
      });
    }
    for (const id of SimpleTab.mmIds) {
      $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
        const v = num(e.target as HTMLInputElement, id === 'lidClearance' ? 0 : 5, 1000);
        if (v === null) return;
        this.state.params[id] = v;
        this.update();
      });
    }
    $<HTMLSelectElement>('#material').addEventListener('change', (e) => {
      this.state.material = (e.target as HTMLSelectElement).value;
      if (this.state.material !== 'custom') this.state.params.thickness = parseFloat(this.state.material);
      this.syncInputs();
      this.update();
    });
    $<HTMLInputElement>('#thickness').addEventListener('input', (e) => {
      const v = num(e.target as HTMLInputElement, 0.2, 10);
      if (v === null) return;
      this.state.params.thickness = v;
      this.update();
    });
    bindBedInputs($<HTMLInputElement>('#bedW'), $<HTMLInputElement>('#bedH'));
    onBedChange(() => this.renderStats());
    document.querySelectorAll<HTMLButtonElement>('#units button').forEach((b) =>
      b.addEventListener('click', () => {
        this.state.units = b.dataset.unit as 'mm' | 'in';
        this.syncInputs();
        this.renderStats();
        this.save();
      }),
    );

    buildSwatches($('#swatches'), (c) => this.setColor(c));
    $<HTMLInputElement>('#color').addEventListener('input', (e) => this.setColor((e.target as HTMLInputElement).value));

    document.querySelectorAll<HTMLInputElement>('input[name=foldMode]').forEach((r) =>
      r.addEventListener('change', () => {
        this.state.exp.foldMode = r.value as FoldMode;
        this.update();
      }),
    );
    $<HTMLInputElement>('#includeGlue').addEventListener('change', (e) => {
      this.state.exp.includeGlue = (e.target as HTMLInputElement).checked;
      this.save();
    });
    $<HTMLInputElement>('#includeArtwork').addEventListener('change', (e) => {
      this.state.exp.includeArtwork = (e.target as HTMLInputElement).checked;
      this.save();
    });
    this.syncTexture = bindTexture('', {
      get: () => this.state.look.texture,
      set: (t) => {
        if (t) this.state.look.texture = t;
        else delete this.state.look.texture;
        this.update();
      },
      dieline: () => this.dieline,
      look: () => this.state.look,
      name: () => this.baseName(),
    });
    const { input, hint } = copiesIds('');
    this.refreshCopies = bindCopies(input, hint, this.state.exp, () => this.dieline, () => this.save());
    onBedChange(() => this.refreshCopies());
    $('#dl-svg-2').addEventListener('click', () => this.downloadSvg());
    $('#dl-pdf-2').addEventListener('click', () => this.downloadPdf());

    // Viewer controls
    const foldInput = $<HTMLInputElement>('#fold');
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
    $('#play').addEventListener('click', () => this.preview.animateTo(this.fold > 0.5 ? 0 : 1));
    $<HTMLInputElement>('#lift').addEventListener('input', () => this.applyLift());
    $<HTMLInputElement>('#spin').addEventListener('change', (e) => (this.preview.autoRotate = (e.target as HTMLInputElement).checked));
  }

  /** Lifts the lid, or slides the sleeve off along its length, from the slider. */
  private applyLift() {
    const v = parseFloat($<HTMLInputElement>('#lift').value);
    const [L, , H] = this.dieline.outer;
    const style = this.state.params.style;
    const sliding = style === 'sleeve' || style === 'matchbox';
    // A flip-top lid swings open on its hinge instead of lifting off.
    this.preview.setLidOpen(style === 'cigarette' ? v : 0);
    this.preview.setLidLift(style === 'cigarette' ? 0 : sliding ? v * L * 1.05 : v * H * 1.2);
  }

  setFold(p: number) {
    this.fold = p;
    $<HTMLInputElement>('#fold').value = String(p);
    this.preview.setProgress(p);
    this.syncPlay();
  }

  private syncPlay() {
    $('#play').textContent = this.fold > 0.5 ? '⟲' : '▶';
    $('#play').title = this.fold > 0.5 ? 'Unfold' : 'Fold';
  }

  private setColor(c: string) {
    this.state.look.color = c;
    this.syncInputs();
    this.update();
  }

  // -------------------------------------------------------------------------
  // Tab API
  // -------------------------------------------------------------------------

  reset() {
    if (!confirm('Reset all settings and decals?')) return;
    this.state = defaults();
    this.syncInputs();
    this.decals.render();
    this.update();
  }

  private baseName() {
    const p = this.state.params;
    const r = (v: number) => Math.round(v);
    if (p.style === 'shape') {
      const [L, W, H] = this.dieline.outer.map(r);
      return `box-${this.state.shape.shape}-${L}x${W}x${H}mm`;
    }
    return `box-${p.style}-${r(p.length)}x${r(p.width)}x${r(p.height)}mm`;
  }

  downloadSvg() {
    return downloadBox('svg', this.dieline, this.state.look, this.state.exp, this.baseName());
  }

  downloadPdf() {
    return downloadBox('pdf', this.dieline, this.state.look, this.state.exp, this.baseName());
  }

  share(): SimpleShare {
    const shape = this.state.params.style === 'shape' ? this.state.shape : undefined;
    return JSON.parse(JSON.stringify({ kind: 'simple', params: this.state.params, ...(shape ? { shape } : {}), look: this.state.look }));
  }

  /** Loads a box shared from the Box Universe (already sanitised). */
  open(s: SimpleShare) {
    this.state.params = { ...defaults().params, ...s.params };
    if (s.shape) this.state.shape = s.shape;
    this.state.look = { color: s.look.color, decals: s.look.decals, ...(s.look.texture ? { texture: s.look.texture } : {}) };
    const preset = ['0.3', '1', '1.5', '2', '3', '4'].find((m) => parseFloat(m) === this.state.params.thickness);
    this.state.material = preset ?? 'custom';
    this.syncInputs();
    this.preview.stopAnimation();
    this.update();
    this.decals.render();
    this.setFold(0);
    this.preview.animateTo(1, 2600);
  }

  /** The current box's decals (for carrying them over to the Advanced tab). */
  get currentDecals(): Decal[] {
    return this.state.look.decals;
  }
}

/** Validates a Simple box loaded from a file or the Box Universe. */
export function sanitizeSimple(raw: unknown): SimpleShare | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const p = (r.params ?? {}) as Record<string, unknown>;
  const look = (r.look ?? {}) as Record<string, unknown>;
  const d = defaults().params;
  const n = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  const style = (Object.keys(STYLE_INFO) as BoxStyle[]).includes(p.style as BoxStyle) ? (p.style as BoxStyle) : d.style;
  return {
    kind: 'simple',
    params: {
      style,
      length: n(p.length, 5, 3000, d.length),
      width: n(p.width, 5, 3000, d.width),
      height: n(p.height, 5, 3000, d.height),
      thickness: n(p.thickness, 0.2, 10, d.thickness),
      glueTab: n(p.glueTab, 5, 200, d.glueTab),
      lidHeight: n(p.lidHeight, 5, 3000, d.lidHeight),
      lidClearance: n(p.lidClearance, 0, 20, d.lidClearance),
    },
    ...(r.shape ? { shape: sanitizeShape(r.shape) ?? newShape() } : {}),
    look: {
      color: typeof look.color === 'string' && /^#[0-9a-f]{6}$/i.test(look.color) ? look.color : KRAFT,
      decals: sanitizeDecals(look.decals),
      ...(sanitizeTexture(look.texture) ? { texture: sanitizeTexture(look.texture) } : {}),
    },
  };
}
