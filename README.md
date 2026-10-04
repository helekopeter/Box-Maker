# Box Maker

A small web app that generates laser-cutting files for cardboard boxes, with a live 3D preview. It has four tabs.

## Simple

1. **Pick a box style:**
   - Shipping box (FEFCO 0201 slotted carton)
   - Straight tuck end
   - Reverse tuck end
   - Snap-lock (1-2-3) bottom
   - Auto-lock (crash-lock) bottom
   - Seal end
   - Gable top with handle
   - Open tray
   - Tray + lid
   - Tray + sleeve
2. **Enter the inside dimensions** (mm or inches) and pick the material: paper, thin card, cardboard, grey board, corrugated or double wall, or a custom thickness. Panels are enlarged automatically to make room for the material.
3. **Choose a colour and add decals** (text or uploaded images). Drag them around on the 3D box. A decal that hangs over an edge wraps onto the next side like a sticker. If the two sides aren't next to each other on the flat sheet (across the glue seam, a lid edge, or the two top flaps), it is split automatically in the cut file.
4. **Download an SVG or PDF.** The page is sized 1:1 to the sheet in millimetres. Set your **laser bed** size under Export (it's shared by every tab), and each tab warns when the cutting layout won't fit.

**Edit in Advanced** turns the current box into an Advanced design, keeping every panel, fold, colour and decal, so you can keep changing it freehand. For two-piece boxes only the tray carries over.

## Shape Maker

Build a simple 3D shape and get the box for it.

1. **Pick a base shape:** rectangle, triangle, pentagon, hexagon, octagon or round. Round shapes are made of flat sides; you choose how many.
2. **Extrude it** in one or more levels. Each level has a height and a top size: below 100% narrows it, above 100% widens it, and 0% brings it to a point, like a roof.
3. **Choose a closed lid or an open top**, plus material and colour.

The 3D view shows the folded box live, with its cutting layout below. The solid is unfolded into a net with:
- a fold angle on every fold
- a glue tab on every seam
- tabs under the lid

It first tries the walls around the base; if they would overlap on the sheet, it lays them out in a strip instead. **Make box in Advanced** opens the result in the Advanced tab for further editing.

## Advanced

Draw a box from scratch. You start with a single square (the base, which lies on the table).

- **Add panels:** click **+** on any free edge of the base or a wall to add a wall (off the base) or a flap (off a wall). Walls are structural and can carry more panels; flaps and glue tabs are end pieces, so they have no **+**.
- **Edit a panel:** select it to set its depth, how much it narrows at each end (symmetric by default; hold Shift while dragging a corner handle to move one side), its inset along the edge, and its type (wall, flap or glue tab). You can also drag its orange handles.
- **Fold angle:** positive folds inwards, negative outwards; there are quick presets for 90° in, 90° out, flat and 180° over. **Fold order** sets what folds first, and **layer** decides which panel ends up on top where panels overlap once folded (it's ignored for panels that don't lie against anything).
- **Pen tool (P):** click a free edge, click some points, then click the same edge again to make a free-form flap.
- **Cut-out tool (C):** click inside a panel, draw a shape, and click the first point again (or press Enter).
- **Free-form shape:** turns any panel, including the base, into editable corners. Drag them, double-click an edge to add a corner, and select a corner and press Delete to remove it.
- **Undo/redo** with Ctrl+Z and Ctrl+Shift+Z. Tools are at the top left of the design panel; snapping, zoom and Fit at the top right.
- Panels that would overlap on the sheet are shown in red.
- Decals go on rectangular walls.

## Box Universe

A gallery of shared boxes. **Share** (top right) saves the current box with a 3D thumbnail. From the gallery, anyone can open it in the tab it was made in, download its SVG, or save it as a `.box.json` file that can be imported again.

By default the gallery lives in each visitor's browser (plus a few built-in examples). To make it shared between everyone, connect a free [Supabase](https://supabase.com) project:

1. Create a project and run this in its SQL editor:

   ```sql
   create table public.boxes (
     id uuid primary key default gen_random_uuid(),
     created_at timestamptz not null default now(),
     name text not null check (char_length(name) between 1 and 80),
     author text not null default 'Anonymous' check (char_length(author) <= 40),
     description text not null default '' check (char_length(description) <= 500),
     kind text not null check (kind in ('simple', 'advanced')),
     data jsonb not null check (pg_column_size(data) < 2000000),
     thumbnail text not null default '' check (char_length(thumbnail) < 400000)
   );
   alter table public.boxes enable row level security;
   create policy "Anyone can read boxes" on public.boxes for select using (true);
   create policy "Anyone can share a box" on public.boxes for insert with check (true);
   ```

2. Give the build the project URL and the **anon** (public) key:
   - **Locally:** put them in `.env.local` as `VITE_SUPABASE_URL=…` and `VITE_SUPABASE_ANON_KEY=…`.
   - **For GitHub Pages:** add them as repository *variables* named `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Settings → Secrets and variables → Actions → Variables).

The anon key is meant to be public. The security comes from the row-level security above, which lets visitors read and add boxes but not change or delete them. Everything loaded from the gallery is validated before use: decal images must be inline, and text is never rendered as HTML. Uploads are anonymous, so for a public site you may want moderation or rate limits (Supabase can add these later).

## Output layers

| Layer | Colour | Meaning |
|---|---|---|
| Cut | red `#ff0000`, 0.1 mm | cut through |
| Fold (score) | blue `#0000ff` | low-power score line |
| Fold (perforate) | red dashes | cut as a perforation instead of scoring |
| Glue | green fill, labelled "GLUE" | apply glue here (do not cut) |
| Artwork | colour + decals | optional, for printing or engraving |

In the SVG each of these is its own Inkscape layer. Cut lines are joined into continuous paths, so the laser pierces fewer times.

## Development

```sh
npm install
npm run dev      # start the dev server
npm test         # geometry + export tests
npm run build    # production build in dist/
```

The project uses Vite, TypeScript and three.js, with jsPDF for PDF export (loaded only when you export a PDF).

- `src/geometry/styles.ts`: dieline generators. Each box is a tree of panels joined by hinges.
- `src/geometry/cartons.ts`: folding cartons, built from a four-wall body plus a closure at each end (tuck, seal, snap-lock, auto-lock, gable).
- `src/geometry/fold.ts`: turns that tree into 3D transforms for any fold progress.
- `src/geometry/lines.ts`: derives cut and fold lines from the panels.
- `src/main.ts`: the tab shell. `src/simple.ts` is the Simple tab, `src/advanced/` the editor (`model.ts` is the design format, `convert.ts` converts Simple boxes, `editor.ts` is the 2D editor), and `src/universe/` the gallery and its storage.
- `src/geometry/surface.ts`: works out which faces touch on the assembled box and how to unfold one next to another, for wrapping decals.
- `src/artwork.ts`: renders colour and decals, which are used as the 3D texture and the PDF artwork.
- `src/export/`: SVG and PDF writers.

`.github/workflows/pages.yml` deploys the app to GitHub Pages on every push to `main`. To use it, enable Pages with source "GitHub Actions" in the repository settings.
