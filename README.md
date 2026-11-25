# kota — Jakarta at 1:1

A 3D building-footprint map of the Green Pramuka City area, Jakarta (2.6 x 2.9 km, 12,706 buildings), rendered in the browser with MapLibre GL. No build step, no tile server: static files + two compact JSON data files.

All substantive code (the data pipeline and the map viewer) was written by **GLM-5.3-Flash** served by [Fenrir](https://fenrir.lio.id), steered through a small driver harness (`gen/driver.py`) with briefs in `gen/briefs/`. Token spend is logged in `gen/ledger.jsonl`.

## Data

- Building footprints: [Microsoft IdMyPh Building Footprints](https://github.com/microsoft/IdMyPhBuildingFootprints) (ODbL). Building heights are **estimates**, derived deterministically from footprint geometry.
- Roads, railways, waterways: [OpenStreetMap](https://www.openstreetmap.org) contributors (ODbL), via Geofabrik.

## Layout

- `data/` raw extracted source data (GeoJSONL footprints, normalized roads)
- `pipeline/build_data.py` raw data -> compact web JSON (written by the model)
- `site/` the static map page (`index.html` written by the model, `data/` generated)
- `gen/` the generation harness, briefs and token ledger

## Run locally

    python3 pipeline/build_data.py   # regenerate site/data/*.json
    python3 -m http.server -d site 8000
