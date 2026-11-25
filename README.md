# kota — Jakarta at 1:1

A 3D building-footprint map of the Green Pramuka City area, Jakarta (5.5 x 5.5 km, 44,795 buildings, 12,252 road segments), rendered in the browser with MapLibre GL. No build step, no tile server: static viewport tiles + a progressive viewer. Live tile payload: 9.2 MB.

All substantive code (the data pipeline, the tiler and the map viewer) was written by **GLM-5.3-Flash** served by [Fenrir](https://fenrir.lio.id), steered through a small driver harness (`gen/driver.py`) with briefs in `gen/briefs/`. Token spend is logged in `gen/ledger.jsonl`.

## Data

- Building footprints: [Microsoft IdMyPh Building Footprints](https://github.com/microsoft/IdMyPhBuildingFootprints) (ODbL). Building heights are **estimates**, derived deterministically from footprint geometry.
- Roads, railways, waterways: [OpenStreetMap](https://www.openstreetmap.org) contributors (ODbL), via Geofabrik.

## How it loads

- `site/tiles/b/` z15 building tiles, `site/tiles/r/` z14 road tiles, `site/tiles/c/` z12 coarse preview tiles, plus `index.json` (bbox, tile lists, counts).
- The viewer shows a baked poster first (`site/tiles/poster.jpg`), renders the tiny coarse tiles immediately, then fades full detail in; a progress bar tracks real tile fetches for the current viewport.
- `pipeline/build_tiles.py` (model-written, flag-driven) builds any bbox: `slice`, `roads`, `finalize`, `index`, `coarse` modes, each resumable and memory-bounded.

## Layout

- `data/` raw extracted source data (GeoJSONL footprints, normalized roads) — gitignored, regenerate from the IdMyPh Indonesia extract and the Geofabrik Java PBF
- `pipeline/build_tiles.py` raw data -> static tiles (written by the model)
- `site/` the static map page (`index.html` written by the model, `tiles/` generated)
- `gen/` the generation harness, briefs and token ledger

## Run locally

    python3 pipeline/build_tiles.py slice --buildings data/buildings_gp.geojsonl --parts-out site/tiles_part --bbox 106.8488,-6.2143,106.8988,-6.1643 --total-buildings 44797 --slice 0 --slices 1
    python3 pipeline/build_tiles.py roads --roads data/roads_gp.geojsonl --parts-out site/tiles_part --bbox 106.8488,-6.2143,106.8988,-6.1643
    python3 pipeline/build_tiles.py finalize --parts-out site/tiles_part --tiles-out site/tiles --finalize-slice 0 --finalize-slices 1
    python3 pipeline/build_tiles.py index --tiles-out site/tiles --parts-out site/tiles_part --bbox 106.8488,-6.2143,106.8988,-6.1643 --roads-count 12252
    python3 pipeline/build_tiles.py coarse --buildings data/buildings_gp.geojsonl --tiles-out site/tiles --bbox 106.8488,-6.2143,106.8988,-6.1643 --per-tile 400
    python3 -m http.server -d site 8000

## History

- Started as a 2.6 x 2.9 km Green Pramuka demo (12,706 buildings, two JSON data files).
- Extended to all of mainland Jakarta (DKI): 1,491,065 buildings + 306,254 road features (first tiled architecture).
- Extended to Greater Jakarta / Jabodetabek (bbox 106.35-107.25, -6.75--5.95): 4,662,955 buildings + 732,867 road features, 6,833 tiles (816 MB) — archived as tag `archive-greater-jakarta`, not served on the live branch.
- Refocused on Green Pramuka (5.5 x 5.5 km) for fast mobile loading, with the progressive viewer.

---

*Substantive code in this repo (data pipeline, tile builder, map viewer) was AI-written by zai/glm-5.3-flash served by Fenrir (promo credits from IDSW 2026), steered by Instinct. Total Fenrir spend: US$0.0434 (see `gen/ledger.jsonl`). AI-written; not fully reviewed by Irvan.*
