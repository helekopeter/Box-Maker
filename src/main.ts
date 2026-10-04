import './style.css';
import { fromDieline } from './advanced/convert';
import { AdvancedTab } from './advanced/tab';
import { STYLE_INFO } from './geometry/styles';
import { ShapeTab } from './shape/tab';
import { SimpleTab } from './simple';
import type { Decal } from './types';
import { $, toast } from './ui';
import type { SharedBox } from './universe/store';
import { UniverseTab } from './universe/tab';

type TabId = 'simple' | 'shape' | 'advanced' | 'universe';
const TABS: TabId[] = ['simple', 'shape', 'advanced', 'universe'];

const simple = new SimpleTab();
const shape = new ShapeTab();
const advanced = new AdvancedTab();
const universe = new UniverseTab({ open: openShared });
let active: TabId = 'simple';

function show(tab: TabId) {
  active = tab;
  for (const id of TABS) $(`#tab-${id}`).hidden = id !== tab;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  const editing = tab !== 'universe';
  for (const id of ['#reset-btn', '#share-btn', '#dl-svg', '#dl-pdf']) $(id).hidden = !editing;
  if (tab === 'advanced') advanced.shown();
  if (tab === 'shape') shape.shown();
  if (tab === 'universe') universe.shown();
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
}

document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab as TabId)));

/** The editing tab the header buttons act on. */
const current = () => (active === 'advanced' ? advanced : active === 'shape' ? shape : simple);

$('#dl-svg').addEventListener('click', () => current().downloadSvg());
$('#dl-pdf').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  try {
    await current().downloadPdf();
  } finally {
    btn.disabled = false;
  }
});
$('#reset-btn').addEventListener('click', () => current().reset());

/** Renders a clean 3D snapshot for the gallery (without the decal selection outline). */
async function snapshot(tab: SimpleTab | AdvancedTab | ShapeTab): Promise<string> {
  if ('decals' in tab) tab.decals.select(null);
  await new Promise((r) => setTimeout(r, 150));
  return tab.preview.snapshot();
}

$('#share-btn').addEventListener('click', () => {
  if (active === 'shape') {
    // Shapes are shared as the box they unfold into.
    universe.share({ kind: 'advanced', design: shape.design }, { name: shape.design.name }, () => snapshot(shape));
  } else if (active === 'advanced') {
    universe.share(advanced.share(), { name: advanced.design.name }, () => snapshot(advanced));
  } else {
    const p = simple.state.params;
    universe.share(simple.share(), { name: `${STYLE_INFO[p.style].name} ${Math.round(p.length)}×${Math.round(p.width)}×${Math.round(p.height)}` }, () =>
      snapshot(simple),
    );
  }
});

/** Simple → Advanced: turn the current ready-made box into a freely editable design. */
$('#to-advanced').addEventListener('click', () => {
  const p = simple.state.params;
  const name = `${STYLE_INFO[p.style].name} ${Math.round(p.length)}×${Math.round(p.width)}×${Math.round(p.height)}`;
  const { design, skipped, droppedPieces, faceIds } = fromDieline(simple.dieline, { name, thickness: p.thickness, color: simple.state.look.color });
  const decals: Decal[] = simple.currentDecals
    .filter((d) => faceIds.has(d.face))
    .map((d) => ({ ...d, face: faceIds.get(d.face)! }));
  advanced.open(design, decals);
  show('advanced');
  const notes = [
    droppedPieces ? 'Only the tray came across; Advanced designs are one piece.' : '',
    skipped ? `${skipped} panel(s) couldn't be converted.` : '',
  ].filter(Boolean);
  toast(notes.length ? notes.join(' ') : 'Now editing in Advanced. Undo (Ctrl+Z) brings back your previous design.');
});

/** Shape Maker → Advanced: open the unfolded box for further editing. */
shape.onMakeBox = (design) => {
  advanced.open(design);
  show('advanced');
  toast('Your shape is now a box in Advanced. Undo (Ctrl+Z) brings back your previous design.');
};

/** Opens a box from the Box Universe in the tab it was made in. */
function openShared(box: SharedBox) {
  if (box.data.kind === 'simple') {
    simple.open(box.data);
    show('simple');
  } else {
    advanced.open(box.data.design);
    show('advanced');
  }
  toast(`Opened “${box.name}”.`);
}

document.addEventListener('keydown', (e) => {
  if (active !== 'advanced') return;
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select, [contenteditable], dialog')) return;
  if (advanced.key(e)) e.preventDefault();
});

const tabFromHash = (): TabId => {
  const h = location.hash.slice(1) as TabId;
  return TABS.includes(h) ? h : 'simple';
};
window.addEventListener('hashchange', () => show(tabFromHash()));
show(tabFromHash());

// Exposed for automated checks.
(window as unknown as { boxMaker: unknown }).boxMaker = {
  get state() {
    return simple.state;
  },
  get dieline() {
    return simple.dieline;
  },
  setFold: (p: number) => simple.setFold(p),
  preview: simple.preview,
  refresh: () => {
    simple.update();
    simple.decals.render();
  },
  simple,
  shape,
  advanced,
  universe,
  show,
};
