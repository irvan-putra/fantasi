Rewrite pipeline/build_tiles.py (current version below) as a CONFIG-DRIVEN tiler so the same script builds the tile set for any city extract. Keep ALL geometry logic byte-for-byte equivalent: estimate_height, dedupe_ring, perpendicular_distance, douglas_peucker, simplify_ring, ring_area_centroid, r6, tile math (lonlat_to_tile, tile_bbox), and the constants BUILD_Z=15, ROAD_Z=14, SIMPLIFY_TOL_M=1.5, MAX_OPEN_FILES=64. The final on-disk tile format stays EXACTLY the same: <tiles-out>/b/<x>/<y>.json {"z":15,"x":x,"y":y,"features":[[height, ring], ...]}, <tiles-out>/r/<x>/<y>.json {"z":14,"x":x,"y":y,"features":[{"id","kind","road_class","name","line"}, ...]}, and <tiles-out>/index.json {"bbox":[W,S,E,N],"buildings":{"z":15,"tiles":[[x,y],...],"count":N},"roads":{"z":14,"tiles":[[x,y],...],"count":M},"heights":"estimated"} (compact separators everywhere).

INPUT FORMATS (note: roads changed from one big JSON doc to line-delimited):
- Buildings: geojsonl, one GeoJSON feature per line (polygon ring at ["geometry"]["coordinates"][0]).
- Roads: geojsonl, one object per line: {"id":int,"kind":"highway"|"railway"|"waterway","name":str|null,"road_class":str|null,"line":[[lon,lat],...]}.

WHY: the next dataset has ~4.7 million buildings and ~733k roads. The sandbox kills any process after 115 seconds and has 2GB RAM. The current single-shot finalize (all roads + all tiles in RAM) would exceed both. Restructure into four resumable modes, every mode streaming line-by-line and memory-bounded (<1GB):

1. `python3 pipeline/build_tiles.py slice --buildings PATH --parts-out DIR --bbox W,S,E,N --total-buildings N --slice I --slices M`
   Process only building lines [I*ceil(N/M), (I+1)*ceil(N/M)) (skip with a counting loop over the file object; stop past the end). For each kept building (simplify/centroid as now; skip drops) APPEND its [height, ring] JSON line (compact separators) to <parts-out>/b/<x>/<y>.jsonl via the HandleCache (append mode, LRU 64). On exit append one line per touched tile to <parts-out>/b_manifest.jsonl: {"x":x,"y":y,"n":count_in_this_slice} and print: slice I, buildings processed, seconds.

2. `python3 pipeline/build_tiles.py roads --roads PATH --parts-out DIR --bbox W,S,E,N`
   Stream the roads geojsonl ONCE. For each road: compute every ROAD_Z tile its line bbox intersects (same tile-bbox overlap logic as now); append the road feature JSON {"id","kind","road_class","name","line"} (line coords rounded to 6dp, compact separators) as ONE line to EACH of its tiles' <parts-out>/r/<x>/<y>.jsonl via a second HandleCache. Append per-tile counts to <parts-out>/r_manifest.jsonl (same {"x","y","n"} shape). Print: roads processed, seconds.

3. `python3 pipeline/build_tiles.py finalize --parts-out DIR --tiles-out DIR --finalize-slice J --finalize-slices K`
   List distinct building-fragment tiles by scanning <parts-out>/b (os.walk) and road-fragment tiles under <parts-out>/r; sort each list; process only slice J of K of EACH list (same J/K splitting by ceil). For each building tile: read its .jsonl fragment line by line, parse, collect features, write <tiles-out>/b/<x>/<y>.json exactly as now. Same for road tiles into <tiles-out>/r/<x>/<y>.json. Print: finalize J, building tiles, road tiles, seconds. (Manifests and parts are removed by the index mode, not here.)

