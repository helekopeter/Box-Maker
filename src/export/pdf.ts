import { jsPDF } from 'jspdf';
import { renderArtwork } from '../artwork';
import { chainSegments, computeLines, dashSegments, type Segment } from '../geometry/lines';
import type { Appearance, Dieline, ExportOptions, Vec2 } from '../types';
import { COLORS } from './svg';

const hex = (c: string): [number, number, number] => {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

function drawPoly(doc: jsPDF, poly: Vec2[], style: 'S' | 'F', closed: boolean) {
  if (poly.length < 2) return;
  const [x0, y0] = poly[0];
  const deltas = poly.slice(1).map((p, i) => [p[0] - poly[i][0], p[1] - poly[i][1]]);
  doc.lines(deltas, x0, y0, [1, 1], style, closed);
}

function drawSegments(doc: jsPDF, segs: Segment[]) {
  for (const { a, b } of segs) doc.line(a[0], a[1], b[0], b[1]);
}

/** Builds a PDF whose page is exactly the sheet size, in millimetres. */
export async function buildPdf(d: Dieline, look: Appearance, opts: ExportOptions): Promise<Blob> {
  const W = d.width;
  const H = d.height;
  const doc = new jsPDF({
    unit: 'mm',
    format: [W, H],
    orientation: W > H ? 'landscape' : 'portrait',
    compress: true,
  });
  doc.setProperties({ title: `Box dieline ${Math.round(W)} × ${Math.round(H)} mm`, creator: 'Box Maker' });

  if (opts.includeArtwork) {
    // Rasterise artwork at ~300 dpi, capped to keep files reasonable.
    const scale = Math.min(300 / 25.4, 6000 / Math.max(W, H));
    const canvas = await renderArtwork(d, look, { scale, preview: false });
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, W, H, undefined, 'FAST');
  }

  const { cuts, folds } = computeLines(d);

  if (opts.includeGlue) {
    const gs = doc.GState({ opacity: 0.25 });
    doc.saveGraphicsState();
    doc.setGState(gs);
    doc.setFillColor(...hex(COLORS.glue));
    for (const p of d.panels) if (p.kind === 'glue') drawPoly(doc, p.poly, 'F', true);
    doc.restoreGraphicsState();
    doc.setTextColor(...hex(COLORS.glue));
    for (const p of d.panels) {
      if (p.kind !== 'glue') continue;
      const xs = p.poly.map((q) => q[0]);
      const ys = p.poly.map((q) => q[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      const vertical = h > w;
      const size = Math.max(2, Math.min(vertical ? w : h, 12) * 0.45);
      doc.setFontSize(size / 0.3528); // mm → pt
      doc.text('GLUE', (Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, {
        align: 'center',
        baseline: 'middle',
        angle: vertical ? 90 : 0,
      });
    }
  }

  doc.setLineWidth(0.1);
  if (opts.foldMode === 'score') {
    doc.setDrawColor(...hex(COLORS.score));
    drawSegments(doc, folds);
  } else {
    doc.setDrawColor(...hex(COLORS.cut));
    drawSegments(doc, dashSegments(folds));
  }

  doc.setDrawColor(...hex(COLORS.cut));
  for (const c of chainSegments(cuts)) {
    const first = c[0];
    const last = c[c.length - 1];
    const closed = c.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-3;
    drawPoly(doc, closed ? c.slice(0, -1) : c, 'S', closed);
  }

  return doc.output('blob');
}
