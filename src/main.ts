import './style.css';
import { faceSize, KRAFT, renderArtwork } from './artwork';
import { buildSvg } from './export/svg';
import { generateDieline, STYLE_INFO } from './geometry/styles';
import { BoxPreview } from './preview3d';
import type { Appearance, BoxParams, BoxStyle, Decal, Dieline, ExportOptions, FoldMode } from './types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface State {
  params: BoxParams;
  look: Appearance;
  exp: ExportOptions;
  units: 'mm' | 'in';
  material: string;
  bed: [number, number];
}

const STORAGE_KEY = 'box-maker:v1';
const IN = 25.4;

const defaults = (): State => ({
  params: {
    style: 'tuck',
    length: 120,
    width: 60,
    height: 160,
    thickness: 1.5,
    glueTab: 15,
    lidHeight: 30,
    lidClearance: 1,
  },
  look: {
    color: '#2f6f8f',
    decals: [
      { id: uid(), type: 'text', face: 'front', x: 0.5, y: 0.4, size: 0.12, rotation: 0, text: 'MY BOX', color: '#ffffff', font: 'sans', bold: true },
    ],
  },
  exp: { foldMode: 'score', includeArtwork: false, includeGlue: true },
  units: 'mm',
  material: '1.5',
  bed: [600, 400],
});

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

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

let state = load();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full (large images) or unavailable: the app works fine without it.
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  e.append(...kids);
  return e;
};

const STYLE_ICONS: Record<BoxStyle, string> = {
  rsc: '<path d="M8 20 32 10l24 10v26L32 56 8 46z"/><path d="M8 20l24 10 24-10M32 30v26" class="l"/><path d="M8 20 2 12l24-10 6 8M56 20l6-8-24-10-6 8" class="l"/>',
  tuck: '<path d="M18 16 34 10l12 6v38l-16 6-12-6z"/><path d="M18 16l16 6 12-6M34 22v38" class="l"/><path d="M18 16l16-6 12 6-16 6z" class="l"/><path d="M34 22l-6-10" class="l"/>',
  tray: '<path d="M6 30 32 20l26 10v12L32 54 6 42z"/><path d="M6 30l26 10 26-10M32 40v14" class="l"/><path d="M14 30l18-7 18 7-18 7z" class="l"/>',
  traylid: '<path d="M8 38 32 30l24 8v8L32 56 8 46z"/><path d="M8 38l24 8 24-8M32 46v10" class="l"/><path d="M6 18 32 8l26 10v6L32 34 6 24z"/><path d="M6 18l26 10 26-10M32 28v6" class="l"/>',
};

