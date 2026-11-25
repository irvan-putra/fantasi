# Demoscene techniques in fantasi (working notes)

Short public note on what we borrowed from the demoscene to keep this site small for
GitHub Pages and smooth on a mid-range phone (tested target: Galaxy A24). Fictional
content; nothing here is load-bearing documentation.

## What the demoscene does (sources)

- **Tiny inputs, big worlds.** 64 kB intros store only compact parameters (a few dozen
  control points) and generate geometry at runtime. Ctrl-Alt-Test describes building
  meshes from Catmull-Rom spline profiles spun into surfaces of revolution, using
  symmetry, then reusing the same generated meshes in variations across a demo.
  Source: <https://www.ctrl-alt-test.fr/2023/procedural-3d-mesh-generation-in-a-64kb-intro/>
- **Recompute, don't ship.** The size-coding wiki's effect notes favor closed-form math
  over stored assets: palettes, placements and motion derived from indices and time.
  Source: <http://www.sizecoding.org/wiki/Design_Tips_and_Demoscene_effects_with_pseudo_code>
- **Mobile GPUs need restraint.** Aras Pranckevicius' "Fast Mobile Shaders" (SIGGRAPH
  2011) and ARM's "Moving Mobile Graphics" (SIGGRAPH 2015) both stress: minimize draw
  calls, avoid full-screen post-processing passes, prefer cheap approximations
  (vertex/cheap-fragment work) over physically-based effects on tile-based mobile GPUs.
  Sources: <https://www.aras-p.info/texts/files/FastMobileShaders_siggraph2011.pdf>,
  <https://developer.arm.com/cfs-file/__key/communityserver-blogs-components-weblogfiles/00-00-00-20-66/siggraph2015_2D00_MovingMobileGraphics.pdf>
- **Synthesized audio.** Classic intros generate music at runtime instead of shipping
  samples; we took the same route with the Web Audio API (no audio files).
  Background: <http://www.sizecoding.org/wiki/4K_Intro>

## Which techniques fantasi actually uses

- **Procedural fantasy layer, zero binary assets.** Dragons, floating islands, landmark
  monuments and fireflies are generated at runtime from a few dozen numbers (positions,
  radii, phases, palette hexes). The whole fictional layer is ~18 kB of inline JS —
  nothing to download beyond the existing city tiles.
- **Deterministic variation from hashes.** Per-building roof colors come from
  `(index*7 + floor(height)*13) mod paletteSize` — the demoscene "derive from the
  index" trick. Firefly fields use a fixed seed, so every visit shows the same realm.
- **Cheap glow instead of bloom.** Dragon and firefly glow is MapLibre's `circle-blur`
  (a splatted sprite), not a post-processing pass — one draw call per layer, no
  framebuffers, which is what the mobile-GPU guidance above recommends avoiding.
- **Bounded draw calls.** The base engine already chunks the city into capped tile
  sources (max 80 live, LRU eviction) and merges per-chunk; agents (cars/people/buses,
  dragons, fireflies) are batched into single GeoJSON sources updated at ~15 Hz, not
  per frame.
- **Palette and mood as data.** The dusk-to-night arc is six atmosphere states
  (background/water/park colors + glow opacities) interpolated GPU-side via paint
  transitions — no per-frame JavaScript color work.
- **Generative score.** The ambient music is three detuned sine oscillators through a
  low-pass filter with a slow LFO, plus randomly scheduled pentatonic chimes; it
  brightens as night falls. It starts on the first user gesture because mobile
  browsers block autoplaying audio (platform policy, not a size limit).
- **Progressive detail over the network.** A small coarse tile set renders first;
  detail tiles stream in, retry with backoff on failure, and a "lite mode"
  (saveData/2G) skips road tiles and caps building tiles. This mirrors the demoscene
  habit of showing *something* correct early rather than a blank.

## Unverified / open

- Real-device frame rate on the Galaxy A24 is **not yet measured** — smoothness claims
  are based on the techniques above, not profiling.
- Slow-3G behavior was exercised by breaking tile URLs and by cold loads; a true
  throttled-network capture (e.g. Chrome DevTools Slow 3G) is still pending.
- The audio mix levels are untested on phone speakers.
