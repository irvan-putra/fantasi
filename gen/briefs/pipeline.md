Write ONE Python 3 standard-library-only file: `build_data.py`.

It converts raw geodata in `data/` into compact web-ready JSON in `site/data/`.

Inputs (already on disk):
- `data/buildings_gpc.geojsonl` — one GeoJSON Feature per line (Microsoft IdMyPh building footprints, Polygon geometry, WGS84 degrees). ~12,700 features around Green Pramuka City, Jakarta.
- `data/roads.json` — already normalized: `{"features":[{"kind":"highway"|"railway"|"waterway", "name":string|null, "road_class":string|null, "line":[[lon,lat],...]}, ...]}` (3,616 ways from OpenStreetMap).

Outputs (create dirs as needed):
- `site/data/buildings.json` — `{"bbox":[w,s,e,n], "features":[[height, [[lon,lat],...]], ...]}`. Coordinates rounded to 6 decimals. Each ring simplified: drop a vertex when it moves the line less than ~1.5 m (perpendicular distance), keep rings valid (>=4 points, closed). `height` is an ESTIMATED building height in meters, deterministic from the footprint: base 3 m, plus a term growing with footprint area in m², plus a small stable jitter from a hash of the centroid; clamp 3–80 m. No randomness across runs.
- `site/data/roads.json` — pass `data/roads.json` through unchanged except: coordinates rounded to 6 decimals and lines simplified with the same ~1.5 m perpendicular-distance rule. Keep kind, name and road_class fields.
- Print a summary: counts in/out, output sizes in KB.

Rules: stdlib only (json, math, hashlib, os, sys). Stream the geojsonl line by line (do not load it all). Run as `python3 pipeline/build_data.py` from the repo root. No comments longer than one line. No external packages.
