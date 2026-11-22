#!/usr/bin/env python3
"""Generate a Zombie TD level pack from OpenStreetMap buildings.

    python3 tools/levelgen/levelgen.py --name paris-marais --lat 48.8580 --lon 2.3580

Queries the Overpass API once (building ways around the centre, at the largest
radius that could be needed), then grows the radius locally in 50 m steps until
the building count is inside the target range. Writes levels/<name>.json.

Only this tool touches the network. Tests and the web app read the committed
JSON.
"""

import argparse
import json
import math
import sys
import time

import requests
from shapely.geometry import Point, Polygon
from shapely.validation import make_valid

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "zombie-td-levelgen/0.1 (proof-of-concept level generator; one query per run)"

RESIDENTIAL = {
    "yes", "residential", "house", "apartments", "detached", "semidetached_house",
    "terrace", "bungalow", "dormitory", "farm", "cabin", "houseboat", "static_caravan",
}
COMMERCIAL = {
    "commercial", "retail", "office", "supermarket", "hotel", "kiosk", "shop",
    "mall", "restaurant", "bank", "warehouse", "industrial",
}

MIN_AREA_M2 = 15.0
RADIUS_STEP_M = 50.0


def project(lat, lon, lat0, lon0):
    """Equirectangular projection to local meters, as the spec defines it."""
    x = (lon - lon0) * math.cos(math.radians(lat0)) * 111320.0
    y = (lat - lat0) * 110540.0
    return x, y


def floors_of(tags):
    for key, div in (("building:levels", 1.0), ("height", 3.0)):
        v = tags.get(key)
        if v is None:
            continue
        try:
            f = float(str(v).split(";")[0].replace("m", "").strip()) / div
            if f > 0:
                return max(1.0, round(f, 1))
        except ValueError:
            pass
    return 2.0


def kind_of(tags):
    b = tags.get("building", "yes")
    if b in COMMERCIAL:
        return "commercial"
    if b in RESIDENTIAL:
        return "residential"
    return "other"


def query(lat, lon, radius):
    q = f"[out:json][timeout:120];way[\"building\"](around:{radius:.0f},{lat},{lon});out tags geom;"
    for attempt in range(4):
        r = requests.post(OVERPASS_URL, data={"data": q}, headers={"User-Agent": USER_AGENT}, timeout=180)
        if r.status_code == 200:
            return r.json()["elements"]
        if r.status_code in (429, 504):
            wait = 30 * (attempt + 1)
            print(f"overpass busy ({r.status_code}), waiting {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        r.raise_for_status()
    raise SystemExit("Overpass did not answer")


def buildings_within(elements, lat0, lon0, radius):
    circle = Point(0, 0).buffer(radius, resolution=64)
    out = []
    for el in elements:
        geom = el.get("geometry")
        if el.get("type") != "way" or not geom or len(geom) < 4:
            continue
        pts = [project(p["lat"], p["lon"], lat0, lon0) for p in geom]
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = make_valid(poly)
        if poly.is_empty:
            continue
        clipped = poly.intersection(circle)
        if clipped.is_empty:
            continue
        parts = [clipped] if clipped.geom_type == "Polygon" else [g for g in getattr(clipped, "geoms", []) if g.geom_type == "Polygon"]
        if not parts:
            continue
        part = max(parts, key=lambda g: g.area)
        if part.area < MIN_AREA_M2:
            continue
        ring = list(part.exterior.coords)[:-1]
        tags = el.get("tags", {})
        out.append({
            "id": el["id"],
            "kind": kind_of(tags),
            "floors": floors_of(tags),
            "polygon": [[round(x, 2), round(y, 2)] for x, y in ring],
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--min-buildings", type=int, default=600)
    ap.add_argument("--max-buildings", type=int, default=1200)
    ap.add_argument("--start-radius", type=float, default=100.0)
    ap.add_argument("--query-radius", type=float, default=700.0, help="radius of the single Overpass query")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    elements = query(a.lat, a.lon, a.query_radius)
    print(f"overpass returned {len(elements)} ways within {a.query_radius:.0f} m", file=sys.stderr)

    radius = a.start_radius
    best = None
    while radius <= a.query_radius:
        b = buildings_within(elements, a.lat, a.lon, radius)
        print(f"  radius {radius:.0f} m -> {len(b)} buildings", file=sys.stderr)
        if a.min_buildings <= len(b) <= a.max_buildings:
            best = (radius, b)
            break
        if len(b) > a.max_buildings:
            break
        radius += RADIUS_STEP_M
    if best is None:
        raise SystemExit(f"no radius up to {a.query_radius:.0f} m gives {a.min_buildings}-{a.max_buildings} buildings; "
                         "adjust --query-radius or the range")
    radius, buildings = best
    pack = {
        "name": a.name,
        "center_lat": a.lat,
        "center_lon": a.lon,
        "radius_m": radius,
        "source": "OpenStreetMap contributors (ODbL), via Overpass API",
        "generated_at": time.strftime("%Y-%m-%d"),
        "buildings": buildings,
    }
    out = a.out or f"levels/{a.name}.json"
    with open(out, "w") as f:
        json.dump(pack, f, separators=(",", ":"))
    print(f"wrote {out}: {len(buildings)} buildings, radius {radius:.0f} m", file=sys.stderr)


if __name__ == "__main__":
    main()
