```python pipeline/build_tiles.py
import hashlib
import json
import math
import os
import shutil
import sys
import time

BUILD_Z = 15
ROAD_Z = 14
COARSE_Z = 12
SIMPLIFY_TOL_M = 1.5
COARSE_SIMPLIFY_TOL_M = 4.0
K = math.pi * 6378137.0 / 180.0
MAX_LAT = 85.05112878
MAX_OPEN_FILES = 64


def estimate_height(area_m2, lon_c, lat_c):
    seed = f"{lon_c:.6f},{lat_c:.6f}".encode("utf-8")
    u = int(hashlib.sha256(seed).hexdigest()[:8], 16)
    jitter = (u % 2000) / 1000.0 - 1.0
    h = 3.0 + 0.45 * math.sqrt(area_m2) + jitter
    return round(min(80.0, max(3.0, h)), 1)


def lonlat_to_tile(lon, lat, z):
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    n = 1 << z
    x = math.floor((lon + 180.0) / 360.0 * n)
    latr = math.radians(lat)
    y = math.floor((1.0 - math.log(math.tan(latr) + 1.0 / math.cos(latr)) / math.pi) / 2.0 * n)
    return x, min(n - 1, max(0, y)), min(n - 1, max(0, x))


def tile_bbox(x, y, z):
    n = 1 << z
    lon1 = x / n * 360.0 - 180.0
    lon2 = (x + 1) / n * 360.0 - 180.0
    def lat_of(yn):
        return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * yn / n))))
    return lon1, lat_of(y + 1), lon2, lat_of(y)


def dedupe_ring(ring):
    seen = []
    out = []
    last = None
    for p in ring:
        q = (round(p[0], 9), round(p[1], 9))
        if q != last:
            out.append((p[0], p[1]))
            last = q
    if len(out) >= 2:
        a, b = out[0], out[-1]
        if abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9:
            out.pop()
    return out


def perpendicular_distance(px, py, ax, ay, bx, by):
    dx = bx - ax
    dy = by - ay
    den = math.hypot(dx, dy)
    if den == 0.0:
        return math.hypot(px - ax, py - ay)
    return abs(dy * (px - ax) - dx * (py - ay)) / den


def douglas_peucker(pts, tol, ref_lat):
    cosl = math.cos(math.radians(ref_lat))
    n = len(pts)
    if n < 3:
        return pts[:]
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        ax, ay = pts[i0]
        bx, by = pts[i1]
        axm, aym = ax * K * cosl, ay * K
        bxm, bym = bx * K * cosl, by * K
        dmax = -1.0
        imax = -1
        for i in range(i0 + 1, i1):
            px, py = pts[i]
            pxm, pym = px * K * cosl, py * K
            d = perpendicular_distance(pxm, pym, axm, aym, bxm, bym)
            if d > dmax:
                dmax = d
                imax = i
        if dmax > tol:
            keep[imax] = True
            stack.append((i0, imax))
            stack.append((imax, i1))
    return [pts[i] for i in range(n) if keep[i]]


def simplify_ring(ring, tol):
    ring = dedupe_ring(ring)
    if len(ring) < 3:
        return None
    ref_lat = sum(p[1] for p in ring) / len(ring)
    simp = douglas_peucker(ring, tol, ref_lat)
    if len(simp) < 4:
        # keep at least 4 points incl. closing point
        n = len(simp)
        if n >= 3:
            simp = [ring[0], ring[len(ring) // 3], ring[2 * len(ring) // 3], ring[0]]
        else:
            return None
    # ensure closed
    if abs(simp[0][0] - simp[-1][0]) > 1e-9 or abs(simp[0][1] - simp[-1][1]) > 1e-9:
        simp.append(simp[0])
    if len(simp) < 4:
        return None
    return simp


def ring_area_centroid(ring):
    ref = ring[0]
    cosl = math.cos(math.radians(ref[1]))
    pts = [((p[0] - ref[0]) * K * cosl, (p[1] - ref[1]) * K) for p in ring]
    a2 = 0.0
    cx = 0.0
    cy = 0.0
    n = len(pts)
    for i in range(n - 1):
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        cross = x1 * y2 - x2 * y1
        a2 += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    area = abs(a2) / 2.0
    if area <= 0.0:
        return None
    cx /= (3.0 * a2)
    cy /= (3.0 * a2)
    lon_c = cx / (K * cosl) + ref[0]
    lat_c = cy / K + ref[1]
    return area, lon_c, lat_c


def r6(v):
    return round(v, 6)


class HandleCache:
    """LRU cache of open append-mode file handles (at most MAX_OPEN_FILES)."""

    def __init__(self, root, sub):
        self.root = root
        self.sub = sub
        self.handles = {}  # (x, y) -> file object
        self.order = []    # least-recently-used first

    def get(self, x, y):
        key = (x, y)
        h = self.handles.get(key)
        if h is not None:
            self.order.remove(key)
            self.order.append(key)
            return h
        if len(self.handles) >= MAX_OPEN_FILES:
            old = self.order.pop(0)
            self.handles.pop(old).close()
        d = os.path.join(self.root, self.sub, str(x))
        os.makedirs(d, exist_ok=True)
        h = open(os.path.join(d, str(y) + ".jsonl"), "a", encoding="utf-8")
        self.handles[key] = h
        self.order.append(key)
        return h

    def close_all(self):
        for h in self.handles.values():
            h.close()
        self.handles.clear()
        self.order.clear()


def parse_flags(argv, spec):
    """Parse '--name value' flags (any order) into a dict per spec.

    spec: name -> "int" | "float" | "str" | "bbox" | "float"
    Returns dict; missing flags are absent from the dict.
    """
    flags = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if not a.startswith("--"):
            print("unexpected argument: " + a, file=sys.stderr)
            sys.exit(2)
        name = a[2:]
        if name not in spec:
            print("unknown flag: --" + name, file=sys.stderr)
            sys.exit(2)
        if name == "bbox":
            parts = argv[i + 1].split(",")
            if len(parts) != 4:
                print("--bbox must be W,S,E,N", file=sys.stderr)
                sys.exit(2)
            flags[name] = [float(p) for p in parts]
            i += 2
            continue
        kind = spec[name]
        raw = argv[i + 1]
        if kind == "int":
            flags[name] = int(raw)
        elif kind == "float":
            flags[name] = float(raw)
        else:
            flags[name] = raw
        i += 2
    return flags


def list_fragment_tiles(root):
    """Collect distinct (x, y) fragment tiles under root/<sub>, sorted."""
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        for fname in filenames:
            if not fname.endswith(".jsonl"):
                continue
            xdir = os.path.basename(dirpath)
            try:
                tx = int(xdir)
                ty = int(fname.split(".")[0])
            except ValueError:
                continue
            out.append((tx, ty))
    out.sort()
    return out


def slice_range(length, index, slices):
    step = (length + slices - 1) // slices
    return index * step, (index + 1) * step


def cmd_slice(flags):
    buildings_in = flags["buildings"]
    parts_out = flags["parts-out"]
    total_buildings = flags["total-buildings"]
    i = flags["slice"]
    n = flags["slices"]
    start, end = slice_range(total_buildings, i, n)
    os.makedirs(parts_out, exist_ok=True)
    handles = HandleCache(parts_out, "b")
    dumps = json.dumps
    processed = 0
    tile_counts = {}
    t0 = time.time()
    with open(buildings_in, "r", encoding="utf-8") as f:
        # skip lines [0, start)
        skipped = 0
        for line in f:
            skipped += 1
            if skipped >= start:
                break
        # process lines [start, end)
        for line in f:
            if start + processed >= end:
                break
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            try:
                ring_raw = feat["geometry"]["coordinates"][0]
            except (KeyError, IndexError, TypeError):
                processed += 1
                continue
            ring = simplify_ring(ring_raw, SIMPLIFY_TOL_M)
            if ring is None:
                processed += 1
                continue
            ac = ring_area_centroid(ring)
            if ac is None:
                processed += 1
                continue
            area_m2, lon_c, lat_c = ac
            height = estimate_height(area_m2, lon_c, lat_c)
            tx, ty, _ = lonlat_to_tile(lon_c, lat_c, BUILD_Z)
            rec = dumps(
                [height, [[r6(x), r6(y)] for x, y in ring]],
                separators=(",", ":"),
            )
            h = handles.get(tx, ty)
            h.write(rec)
            h.write("\n")
            tile_counts[(tx, ty)] = tile_counts.get((tx, ty), 0) + 1
            processed += 1
    handles.close_all()
    with open(os.path.join(parts_out, "b_manifest.jsonl"), "a", encoding="utf-8") as mf:
        for (tx, ty), cnt in sorted(tile_counts.items()):
            mf.write(dumps({"x": tx, "y": ty, "n": cnt}, separators=(",", ":")))
            mf.write("\n")
    elapsed = time.time() - t0
    print("slice " + str(i) + ": " + str(processed) + " buildings in " + format(elapsed, ".1f") + "s")


def cmd_roads(flags):
    roads_in = flags["roads"]
    parts_out = flags["parts-out"]
    os.makedirs(parts_out, exist_ok=True)
    handles = HandleCache(parts_out, "r")
    dumps = json.dumps
    processed = 0
    tile_counts = {}
    t0 = time.time()
    with open(roads_in, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            line_pts = feat.get("line")
            if not line_pts:
                continue
            lons = [p[0] for p in line_pts]
            lats = [p[1] for p in line_pts]
            lo, hi = min(lons), max(lons)
            la, hb = min(lats), max(lats)
            x0, y1, _ = lonlat_to_tile(lo, hb, ROAD_Z)  # NW corner
            x1, y0, _ = lonlat_to_tile(hi, la, ROAD_Z)  # SE corner
            out_line = [[r6(p[0]), r6(p[1])] for p in line_pts]
            rec = dumps(
                {
                    "id": feat["id"],
                    "kind": feat["kind"],
                    "road_class": feat["road_class"],
                    "name": feat["name"],
                    "line": out_line,
                },
                separators=(",", ":"),
            )
            for tx in range(x0, x1 + 1):
                for ty in range(y0, y1 + 1):
                    bx0, by0, bx1, by1 = tile_bbox(tx, ty, ROAD_Z)
                    if hi < bx0 or lo > bx1 or hb < by0 or la > by1:
                        continue
                    h = handles.get(tx, ty)
                    h.write(rec)
                    h.write("\n")
                    tile_counts[(tx, ty)] = tile_counts.get((tx, ty), 0) + 1
            processed += 1
    handles.close_all()
    with open(os.path.join(parts_out, "r_manifest.jsonl"), "a", encoding="utf-8") as mf:
        for (tx, ty), cnt in sorted(tile_counts.items()):
            mf.write(dumps({"x": tx, "y": ty, "n": cnt}, separators=(",", ":")))
            mf.write("\n")
    elapsed = time.time() - t0
    print("roads processed: " + str(processed) + " in " + format(elapsed, ".1f") + "s")


def write_tile(tiles_out, sub, x, y, payload):
    d = os.path.join(tiles_out, sub, str(x))
    os.makedirs(d, exist_ok=True)
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    with open(os.path.join(d, str(y) + ".json"), "wb") as out:
        out.write(data)


def cmd_finalize(flags):
    parts_out = flags["parts-out"]
    tiles_out = flags["tiles-out"]
    j = flags["finalize-slice"]
    k = flags["finalize-slices"]
    os.makedirs(os.path.join(tiles_out, "b"), exist_ok=True)
    os.makedirs(os.path.join(tiles_out, "r"), exist_ok=True)

    b_all = list_fragment_tiles(os.path.join(parts_out, "b"))
    r_all = list_fragment_tiles(os.path.join(parts_out, "r"))
    b_start, b_end = slice_range(len(b_all), j, k)
    r_start, r_end = slice_range(len(r_all), j, k)
    b_tiles = b_all[b_start:b_end]
    r_tiles = r_all[r_start:r_end]

    t0 = time.time()

    for tx, ty in b_tiles:
        path = os.path.join(parts_out, "b", str(tx), str(ty) + ".jsonl")
        feats = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                feats.append(json.loads(line))
        if not feats:
            continue
        write_tile(tiles_out, "b", tx, ty, {"z": BUILD_Z, "x": tx, "y": ty, "features": feats})
        del feats

    for tx, ty in r_tiles:
        path = os.path.join(parts_out, "r", str(tx), str(ty) + ".jsonl")
        feats = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                feats.append(json.loads(line))
        if not feats:
            continue
        write_tile(tiles_out, "r", tx, ty, {"z": ROAD_Z, "x": tx, "y": ty, "features": feats})
        del feats

    elapsed = time.time() - t0
    print(
        "finalize " + str(j)
        + ", building tiles: " + str(len(b_tiles))
        + ", road tiles: " + str(len(r_tiles))
        + " in " + format(elapsed, ".1f") + "s"
    )


def list_tile_files(root):
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        for fname in filenames:
            if not fname.endswith(".json"):
                continue
            xdir = os.path.basename(dirpath)
            try:
                tx = int(xdir)
                ty = int(fname.split(".")[0])
            except ValueError:
                continue
            out.append((tx, ty))
    out.sort()
    return out


def cmd_coarse(flags):
    import heapq

    buildings_in = flags["buildings"]
    tiles_out = flags["tiles-out"]
    per_tile = flags["per-tile"]

    # bounded heap per coarse tile: (area, seq, height, ring); never the full set
    heaps = {}
    seq = 0
    t0 = time.time()
    with open(buildings_in, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            try:
                ring_raw = feat["geometry"]["coordinates"][0]
            except (KeyError, IndexError, TypeError):
                continue
            ring = simplify_ring(ring_raw, COARSE_SIMPLIFY_TOL_M)
            if ring is None:
                continue
            ac = ring_area_centroid(ring)
            if ac is None:
                continue
            area_m2, lon_c, lat_c = ac
            height = estimate_height(area_m2, lon_c, lat_c)
            tx, ty, _ = lonlat_to_tile(lon_c, lat_c, COARSE_Z)
            h = heaps.get((tx, ty))
            if h is None:
                h = []
                heaps[(tx, ty)] = h
            entry = (area_m2, seq, height, ring)
            seq += 1
            if len(h) < per_tile:
                heapq.heappush(h, entry)
            elif area_m2 > h[0][0]:
                heapq.heapreplace(h, entry)

    kept = 0
    tile_count = 0
    for (tx, ty), h in heaps.items():
        if not h:
            continue
        feats = []
        for _area, _seq, height, ring in sorted(h, key=lambda e: -e[0]):
            feats.append([height, [[r6(x), r6(y)] for x, y in ring]])
        write_tile(tiles_out, "c", tx, ty, {"z": COARSE_Z, "x": tx, "y": ty, "features": feats})
        kept += len(feats)
        tile_count += 1

    elapsed = time.time() - t0
    print(
        "coarse tiles: " + str(tile_count)
        + ", features kept: " + str(kept)
        + " in " + format(elapsed, ".1f") + "s"
    )


def cmd_index(flags):
    tiles_out = flags["tiles-out"]
    parts_out = flags["parts-out"]
    W, S, E, N = flags["bbox"]
    roads_count = flags["roads-count"]

    b_tiles = list_tile_files(os.path.join(tiles_out, "b"))
    r_tiles = list_tile_files(os.path.join(tiles_out, "r"))

    b_count = 0
    manifest = os.path.join(parts_out, "b_manifest.jsonl")
    if os.path.isfile(manifest):
        with open(manifest, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                b_count += json.loads(line)["n"]

    index = {
        "bbox": [W, S, E, N],
        "buildings": {
            "z": BUILD_Z,
            "tiles": [[x, y] for x, y in b_tiles],
            "count": b_count,
        },
        "roads": {
            "z": ROAD_Z,
            "tiles": [[x, y] for x, y in r_tiles],
            "count": roads_count,
        },
        "heights": "estimated",
    }

    c_root = os.path.join(tiles_out, "c")
    if os.path.isdir(c_root):
        c_tiles = list_tile_files(c_root)
        c_count = 0
        for tx, ty in c_tiles:
            path = os.path.join(c_root, str(tx), str(ty) + ".json")
            try:
                with open(path, "r", encoding="utf-8") as f:
                    c_count += len(json.load(f).get("features", []))
            except (OSError, ValueError):
                pass
        index["coarse"] = {
            "z": COARSE_Z,
            "tiles": [[x, y] for x, y in c_tiles],
            "count": c_count,
        }

    idx_path = os.path.join(tiles_out, "index.json")
    data = json.dumps(index, separators=(",", ":")).encode("utf-8")
    with open(idx_path, "wb") as f:
        f.write(data)

    shutil.rmtree(parts_out, ignore_errors=True)

    total_bytes = len(data)
    max_tile_bytes = 0
    for sub in ("b", "r", "c"):
        root = os.path.join(tiles_out, sub)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            for fname in filenames:
                sz = os.path.getsize(os.path.join(dirpath, fname))
                total_bytes += sz
                if sz > max_tile_bytes:
                    max_tile_bytes = sz

    print(
        "total written: " + format(total_bytes / (1024.0 * 1024.0), ".1f") + " MB, "
        + "largest tile: " + format(max_tile_bytes / 1024.0, ".1f") + " KB"
    )


def main():
    argv = sys.argv[1:]
    if not argv:
        print(
            "usage: build_tiles.py slice --buildings PATH --parts-out DIR --bbox W,S,E,N "
            "--total-buildings N --slice I --slices M | "
            "build_tiles.py roads --roads PATH --parts-out DIR --bbox W,S,E,N | "
            "build_tiles.py finalize --parts-out DIR --tiles-out DIR --finalize-slice J --finalize-slices K | "
            "build_tiles.py coarse --buildings PATH --tiles-out DIR --bbox W,S,E,N --per-tile N | "
            "build_tiles.py index --tiles-out DIR --parts-out DIR --bbox W,S,E,N --roads-count M",
            file=sys.stderr,
        )
        sys.exit(2)
    cmd = argv[0]
    rest = argv[1:]
    if cmd == "slice":
        flags = parse_flags(rest, {
            "buildings": "str",
            "parts-out": "str",
            "bbox": "bbox",
            "total-buildings": "int",
            "slice": "int",
            "slices": "int",
        })
        for req in ("buildings", "parts-out", "bbox", "total-buildings", "slice", "slices"):
            if req not in flags:
                print("missing flag: --" + req, file=sys.stderr)
                sys.exit(2)
        cmd_slice(flags)
    elif cmd == "roads":
        flags = parse_flags(rest, {
            "roads": "str",
            "parts-out": "str",
            "bbox": "bbox",
        })
        for req in ("roads", "parts-out", "bbox"):
            if req not in flags:
                print("missing flag: --" + req, file=sys.stderr)
                sys.exit(2)
        cmd_roads(flags)
    elif cmd == "finalize":
        flags = parse_flags(rest, {
            "parts-out": "str",
            "tiles-out": "str",
            "finalize-slice": "int",
            "finalize-slices": "int",
        })
        for req in ("parts-out", "tiles-out", "finalize-slice", "finalize-slices"):
            if req not in flags:
                print("missing flag: --" + req, file=sys.stderr)
                sys.exit(2)
        cmd_finalize(flags)
    elif cmd == "coarse":
        flags = parse_flags(rest, {
            "buildings": "str",
            "tiles-out": "str",
            "bbox": "bbox",
            "per-tile": "int",
        })
        for req in ("buildings", "tiles-out", "bbox", "per-tile"):
            if req not in flags:
                print("missing flag: --" + req, file=sys.stderr)
                sys.exit(2)
        cmd_coarse(flags)
    elif cmd == "index":
        flags = parse_flags(rest, {
            "tiles-out": "str",
            "parts-out": "str",
            "bbox": "bbox",
            "roads-count": "int",
        })
        for req in ("tiles-out", "parts-out", "bbox", "roads-count"):
            if req not in flags:
                print("missing flag: --" + req, file=sys.stderr)
                sys.exit(2)
        cmd_index(flags)
    else:
        print("unknown command: " + cmd, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
```

