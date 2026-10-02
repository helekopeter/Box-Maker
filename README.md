# Box Maker

A small web app that generates laser-cutting files for cardboard boxes, with a live 3D preview.

1. **Pick a box style:** shipping box (FEFCO 0201), tuck-end box, open tray, or tray + lid.
2. **Enter the inside dimensions** (mm or inches) and pick the material thickness. Panels are enlarged automatically to make room for the material.
3. **Choose a colour and add decals** (text or uploaded images). Drag them around on the 3D box. A decal that hangs over an edge wraps onto the next side like a sticker. If the two sides aren't next to each other on the flat sheet (across the glue seam, a lid edge, or the two top flaps), it is split automatically in the cut file.
4. **Download an SVG or PDF.** The page is sized 1:1 to the sheet in millimetres.

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
- `src/geometry/fold.ts`: turns that tree into 3D transforms for any fold progress.
- `src/geometry/lines.ts`: derives cut and fold lines from the panels.
- `src/geometry/surface.ts`: works out which faces touch on the assembled box and how to unfold one next to another, for wrapping decals.
- `src/artwork.ts`: renders colour and decals, which are used as the 3D texture and the PDF artwork.
- `src/export/`: SVG and PDF writers.

`.github/workflows/pages.yml` deploys the app to GitHub Pages on every push to `main`. To use it, enable Pages with source "GitHub Actions" in the repository settings.