const SWATCHES = [
  ['Kraft', KRAFT], ['White', '#f4f1ea'], ['Black', '#222222'], ['Red', '#c0392b'],
  ['Orange', '#e67e22'], ['Yellow', '#f1c40f'], ['Green', '#3f8f4f'], ['Teal', '#2f6f8f'],
  ['Blue', '#2c4f9e'], ['Purple', '#7d4a9e'], ['Pink', '#e48aa8'],
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const preview = new BoxPreview($('#viewer'));
let dieline: Dieline = generateDieline(state.params);
let geomKey = '';
let lastStyle: BoxStyle | null = null;
const artCanvas = document.createElement('canvas');
let artToken = 0;
let fold = 1;

function update() {
  const p = state.params;
  dieline = generateDieline(p);
  const key = JSON.stringify(p);
  if (key !== geomKey) {
    preview.setDieline(dieline, p.thickness, p.style !== lastStyle);
    geomKey = key;
    lastStyle = p.style;
  }
  // Keep decals on faces that exist for this style.
  for (const dc of state.look.decals) {
    if (!dieline.faces.some((f) => f.id === dc.face)) dc.face = dieline.faces[0].id;
  }
  renderStats();
  renderDieline2D();
  renderArt();
  $('#lid-opts').hidden = p.style !== 'traylid';
  $('#lift-wrap').hidden = p.style !== 'traylid';
  save();
}

async function renderArt() {
  const token = ++artToken;
  const scale = Math.min(4, 4096 / Math.max(dieline.width, dieline.height));
  const off = document.createElement('canvas');
  await renderArtwork(dieline, state.look, { scale, preview: true }, off);
  if (token !== artToken) return;
  artCanvas.width = off.width;
  artCanvas.height = off.height;
  artCanvas.getContext('2d')!.drawImage(off, 0, 0);
  preview.setArtwork(artCanvas);
}

let svgTimer = 0;
function renderDieline2D() {
  cancelAnimationFrame(svgTimer);
  svgTimer = requestAnimationFrame(() => {
    $('#dieline').innerHTML = buildSvg(dieline, state.look, { ...state.exp, includeArtwork: true, includeGlue: true, preview: true });
  });
  $('#legend-fold').className = `sw ${state.exp.foldMode === 'score' ? 'fold' : 'perf'}`;
}

const fmt = (mm: number) =>
  state.units === 'in' ? `${(mm / IN).toFixed(2)}″` : `${Math.round(mm)} mm`;

function renderStats() {
  const [L, W, H] = dieline.outer;
  const sw = dieline.width;
  const sh = dieline.height;
  const [bw, bh] = state.bed;
  const fits = (sw <= bw && sh <= bh) || (sw <= bh && sh <= bw);
  $('#stats').innerHTML =
    `<div><span>Outside</span><b>${fmt(L)} × ${fmt(W)} × ${fmt(H)}</b></div>` +
    `<div><span>Sheet</span><b>${fmt(sw)} × ${fmt(sh)}</b></div>` +
    (fits
      ? ''
      : `<div class="warn">⚠ Larger than your ${bw} × ${bh} mm laser bed. Make the box smaller or change the bed size under Advanced.</div>`);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function buildStyleCards() {
  const wrap = $('#styles');
  wrap.innerHTML = '';
  for (const style of Object.keys(STYLE_INFO) as BoxStyle[]) {
    const b = el('button', { className: 'style-card', title: STYLE_INFO[style].description });
    b.dataset.style = style;
    b.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true">${STYLE_ICONS[style]}</svg><span>${STYLE_INFO[style].name}</span>`;
    b.onclick = () => {
      state.params.style = style;
      syncInputs();
      preview.stopAnimation();
      update();
      renderDecalList();
      // Show the box folding up when switching style.
      setFold(0);
      preview.animateTo(1, 2600);
    };
    wrap.append(b);
  }
}

const dimIds = ['length', 'width', 'height'] as const;
const mmIds = ['glueTab', 'lidHeight', 'lidClearance'] as const;

function syncInputs() {
  const p = state.params;
  document.querySelectorAll<HTMLButtonElement>('.style-card').forEach((b) => b.classList.toggle('on', b.dataset.style === p.style));
  $('#style-desc').textContent = STYLE_INFO[p.style].description;
  for (const id of dimIds) {
    const inp = $<HTMLInputElement>(`#${id}`);
    inp.value = state.units === 'in' ? (+(p[id] / IN).toFixed(3)).toString() : (+p[id].toFixed(1)).toString();
    inp.step = state.units === 'in' ? '0.125' : '1';
  }
  for (const id of mmIds) $<HTMLInputElement>(`#${id}`).value = String(p[id]);
  $<HTMLInputElement>('#thickness').value = String(p.thickness);
  $<HTMLSelectElement>('#material').value = state.material;
  $('#thickness-row').hidden = state.material !== 'custom';
  $<HTMLInputElement>('#bedW').value = String(state.bed[0]);
  $<HTMLInputElement>('#bedH').value = String(state.bed[1]);
  document.querySelectorAll<HTMLButtonElement>('#units button').forEach((b) => b.classList.toggle('on', b.dataset.unit === state.units));
  $<HTMLInputElement>('#color').value = state.look.color;
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color?.toLowerCase() === state.look.color.toLowerCase()));
  document.querySelectorAll<HTMLInputElement>('input[name=foldMode]').forEach((r) => (r.checked = r.value === state.exp.foldMode));
  $<HTMLInputElement>('#includeGlue').checked = state.exp.includeGlue;
  $<HTMLInputElement>('#includeArtwork').checked = state.exp.includeArtwork;
}

