// Fantasi camera QA (fast, no raycasts). Run with: tools cloud_browser execute-js --script-file lab/tests/camtests.js
// on the live page. Per beat: pitch>50, cam (camera inside a roof/wall footprint: roofAt >= camera y),
// wall (camera within 3 m height of a roof at radius 3 or 7 m), clip (camera below a roof within 1.5 m radius).
// Props, lamps and folk: run near.js, solid checks and dyn.js (dragons, wyverns, ship, balloons) from this folder.
const F = window.__FOLK, by = {};
for (let ms = 0; ms < F.LOOP_MS; ms += 40) {
  const c = F.camAt(ms), t = F.KEYS[c.keyIdx].title, p = c.pos, l = c.look;
  const b = by[t] = by[t] || {n:0, pitchOver50:0, cam:0, wall:0, clip:0};
  b.n++;
  if (Math.atan2(p[1]-l[1], Math.hypot(l[0]-p[0], l[2]-p[2]) || 1) * 180/Math.PI > 50) b.pitchOver50++;
  if (F.roofAt(p[0], p[2]) >= p[1]) b.cam++;
  let wall = false, clip = false;
  for (let a = 0; a < 16; a++) for (const r of [1.5, 3, 7]) {
    const rf = F.roofAt(p[0] + Math.cos(a*Math.PI/8)*r, p[2] + Math.sin(a*Math.PI/8)*r);
    if (rf >= 0 && rf >= p[1] - 3) wall = true;
    if (rf >= 0 && r <= 1.5 && rf >= p[1] - 1.5) clip = true;
  }
  if (wall) b.wall++; if (clip) b.clip++;
}
return JSON.stringify(by);
