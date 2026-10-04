import { decalCenter, faceSize, hitDecal, setDecalCenter } from './artwork';
import { angleOf, apply, applyLinear, faceAt, invert, multiply, unfoldFrom, wrapPoint } from './geometry/surface';
import type { BoxPreview, SurfaceHit } from './preview3d';
import type { Decal, Dieline, Face, Texture, Vec2 } from './types';
import { el, readImage, uid } from './ui';

export interface DecalLayerOptions {
  /** Where the decal cards go. */
  list: HTMLElement;
  /** Shown when there are no decals / when there are some. */
  empty: HTMLElement;
  help: HTMLElement;
  addText: HTMLElement;
  addImage: HTMLInputElement;
  preview: BoxPreview;
  dieline: () => Dieline;
  decals: () => Decal[];
  /** Redraw after a change. `dragging` is true mid-drag (skip expensive work). */
  changed: (dragging: boolean) => void;
}

const normAngle = (a: number) => Math.round((((a + 180) % 360 + 360) % 360 - 180) * 100) / 100;

/**
 * Decals on a box: the list of decal cards plus selecting and dragging decals on the 3D
 * preview, where they wrap around edges onto neighbouring faces.
 */
export class DecalLayer {
  selected: string | null = null;
  /** Active drag: offset from the pointer to the decal centre, in the anchor face's sheet frame. */
  private drag: { id: string; grab: Vec2 } | null = null;

  constructor(private o: DecalLayerOptions) {
    o.preview.onPointer = (type, hit) => this.pointer(type, hit);
    o.addText.addEventListener('click', () =>
      this.placeNew({ id: uid(), type: 'text', face: '', x: 0.5, y: 0.5, size: 10, rotation: 0, text: 'Text', color: '#111111', font: 'sans', bold: true }),
    );
    o.addImage.addEventListener('change', async () => {
      const file = o.addImage.files?.[0];
      o.addImage.value = '';
      if (!file) return;
      const src = await readImage(file);
      const img = new Image();
      img.src = src;
      await img.decode().catch(() => undefined);
      const aspect = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1;
      this.placeNew({ id: uid(), type: 'image', face: '', x: 0.5, y: 0.5, size: 50, rotation: 0, src, aspect });
    });
  }

  get dragging() {
    return !!this.drag;
  }

  /** Moves decals off faces that no longer exist (e.g. after a style change). */
  validate() {
    const faces = this.o.dieline().faces;
    for (const dc of this.o.decals()) {
      if (faces.some((f) => f.id === dc.face)) continue;
      if (!faces.length) continue;
      dc.face = faces[0].id;
      dc.x = dc.y = 0.5;
    }
  }

  private faceById(id: string) {
    return this.o.dieline().faces.find((f) => f.id === id);
  }

  private surfaceAt(hit: SurfaceHit | null): { face: Face; point: Vec2 } | null {
    if (!hit) return null;
    const face = faceAt(this.o.dieline(), hit.panel, hit.sheet);
    return face ? { face, point: hit.sheet } : null;
  }