```html site/index.html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#070b13">
<meta name="description" content="A 1:1 3D map of Greater Jakarta (Jabodetabek) — MapLibre, tiled, every block a real building.">
<title>kota — Jakarta at 1:1</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@3.6.2/dist/maplibre-gl.css">
<style>
  :root{
    --bg:#070b13;
    --ink:#e9eef7;
    --muted:#a3b1c7;
    --faint:#6d7d95;
    --amber:#f0a84b;
    --line:rgba(148,170,205,.16);
    --glass:rgba(9,13,21,.8);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;
    background:var(--bg);
    color:var(--ink);
    overflow:hidden;
    overscroll-behavior:none;
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  #map{position:fixed;inset:0}
  .maplibregl-canvas{outline:none}
  .maplibregl-canvas-container{cursor:grab}
  .maplibregl-canvas-container:active{cursor:grabbing}
  #poster{
    position:fixed;inset:0;width:100%;height:100%;
    object-fit:cover;z-index:2;pointer-events:none;
    background:var(--bg);
    transition:opacity .6s ease;
  }
  #vignette{
    position:fixed;inset:0;z-index:5;pointer-events:none;
    background:radial-gradient(130% 100% at 50% 38%,transparent 52%,rgba(3,6,11,.5) 100%);
  }
  #progress{
    position:fixed;top:0;left:0;height:3px;width:0;
    background:var(--amber);z-index:40;pointer-events:none;
    width:0;opacity:0;
    transition:width .2s ease,opacity .4s ease;
  }

  /* stats chip */
  #counter{
    position:fixed;top:max(10px,env(safe-area-inset-top,0px));right:10px;z-index:20;
    max-width:min(80vw,300px);text-align:right;
    background:var(--glass);border:1px solid var(--line);border-radius:12px;
    padding:7px 11px;font-size:11px;line-height:1.45;color:var(--muted);
    font-variant-numeric:tabular-nums;
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  }
  #counter b{color:var(--ink);font-weight:600}
  #counter .src{display:block;font-size:8.5px;letter-spacing:.02em;color:#5d6c85;margin-top:2px}

  /* tour */
  #tour{
    position:fixed;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:25;
    display:inline-flex;align-items:center;gap:7px;
    background:var(--glass);border:1px solid var(--line);border-radius:999px;color:var(--ink);
    font-family:inherit;font-size:13px;font-weight:600;padding:10px 16px;cursor:pointer;
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    opacity:0;pointer-events:none;transform:translateY(8px);
    transition:opacity .3s ease,transform .3s ease,color .3s ease,border-color .3s ease;
  }
  #tour.show{opacity:1;pointer-events:auto;transform:none}
  #tour.active{color:var(--amber);border-color:rgba(240,168,75,.5)}
  #tourlabel{
    position:fixed;left:50%;bottom:calc(72px + env(safe-area-inset-bottom,0px));z-index:22;
    transform:translateX(-50%) translateY(6px);
    background:var(--glass);border:1px solid var(--line);border-radius:999px;
    padding:7px 14px;font-size:12px;color:var(--ink);
    white-space:nowrap;max-width:88vw;overflow:hidden;text-overflow:ellipsis;
    opacity:0;pointer-events:none;
    transition:opacity .3s ease,transform .3s ease;
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  }
  #tourlabel.show{opacity:1;transform:translateX(-50%)}

  /* start card */
  #card{
    position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));
    transform:translateX(-50%);z-index:30;
    width:min(370px,calc(100vw - 24px));
    max-height:min(72vh,520px);overflow-y:auto;
    background:var(--glass);border:1px solid var(--line);border-radius:16px;
    padding:16px 16px 14px;
    box-shadow:0 18px 50px rgba(0,0,0,.55);
    backdrop-filter:blur(14px) saturate(1.15);-webkit-backdrop-filter:blur(14px) saturate(1.15);
    transition:opacity .35s ease,transform .35s ease;
  }
  #card.hidden{opacity:0;transform:translateX(-50%) translateY(14px);pointer-events:none}
  #card .kicker{margin:0 0 7px;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--amber)}
  #card h1{margin:0 0 8px;font-family:Georgia,"Times New Roman",serif;font-weight:600;font-size:21px;line-height:1.25}
  #card p{margin:0 0 9px;font-size:13px;line-height:1.55;color:var(--muted)}
  #card .note{font-size:11.5px;color:#e2b568}
  #card .credit{font-size:11px;color:var(--faint)}
  #card .fineprint{font-size:9.5px;line-height:1.5;color:#5d6c85;margin:10px 0 0}
  #dismiss{
    margin-top:12px;width:100%;appearance:none;border:0;border-radius:10px;
    background:var(--amber);color:#1a1108;font-family:inherit;font-size:13.5px;font-weight:700;
    padding:11px 14px;cursor:pointer;
  }
  #dismiss:hover{filter:brightness(1.07)}
  #dismiss:focus-visible,#tour:focus-visible,#error button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}

  /* errors */
  #error{
    position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;
    padding:20px;background:rgba(4,7,12,.78);
    backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  }
  #error.show{display:flex}
  #error .box{width:100%;max-width:430px;background:#101828;border:1px solid rgba(255,120,110,.35);border-radius:14px;padding:18px}
  #error h2{margin:0 0 8px;font-size:15px;color:#ff9f92}
  #error p{margin:0 0 14px;font-size:12.5px;line-height:1.6;color:var(--muted);overflow-wrap:anywhere}
  #error .row{display:flex;gap:8px;flex-wrap:wrap}
  #error button{
    appearance:none;border:1px solid var(--line);background:rgba(148,170,205,.08);color:var(--ink);
    font-family:inherit;font-size:13px;font-weight:600;padding:9px 14px;border-radius:9px;cursor:pointer;
  }
  #error button:hover{background:rgba(148,170,205,.16)}
</style>
</head>
<body>
<div id="map"></div>
<img id="poster" src="tiles/poster.jpg" alt="" aria-hidden="true" onerror="this.remove()">
<div id="vignette" aria-hidden="true"></div>
<div id="progress" aria-hidden="true"></div>

<div id="counter">loading index…<span class="src">© Microsoft · © OpenStreetMap contributors</span></div>

<div id="tourlabel"></div>
<button id="tour" type="button">
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <circle cx="12" cy="12" r="2.6" fill="currentColor"/>
    <ellipse cx="12" cy="12" rx="9.5" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.8" transform="rotate(-24 12 12)"/>
  </svg>
  <span>Tour</span>
</button>

<section id="card" role="dialog" aria-label="About this map">
  <p class="kicker">Green Pramuka City</p>
  <h1>kota — Jakarta at 1:1</h1>
  <p>A 1:1 3D map covering Greater Jakarta (Jabodetabek) — every block you see is a real building.</p>
  <p class="note">≈ Building heights are estimates — the skyline is a sketch, not a survey.</p>
  <p class="credit">Data: Microsoft building footprints · © OpenStreetMap contributors</p>
  <p class="fineprint">Generated by GLM-5.3-Flash on Fenrir (fenrir.lio.id), steered by Instinct</p>
  <button id="dismiss" type="button">Explore</button>
</section>

<div id="error" aria-live="assertive">
  <div class="box">
    <h2 id="err-title"></h2>
    <p id="err-detail"></p>
    <div class="row">
      <button id="err-retry" type="button">Reload</button>
      <button id="err-continue" type="button" hidden>Continue anyway</button>
    </div>
  </div>
</div>

<noscript>
  <div style="position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:#070b13;color:#e9eef7;font-family:sans-serif;padding:20px;text-align:center">
    This map needs JavaScript to render.
  </div>
</noscript>

<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@3.6.2/dist/maplibre-gl.js"></script>
<script type="module">
const CENTER = [106.8738, -6.1893]; // Green Pramuka City, as [lng, lat]

const B_Z = 15, R_Z = 14, C_Z = 12;
const MAX_TILES = 80;
const CACHE_SIZE = 60;

const $card = document.getElementById('card');
const $dismiss = document.getElementById('dismiss');
const $counter = document.getElementById('counter');
const $tour = document.getElementById('tour');
const $tourLabel = document.getElementById('tourlabel');
const $error = document.getElementById('error');
const $errTitle = document.getElementById('err-title');
const $errDetail = document.getElementById('err-detail');
const $errRetry = document.getElementById('err-retry');
const $errContinue = document.getElementById('err-continue');
const $progress = document.getElementById('progress');

const fmt = new Intl.NumberFormat('en-US');
const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const reduceMotion = !!(mq && mq.matches);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showError(title, detail, fatal = true) {
  $errTitle.textContent = title;
  $errDetail.textContent = detail;
  $errContinue.hidden = fatal;
  $error.classList.add('show');
}

$errRetry.addEventListener('click', () => location.reload());
$errContinue.addEventListener('click', () => $error.classList.remove('show'));

function dismissCard() {
  $card.classList.add('hidden');
  $tour.classList.add('show');
}
$dismiss.addEventListener('click', dismissCard);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$card.classList.contains('hidden')) dismissCard();
});

// poster: fade out and remove once the first real building tile renders
let posterGone = false;
function hidePoster() {
  if (posterGone) return;
  posterGone = true;
  const p = document.getElementById('poster');
  if (!p) return;
  p.style.opacity = '0';
  setTimeout(() => { try { p.remove(); } catch (e) {} }, 700);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// --- slippy tile math -------------------------------------------------------

function lon2x(lon, z) { return ((lon + 180) / 360) * (1 << z); }
function lat2y(lat, z) {
  const s = Math.sin(lat * Math.PI / 180);
  const cl = Math.max(-0.9999, Math.min(0.9999, s));
  return (0.5 - Math.log((1 + cl) / (1 - cl)) / (4 * Math.PI)) * (1 << z);
}
function tilesForBounds(b, z) {
  const max = 1 << z;
  const latN = Math.max(-85, Math.min(85, b.getNorth()));
  const latS = Math.max(-85, Math.min(85, b.getSouth()));
  const x0 = Math.floor(lon2x(b.getWest(), z)), x1 = Math.floor(lon2x(b.getEast(), z));
  const y0 = Math.floor(lat2y(latN, z)), y1 = Math.floor(lat2y(latS, z));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    if (x >= 0 && x < max && y >= 0 && y < max) out.push([x, y]);
  }
  return out;
}

// --- data shaping -----------------------------------------------------------

function toBuildingsFC(raw) {
  const out = [];
  const list = raw && Array.isArray(raw.features) ? raw.features : [];
  for (let n = 0; n < list.length; n++) {
    const f = list[n];
    if (!Array.isArray(f) || f.length < 2 || !Array.isArray(f[1]) || f[1].length < 3) continue;
    const hNum = Number(f[0]);
    const h = Number.isFinite(hNum) ? hNum : 3;
    const coords = [];
    let ok = true;
    for (const p of f[1]) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { ok = false; break; }
      coords.push([p[0], p[1]]);
    }
    if (!ok) continue;
    const a = coords[0], b = coords[coords.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) coords.push([a[0], a[1]]); // close the ring
    out.push({
      type: 'Feature',
      properties: { h, i: n },
      geometry: { type: 'Polygon', coordinates: [coords] },
    });
  }
  return { type: 'FeatureCollection', features: out };
}

const MAJOR_CLASSES = new Set(['motorway', 'motorway_link', 'toll', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const MID_CLASSES = new Set(['secondary', 'secondary_link', 'tertiary', 'tertiary_link']);

function toRoadsFC(raw) {
  const out = [];
  const list = raw && Array.isArray(raw.features) ? raw.features : [];
  for (let n = 0; n < list.length; n++) {
    const f = list[n];
    if (!f || !Array.isArray(f.line) || f.line.length < 2) continue;
    const coords = [];
    let ok = true;
    for (const p of f.line) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { ok = false; break; }
      coords.push([p[0], p[1]]);
    }
    if (!ok || coords.length < 2) continue;
    const cls = String(f.road_class || '').toLowerCase();
    const tier = MAJOR_CLASSES.has(cls) ? 3 : MID_CLASSES.has(cls) ? 2 : 1;
    out.push({
      type: 'Feature',
      properties: {
        kind: String(f.kind || ''), road_class: cls, name: String(f.name || ''),
        tier, rid: Number.isFinite(f.id) ? f.id : -1, i: n,
      },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  return { type: 'FeatureCollection', features: out };
}

// --- boot -------------------------------------------------------------------

if (!window.maplibregl) {
  showError('Map library failed to load', 'maplibre-gl could not be fetched from cdn.jsdelivr.net. Check the network connection and reload the page.');
} else {
  boot().catch((err) => showError('Something went wrong', String((err && err.message) || err)));
}

async function boot() {
  let map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        light: { anchor: 'viewport', color: '#ffe2b0', intensity: 0.36 },
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#070b13' } }],
      },
      center: CENTER,
      zoom: 15.2,
      pitch: 60,
      bearing: -24,
      maxPitch: 70,
      attributionControl: false,
      antialias: true,
      fadeDuration: 0,
    });
  } catch (err) {
    showError('WebGL is unavailable', 'The 3D map could not start: ' + String((err && err.message) || err));
    return;
  }
  map.on('error', (e) => console.warn('maplibre error:', (e && e.error) || e));

  // --- fetch the tile index -------------------------------------------------
  let index = null;
  try {
    index = await fetchJSON('tiles/index.json');
  } catch (err) {
    showError('Tile index failed to load', 'Could not fetch tiles/index.json — ' + String((err && err.message) || err) + '. Serve this folder over HTTP(S) and reload.');
    return;
  }
  const bIndex = new Set((index.buildings && index.buildings.tiles || []).map((t) => t[0] + ',' + t[1]));
  const rIndex = new Set((index.roads && index.roads.tiles || []).map((t) => t[0] + ',' + t[1]));
  const cIndex = new Set((index.coarse && index.coarse.tiles || []).map((t) => t[0] + ',' + t[1]));
  const totals = {
    b: (index.buildings && index.buildings.count) || 0,
    r: (index.roads && index.roads.count) || 0,
  };

  function counterHTML() {
    return '<b>' + fmt.format(totals.b) + '</b> buildings · <b>' + fmt.format(totals.r) + '</b> road segments' +
      '<span class="src">© Microsoft · © OpenStreetMap contributors</span>';
  }
  function loadingHTML(done, total) {
    return 'loading tiles ' + done + '/' + total +
      '<span class="src">© Microsoft · © OpenStreetMap contributors</span>';
  }
  $counter.innerHTML = counterHTML();

  await new Promise((resolve) => map.on('load', resolve));

  // --- coarse preview layer (added first so it sits beneath everything) ------

  const BUILDING_COLOR = [
    'interpolate', ['linear'], ['coalesce', ['get', 'h'], 3],
    0,   '#1f2a40',
    10,  '#2a3752',
    25,  '#3a4a6e',
    50,  '#575a80',
    90,  '#7d6285',
    140, '#b57a52',
    200, '#e09a4e',
    300, '#f7bd63',
    450, '#ffdf9e',
  ];

  const coarseParts = new Map(); // "x,y" -> FeatureCollection
  let coarseOpacity = -1;
  try {
    map.addSource('coarse-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'coarse-bldg',
      type: 'fill-extrusion',
      source: 'coarse-src',
      paint: {
        'fill-extrusion-height': ['min', ['max', ['coalesce', ['get', 'h'], 3], 2.5], 500],
        'fill-extrusion-base': 0,
        'fill-extrusion-color': BUILDING_COLOR,
        'fill-extrusion-opacity': 0,
        'fill-extrusion-opacity-transition': { duration: 400 },
        'fill-extrusion-vertical-gradient': true,
      },
      layout: { visibility: 'none' },
    });
  } catch (e) { /* coarse preview is best-effort */ }

  function rebuildCoarse() {
    const feats = [];
    for (const fc of coarseParts.values()) feats.push(...fc.features);
    try {
      const src = map.getSource('coarse-src');
      if (src) src.setData({ type: 'FeatureCollection', features: feats });
    } catch (e) {}
  }

  // --- tile manager -----------------------------------------------------------

  const bLoaded = new Map();   // "x,y" -> { src, layers:[] }
  const rLoaded = new Map();   // "x,y" -> { src, layers:[], ids:Set }
  const inflight = new Set();  // "kind:x,y"
  const failed = new Set();    // "kind:x,y" — fetch failed, treat as loaded-empty
  const cache = new Map();     // "kind:x,y" -> FeatureCollection (LRU)
  let neededKeys = new Set();  // "kind:x,y" needed for the current viewport

  function cachePut(key, fc) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, fc);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  }
  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const fc = cache.get(key);
    cache.delete(key);
    cache.set(key, fc);
    return fc;
  }

  function tileCenter(key, z) {
    const [x, y] = key.split(',').map(Number);
    const n = Math.PI - 2 * Math.PI * (y + 0.5) / (1 << z);
    const lon = (x + 0.5) / (1 << z) * 360 - 180;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lon2x(lon, z) / (1 << z), lat2y(lat, z) / (1 << z)];
  }

  function firstBuildingLayerId() {
    const style = map.getStyle();
    if (!style || !Array.isArray(style.layers)) return null;
    for (const l of style.layers) if (l.id.startsWith('bldg-')) return l.id;
    return null;
  }

  function evictFarthest(neededKeysArg) {
    // evict the loaded tile whose center is farthest from the viewport center
    const c = map.getCenter();
    const cx = lon2x(c.lng, B_Z) / (1 << B_Z);
    const cy = lat2y(c.lat, B_Z) / (1 << B_Z);
    let worstKey = null, worstKind = null, worstD = -1;
    const scan = (m, kind, z) => {
      for (const key of m.keys()) {
        if (neededKeysArg.has(kind + ':' + key)) continue;
        const [tx, ty] = tileCenter(key, z);
        const d = (tx - cx) * (tx - cx) + (ty - cy) * (ty - cy);
        if (d > worstD) { worstD = d; worstKey = key; worstKind = kind; }
      }
    };
    scan(bLoaded, 'b', B_Z);
    scan(rLoaded, 'r', R_Z);
    if (worstKey) removeTile(worstKind, worstKey);
  }

  function removeTile(kind, key) {
    const rec = (kind === 'b' ? bLoaded : rLoaded).get(key);
    if (!rec) return;
    for (const id of rec.layers) { try { if (map.getLayer(id)) map.removeLayer(id); } catch (e) {} }
    try { if (map.getSource(rec.src)) map.removeSource(rec.src); } catch (e) {}
    (kind === 'b' ? bLoaded : rLoaded).delete(key);
    if (kind === 'r' && rec.ids) {
      const seen = roadSeen;
      for (const id of rec.ids) seen.delete(id);
    }
    if (rec.fc) cachePut(kind + ':' + key, rec.fc);
  }

  const roadSeen = new Set(); // deduped road feature ids across tiles

  function addBuildingLayers(src, key) {
    const id = 'bldg-' + key.replace(',', '-');
    map.addLayer({
      id,
      type: 'fill-extrusion',
      source: src,
      paint: {
        'fill-extrusion-height': ['min', ['max', ['coalesce', ['get', 'h'], 3], 2.5], 500],
        'fill-extrusion-base': 0,
        'fill-extrusion-color': BUILDING_COLOR,
        'fill-extrusion-opacity': [
          'interpolate', ['linear'], ['zoom'],
          13, 0, 14, 0.94,
        ],
        'fill-extrusion-vertical-gradient': true,
      },
    });
    return id;
  }

  function addRoadLayers(src, key) {
    const suffix = key.replace(',', '-');
    const widths = (a, b) => ['interpolate', ['linear'], ['zoom'], 14, a, 17.5, b];
    const defs = [
      ['waterway-' + suffix, ['==', ['get', 'kind'], 'waterway'],
        { 'line-color': '#22415f', 'line-width': widths(1.2, 3.2), 'line-opacity': 0.9 },
        { 'line-cap': 'round', 'line-join': 'round' }, null],
      ['railway-' + suffix, ['==', ['get', 'kind'], 'railway'],
        { 'line-color': '#655e7d', 'line-width': widths(0.8, 1.7), 'line-dasharray': [2, 2.2], 'line-opacity': 0.85 },
        { 'line-join': 'round' }, null],
      ['roads-glow-' + suffix, ['all', ['==', ['get', 'kind'], 'highway'], ['==', ['get', 'tier'], 3]],
        { 'line-color': '#6f8cc9', 'line-width': widths(3.5, 9), 'line-blur': 4, 'line-opacity': 0.2 },
        { 'line-cap': 'round', 'line-join': 'round' }, null],
      ['roads-minor-' + suffix, ['all', ['==', ['get', 'kind'], 'highway'], ['==', ['get', 'tier'], 1]],
        { 'line-color': '#333e54', 'line-width': widths(0.6, 1.3), 'line-opacity': 0.72 },
        { 'line-cap': 'round', 'line-join': 'round' }, null],
      ['roads-mid-' + suffix, ['all', ['==', ['get', 'kind'], 'highway'], ['==', ['get', 'tier'], 2]],
        { 'line-color': '#4d5b7d', 'line-width': widths(0.9, 1.9), 'line-opacity': 0.85 },
        { 'line-cap': 'round', 'line-join': 'round' }, null],
      ['roads-major-' + suffix, ['all', ['==', ['get', 'kind'], 'highway'], ['==', ['get', 'tier'], 3]],
        { 'line-color': '#93a9cf', 'line-width': widths(1.3, 2.7), 'line-opacity': 0.95 },
        { 'line-cap': 'round', 'line-join': 'round' }, null],
    ];
    const ids = [];
    for (const [id, filter, paint, layout] of defs) {
      map.addLayer({ id, type: 'line', source: src, filter, layout, paint });
      ids.push(id);
    }
    return ids;
  }

  async function loadTile(kind, x, y) {
    const key = x + ',' + y;
    const fkey = kind + ':' + key;
    if (inflight.has(fkey)) return;
    if ((kind === 'b' ? bLoaded : rLoaded).has(key)) return;
    const z = kind === 'b' ? B_Z : R_Z;
    const url = 'tiles/' + kind + '/' + x + '/' + y + '.json';

    inflight.add(fkey);
    updateProgress();
    let fc = cacheGet(fkey);
    if (!fc) {
      let raw;
      try {
        raw = await fetchJSON(url);
      } catch (err) {
        inflight.delete(fkey);
        failed.add(fkey);
        updateProgress();
        updateCoarseVisibility();
        return; // missing or broken tile: treat as loaded-empty, stay silent
      }
      fc = kind === 'b' ? toBuildingsFC(raw) : toRoadsFC(raw);
      cachePut(fkey, fc);
    }
    inflight.delete(fkey);

    // stale check: evicted or already present while we were fetching
    if ((kind === 'b' ? bLoaded : rLoaded).has(key)) { updateProgress(); return; }
    if (!map.getStyle()) return;

    const src = (kind === 'b' ? 'b-' : 'r-') + key.replace(',', '-');
    try {
      map.addSource(src, { type: 'geojson', data: fc });
    } catch (err) { return; }

    const rec = { src, layers: [], fc };
    if (kind === 'b') {
      rec.layers.push(addBuildingLayers(src, key));
      bLoaded.set(key, rec);
      hidePoster();
    } else {
      const kept = [];
      for (const f of fc.features) {
        const rid = f.properties.rid;
        if (rid >= 0) {
          if (roadSeen.has(rid)) continue;
          roadSeen.add(rid);
          kept.push(rid);
        }
      }
      rec.ids = new Set(kept);
      rec.layers = addRoadLayers(src, key);
      rLoaded.set(key, rec);
    }
    updateProgress();
    updateCoarseVisibility();
  }

  async function loadCoarseTile(x, y) {
    const key = x + ',' + y;
    const fkey = 'c:' + key;
    if (inflight.has(fkey) || coarseParts.has(key)) return;
    const url = 'tiles/c/' + x + '/' + y + '.json';

    inflight.add(fkey);
    updateProgress();
    let fc;
    try {
      const raw = await fetchJSON(url);
      fc = toBuildingsFC(raw);
    } catch (err) {
      inflight.delete(fkey);
      failed.add(fkey);
      updateProgress();
      updateCoarseVisibility();
      return;
    }
    inflight.delete(fkey);
    coarseParts.set(key, fc);
    rebuildCoarse();
    updateProgress();
    updateCoarseVisibility();
  }

  // --- progress bar + counter -------------------------------------------------

  function progressState() {
    const total = neededKeys.size;
    let done = 0;
    for (const fk of neededKeys) {
      const ci = fk.indexOf(':');
      const kind = fk.slice(0, ci);
      const key = fk.slice(ci + 1);
      if (failed.has(fk)) { done++; continue; }
      const m = kind === 'b' ? bLoaded : kind === 'r' ? rLoaded : coarseParts;
      if (m.has(key)) done++;
    }
    return { done, total };
  }

  function updateProgress() {
    const { done, total } = progressState();
    const pct = total === 0 ? 100 : (done / total) * 100;
    $progress.style.width = pct.toFixed(2) + '%';
    if (total === 0 || done >= total) {
      $progress.style.opacity = '0';
    } else {
      $progress.style.opacity = '1';
    }
    if (inflight.size > 0 && total > 0) {
      $counter.innerHTML = loadingHTML(done, total);
    } else {
      $counter.innerHTML = counterHTML();
    }
  }

  function updateCoarseVisibility() {
    if (!map.getLayer('coarse-bldg')) return;
    let missing = false;
    for (const fk of neededKeys) {
      if (fk[0] === 'c') continue;
      const ci = fk.indexOf(':');
      const kind = fk.slice(0, ci);
      const key = fk.slice(ci + 1);
      if (failed.has(fk)) continue;
      const m = kind === 'b' ? bLoaded : rLoaded;
      if (!m.has(key)) { missing = true; break; }
    }
    const target = missing ? 0.6 : 0;
    if (target !== coarseOpacity) {
      coarseOpacity = target;
      try { map.setPaintProperty('coarse-bldg', 'fill-extrusion-opacity', target); } catch (e) {}
    }
  }

  let updateTimer = null;
  function scheduleUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(updateTiles, 200);
  }

  function updateTiles() {
    if (!map.getStyle()) return;
    const b = map.getBounds();
    const zoom = map.getZoom();
    const wantB = zoom >= 13 ? tilesForBounds(b, B_Z) : [];
    const wantR = tilesForBounds(b, R_Z);
    const wantC = zoom >= 12 ? tilesForBounds(b, C_Z) : [];

    const needed = new Set();
    for (const [x, y] of wantC) if (cIndex.has(x + ',' + y)) needed.add('c:' + x + ',' + y);
    for (const [x, y] of wantB) if (bIndex.has(x + ',' + y)) needed.add('b:' + x + ',' + y);
    for (const [x, y] of wantR) if (rIndex.has(x + ',' + y)) needed.add('r:' + x + ',' + y);
    neededKeys = needed;

    // remove loaded tiles well outside the viewport (one-tile margin)
    const marginB = new Set();
    for (const [x, y] of wantB) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) marginB.add((x + dx) + ',' + (y + dy));
    }
    for (const key of [...bLoaded.keys()]) if (!marginB.has(key)) removeTile('b', key);

    const marginR = new Set();
    for (const [x, y] of wantR) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) marginR.add((x + dx) + ',' + (y + dy));
    }
    for (const key of [...rLoaded.keys()]) if (!marginR.has(key)) removeTile('r', key);

    // coarse preview first: tiny tiles, not counted against the detail cap
    for (const fk of needed) {
      if (fk[0] !== 'c') continue;
      const key = fk.slice(2);
      if (coarseParts.has(key) || inflight.has(fk)) continue;
      const [cx, cy] = key.split(',').map(Number);
      loadCoarseTile(cx, cy);
    }

    // fetch missing detail tiles, respecting the cap
    const missing = [];
    for (const fk of needed) {
      const ci = fk.indexOf(':');
      const kind = fk.slice(0, ci);
      if (kind === 'c') continue;
      const key = fk.slice(ci + 1);
      const m = kind === 'b' ? bLoaded : rLoaded;
      if (!m.has(key) && !inflight.has(fk)) missing.push([kind, key]);
    }
    let room = MAX_TILES - bLoaded.size - rLoaded.size;
    for (const [kind, key] of missing) {
      if (room <= 0) evictFarthest(needed);
      room = MAX_TILES - bLoaded.size - rLoaded.size;
      if (room <= 0) break;
      room--;
      loadTile(kind, Number(key.split(',')[0]), Number(key.split(',')[1]));
    }

    // building + coarse visibility below z13
    const showB = zoom >= 13 ? 'visible' : 'none';
    for (const rec of bLoaded.values()) {
      for (const id of rec.layers) {
        try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', showB); } catch (e) {}
      }
    }
    try { if (map.getLayer('coarse-bldg')) map.setLayoutProperty('coarse-bldg', 'visibility', showB); } catch (e) {}

    updateProgress();
    updateCoarseVisibility();
  }

  // --- camera: slow orbit, guided tour, free control ------------------------

  let orbiting = false;
  let tourToken = 0;
  let tourRunning = false;

  const VIEWS = [
    { name: 'Green Pramuka City towers', center: [106.8738, -6.1893], zoom: 16.25, pitch: 63, bearing: 28 },
    { name: 'Cempaka Putih', center: [106.8725, -6.1780], zoom: 15.8, pitch: 55, bearing: -38 },
    { name: 'Rawasari · the toll-road curve', center: [106.8790, -6.1860], zoom: 15.3, pitch: 58, bearing: 115 },
  ];

  function orbitStep() {
    if (!orbiting) return;
    map.easeTo({ bearing: map.getBearing() + 45, duration: 24000, easing: (t) => t });
  }
  function startOrbit() {
    if (orbiting || reduceMotion) return;
    orbiting = true;
    orbitStep();
  }
  function endTourUI() {
    tourRunning = false;
    $tour.classList.remove('active');
    const label = $tour.querySelector('span');
    if (label) label.textContent = 'Tour';
    $tourLabel.classList.remove('show');
  }
  function releaseCamera() {
    tourToken++;
    if (tourRunning) endTourUI();
    orbiting = false;
    map.stop(); // cut any in-flight camera animation
  }

  // Any user gesture hands over full control of the camera.
  for (const ev of ['mousedown', 'touchstart', 'wheel', 'keydown', 'dragstart']) {
    map.on(ev, releaseCamera);
  }
  map.on('moveend', () => {
    scheduleUpdate();
    if (orbiting) orbitStep();
  });
  map.on('zoomend', scheduleUpdate);

  async function runTour() {
    releaseCamera();
    tourRunning = true;
    $tour.classList.add('active');
    const label = $tour.querySelector('span');
    if (label) label.textContent = 'Stop';
    const token = tourToken;
    const flyMs = reduceMotion ? 900 : 5200;
    const holdMs = reduceMotion ? 500 : 3000;
    for (const v of VIEWS) {
      if (token !== tourToken) return;
      $tourLabel.textContent = v.name;
      $tourLabel.classList.add('show');
      map.flyTo({ center: v.center, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing, duration: flyMs, essential: true });
      await sleep(flyMs + holdMs);
    }
    if (token !== tourToken) return;
    endTourUI();
    startOrbit(); // hand the city back to the slow drift
  }

  $tour.addEventListener('click', () => {
    if (tourRunning) { releaseCamera(); return; }
    runTour();
  });

  // --- go -------------------------------------------------------------------
  updateTiles();
  startOrbit();
}
</script>
</body>
</html>
```