4. `python3 pipeline/build_tiles.py index --tiles-out DIR --parts-out DIR --bbox W,S,E,N --roads-count M`
   Scan <tiles-out>/b and <tiles-out>/r for tile lists ([[x,y],...] sorted). Buildings count = sum of "n" over all lines of <parts-out>/b_manifest.jsonl. Roads count = --roads-count value. Write <tiles-out>/index.json exactly in the current format with the --bbox values as numbers. Then remove <parts-out> entirely (shutil.rmtree). Print: total MB written under <tiles-out>, largest tile KB.

Rules: stdlib only; no f-strings nested inside f-strings; parse flags with a tiny helper (flags may come in any order; --bbox is four comma-separated floats). Keep coordinate rounding to 6 decimals and heights to 1 decimal. Every mode except index must individually finish in under 100 seconds for the stated data sizes when its slice count is chosen so each slice has <=300k buildings (slice) or <=1200 tiles (finalize). Output the COMPLETE new file in one fenced block: ```python pipeline/build_tiles.py

CURRENT VERSION TO GENERALIZE:
```python pipeline/build_tiles.py
import hashlib
import json
import math
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILDINGS_IN = os.path.join(ROOT, "data", "buildings_jkt.geojsonl")
ROADS_IN = os.path.join(ROOT, "data", "roads_jkt.json")
TILES_OUT = os.path.join(ROOT, "site", "tiles")
PARTS_OUT = os.path.join(ROOT, "site", "tiles_part")

TOTAL_BUILDINGS = 1491133

W, S, E, N = 106.68, -6.38, 106.975, -6.08
BUILD_Z = 15
ROAD_Z = 14
SIMPLIFY_TOL_M = 1.5
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

    def __init__(self, root):
        self.root = root
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
        d = os.path.join(self.root, "b", str(x))
        os.makedirs(d, exist_ok=True)
        h = open(os.path.join(d, f"{y}.jsonl"), "a", encoding="utf-8")
        self.handles[key] = h
        self.order.append(key)
        return h

    def close_all(self):
        for h in self.handles.values():
            h.close()
        self.handles.clear()
        self.order.clear()