  select(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.o.list.querySelectorAll<HTMLElement>('.decal').forEach((c) => c.classList.toggle('on', c.dataset.id === id));
    if (id) this.o.list.querySelector(`.decal[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.o.changed(false);
  }

  private pointer(type: 'down' | 'move' | 'up' | 'hover', hit: SurfaceHit | null): boolean | void {
    const dl = this.o.dieline();
    const decals = this.o.decals();
    const surf = this.surfaceAt(hit);
    if (type === 'hover') return !!surf && hitDecal(dl, decals, surf.face.id, surf.point) >= 0;

    if (type === 'down') {
      const i = surf ? hitDecal(dl, decals, surf.face.id, surf.point) : -1;
      if (!surf || i < 0) {
        this.select(null);
        return false;
      }
      const dc = decals[i];
      const toAnchor = unfoldFrom(dl, surf.face.id).get(dc.face)!;
      const p = apply(toAnchor, surf.point);
      const c = decalCenter(this.faceById(dc.face)!, dc);
      this.drag = { id: dc.id, grab: [c[0] - p[0], c[1] - p[1]] };
      this.select(dc.id);
      return true;
    }

    if (type === 'move' && this.drag && surf) {
      const drag = this.drag;
      const dc = decals.find((x) => x.id === drag.id);
      const anchor = dc && this.faceById(dc.face);
      if (!dc || !anchor) return;
      const toAnchor = unfoldFrom(dl, surf.face.id).get(dc.face);
      if (!toAnchor) return;
      // Work in the frame of the face under the pointer, then hand the decal to whichever
      // face its centre lands on. Overhanging parts wrap onto neighbouring faces when drawn.
      const fromAnchor = invert(toAnchor);
      const grab = applyLinear(fromAnchor, drag.grab);
      const centre: Vec2 = [surf.point[0] + grab[0], surf.point[1] + grab[1]];
      const w = wrapPoint(dl, surf.face.id, centre);
      const target = this.faceById(w.face)!;
      const anchorToTarget = multiply(unfoldFrom(dl, surf.face.id).get(w.face)!, fromAnchor);
      // Keep the decal's orientation on the surface continuous as it crosses an edge.
      dc.rotation = normAngle(anchor.rotation + dc.rotation + angleOf(anchorToTarget) - target.rotation);
      dc.face = w.face;
      setDecalCenter(target, dc, w.point);
      drag.grab = applyLinear(anchorToTarget, drag.grab);
      this.syncCard(dc);
      this.o.changed(true);
      return;
    }

    if (type === 'up' && this.drag) {
      this.drag = null;
      this.o.changed(false);
    }
  }

  /** Places a new decal on the face in the middle of the 3D view (or the first face). */
  private placeNew(dc: Decal) {
    const dl = this.o.dieline();
    const surf = this.surfaceAt(this.o.preview.pick(0, 0));
    const face = surf?.face ?? this.faceById('front') ?? dl.faces[0];
    if (!face) return;
    dc.face = face.id;
    const { w, h } = faceSize(face);
    if (dc.type === 'text') dc.size = Math.max(4, Math.round(Math.min(w, h) * 0.18));
    else dc.size = Math.round(w * 0.5);
    if (surf) setDecalCenter(face, dc, surf.point);
    this.o.decals().push(dc);
    this.selected = dc.id;
    this.render();
    this.o.changed(false);
  }

  render() {
    const decals = this.o.decals();
    this.o.list.innerHTML = '';
    this.o.empty.hidden = decals.length > 0;
    this.o.help.hidden = decals.length === 0;
    decals.forEach((dc, i) => this.o.list.append(this.card(dc, i)));
  }

  /** Updates a decal card's controls after the decal was moved in 3D. */
  private syncCard(dc: Decal) {
    const card = this.o.list.querySelector<HTMLElement>(`.decal[data-id="${dc.id}"]`);
    if (!card) return;
    card.querySelector<HTMLSelectElement>('select.side')!.value = dc.face;
    const rot = card.querySelector<HTMLInputElement>('input[data-key=rotation]')!;
    rot.value = String(dc.rotation);
    rot.dispatchEvent(new Event('sync'));
  }

  private card(dc: Decal, index: number): HTMLElement {
    const decals = this.o.decals();
    const dl = this.o.dieline();
    const changed = () => this.o.changed(false);
    const card = el('div', { className: `decal${dc.id === this.selected ? ' on' : ''}` });
    card.dataset.id = dc.id;
    card.addEventListener('pointerdown', () => this.select(dc.id));

    const faceSel = el('select', { className: 'side', title: 'Side of the box' });
    for (const f of dl.faces) faceSel.append(el('option', { value: f.id, textContent: f.label, selected: f.id === dc.face }));
    faceSel.onchange = () => {
      dc.face = faceSel.value;
      dc.x = dc.y = 0.5;
      dc.rotation = 0;
      this.syncCard(dc);
      changed();
    };

    const up = el('button', { className: 'icon', title: 'Bring forward', textContent: '↑', disabled: index === decals.length - 1 });
    up.onclick = () => {
      [decals[index + 1], decals[index]] = [decals[index], decals[index + 1]];
      this.render();
      changed();
    };
    const del = el('button', { className: 'icon', title: 'Remove', textContent: '✕' });
    del.onclick = () => {
      decals.splice(index, 1);
      if (this.selected === dc.id) this.selected = null;
      this.render();
      changed();
    };
    card.append(
      el('div', { className: 'decal-head' }, el('span', { className: 'decal-kind', textContent: dc.type === 'text' ? 'T' : '▣' }), faceSel, up, del),
    );

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

    const slider = (label: string, key: 'size' | 'rotation', min: number, max: number, step: number, unit: string) => {
      const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(dc[key]) });
      inp.dataset.key = key;
      const out = el('output', { textContent: `${Math.round(dc[key])}${unit}` });
      const show = () => (out.textContent = `${Math.round(parseFloat(inp.value))}${unit}`);
      inp.addEventListener('sync', show);
      inp.oninput = () => {
        dc[key] = parseFloat(inp.value);
        show();
        changed();
      };
      return el('label', { className: 'mini' }, el('span', { textContent: label }), inp, out);
    };
    const maxSize = Math.ceil(Math.max(...dl.outer, 50) * (dc.type === 'text' ? 0.6 : 1.5));
    card.append(slider('Size', 'size', 2, Math.max(maxSize, dc.size), 0.5, ' mm'), slider('Turn', 'rotation', -180, 180, 1, '°'));
    return card;
  }
}

/** Keeps only well-formed decals; images must be inline data URLs. */
/** Validates a texture loaded from a file or the Box Universe (inline raster images only). */
export function sanitizeTexture(raw: unknown): Texture | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.src !== 'string' || t.src.length > 8_000_000 || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(t.src)) return undefined;
  const size = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(10000, Math.max(1, v)) : 100);
  return { src: t.src, width: size(t.width), height: size(t.height) };
}

export function sanitizeDecals(raw: unknown): Decal[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#111111');
  const out: Decal[] = [];
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const base = {
      id: typeof d.id === 'string' ? d.id.slice(0, 40) : uid(),
      face: typeof d.face === 'string' ? d.face.slice(0, 60) : '',
      x: num(d.x, -5, 5, 0.5),
      y: num(d.y, -5, 5, 0.5),
      size: num(d.size, 1, 3000, 20),
      rotation: num(d.rotation, -360, 360, 0),
    };
    if (d.type === 'image') {
      // Only inline raster/SVG images: no remote URLs that could track viewers.
      if (typeof d.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(d.src)) continue;
      if (d.src.length > 3_000_000) continue;
      out.push({ ...base, type: 'image', src: d.src, aspect: num(d.aspect, 0.01, 100, 1) });
    } else {
      out.push({
        ...base,
        type: 'text',
        text: typeof d.text === 'string' ? d.text.slice(0, 500) : '',
        color: color(d.color),
        font: ['sans', 'serif', 'mono', 'display', 'script'].includes(d.font as string) ? (d.font as string) : 'sans',
        bold: d.bold === true,
      });
    }
  }
  return out;
}
