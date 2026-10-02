import { decalExtent, decalPieces, fontStack } from '../artwork';
import { chainSegments, computeLines, dashSegments, type Segment } from '../geometry/lines';
import type { Appearance, Dieline, ExportOptions, Vec2 } from '../types';

export const COLORS = {
  cut: '#ff0000',
  score: '#0000ff',
  glue: '#00a651',
};

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const polyPath = (poly: Vec2[], closed: boolean) =>
  poly.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ') + (closed ? ' Z' : '');

function chainsToPath(chains: Vec2[][]): string {
  return chains
    .map((c) => {
      const first = c[0];
      const last = c[c.length - 1];
      const closed = c.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-3;
      return polyPath(closed ? c.slice(0, -1) : c, closed);
    })
    .join(' ');
}

const segPath = (segs: Segment[]) =>
  segs.map(({ a, b }) => `M${n(a[0])} ${n(a[1])} L${n(b[0])} ${n(b[1])}`).join(' ');

function layer(id: string, label: string, body: string, attrs = '') {
  return `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${label}"${attrs}>${body}</g>`;
}

export interface SvgOptions extends ExportOptions {
  /** Screen preview: hairlines that stay visible at any zoom, dashed score lines. */
  preview?: boolean;
}

export function buildSvg(d: Dieline, look: Appearance, opts: SvgOptions): string {
  const { cuts, folds } = computeLines(d);
  const pv = !!opts.preview;
  const stroke = (color: string, extra = '') =>
    pv
      ? ` fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"${extra}`
      : ` fill="none" stroke="${color}" stroke-width="0.1"${extra}`;

  const parts: string[] = [];

  if (opts.includeArtwork) {
    const defs: string[] = [];
    const body: string[] = [];
    const bg = d.panels
      .filter((p) => p.kind !== 'glue')
      .map((p) => [p.poly, ...(p.holes ?? [])].map((loop) => polyPath(loop, true)).join(' '))
      .join(' ');
    body.push(`<path d="${bg}" fill="${esc(look.color)}" fill-rule="evenodd" stroke="none"/>`);
    const clipped = new Set<string>();
    look.decals.forEach((dc, i) => {
      const pieces = decalPieces(d, dc);
      if (!pieces.length) return;
      const { w, h } = decalExtent(dc);
      let inner = '';
      if (dc.type === 'text' && dc.text) {
        const lines = dc.text.split('\n');
        inner = lines
          .map(
            (line, li) =>
              `<text x="0" y="${n((li - (lines.length - 1) / 2) * dc.size * 1.15)}" text-anchor="middle" dominant-baseline="central" font-family="${esc(fontStack(dc.font))}" font-size="${n(dc.size)}"${dc.bold ? ' font-weight="bold"' : ''} fill="${esc(dc.color ?? '#000')}">${esc(line)}</text>`,
          )
          .join('');
      } else if (dc.type === 'image' && dc.src) {
        inner = `<image href="${esc(dc.src)}" x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`;
      }
      if (!inner) return;
      // Define the decal once; a decal wrapping over several faces is reused on each of them.
      const id = `decal-${i}`;
      defs.push(`<g id="${id}">${inner}</g>`);
      for (const pc of pieces) {
        const clip = `clip-${pc.face.id}`;
        if (!clipped.has(clip)) {
          clipped.add(clip);
          const r = pc.face.rect;
          defs.push(`<clipPath id="${clip}"><rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}"/></clipPath>`);
        }
        body.push(`<g clip-path="url(#${clip})"><use href="#${id}" transform="matrix(${pc.matrix.map(n).join(' ')})"/></g>`);
      }
    });
    if (defs.length) parts.push(`<defs>${defs.join('')}</defs>`);
    parts.push(layer('artwork', 'Artwork (print / engrave)', body.join('')));
  }

  if (opts.includeGlue) {
    const glue = d.panels.filter((p) => p.kind === 'glue');
    const body = glue
      .map((p) => {
        const xs = p.poly.map((q) => q[0]);
        const ys = p.poly.map((q) => q[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        const vertical = h > w;
        const size = Math.max(2, Math.min(vertical ? w : h, 12) * 0.45);
        return (
          `<path d="${polyPath(p.poly, true)}" fill="${COLORS.glue}" fill-opacity="0.25" stroke="none"/>` +
          `<text x="${n(cx)}" y="${n(cy)}" transform="rotate(${vertical ? -90 : 0} ${n(cx)} ${n(cy)})" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="${n(size)}" fill="${COLORS.glue}">GLUE</text>`
        );
      })
      .join('');
    parts.push(layer('glue', 'Glue areas (do not cut)', body));
  }

  if (opts.foldMode === 'score') {
    const dash = pv ? ' stroke-dasharray="6 4"' : '';
    parts.push(layer('fold', 'Fold lines (score)', `<path d="${segPath(folds)}"${stroke(COLORS.score, dash)}/>`));
  } else {
    parts.push(
      layer('fold', 'Fold lines (perforated cut)', `<path d="${segPath(dashSegments(folds))}"${stroke(COLORS.cut)}/>`),
    );
  }
  parts.push(layer('cut', 'Cut lines', `<path d="${chainsToPath(chainSegments(cuts))}"${stroke(COLORS.cut)}/>`));

  const W = n(d.width);
  const H = n(d.height);
  const size = pv ? '' : ` width="${W}mm" height="${H}mm"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"${size} viewBox="0 0 ${W} ${H}">` +
    `<title>Box dieline ${W} × ${H} mm</title>` +
    parts.join('') +
    `</svg>`
  );
}
