import { $, el } from '../ui';
import { isPoint, newShape, profile, SHAPE_INFO, type BaseShape, type ShapeSpec } from './model';

/** Top-view icon of a base shape. */
export function shapeIcon(shape: BaseShape): string {
  const s = { ...newShape(), shape, width: 52, depth: 40, size: 52, sides: 16 };
  const pts = profile(s).map(([x, y]) => `${(32 + x).toFixed(1)},${(32 - y).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><polygon points="${pts}"/></svg>`;
}

/**
 * The Shape Builder controls in the Simple tab: base shape, extrusion levels and top.
 * Edits `spec` in place and calls `changed` (with `structure` when the controls
 * themselves need redrawing).
 */
export class ShapeControls {
  constructor(
    private spec: () => ShapeSpec,
    private changed: () => void,
  ) {
    this.buildCards();
    this.bind();
    this.sync();
  }

  private buildCards() {
    const wrap = $('#shape-cards');
    wrap.innerHTML = '';
    for (const shape of Object.keys(SHAPE_INFO) as BaseShape[]) {
      const b = el('button', { className: 'style-card shape-card', title: SHAPE_INFO[shape].name });
      b.dataset.shape = shape;
      b.innerHTML = `${shapeIcon(shape)}<span>${SHAPE_INFO[shape].name}</span>`;
      b.addEventListener('click', () => {
        const s = this.spec();
        // Levels that went straight up from the base still do in the new shape.
        const keys = (sh: BaseShape) => (sh === 'rect' ? (['width', 'depth'] as const) : (['size'] as const));
        for (const lv of s.levels) {
          if (!keys(s.shape).every((k) => Math.abs(lv[k] - s[k]) < 0.01)) break;
          [lv.width, lv.depth, lv.size] = [s.width, s.depth, s.size];
        }
        s.shape = shape;
        this.sync();
        this.changed();
      });
      wrap.append(b);
    }
  }

  private bind() {
    const numInput = (id: string, key: 'width' | 'depth' | 'size' | 'sides', min: number, max: number) =>
      $<HTMLInputElement>(id).addEventListener('input', (e) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!Number.isFinite(v)) return;
        const s = this.spec();
        const old = s[key];
        s[key] = Math.min(max, Math.max(min, v));
        // Levels as wide as the base (straight up) keep following it.
        if (key !== 'sides') {
          let changed = false;
          for (const lv of s.levels) {
            if (Math.abs(lv[key] - old) > 0.01) break;
            lv[key] = s[key];
            changed = true;
          }
          if (changed) this.renderLevels();
        }
        this.changed();
      });
    numInput('#shape-width', 'width', 5, 2000);
    numInput('#shape-depth', 'depth', 5, 2000);
    numInput('#shape-size', 'size', 5, 2000);
    numInput('#shape-sides', 'sides', 6, 48);
    $('#shape-add-level').addEventListener('click', () => {
      const levels = this.spec().levels;
      const last = levels[levels.length - 1];
      // Carries straight on up from the level below.
      levels.push({ height: Math.round(last.height / 2) || 20, width: last.width, depth: last.depth, size: last.size });
      this.sync();
      this.changed();
    });
    document.querySelectorAll<HTMLButtonElement>('#shape-top button').forEach((b) =>
      b.addEventListener('click', () => {
        this.spec().top = b.dataset.top as 'open' | 'closed';
        this.sync();
        this.changed();
      }),
    );
  }

  /** Updates the controls to match the spec. */
  sync() {
    const s = this.spec();
    document.querySelectorAll<HTMLButtonElement>('.shape-card').forEach((b) => b.classList.toggle('on', b.dataset.shape === s.shape));
    $('#shape-rect-size').hidden = s.shape !== 'rect';
    $('#shape-poly-size').hidden = s.shape === 'rect';
    $('#shape-sides-row').hidden = s.shape !== 'round';
    $<HTMLInputElement>('#shape-width').value = String(s.width);
    $<HTMLInputElement>('#shape-depth').value = String(s.depth);
    $<HTMLInputElement>('#shape-size').value = String(s.size);
    $<HTMLInputElement>('#shape-sides').value = String(s.sides);
    document.querySelectorAll<HTMLButtonElement>('#shape-top button').forEach((b) => b.classList.toggle('on', b.dataset.top === s.top));
    this.renderLevels();
  }

  /** One row per extrusion level. */
  private renderLevels() {
    const host = $('#shape-levels');
    host.innerHTML = '';
    const levels = this.spec().levels;
    levels.forEach((lv, i) => {
      const last = i === levels.length - 1;
      const row = el('div', { className: 'level' });
      const del = el('button', { className: 'icon', title: 'Remove this level', textContent: '✕', disabled: levels.length === 1 });
      del.addEventListener('click', () => {
        levels.splice(i, 1);
        this.sync();
        this.changed();
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

      // The top's size in mm (rectangles: width and depth).
      const s = this.spec();
      const point = isPoint(s, lv);
      const keys = s.shape === 'rect' ? (['width', 'depth'] as const) : (['size'] as const);
      const labels = { width: 'Top width (mm)', depth: 'Top depth (mm)', size: 'Top size (mm)' };
      for (const key of keys) {
        const inp = el('input', { type: 'number', min: '1', step: '1', value: String(Math.round(lv[key] * 10) / 10), disabled: point });
        inp.addEventListener('input', () => {
          const v = parseFloat(inp.value);
          if (!Number.isFinite(v)) return;
          lv[key] = Math.min(4000, Math.max(1, v));
          this.changed();
        });
        row.append(el('label', { className: 'row' }, labels[key], inp));
      }
      // Only the last level may come to a point (nothing can sit on top of a point).
      if (last) {
        const cb = el('input', { type: 'checkbox', checked: point });
        cb.addEventListener('change', () => {
          if (cb.checked) {
            lv.width = lv.depth = lv.size = 0;
          } else {
            // Back to the size of the level below (or the base).
            const below = i ? levels[i - 1] : s;
            [lv.width, lv.depth, lv.size] = [below.width, below.depth, below.size];
          }
          this.renderLevels();
          this.changed();
        });
        row.append(el('label', { className: 'check' }, cb, 'Comes to a point'));
      }
      host.append(row);
    });
    this.syncAfterLevels();
  }

  /** The add button and the top choice depend on whether the shape ends in a point. */
  private syncAfterLevels() {
    const levels = this.spec().levels;
    const pointy = isPoint(this.spec(), levels[levels.length - 1]);
    const add = $<HTMLButtonElement>('#shape-add-level');
    add.disabled = pointy || levels.length >= 6;
    add.title = pointy ? 'The top comes to a point, so nothing can go on top' : '';
    $('#shape-top-panel').hidden = pointy;
  }
}