function num(inp: HTMLInputElement, min: number, max: number): number | null {
  const v = parseFloat(inp.value);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function bindControls() {
  for (const id of dimIds) {
    $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
      let v = num(e.target as HTMLInputElement, 0.01, 5000);
      if (v === null) return;
      if (state.units === 'in') v *= IN;
      state.params[id] = Math.max(5, v);
      update();
    });
  }
  for (const id of mmIds) {
    $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
      const v = num(e.target as HTMLInputElement, id === 'lidClearance' ? 0 : 5, 1000);
      if (v === null) return;
      state.params[id] = v;
      update();
    });
  }
  $<HTMLSelectElement>('#material').addEventListener('change', (e) => {
    state.material = (e.target as HTMLSelectElement).value;
    if (state.material !== 'custom') state.params.thickness = parseFloat(state.material);
    syncInputs();
    update();
  });
  $<HTMLInputElement>('#thickness').addEventListener('input', (e) => {
    const v = num(e.target as HTMLInputElement, 0.2, 10);
    if (v === null) return;
    state.params.thickness = v;
    update();
  });
  for (const [i, id] of (['bedW', 'bedH'] as const).entries()) {
    $<HTMLInputElement>(`#${id}`).addEventListener('input', (e) => {
      const v = num(e.target as HTMLInputElement, 10, 5000);
      if (v === null) return;
      state.bed[i] = v;
      renderStats();
      save();
    });
  }
  document.querySelectorAll<HTMLButtonElement>('#units button').forEach((b) =>
    b.addEventListener('click', () => {
      state.units = b.dataset.unit as 'mm' | 'in';
      syncInputs();
      renderStats();
      save();
    }),
  );

  const sw = $('#swatches');
  for (const [name, color] of SWATCHES) {
    const b = el('button', { className: 'swatch', title: name });
    b.dataset.color = color;
    b.style.background = color;
    b.onclick = () => setColor(color);
    sw.append(b);
  }
  $<HTMLInputElement>('#color').addEventListener('input', (e) => setColor((e.target as HTMLInputElement).value));

  document.querySelectorAll<HTMLInputElement>('input[name=foldMode]').forEach((r) =>
    r.addEventListener('change', () => {
      state.exp.foldMode = r.value as FoldMode;
      update();
    }),
  );
  $<HTMLInputElement>('#includeGlue').addEventListener('change', (e) => {
    state.exp.includeGlue = (e.target as HTMLInputElement).checked;
    save();
  });
  $<HTMLInputElement>('#includeArtwork').addEventListener('change', (e) => {
    state.exp.includeArtwork = (e.target as HTMLInputElement).checked;
    save();
  });

  for (const id of ['#dl-svg', '#dl-svg-2']) $(id).addEventListener('click', downloadSvg);
  for (const id of ['#dl-pdf', '#dl-pdf-2']) $(id).addEventListener('click', downloadPdf);
  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('Reset all settings and decals?')) return;
    state = defaults();
    syncInputs();
    renderDecalList();
    update();
  });

  // Viewer controls
  const foldInput = $<HTMLInputElement>('#fold');
  foldInput.value = String(fold);
  foldInput.addEventListener('input', () => {
    preview.stopAnimation();
    fold = parseFloat(foldInput.value);
    preview.setProgress(fold);
    syncPlay();
  });
  preview.onProgress = (p) => {
    fold = p;
    foldInput.value = String(p);
    syncPlay();
  };
  $('#play').addEventListener('click', () => {
    preview.animateTo(fold > 0.5 ? 0 : 1);
  });
  $<HTMLInputElement>('#lift').addEventListener('input', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    preview.setLidLift(v * dieline.outer[2] * 1.2);
  });
  $<HTMLInputElement>('#spin').addEventListener('change', (e) => (preview.autoRotate = (e.target as HTMLInputElement).checked));

  $('#add-text').addEventListener('click', () => {
    state.look.decals.push({ id: uid(), type: 'text', face: 'front', x: 0.5, y: 0.5, size: 0.12, rotation: 0, text: 'Text', color: '#111111', font: 'sans', bold: false });
    renderDecalList();
    update();
  });
  $<HTMLInputElement>('#add-image').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const src = await readImage(file);
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => undefined);
    const aspect = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1;
    state.look.decals.push({ id: uid(), type: 'image', face: 'front', x: 0.5, y: 0.5, size: 0.5, rotation: 0, src, aspect });
    renderDecalList();
    update();
  });
}

function setFold(p: number) {
  fold = p;
  $<HTMLInputElement>('#fold').value = String(p);
  preview.setProgress(p);
  syncPlay();
}

function syncPlay() {
  $('#play').textContent = fold > 0.5 ? '⟲' : '▶';
  $('#play').title = fold > 0.5 ? 'Unfold' : 'Fold';
}

function setColor(c: string) {
  state.look.color = c;
  syncInputs();
  update();
}

