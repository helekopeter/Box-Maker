import { jsPDF } from 'jspdf';
import { faceFrame, faceSize, renderArtwork } from '../artwork';
import { apply } from '../geometry/surface';
import { chainSegments, computeLines, dashSegments, type Segment } from '../geometry/lines';
import type { Appearance, Dieline, ExportOptions, Vec2 } from '../types';
import { curvesOf, restartLoop, stepsOf } from './curves';
import { COLORS } from './svg';

const hex = (c: string): [number, number, number] => {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** A cut line, with real curves where the dieline has them. */
function drawPath(doc: jsPDF, chain: Vec2[], closed: boolean, curves: ReturnType<typeof curvesOf>) {
  if (chain.length < 2) return;
  const pts = closed ? restartLoop(chain, curves) : chain;
  let at = pts[0];
  const ops = stepsOf(pts, curves).map(({ p, c }) => {
    const rel = (q: Vec2) => [q[0] - at[0], q[1] - at[1]];
    const op = c ? [...rel(c[0]), ...rel(c[1]), ...rel(p)] : rel(p);
    at = p;
    return op;
  });
  doc.lines(ops, pts[0][0], pts[0][1], [1, 1], 'S', closed);
}

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
  return buildPdfPages([{ dieline: d, look }], opts);
}

/** One page per sheet (e.g. several copies spread over laser-bed-sized sheets). */
export async function buildPdfPages(sheets: { dieline: Dieline; look: Appearance }[], opts: ExportOptions): Promise<Blob> {
  const first = sheets[0].dieline;
  const orientation = (d: Dieline) => (d.width > d.height ? 'landscape' : 'portrait');
  const doc = new jsPDF({ unit: 'mm', format: [first.width, first.height], orientation: orientation(first), compress: true });
  doc.setProperties({ title: `Box dieline ${Math.round(first.width)} × ${Math.round(first.height)} mm`, creator: 'Box Maker' });
  for (const [i, { dieline, look }] of sheets.entries()) {
    if (i) doc.addPage([dieline.width, dieline.height], orientation(dieline));
    await drawPage(doc, dieline, look, opts);
  }
  return doc.output('blob');
}

/**
 * A template for painting a texture: the sheet at its real size with the box's current look,
 * the cut and fold lines, the glue areas (hidden once folded) and each side's name, written
 * the right way up as it will be on the box. Paint over it, keep the page size, import it.
 */
export async function buildTemplatePdf(d: Dieline, look: Appearance): Promise<Blob> {
  const W = d.width;
  const H = d.height;
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: W > H ? 'landscape' : 'portrait', compress: true });
  doc.setProperties({ title: `Box texture template ${Math.round(W)} × ${Math.round(H)} mm`, creator: 'Box Maker' });
  const scale = Math.min(150 / 25.4, 5000 / Math.max(W, H));
  const canvas = await renderArtwork(d, look, { scale, preview: false });
  doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, W, H, undefined, 'FAST');

  const { cuts, folds } = computeLines(d);
  doc.saveGraphicsState();
  doc.setGState(doc.GState({ opacity: 0.3 }));
  doc.setFillColor(...hex(COLORS.glue));
  for (const p of d.panels) if (p.kind === 'glue') drawPoly(doc, p.poly, 'F', true);
  doc.restoreGraphicsState();

  // Side names, upright as on the box, with an arrow pointing up.
  doc.setTextColor(90, 90, 90);
  doc.setDrawColor(90, 90, 90);
  doc.setFillColor(90, 90, 90);
  for (const f of d.faces) {
    const { w, h } = faceSize(f);
    const size = Math.max(2.5, Math.min(12, Math.min(w, h) / 6));
    const m = faceFrame(f);
    const at = apply(m, [0, size * 0.6]);
    doc.setFontSize(size / 0.3528);
    doc.text(f.label, at[0], at[1], { align: 'center', baseline: 'middle', angle: -f.rotation });
    const tip = apply(m, [0, -size * 1.2]);
    const l = apply(m, [-size * 0.45, -size * 0.35]);
    const r = apply(m, [size * 0.45, -size * 0.35]);
    doc.triangle(tip[0], tip[1], l[0], l[1], r[0], r[1], 'F');
  }

  doc.setLineWidth(0.25);
  doc.setDrawColor(...hex(COLORS.score));
  doc.setLineDashPattern([2, 1.5], 0);
  drawSegments(doc, folds);
  doc.setLineDashPattern([], 0);
  doc.setDrawColor(...hex(COLORS.cut));
  const curves = curvesOf(d);
  for (const c of chainSegments(cuts)) {
    const first = c[0];
    const last = c[c.length - 1];
    drawPath(doc, c, c.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-3, curves);
  }
  doc.setFontSize(2.4 / 0.3528);
  doc.setTextColor(140, 140, 140);
  doc.text('Box Maker texture template: paint over this page (paint past the red lines), keep the page size, save as PNG or JPG and import it.', 2, H - 1.4);
  return doc.output('blob');
}

async function drawPage(doc: jsPDF, d: Dieline, look: Appearance, opts: ExportOptions) {
  const W = d.width;
  const H = d.height;

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
  const curves = curvesOf(d);
  for (const c of chainSegments(cuts)) {
    const first = c[0];
    const last = c[c.length - 1];
    const closed = c.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-3;
    drawPath(doc, c, closed, curves);
  }
}
