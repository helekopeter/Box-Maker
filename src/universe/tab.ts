import { toDieline } from '../advanced/model';
import { buildSvg } from '../export/svg';
import { generateDieline, STYLE_INFO } from '../geometry/styles';
import type { Decal, Dieline, ExportOptions } from '../types';
import { $, download, el, toast } from '../ui';
import { EXAMPLES } from './examples';
import { createStore, sanitizeBox, type BoxStore, type NewBox, type ShareData, type SharedBox } from './store';

const AUTHOR_KEY = 'box-maker:author';

export interface UniverseHooks {
  /** Opens a box in the Simple or Advanced tab. */
  open: (box: SharedBox) => void;
}

function dielineOf(data: ShareData): { dl: Dieline; color: string; decals: Decal[] } {
  if (data.kind === 'simple') return { dl: generateDieline(data.params), color: data.look.color, decals: data.look.decals };
  return { dl: toDieline(data.design), color: data.design.color, decals: data.design.decals ?? [] };
}

const EXPORT: ExportOptions = { foldMode: 'score', includeArtwork: false, includeGlue: true };

/** Folded size text for a card. */
function sizeOf(data: ShareData): string {
  const [L, W, H] = dielineOf(data).dl.outer.map((v) => Math.round(v));
  return `${L} × ${W} × ${H} mm`;
}

/**
 * The Box Universe tab: a gallery of boxes people have shared, plus built-in examples.
 */
export class UniverseTab {
  readonly store: BoxStore = createStore();
  private query = '';
  private searchTimer = 0;

