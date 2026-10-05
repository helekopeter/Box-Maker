import { it } from 'vitest';
import { cutThrough } from '../src/advanced/cutthrough';
import { sanitizeDesign, toDieline } from '../src/advanced/model';
import { chainSegments, computeLines } from '../src/geometry/lines';
import table from './fixtures/table.json';
it('x', () => {
  const d = sanitizeDesign(table)!;
  const before = chainSegments(computeLines(toDieline(d)).cuts);
  console.log('before', before.map((c) => c.length));
  cutThrough(d, 'khd65jh');
  const ch = chainSegments(computeLines(toDieline(d)).cuts);
  for (const c of ch) console.log(c.length, JSON.stringify(c.slice(0, 3).map((q) => q.map((v) => +v.toFixed(1)))), JSON.stringify(c[c.length - 1].map((v) => +v.toFixed(1))));
});
