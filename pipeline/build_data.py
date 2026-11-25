#!/usr/bin/env python3
"""Convert raw geodata in data/ into compact web-ready JSON in site/data/."""

import hashlib
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILDINGS_IN = os.path.join(ROOT, "data", "buildings_gpc.geojsonl")
ROADS_IN = os.path.join(ROOT, "data", "roads.json")
OUT_DIR = os.path.join(ROOT, "site", "data")

TOL_M = 1.5                      # simplification tolerance in meters
K = math.pi * 6378137.0 / 180.0  # meters per degree of latitude
MIN_RING = 3                     # minimum unique vertices for a valid ring


def perp_dist(p, a, b):
    px, py = p
    ax, ay = a
    bx, by = b
    dx = bx - ax
    dy = by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    return abs(dy * (px - ax) - dx * (py - ay)) / math.hypot(dx, dy)


def decimate(pts, tol, closed, min_pts):
    # drop vertices whose perpendicular offset to the neighbor chord is < tol
    pts = list(pts)
    while len(pts) > min_pts:
        n = len(pts)
        drop = [False] * n
        remaining = n
        i = 0 if closed else 1
        end = n if closed else n - 1
        while i < end:
            if remaining <= min_pts:
                break
            a = pts[i - 1]
            b = pts[(i + 1) % n] if closed else pts[i + 1]
            if perp_dist(pts[i], a, b) < tol:
                drop[i] = True
                remaining -= 1
                i += 2
            else:
                i += 1
        if remaining == n:
            break
        pts = [p for p, d in zip(pts, drop) if not d]
    return pts


def ring_area_centroid(pts):
    # shoelace over a cyclic ring; returns (area, cx, cy)
    s = 0.0
    cx = 0.0
    cy = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        w = x1 * y2 - x2 * y1
        s += w
        cx += (x1 + x2) * w
        cy += (y1 + y2) * w
    if s == 0.0:
        return 0.0, 0.0, 0.0
    return abs(s) * 0.5, cx / (3.0 * s), cy / (3.0 * s)


def estimate_height(area_m2, lon_c, lat_c):
    # base + area growth + jitter hashed from the centroid, clamped to 3..80
    seed = f"{lon_c:.6f},{lat_c:.6f}".encode("utf-8")
    u = int(hashlib.sha256(seed).hexdigest()[:8], 16)
    jitter = (u % 2000) / 1000.0 - 1.0
    h = 3.0 + 0.45 * math.sqrt(area_m2) + jitter
    return round(min(80.0, max(3.0, h)), 1)


def build_ring(ring):
    # simplify one exterior ring; returns (area_m2, height, closed_ring) or None
    pts = []
    for c in ring:
        if not isinstance(c, (list, tuple)) or len(c) < 2:
            return None
        pts.append((float(c[0]), float(c[1])))
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < MIN_RING:
        return None
    lat0 = sum(p[1] for p in pts) / len(pts)
    kx = K * math.cos(math.radians(lat0))
    m = [(x * kx, y * K) for x, y in pts]
    m = decimate(m, TOL_M, True, MIN_RING)
    if len(m) < MIN_RING:
        return None
    area, cx, cy = ring_area_centroid(m)
    if area <= 0.0:
        return None
    ring_out = [[round(x / kx, 6) + 0.0, round(y / K, 6) + 0.0] for x, y in m]
    ring_out.append(list(ring_out[0]))
    return area, estimate_height(area, cx / kx, cy / K), ring_out


def exterior_rings(geom):
    if not isinstance(geom, dict):
        return []
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "Polygon" and isinstance(coords, list) and coords:
        return [coords[0]]
    if gtype == "MultiPolygon" and isinstance(coords, list):
        return [poly[0] for poly in coords if isinstance(poly, list) and poly]
    return []


def process_building(feat):
    if not isinstance(feat, dict):
        return None
    best = None
    for ring in exterior_rings(feat.get("geometry")):
        res = build_ring(ring)
        if res is not None and (best is None or res[0] > best[0]):
            best = res
    return best


def simplify_line(line):
    # round to 6 decimals and decimate open lines with the same tolerance
    try:
        pts = [(float(c[0]), float(c[1])) for c in line]
    except (TypeError, ValueError, IndexError):
        return line
    if len(pts) < 3:
        return [[round(x, 6) + 0.0, round(y, 6) + 0.0] for x, y in pts]
    lat0 = sum(p[1] for p in pts) / len(pts)
    kx = K * math.cos(math.radians(lat0))
    m = [(x * kx, y * K) for x, y in pts]
    m = decimate(m, TOL_M, False, 2)
    return [[round(x / kx, 6) + 0.0, round(y / K, 6) + 0.0] for x, y in m]


def process_roads(doc):
    out = []
    n_in = 0
    for feat in doc.get("features", []):
        n_in += 1
        item = dict(feat) if isinstance(feat, dict) else feat
        if isinstance(feat, dict) and isinstance(feat.get("line"), list):
            item["line"] = simplify_line(feat["line"])
        out.append(item)
    return n_in, out


def main():
    for path in (BUILDINGS_IN, ROADS_IN):
        if not os.path.isfile(path):
            sys.exit(f"missing input file: {path}")
    os.makedirs(OUT_DIR, exist_ok=True)

    bbox = [math.inf, math.inf, -math.inf, -math.inf]
    features = []
    n_read = 0
    n_skip = 0
    with open(BUILDINGS_IN, "r", encoding="utf-8-sig") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            n_read += 1
            try:
                feat = json.loads(raw)
            except ValueError:
                n_skip += 1
                continue
            res = process_building(feat)
            if res is None:
                n_skip += 1
                continue
            _area, height, ring = res
            features.append([height, ring])
            for lon, lat in ring:
                if lon < bbox[0]:
                    bbox[0] = lon
                if lat < bbox[1]:
                    bbox[1] = lat
                if lon > bbox[2]:
                    bbox[2] = lon
                if lat > bbox[3]:
                    bbox[3] = lat
    bbox = [round(v, 6) + 0.0 for v in bbox] if features else [0.0, 0.0, 0.0, 0.0]

    build_path = os.path.join(OUT_DIR, "buildings.json")
    with open(build_path, "w", encoding="utf-8") as fh:
        json.dump({"bbox": bbox, "features": features}, fh, separators=(",", ":"), ensure_ascii=False)

    with open(ROADS_IN, "r", encoding="utf-8-sig") as fh:
        roads_doc = json.load(fh)
    if not isinstance(roads_doc, dict) or not isinstance(roads_doc.get("features"), list):
        sys.exit("roads.json: unexpected top-level structure")
    n_roads, road_features = process_roads(roads_doc)
    roads_out = dict(roads_doc)
    roads_out["features"] = road_features
    roads_path = os.path.join(OUT_DIR, "roads.json")
    with open(roads_path, "w", encoding="utf-8") as fh:
        json.dump(roads_out, fh, separators=(",", ":"), ensure_ascii=False)

    kb_build = os.path.getsize(build_path) / 1024.0
    kb_roads = os.path.getsize(roads_path) / 1024.0
    print(f"buildings: {n_read} in / {len(features)} out ({n_skip} skipped) -> {kb_build:.1f} KB")
    print(f"roads: {n_roads} in / {len(road_features)} out -> {kb_roads:.1f} KB")


if __name__ == "__main__":
    main()