def cmd_slice(i, n):
    start = i * ((TOTAL_BUILDINGS + n - 1) // n)
    end = (i + 1) * ((TOTAL_BUILDINGS + n - 1) // n)
    os.makedirs(PARTS_OUT, exist_ok=True)
    handles = HandleCache(PARTS_OUT)
    dumps = json.dumps
    processed = 0
    t0 = time.time()
    with open(BUILDINGS_IN, "r", encoding="utf-8") as f:
        # skip lines [0, start)
        for _ in range(start):
            next(f, None)
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
            processed += 1
    handles.close_all()
    elapsed = time.time() - t0
    print(f"slice {i}: {processed} buildings in {elapsed:.1f}s")


def cmd_finalize():
    os.makedirs(os.path.join(TILES_OUT, "b"), exist_ok=True)
    os.makedirs(os.path.join(TILES_OUT, "r"), exist_ok=True)

    # ---------- roads: pass 1, group ids by tile ----------
    with open(ROADS_IN, "r", encoding="utf-8") as f:
        roads_doc = json.load(f)
    road_features = roads_doc.get("features", [])

    r_ids = {}  # (x,y) -> list of ids
    r_count = 0
    for feat in road_features:
        line = feat.get("line")
        if not line:
            continue
        lons = [p[0] for p in line]
        lats = [p[1] for p in line]
        lo, hi = min(lons), max(lons)
        la, hb = min(lats), max(lats)
        x0, y1, _ = lonlat_to_tile(lo, hb, ROAD_Z)  # NW corner
        x1, y0, _ = lonlat_to_tile(hi, la, ROAD_Z)  # SE corner
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                bx0, by0, bx1, by1 = tile_bbox(tx, ty, ROAD_Z)
                if hi < bx0 or lo > bx1 or hb < by0 or la > by1:
                    continue
                r_ids.setdefault((tx, ty), []).append(feat["id"])
        r_count += 1

    # ---------- roads: pass 2, emit features into tiles ----------
    r_tiles = {}  # (x,y) -> list of feature dicts
    id_to_tiles = {}
    for tkey, ids in r_ids.items():
        for fid in ids:
            id_to_tiles.setdefault(fid, []).append(tkey)
    for feat in road_features:
        keys = id_to_tiles.get(feat["id"])
        if not keys:
            continue
        out_line = [[r6(p[0]), r6(p[1])] for p in feat["line"]]
        rec = {
            "id": feat["id"],
            "kind": feat["kind"],
            "road_class": feat["road_class"],
            "name": feat["name"],
            "line": out_line,
        }
        for tkey in keys:
            r_tiles.setdefault(tkey, []).append(rec)
    del id_to_tiles, r_ids

    dumps = json.dumps
    total_bytes = 0
    max_tile_bytes = 0

    def write_tile(sub, x, y, payload):
        nonlocal total_bytes, max_tile_bytes
        d = os.path.join(TILES_OUT, sub, str(x))
        os.makedirs(d, exist_ok=True)
        data = dumps(payload, separators=(",", ":")).encode("utf-8")
        with open(os.path.join(d, f"{y}.json"), "wb") as out:
            out.write(data)
        total_bytes += len(data)
        if len(data) > max_tile_bytes:
            max_tile_bytes = len(data)

    # ---------- buildings: merge fragments, one tile at a time ----------
    b_tiles = []
    b_count = 0
    b_root = os.path.join(PARTS_OUT, "b")
    for xdir in sorted(os.listdir(b_root), key=lambda s: int(s)):
        xdir_path = os.path.join(b_root, xdir)
        for fname in sorted(os.listdir(xdir_path), key=lambda s: int(s.split(".")[0])):
            tx = int(xdir)
            ty = int(fname.split(".")[0])
            feats = []
            with open(os.path.join(xdir_path, fname), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    feats.append(json.loads(line))
            if not feats:
                continue
            b_count += len(feats)
            b_tiles.append([tx, ty])
            write_tile("b", tx, ty, {"z": BUILD_Z, "x": tx, "y": ty, "features": feats})
            del feats

    # ---------- roads: write tiles ----------
    for (tx, ty), feats in r_tiles.items():
        if not feats:
            continue
        write_tile("r", tx, ty, {"z": ROAD_Z, "x": tx, "y": ty, "features": feats})

    index = {
        "bbox": [W, S, E, N],
        "buildings": {
            "z": BUILD_Z,
            "tiles": sorted(b_tiles),
            "count": b_count,
        },
        "roads": {
            "z": ROAD_Z,
            "tiles": sorted([list(k) for k in r_tiles if r_tiles[k]]),
            "count": r_count,
        },
        "heights": "estimated",
    }
    idx_path = os.path.join(TILES_OUT, "index.json")
    with open(idx_path, "wb") as f:
        data = dumps(index, separators=(",", ":")).encode("utf-8")
        f.write(data)
    total_bytes += len(data)

    shutil.rmtree(PARTS_OUT, ignore_errors=True)

    print(
        f"building tiles: {len(b_tiles)}, "
        f"road tiles: {sum(1 for v in r_tiles.values() if v)}, "
        f"largest tile: {max_tile_bytes / 1024.0:.1f} KB, "
        f"total written: {total_bytes / (1024.0 * 1024.0):.1f} MB"
    )


def main():
    argv = sys.argv[1:]
    if not argv:
        print("usage: build_tiles.py slice <i> <n> | build_tiles.py finalize", file=sys.stderr)
        sys.exit(2)
    cmd = argv[0]
    if cmd == "slice":
        if len(argv) != 3:
            print("usage: build_tiles.py slice <i> <n>", file=sys.stderr)
            sys.exit(2)
        cmd_slice(int(argv[1]), int(argv[2]))
    elif cmd == "finalize":
        cmd_finalize()
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
```
