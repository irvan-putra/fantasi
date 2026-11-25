Write ONE file: pipeline/build_tiles.py (Python 3.10, stdlib only). It converts raw Jakarta geodata into a static tile tree for a MapLibre viewer. No third-party packages exist.

INPUT (paths relative to repo root; script lives in pipeline/, resolves them relative to itself):
- data/buildings_jkt.geojsonl — 1,491,133 lines, one GeoJSON Feature per line, Polygon in "geometry"."coordinates"[0] (exterior ring, [lon,lat] pairs, WGS84), covering bbox W=106.68, S=-6.38, E=106.975, N=-6.08.
- data/roads_jkt.json — {"features":[{"id": int, "kind":"highway"|"railway"|"waterway", "road_class": str|null, "name": str|null, "line": [[lon,lat],...]}]} (up to ~400k features).

OUTPUT: directory site/tiles/ containing:
- site/tiles/b/{x}/{y}.json — building tiles at WEB-MERCATOR TILE ZOOM 15 covering the bbox. Each file: {"z":15,"x":x,"y":y,"features":[[height, ring], ...]} where ring is the simplified exterior ring ([lon,lat] floats rounded to 6 decimals). Skip empty tiles; no file for them.
- site/tiles/r/{x}/{y}.json — road tiles at ZOOM 14, same bbox. Each: {"z":14,"x":x,"y":y,"features":[{"id":int,"kind":...,"road_class":...,"name":...,"line":[[lon,lat],...]}]}. Assign a road to EVERY tile its line's bounding box intersects (the viewer dedupes by id across tiles). Round coords to 6 decimals.
- site/tiles/index.json — {"bbox":[W,S,E,N],"buildings":{"z":15,"tiles":[[x,y],...],"count":N},"roads":{"z":14,"tiles":[[x,y],...],"count":M},"heights":"estimated"}.

HEIGHT: reuse EXACTLY this estimator (from the previous pipeline, keep identical so the map stays consistent):
    import hashlib, math
    def estimate_height(area_m2, lon_c, lat_c):
        seed = f"{lon_c:.6f},{lat_c:.6f}".encode("utf-8")
        u = int(hashlib.sha256(seed).hexdigest()[:8], 16)
        jitter = (u % 2000) / 1000.0 - 1.0
        h = 3.0 + 0.45 * math.sqrt(area_m2) + jitter
        return round(min(80.0, max(3.0, h)), 1)

RING HANDLING (same semantics as the existing pipeline): drop degenerate rings (<3 unique points); simplify with perpendicular-distance decimation, tolerance 1.5 meters, keeping at least 4 points incl. closing point; compute area_m2 and centroid in a local meters frame (K = math.pi*6378137/180; x = lon*K*cos(lat), y = lat*K). Skip buildings whose simplified ring is invalid.

MEMORY LIMIT: the box has 2 GB RAM. Stream the geojsonl line by line. A dict tile->list of buildings is fine (each building lands in exactly one z15 tile). For roads, first group by tile in a dict tile->list of feature ids, then emit. Do NOT hold parsed shapely-like structures; plain lists only. Write each tile file as soon as its list is complete or at the end from the dicts.

PERFORMANCE: must process 1.5M buildings in < ~90 seconds on a weak 2-core box. Use fast parsing: json.loads per line is acceptable, but avoid regex per coordinate. Use math.floor for tile indexing (standard slippy-map formula with latitude clamp). No printing per line; print a one-line summary at the end: number of building tiles, road tiles, largest tile KB, total MB written.

Output the single fenced code block ```python pipeline/build_tiles.py with the complete file.