/** Reads an image file as a data URL, downscaling large bitmaps to keep files small. */
async function readImage(file: File): Promise<string> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  if (file.type === 'image/svg+xml') return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  const max = 1600;
  if (Math.max(img.naturalWidth, img.naturalHeight) <= max) return url;
  const k = max / Math.max(img.naturalWidth, img.naturalHeight);
  const c = el('canvas', { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Decal editor
// ---------------------------------------------------------------------------
function renderDecalList() {
  const wrap = $('#decals');
  wrap.innerHTML = '';
  $('#decal-empty').hidden = state.look.decals.length > 0;
  state.look.decals.forEach((dc, i) => wrap.append(decalEditor(dc, i)));
}

function decalEditor(dc: Decal, index: number): HTMLElement {
  const changed = () => update();
  const card = el('div', { className: 'decal' });

  const faceSel = el('select');
  for (const f of dieline.faces) faceSel.append(el('option', { value: f.id, textContent: f.label, selected: f.id === dc.face }));
  faceSel.onchange = () => {
    dc.face = faceSel.value;
    changed();
  };

  const head = el(
    'div',
    { className: 'decal-head' },
    el('span', { className: 'decal-kind', textContent: dc.type === 'text' ? 'T' : '🖼' }),
    faceSel,
  );
  const up = el('button', { className: 'icon', title: 'Move up', textContent: '↑', disabled: index === 0 });
  up.onclick = () => {
    const d = state.look.decals;
    [d[index - 1], d[index]] = [d[index], d[index - 1]];
    renderDecalList();
    changed();
  };
  const del = el('button', { className: 'icon', title: 'Remove', textContent: '✕' });
  del.onclick = () => {
    state.look.decals.splice(index, 1);
    renderDecalList();
    changed();
  };
  head.append(up, del);
  card.append(head);

  if (dc.type === 'text') {
    const txt = el('textarea', { value: dc.text ?? '', rows: 1, placeholder: 'Your text' });
    txt.oninput = () => {
      dc.text = txt.value;
      changed();
    };
    const color = el('input', { type: 'color', value: dc.color ?? '#000000', title: 'Text colour' });
    color.oninput = () => {
      dc.color = color.value;
      changed();
    };
    const font = el('select', { title: 'Font' });
    for (const [v, label] of [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono'], ['display', 'Display'], ['script', 'Script']])
      font.append(el('option', { value: v, textContent: label, selected: v === (dc.font ?? 'sans') }));
    font.onchange = () => {
      dc.font = font.value;
      changed();
    };
    const bold = el('button', { className: `icon toggle${dc.bold ? ' on' : ''}`, title: 'Bold', innerHTML: '<b>B</b>' });
    bold.onclick = () => {
      dc.bold = !dc.bold;
      bold.classList.toggle('on', dc.bold);
      changed();
    };
    card.append(txt, el('div', { className: 'decal-row' }, font, color, bold));
  } else if (dc.src) {
    card.append(el('img', { className: 'decal-thumb', src: dc.src, alt: '' }));
  }

  const slider = (label: string, key: 'x' | 'y' | 'size' | 'rotation', min: number, max: number, step: number) => {
    const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(dc[key]) });
    inp.oninput = () => {
      dc[key] = parseFloat(inp.value);
      changed();
    };
    return el('label', { className: 'mini' }, label, inp);
  };
  const face = dieline.faces.find((f) => f.id === dc.face);
  const maxSize = dc.type === 'text' ? 0.6 : 1.2;
  card.append(
    el(
      'div',
      { className: 'decal-sliders' },
      slider('←→', 'x', 0, 1, 0.005),
      slider('↑↓', 'y', 0, 1, 0.005),
      slider('Size', 'size', 0.02, maxSize, 0.005),
      slider('Turn', 'rotation', -180, 180, 1),
    ),
  );
  if (face) card.title = `${face.label}: ${Math.round(faceSize(face).w)} × ${Math.round(faceSize(face).h)} mm`;
  return card;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function baseName() {
  const p = state.params;
  const r = (v: number) => Math.round(v);
  return `box-${p.style}-${r(p.length)}x${r(p.width)}x${r(p.height)}mm`;
}

function download(blob: Blob, name: string) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadSvg() {
  const svg = buildSvg(dieline, state.look, state.exp);
  download(new Blob([svg], { type: 'image/svg+xml' }), `${baseName()}.svg`);
}

async function downloadPdf() {
  const btns = [$<HTMLButtonElement>('#dl-pdf'), $<HTMLButtonElement>('#dl-pdf-2')];
  btns.forEach((b) => (b.disabled = true));
  try {
    // jsPDF is large, so load it only when someone actually exports a PDF.
    const { buildPdf } = await import('./export/pdf');
    const blob = await buildPdf(dieline, state.look, state.exp);
    download(blob, `${baseName()}.pdf`);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildStyleCards();
bindControls();
syncInputs();
update();
renderDecalList();
setFold(0);
preview.animateTo(1, 2600);

// Exposed for automated checks.
(window as unknown as { boxMaker: unknown }).boxMaker = {
  get state() { return state; },
  get dieline() { return dieline; },
  setFold,
  preview,
  refresh: () => {
    update();
    renderDecalList();
  },
};
