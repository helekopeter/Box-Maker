import { BASE_ID, makeChild, newDesign, type AdvancedDesign } from '../advanced/model';
import type { Vec2 } from '../types';
import type { SharedBox } from './store';

/** A pentagonal box: a pentagon base, five walls and a glue tab on each wall. */
function pentagonBox(): AdvancedDesign {
  const d = newDesign();
  d.name = 'Pentagon box';
  d.color = '#2f6f8f';
  const side = 60;
  const R = side / (2 * Math.sin(Math.PI / 5));
  const pts: Vec2[] = Array.from({ length: 5 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    return [R + R * Math.cos(a), R + R * Math.sin(a)];
  });
  d.base = { width: 2 * R, height: 2 * R, points: pts, holes: [] };
  for (let e = 0; e < 5; e++) {
    const wall = makeChild(d, BASE_ID, e)!;
    wall.shape = { type: 'rect', depth: 50, taper0: 0, taper1: 0 };
    d.panels.push(wall);
    // A glue tab on the wall's side edge folds 72° to lie inside the next wall.
    const tab = makeChild(d, wall.id, 1)!;
    tab.kind = 'glue';
    tab.shape = { type: 'rect', depth: 10, taper0: 6, taper1: 6 };
    tab.inset0 = 2;
    tab.inset1 = 2;
    tab.angle = 72;
    tab.order = 1;
    tab.layer = -1;
    d.panels.push(tab);
  }
  return d;
}

/** An open tray whose walls have a folded-over rim. */
function rimTray(): AdvancedDesign {
  const d = newDesign();
  d.name = 'Tray with rolled rim';
  d.base = { width: 140, height: 90, holes: [] };
  for (let e = 0; e < 4; e++) {
    const wall = makeChild(d, BASE_ID, e)!;
    wall.shape = { type: 'rect', depth: 35, taper0: 0, taper1: 0 };
    d.panels.push(wall);
    // Rim folds over the top of the wall to the inside.
    const rim = makeChild(d, wall.id, 2)!;
    rim.kind = 'wall';
    rim.shape = { type: 'rect', depth: 12, taper0: 12, taper1: 12 };
    rim.angle = 180;
    rim.order = 2;
    rim.layer = -1;
    d.panels.push(rim);
  }
  return d;
}

const t = '2026-10-01T12:00:00.000Z';

export const EXAMPLES: SharedBox[] = [
  {
    id: 'ex-gable', created_at: t, example: true, kind: 'simple', thumbnail: '', tags: ['party', 'gift', 'handle'], likes: 0,
    name: 'Party favour box', author: 'Box Maker', description: 'Gable top with a carry handle.',
    data: { kind: 'simple', params: { style: 'gable', length: 80, width: 80, height: 90, thickness: 1, glueTab: 12, lidHeight: 30, lidClearance: 1 }, look: { color: '#ff94ec', decals: [] } },
  },
  {
    id: 'ex-rsc', created_at: t, example: true, kind: 'simple', thumbnail: '', tags: ['shipping', 'storage'], likes: 0,
    name: 'Moving box', author: 'Box Maker', description: 'Classic shipping carton in 4 mm double wall.',
    data: { kind: 'simple', params: { style: 'rsc', length: 300, width: 200, height: 150, thickness: 4, glueTab: 30, lidHeight: 30, lidClearance: 1 }, look: { color: '#c9a46b', decals: [] } },
  },
  {
    id: 'ex-sleeve', created_at: t, example: true, kind: 'simple', thumbnail: '', tags: ['gift', 'drawer'], likes: 0,
    name: 'Gift box with sleeve', author: 'Box Maker', description: 'A tray that slides into a sleeve.',
    data: { kind: 'simple', params: { style: 'matchbox', length: 120, width: 80, height: 30, thickness: 1.5, glueTab: 15, lidHeight: 30, lidClearance: 1, notches: false }, look: { color: '#222222', decals: [] } },
  },
  {
    id: 'ex-pentagon', created_at: t, example: true, kind: 'advanced', thumbnail: '', tags: ['gift', 'geometric'], likes: 0,
    name: 'Pentagon box', author: 'Box Maker', description: 'Drawn in Advanced: five walls with glue tabs at 72°.',
    data: { kind: 'advanced', design: pentagonBox() },
  },
  {
    id: 'ex-rim', created_at: t, example: true, kind: 'advanced', thumbnail: '', tags: ['tray', 'storage'], likes: 0,
    name: 'Tray with rolled rim', author: 'Box Maker', description: 'Drawn in Advanced: each wall has a rim folded 180° inwards.',
    data: { kind: 'advanced', design: rimTray() },
  },
];