  constructor(private hooks: UniverseHooks) {
    $('#uni-mode').textContent = this.store.shared
      ? 'Shared with everyone who visits this site.'
      : 'Boxes you share are kept in this browser only. To share them with everyone, the site owner can connect a free Supabase project (see the README). You can still swap boxes as files.';
    $<HTMLInputElement>('#uni-search').addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.query = (e.target as HTMLInputElement).value;
      this.searchTimer = window.setTimeout(() => this.refresh(), 250);
    });
    $<HTMLInputElement>('#uni-import').addEventListener('change', (e) => this.importFile(e.target as HTMLInputElement));
    $<HTMLFormElement>('#share-form').addEventListener('submit', (e) => e.preventDefault());
  }

  /** Called when the tab is shown. */
  shown() {
    this.refresh();
  }

  async refresh() {
    const grid = $('#uni-grid');
    const status = $('#uni-status');
    status.textContent = 'Loading…';
    let boxes: SharedBox[] = [];
    try {
      boxes = await this.store.list(this.query);
      status.textContent = '';
    } catch (err) {
      status.textContent = (err as Error).message;
    }
    const q = this.query.toLowerCase();
    const examples = EXAMPLES.filter((b) => !q || `${b.name} ${b.description}`.toLowerCase().includes(q));
    grid.innerHTML = '';
    if (boxes.length) {
      grid.append(el('h3', { className: 'uni-heading', textContent: this.store.shared ? 'Shared boxes' : 'Your boxes' }));
      for (const b of boxes) grid.append(this.card(b));
    } else if (!this.query) {
      grid.append(el('p', { className: 'hint uni-empty', textContent: 'Nothing shared yet. Make a box in Simple or Advanced and press "Share".' }));
    }
    if (examples.length) {
      grid.append(el('h3', { className: 'uni-heading', textContent: 'Examples' }));
      for (const b of examples) grid.append(this.card(b));
    }
    if (!boxes.length && !examples.length) grid.append(el('p', { className: 'hint uni-empty', textContent: `No boxes match “${this.query}”.` }));
  }

  private card(b: SharedBox): HTMLElement {
    const card = el('article', { className: 'uni-card' });
    const thumb = el('div', { className: 'uni-thumb' });
    if (b.thumbnail) {
      thumb.append(el('img', { src: b.thumbnail, alt: '', loading: 'lazy' }));
    } else {
      // No snapshot: show the cutting layout instead.
      try {
        const { dl, color } = dielineOf(b.data);
        thumb.innerHTML = buildSvg(dl, { color, decals: [] }, { ...EXPORT, includeArtwork: true, preview: true });
      } catch {
        /* leave blank */
      }
    }
    const kind = b.kind === 'simple' ? STYLE_INFO[b.data.kind === 'simple' ? b.data.params.style : 'tuck'].name : 'Custom (Advanced)';
    const meta = el('div', { className: 'uni-meta' },
      el('h4', { textContent: b.name }),
      el('p', { className: 'uni-by', textContent: `${b.example ? 'Example' : `by ${b.author}`} · ${kind}` }),
      el('p', { className: 'uni-size', textContent: sizeOf(b.data) }),
    );
    if (b.description) meta.append(el('p', { className: 'uni-desc', textContent: b.description }));
    const actions = el('div', { className: 'uni-actions' });
    const btn = (text: string, cls: string, fn: () => void) => {
      const x = el('button', { className: cls, textContent: text });
      x.addEventListener('click', fn);
      actions.append(x);
    };
    btn('Open', 'btn small primary', () => this.hooks.open(b));
    btn('SVG', 'btn small', () => {
      const { dl, color, decals } = dielineOf(b.data);
      const svg = buildSvg(dl, { color, decals }, EXPORT);
      download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(b.name)}.svg`);
    });
    btn('File', 'btn small', () => exportFile(b));
    if (!b.example && this.store.remove) {
      btn('Delete', 'btn small ghost', async () => {
        if (!confirm(`Delete “${b.name}” from this browser?`)) return;
        await this.store.remove!(b.id);
        this.refresh();
      });
    }
    card.append(thumb, meta, actions);
    return card;
  }

  /**
   * Shows the share dialog for a box from one of the editor tabs and uploads it.
   * `snapshot` renders the current 3D preview.
   */
  share(data: ShareData, defaults: { name: string }, snapshot: () => Promise<string>) {
    const dialog = $<HTMLDialogElement>('#share-dialog');
    const form = $<HTMLFormElement>('#share-form');
    const name = $<HTMLInputElement>('#share-name');
    const author = $<HTMLInputElement>('#share-author');
    const desc = $<HTMLTextAreaElement>('#share-desc');
    const img = $<HTMLImageElement>('#share-thumb');
    const err = $('#share-error');
    name.value = defaults.name;
    try {
      author.value = localStorage.getItem(AUTHOR_KEY) ?? '';
    } catch {
      author.value = '';
    }
    desc.value = '';
    err.textContent = '';
    const thumbnail = snapshot().then(shrink);
    img.removeAttribute('src');
    $('#share-where').textContent = this.store.shared
      ? 'Everyone visiting this site will be able to see and open it.'
      : 'It will be saved in this browser’s Box Universe.';
    const submit = $<HTMLButtonElement>('#share-submit');
    const onSubmit = async () => {
      submit.disabled = true;
      err.textContent = '';
      try {
        try {
          localStorage.setItem(AUTHOR_KEY, author.value.trim());
        } catch {
          /* ignore */
        }
        const box: NewBox = {
          name: name.value.trim().slice(0, 80) || 'Untitled box',
          author: author.value.trim().slice(0, 40) || 'Anonymous',
          description: desc.value.trim().slice(0, 500),
          kind: data.kind,
          data,
          thumbnail: await thumbnail,
        };
        await this.store.add(box);
        dialog.close();
        toast(this.store.shared ? 'Shared to the Box Universe!' : 'Saved to your Box Universe.');
        this.refresh();
      } catch (e) {
        err.textContent = (e as Error).message;
      } finally {
        submit.disabled = false;
      }
    };
    submit.onclick = onSubmit;
    form.onsubmit = (e) => {
      e.preventDefault();
      onSubmit();
    };
    $('#share-cancel').onclick = () => dialog.close();
    $('#share-file').onclick = () =>
      exportFile({ name: name.value.trim() || 'box', author: author.value.trim(), description: desc.value.trim(), kind: data.kind, data });
    dialog.showModal();
    thumbnail.then((t) => (img.src = t));
  }

  private async importFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 8_000_000) throw new Error('That file is too big.');
      const json = JSON.parse(await file.text()) as Record<string, unknown>;
      const box = sanitizeBox({ ...json, id: undefined });
      if (!box) throw new Error('That doesn’t look like a Box Maker file.');
      this.hooks.open(box);
    } catch (e) {
      toast((e as Error).message);
    }
  }
}

/** Saves a box as a .box.json file that can be imported again. */
export function exportFile(b: Pick<SharedBox, 'name' | 'author' | 'description' | 'kind' | 'data'>) {
  const file = { app: 'box-maker', version: 1, name: b.name, author: b.author, description: b.description, kind: b.kind, data: b.data };
  download(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }), `${slug(b.name)}.box.json`);
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'box';
}

/** Scales a PNG snapshot down to a small JPEG for the gallery. */
async function shrink(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => undefined);
  if (!img.naturalWidth) return '';
  const w = 480;
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  const c = el('canvas', { width: w, height: h });
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f3efe8';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.8);
}
