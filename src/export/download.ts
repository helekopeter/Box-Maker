import { getBed } from '../bed';
import type { Appearance, Dieline, ExportOptions } from '../types';
import { $, download } from '../ui';
import { layoutCopies } from './sheets';
import { buildSvg } from './svg';

const copiesOf = (exp: ExportOptions) => Math.max(1, Math.min(500, Math.round(exp.copies ?? 1)));

function sheets(d: Dieline, look: Appearance, exp: ExportOptions) {
  const n = copiesOf(exp);
  return n > 1 ? layoutCopies(d, look, n, getBed()).sheets : [{ dieline: d, look }];
}

/**
 * Downloads the box as SVG or PDF. With several copies they're packed onto laser-bed-sized
 * sheets: a PDF gets a page per sheet, SVG a file per sheet.
 */
export async function downloadBox(kind: 'svg' | 'pdf', d: Dieline, look: Appearance, exp: ExportOptions, name: string) {
  const n = copiesOf(exp);
  const base = n > 1 ? `${name}-x${n}` : name;
  const list = sheets(d, look, exp);
  if (kind === 'svg') {
    // Browsers accept a few downloads in a row when they're spaced out a little.
    list.forEach(({ dieline, look: lk }, i) => {
      const svg = buildSvg(dieline, lk, exp);
      const file = list.length > 1 ? `${base}-sheet-${i + 1}.svg` : `${base}.svg`;
      setTimeout(() => download(new Blob([svg], { type: 'image/svg+xml' }), file), i * 400);
    });
    return;
  }
  // jsPDF is large, so load it only when someone actually exports a PDF.
  const { buildPdfPages } = await import('./pdf');
  download(await buildPdfPages(list, exp), `${base}.pdf`);
}

/**
 * Wires a copies input to `exp.copies` and keeps its hint (how many fit per sheet, how many
 * sheets) up to date. Returns a function to call when the box or the bed changes.
 */
export function bindCopies(input: HTMLInputElement, hint: HTMLElement, exp: ExportOptions, dieline: () => Dieline, changed: () => void) {
  input.value = String(copiesOf(exp));
  const refresh = () => {
    const n = copiesOf(exp);
    if (n <= 1) {
      hint.textContent = '';
      hint.hidden = true;
      return;
    }
    const d = dieline();
    const { perSheet, sheets: list } = layoutCopies(d, { color: '#fff', decals: [] }, n, getBed());
    const [bw, bh] = getBed();
    hint.hidden = false;
    hint.textContent =
      perSheet === 0
        ? `One box doesn’t fit your ${bw} × ${bh} mm bed, so each piece gets a sheet of its own (${list.length} sheets).`
        : `${perSheet} fit on one ${bw} × ${bh} mm sheet · ${list.length} sheet${list.length === 1 ? '' : 's'}` +
          (list.length > 1 ? ' (one PDF page or SVG file per sheet)' : '');
  };
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    exp.copies = Math.max(1, Math.min(500, Math.round(v)));
    refresh();
    changed();
  });
  refresh();
  return refresh;
}

/** The ids of a tab's copies controls. */
export const copiesIds = (prefix: string) => ({ input: $<HTMLInputElement>(`#${prefix}copies`), hint: $(`#${prefix}copies-hint`) });
