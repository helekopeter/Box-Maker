import { describe, expect, it } from 'vitest';
import { buildSvg } from '../src/export/svg';
import { generateDieline } from '../src/geometry/styles';
import type { Appearance } from '../src/types';

const d = generateDieline({ style: 'tuck', length: 100, width: 50, height: 120, thickness: 1.5, glueTab: 15, lidHeight: 30, lidClearance: 1 });
const look: Appearance = {
  color: '#336699',
  decals: [{ id: 'a', type: 'text', face: 'front', x: 0.5, y: 0.5, size: 8, rotation: 0, text: 'A & <B>', color: '#fff' }],
};

describe('buildSvg', () => {
  it('sizes the document in millimetres and separates layers', () => {
    const svg = buildSvg(d, look, { foldMode: 'score', includeArtwork: true, includeGlue: true });
    expect(svg).toContain(`width="${Math.round(d.width * 1000) / 1000}mm"`);
    for (const id of ['artwork', 'glue', 'fold', 'cut']) expect(svg).toContain(`id="${id}"`);
    expect(svg).toContain('stroke="#0000ff"');
    expect(svg).toContain('A &amp; &lt;B&gt;');
  });

  it('omits optional layers and uses red dashes for perforated folds', () => {
    const svg = buildSvg(d, look, { foldMode: 'perforate', includeArtwork: false, includeGlue: false });
    expect(svg).not.toContain('id="artwork"');
    expect(svg).not.toContain('id="glue"');
    expect(svg).not.toContain('#0000ff');
    expect(svg).not.toContain('stroke-dasharray');
  });
});
