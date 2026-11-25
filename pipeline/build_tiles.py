import hashlib
import json
import math
import os
import shutil
import sys
import time

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
    idx_path = os.path.join(tiles_out, "index.json")
    data = json.dumps(index, separators=(",", ":")).encode("utf-8")
    with open(idx_path, "wb") as f:
        f.write(data)

    shutil.rmtree(parts_out, ignore_errors=True)

    total_bytes = len(data)
    max_tile_bytes = 0
    for sub in ("b", "r"):
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
