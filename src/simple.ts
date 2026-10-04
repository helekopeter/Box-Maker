import { KRAFT, renderArtwork } from './artwork';
import { DecalLayer, sanitizeDecals } from './decals';
import { buildSvg } from './export/svg';
import { generateDieline, STYLE_INFO } from './geometry/styles';
import { BoxPreview } from './preview3d';
import type { Appearance, BoxParams, BoxStyle, Decal, Dieline, ExportOptions, FoldMode } from './types';
import { $, buildSwatches, download, el, num, syncSwatches } from './ui';

/**
 * The Simple tab: pick a ready-made box style, set its size, colour and decals.
 */
interface State {
  params: BoxParams;
  look: Appearance;
  exp: ExportOptions;
  units: 'mm' | 'in';
  material: string;
  bed: [number, number];
}

/** What the Simple tab saves to the Box Universe. */
export interface SimpleShare {
  kind: 'simple';
  params: BoxParams;
  look: Appearance;
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
  look: { color: KRAFT, decals: [] },
  exp: { foldMode: 'score', includeArtwork: false, includeGlue: true },
  units: 'mm',
  material: '1.5',
  bed: [600, 400],
});

function load(): State {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<State>;
    return {
      ...d,
      ...s,
      params: { ...d.params, ...s.params },
      look: { ...d.look, ...s.look },
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

  constructor() {
    this.dieline = generateDieline(this.state.params);
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        // Storage full (large images) or unavailable: the app works fine without it.
      }
    }, 300);
  }

  update() {
    const p = this.state.params;
    this.dieline = generateDieline(p);
    const key = JSON.stringify(p);
    if (key !== this.geomKey) {
      this.preview.setDieline(this.dieline, p.thickness, p.style !== this.lastStyle);
      this.geomKey = key;
      this.lastStyle = p.style;
    }
    this.decals.validate();
    this.renderStats();
    this.renderDieline2D();
    this.renderArt();
    const twoPiece = p.style === 'traylid' || p.style === 'sleeve';
    $('#lid-opts').hidden = !twoPiece;
    $('#lid-height-row').hidden = p.style !== 'traylid';
    $('#lift-wrap').hidden = !twoPiece;
    $('#lift-label').textContent = p.style === 'sleeve' ? 'Slide' : 'Lid';
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
      $('#dieline').innerHTML = buildSvg(this.dieline, this.state.look, { ...this.state.exp, includeArtwork: true, includeGlue: true, preview: true });
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
    const [bw, bh] = this.state.bed;
    const fits = (sw <= bw && sh <= bh) || (sw <= bh && sh <= bw);
    $('#stats').innerHTML =
      `<div><span>Outside</span><b>${this.fmt(L)} × ${this.fmt(W)} × ${this.fmt(H)}</b></div>` +
      `<div><span>Sheet</span><b>${this.fmt(sw)} × ${this.fmt(sh)}</b></div>` +
      (fits ? '' : `<div class="warn">⚠ Larger than your ${bw} × ${bh} mm laser bed. Make the box smaller or change the bed size under Advanced.</div>`);
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private buildStyleCards() {
    const wrap = $('#styles');
    wrap.innerHTML = '';
    for (const style of Object.keys(STYLE_INFO) as BoxStyle[]) {
      const b = el('button', { className: 'style-card', title: STYLE_INFO[style].description });
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
    for (const id of SimpleTab.dimIds) {
      const inp = $<HTMLInputElement>(`#${id}`);
      inp.value = state.units === 'in' ? (+(p[id] / IN).toFixed(3)).toString() : (+p[id].toFixed(1)).toString();
      inp.step = state.units === 'in' ? '0.125' : '1';
    }
    for (const id of SimpleTab.mmIds) $<HTMLInputElement>(`#${id}`).value = String(p[id]);
    $<HTMLInputElement>('#thickness').value = String(p.thickness);
    $<HTMLSelectElement>('#material').value = state.material;
    $('#thickness-row').hidden = state.material !== 'custom';
    $<HTMLInputElement>('#bedW').value = String(state.bed[0]);
    $<HTMLInputElement>('#bedH').value = String(state.bed[1]);
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
    for (const [i, id] of (['bedW', 'bedH'] as const).entries()) {
      $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
        const v = num(e.target as HTMLInputElement, 10, 5000);
        if (v === null) return;
        this.state.bed[i] = v;
        this.renderStats();
        this.save();
      });
    }
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
    this.preview.setLidLift(this.state.params.style === 'sleeve' ? v * L * 1.05 : v * H * 1.2);
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
    return `box-${p.style}-${r(p.length)}x${r(p.width)}x${r(p.height)}mm`;
  }

  downloadSvg() {
    const svg = buildSvg(this.dieline, this.state.look, this.state.exp);
    download(new Blob([svg], { type: 'image/svg+xml' }), `${this.baseName()}.svg`);
  }

  async downloadPdf() {
    // jsPDF is large, so load it only when someone actually exports a PDF.
    const { buildPdf } = await import('./export/pdf');
    const blob = await buildPdf(this.dieline, this.state.look, this.state.exp);
    download(blob, `${this.baseName()}.pdf`);
  }

  share(): SimpleShare {
    return JSON.parse(JSON.stringify({ kind: 'simple', params: this.state.params, look: this.state.look }));
  }

  /** Loads a box shared from the Box Universe (already sanitised). */
  open(s: SimpleShare) {
    this.state.params = { ...defaults().params, ...s.params };
    this.state.look = { color: s.look.color, decals: s.look.decals };
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
    look: {
      color: typeof look.color === 'string' && /^#[0-9a-f]{6}$/i.test(look.color) ? look.color : KRAFT,
      decals: sanitizeDecals(look.decals),
    },
  };
}
