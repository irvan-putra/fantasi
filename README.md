# fantasi — Pramuka Astral · Pasar Lampion, a fantasy realm at 1:1

**Pramuka Astral — Pasar Lampion** is an invented fantasy realm draped over the real street layout of Green Pramuka City, Jakarta (~3 x 2.8 km, 12,706 real building footprints, 3,616 road segments), rendered as a directed dusk-to-night three.js flythrough. Everything is procedural and baked to static files: no build step at serve time, no tile server, no external CDN. Live payload: ~4.5 MB (3.85 MB baked geometry + vendored three.js).

The realm: 3,119 near buildings with lit windows and hip roofs plus ~9,500 instanced outer buildings, six invented landmarks (castle, prism tower, lantern market, temple, mist arena, lighthouse harbor), three named dragons, 130 floating sky lanterns, street lamps, glowing canal water, crystal clusters, festival crowds, a shader sky with stars and moon, and a synthesized ambient score. **Everything magical is fictional; the streets and footprints underneath are real.**

It opens by itself — an eight-beat cinematic (title cards, no buttons) tuned for a budget phone (Galaxy A24 class): ~39 draw calls, ~226k triangles, DPR capped.

Live: <https://vanipy.com/fantasi/> (old <https://vanipy.com/kota/> links redirect here). Style picker lab: <https://vanipy.com/fantasi/lab/style.html>.

Earlier builds are preserved as tags: `archive-real-green-pramuka` (daylight city viewer), `archive-greater-jakarta` (816 MB Jabodetabek build, not served), and the MapLibre fantasy v1 in gh-pages history before the v2 promotion.

Inspired by [Gabriel Chua's 1:1 Singapore flythrough](https://www.threads.com/share/FNCjS5T_A).

All substantive code (the data pipeline, the tiler, the viewers, the realm's creative direction) was written by AI models served by [Fenrir](https://fenrir.lio.id) — **GLM-5.3-Flash** for the original pipeline and viewer, **qwen3.8-27b** for the daylight redesign, the fantasy direction, the v2 film arc and creature modules — steered through a small driver harness (`gen/driver.py`) with briefs in `gen/briefs/`. Token spend is logged in `gen/ledger.jsonl`. AI-written and not fully reviewed. Techniques and sources: `docs/procedural-demoscene-notes.md`.

## v2 scene pipeline

- `site/v2/` the baked realm: `manifest.json` (sections, camera beats, prop placements) + `scene.bin` (packed Float32/Uint8 geometry) + `app.js` + vendored three.js
- The bake script triangulates real footprints (Douglas-Peucker simplified), extrudes stylized heights, assigns a jewel palette, splits near/detail vs far/instanced LOD by distance to the camera path, and places props with a seeded RNG

## v1 data pipeline (historical)

- `site/tiles/` z15 building tiles, z14 road tiles, z12 coarse preview tiles, plus `index.json` and the poster
- `pipeline/build_tiles.py` (model-written, flag-driven) builds any bbox: `slice`, `roads`, `finalize`, `index`, `coarse` modes, each resumable and memory-bounded

## Data

- Building footprints: [Microsoft IdMyPh Building Footprints](https://github.com/microsoft/IdMyPhBuildingFootprints) (ODbL). Building heights are **estimates**, derived deterministically from footprint geometry.
- Roads, waterways, green areas: [OpenStreetMap](https://www.openstreetmap.org) contributors (ODbL), via Geofabrik.
