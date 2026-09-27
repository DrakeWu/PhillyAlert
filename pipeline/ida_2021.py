"""Hurricane Ida (September 2021) replay for the Schuylkill River in Philadelphia.

Real inputs, all public and fetched without an account:
  * USGS gauge 01474500, Schuylkill River at Philadelphia (Fairmount Dam): 15-minute stage.
  * NWS flood categories for that gauge (PADP1).
  * USGS Short-Term Network high-water marks surveyed after Ida (event 312).
  * USGS 3DEP 1 m ground elevation, sampled every 30 m around the river.
  * OpenStreetMap water polygons, so the river itself isn't counted as flooded ground.
  * City of Philadelphia (L&I) building footprints, since routers live in buildings.

From those we estimate the flood footprint: ground inside the city, within 450 m of a surveyed
high-water mark, lower than the water surface interpolated from the nearest marks, not already
water, and connected to the river through other flooded ground. It's an estimate built only
from real measurements.

No Wi-Fi observations from 2021 exist in public, so the router layer is RECONSTRUCTED: the
same synthetic baseline as the demo, with routers going dark only inside the real footprint.
Assumptions (documented in the site's sidebar too):
  * a hexagon's routers are spread evenly over its buildings, so its exposure is the share of
    its building footprint under water (parks, rail yards and highways flood without routers);
  * every router on flooded ground loses power when the river crests;
  * 35% are back within 1-4 days, 20% stay off 1-4 weeks (cleanup, electrical inspection),
    45% are destroyed and replaced by a new router 2-7 weeks later;
  * the positioning database forgets a router only after it has been dark for 5-9 days, and
    re-learns a returning one within 2-6 days. Short outages therefore never show up.

The processed inputs are cached in raw/ida_2021/ so the build is reproducible offline;
pass --refresh to download them again.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

import build_dataset as bd

CACHE = bd.RAW / "ida_2021"
START = dt.date(2021, 8, 9)   # 60-day window: Aug 9 - Oct 7, 2021
CREST = dt.date(2021, 9, 2)
GAUGE = "01474500"
NWS_LID = "PADP1"
STN_EVENT = 312
SAMPLE_M = 30.0      # elevation lattice spacing
REACH_M = 450.0      # only ground this close to a surveyed mark can count as flooded
UA = "PhillyAlert-pipeline/1.0 (https://github.com/DrakeWu/PhillyAlert)"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
BUILDINGS = "https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/LI_BUILDING_FOOTPRINTS/FeatureServer/0"
EPQS = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples"


def _get(url: str, data: bytes | None = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def _cached(name: str, refresh: bool, build):
    path = CACHE / name
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    CACHE.mkdir(parents=True, exist_ok=True)
    value = build()
    path.write_text(json.dumps(value, separators=(",", ":")))
    print(f"  cached {path.relative_to(bd.HERE)}")
    return value


# ---------------------------------------------------------------- sources

def fetch_gauge(days: int) -> dict:
    end = START + dt.timedelta(days=days)
    q = urllib.parse.urlencode({"format": "json", "sites": GAUGE, "parameterCd": "00065,00060",
                                "startDT": START.isoformat(), "endDT": end.isoformat()})
    series = json.loads(_get(f"https://waterservices.usgs.gov/nwis/iv/?{q}"))["value"]["timeSeries"]
    by = {ts["variable"]["variableCode"][0]["value"]: ts["values"][0]["value"] for ts in series}
    stage, flow = by["00065"], by["00060"]
    daily = [None] * days
    for v in stage:
        i = (dt.date.fromisoformat(v["dateTime"][:10]) - START).days  # local (EDT) date
        if 0 <= i < days:
            daily[i] = max(daily[i] or 0.0, float(v["value"]))
    top = max(stage, key=lambda v: float(v["value"]))
    top_flow = next((float(v["value"]) for v in flow if v["dateTime"] == top["dateTime"]), None)
    nws = json.loads(_get(f"https://api.water.noaa.gov/nwps/v1/gauges/{NWS_LID}"))
    cats = nws["flood"]["categories"]
    record = max(nws["flood"]["crests"]["historic"], key=lambda c: c["stage"])
    return {
        "site": GAUGE,
        "name": "Schuylkill River at Philadelphia (Fairmount Dam)",
        "stageFt": [round(v, 2) if v is not None else None for v in daily],
        "crest": {"time": top["dateTime"][:16], "stageFt": float(top["value"]), "flowCfs": top_flow},
        "floodFt": {k: cats[k]["stage"] for k in ("action", "minor", "moderate", "major")},
        "record": {"stageFt": record["stage"], "year": int(record["occurredTime"][:4])},
    }


def fetch_hwms(city: dict) -> list[dict]:
    q = urllib.parse.urlencode({"Event": STN_EVENT, "States": "PA"})
    rows = json.loads(_get(f"https://stn.wim.usgs.gov/STNServices/HWMs/FilteredHWMs.json?{q}"))
    out = []
    for h in rows:
        lon, lat = h.get("longitude_dd"), h.get("latitude_dd")
        if lon is None or lat is None or not bd.point_in_geom(lon, lat, city):
            continue
        out.append({
            "id": h["hwm_id"],
            "label": (h.get("hwm_label") or "").strip(),
            "lon": round(lon, 6), "lat": round(lat, 6),
            "elevFt": h.get("elev_ft"),
            "depthFt": h.get("height_above_gnd"),
            "note": (h.get("hwm_locationdescription") or "").strip(),
            "site": (h.get("siteDescription") or "").strip(),
        })
    return out


def fetch_water(bbox: tuple[float, float, float, float]) -> list[list[list[float]]]:
    """OSM water areas as lists of edges' rings (one list per feature), for even-odd tests."""
    s, w, n, e = bbox
    q = (f'[out:json][timeout:90];(way["natural"="water"]({s},{w},{n},{e});'
         f'relation["natural"="water"]({s},{w},{n},{e}););out geom;')
    last = None
    for url in OVERPASS:
        try:
            els = json.loads(_get(url, urllib.parse.urlencode({"data": q}).encode(), timeout=150))["elements"]
            break
        except Exception as err:  # busy mirrors return 504s; try the next one
            last = err
    else:
        raise SystemExit(f"Overpass unavailable: {last}")
    features = []
    for el in els:
        parts = [el["geometry"]] if el["type"] == "way" else [m["geometry"] for m in el.get("members", []) if "geometry" in m]
        rings = [[[round(p["lon"], 6), round(p["lat"], 6)] for p in part] for part in parts if len(part) > 1]
        if rings:
            features.append(rings)
    return features


def fetch_elevations(points: list[tuple[float, float]]) -> list[float | None]:
    out: list[float | None] = []
    for i in range(0, len(points), 1000):
        chunk = points[i:i + 1000]
        body = urllib.parse.urlencode({
            "geometry": json.dumps({"points": chunk, "spatialReference": {"wkid": 4326}}),
            "geometryType": "esriGeometryMultipoint", "returnFirstValueOnly": "true", "f": "json",
        }).encode()
        samples = json.loads(_get(EPQS, body))["samples"]
        vals: list[float | None] = [None] * len(chunk)
        for smp in samples:
            try:
                vals[smp["locationId"]] = float(smp["value"])
            except (TypeError, ValueError):
                pass
        out += vals
        print(f"  elevation {min(i + 1000, len(points))}/{len(points)}")
    return out


# ---------------------------------------------------------------- footprint

def _even_odd(lon: float, lat: float, rings: list) -> bool:
    inside = False
    for ring in rings:  # every edge counts, so ring order and holes don't matter
        for a, b in zip(ring, ring[1:]):
            if (a[1] > lat) != (b[1] > lat) and lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def _index(features: list) -> list[tuple[list, tuple[float, float, float, float]]]:
    out = []
    for rings in features:
        xs = [p[0] for ring in rings for p in ring]; ys = [p[1] for ring in rings for p in ring]
        out.append((rings, (min(xs), min(ys), max(xs), max(ys))))
    return out


def _inside_any(lon: float, lat: float, indexed: list) -> bool:
    return any(x0 <= lon <= x1 and y0 <= lat <= y1 and _even_odd(lon, lat, rings) for rings, (x0, y0, x1, y1) in indexed)


def fetch_buildings(bbox: tuple[float, float, float, float]) -> list[list[list[float]]]:
    """City building footprints (L&I) intersecting a lon/lat box, as ring lists."""
    x0, y0, x1, y1 = bbox
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": "1=1", "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects",
            "geometry": json.dumps({"xmin": x0, "ymin": y0, "xmax": x1, "ymax": y1, "spatialReference": {"wkid": 4326}}),
            "outSR": 4326, "outFields": "objectid", "geometryPrecision": 6,
            "resultOffset": offset, "resultRecordCount": 2000, "f": "json",
        })
        page = json.loads(_get(f"{BUILDINGS}/query?{q}"))
        feats = page.get("features", [])
        out += [f["geometry"]["rings"] for f in feats if f.get("geometry")]
        if not page.get("exceededTransferLimit") or not feats:
            return out
        offset += len(feats)


def sample_grid(cells: list[dict], hwms: list[dict]) -> list[list]:
    """Lattice points around the river: [lon, lat, elevation m | None, is_water, is_building, q, r]."""
    marks = [bd.to_xy(h["lon"], h["lat"]) for h in hwms]
    near = lambda x, y: min(math.hypot(x - mx, y - my) for mx, my in marks)
    cand = [c for c in cells if near(*bd.to_xy(*c["center"])) <= REACH_M + bd.HEX_SIZE_M]
    rows = []
    for i, c in enumerate(cand):
        cx, cy = bd.hex_center(c["q"], c["r"])
        n = int(bd.HEX_SIZE_M // SAMPLE_M) + 1
        gx, gy = np.meshgrid(cx + np.arange(-n, n + 1) * SAMPLE_M, cy + np.arange(-n, n + 1) * SAMPLE_M)
        q, r = bd.xy_to_hex(gx.ravel(), gy.ravel())
        keep = (q == c["q"]) & (r == c["r"])
        pts = [tuple(round(v, 6) for v in bd.to_lonlat(x, y)) for x, y in zip(gx.ravel()[keep], gy.ravel()[keep])]
        lons = [p[0] for p in pts]; lats = [p[1] for p in pts]
        blds = _index(fetch_buildings((min(lons), min(lats), max(lons), max(lats))))
        rows += [[lon, lat, None, 0, int(_inside_any(lon, lat, blds)), c["q"], c["r"]] for lon, lat in pts]
        print(f"  buildings {i + 1}/{len(cand)} hexagons")
    lons = [r[0] for r in rows]; lats = [r[1] for r in rows]
    water = _index(fetch_water((min(lats) - 0.01, min(lons) - 0.01, max(lats) + 0.01, max(lons) + 0.01)))
    for row, z in zip(rows, fetch_elevations([[r[0], r[1]] for r in rows])):
        row[2] = None if z is None else round(z, 2)
        row[3] = int(_inside_any(row[0], row[1], water))
    return rows


def build_footprint(samples: list[list], hwms: list[dict], city: dict) -> dict:
    marks = [bd.to_xy(h["lon"], h["lat"]) for h in hwms]
    surveyed = [(*bd.to_xy(h["lon"], h["lat"]), h["elevFt"] * 0.3048) for h in hwms if h["elevFt"]]

    def water_surface(x: float, y: float) -> float:
        d = sorted((math.hypot(x - mx, y - my), z) for mx, my, z in surveyed)[:3]
        w = [1 / max(dd, 1.0) ** 2 for dd, _ in d]
        return sum(wi * z for wi, (_, z) in zip(w, d)) / sum(w)

    # Bathtub model with connectivity: ground is flooded when it's below the local water surface
    # AND joined to the river through other flooded ground (so rail cuts and underpasses behind
    # high ground don't count). Neighbors are lattice points within 1.6 spacings of each other.
    xy = [bd.to_xy(r[0], r[1]) for r in samples]
    below = [False] * len(samples)
    depth = [0.0] * len(samples)
    inside = [bd.point_in_geom(r[0], r[1], city) for r in samples]  # hexagons on the city line reach past it
    for i, ((x, y), (lon, lat, z, is_water, *_)) in enumerate(zip(xy, samples)):
        if not inside[i] or z is None or is_water or min(math.hypot(x - mx, y - my) for mx, my in marks) > REACH_M:
            continue
        depth[i] = water_surface(x, y) - z
        below[i] = depth[i] > 0
    grid: dict[tuple[int, int], list[int]] = {}
    for i, (x, y) in enumerate(xy):
        grid.setdefault((int(x // SAMPLE_M), int(y // SAMPLE_M)), []).append(i)
    reach = SAMPLE_M * 1.6
    wet = [bool(r[3]) for r in samples]  # start from the river itself
    stack = [i for i, w in enumerate(wet) if w]
    while stack:
        i = stack.pop()
        gx, gy = int(xy[i][0] // SAMPLE_M), int(xy[i][1] // SAMPLE_M)
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if not wet[j] and below[j] and math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]) <= reach:
                        wet[j] = True
                        stack.append(j)

    stats: dict[str, dict] = {}
    flooded_pts = []
    for i, (lon, lat, z, is_water, is_bldg, q, r) in enumerate(samples):
        s = stats.setdefault(f"{q},{r}", {"land": 0, "flooded": 0, "bldg": 0, "bldgFlooded": 0})
        if not inside[i] or z is None or is_water:
            continue
        s["land"] += 1
        s["bldg"] += is_bldg
        if wet[i]:
            s["flooded"] += 1
            s["bldgFlooded"] += is_bldg
            flooded_pts.append([lon, lat, round(depth[i], 1)])
    cells = {}
    for k, v in stats.items():
        if not v["flooded"]:
            continue
        # Routers live in buildings: a hexagon's exposure is the share of its buildings under water.
        # Too few buildings sampled to say (parks, rail yards) -> treat as no routers exposed.
        share = v["bldgFlooded"] / v["bldg"] if v["bldg"] >= 8 else 0.0
        cells[k] = {**v, "landShare": round(v["flooded"] / v["land"], 4), "share": round(share, 4)}
    return {"sampleM": SAMPLE_M, "reachM": REACH_M, "cells": cells, "points": flooded_pts}


# ---------------------------------------------------------------- simulation

def simulate(cells: list[dict], rng: np.random.Generator, footprint: dict, days: int) -> None:
    crest = (CREST - START).days
    lag_forget = lambda n: rng.integers(5, 10, n)  # dark this long before the database drops it
    lag_learn = lambda n: rng.integers(2, 7, n)    # time to re-learn a returning router
    lag_new = lambda n: rng.integers(5, 10, n)     # time to learn a brand-new router
    for c in cells:
        base = int(rng.poisson(38 * bd.density_at(*c["center"]) + 4))
        gone = np.full(base, days, dtype=int)
        back = np.full(base, days * 2, dtype=int)
        churn = rng.random(base) < 0.08 * days / 30
        gone[churn] = rng.integers(0, days, churn.sum())
        returns = churn & (rng.random(base) < 0.25)
        back[returns] = gone[returns] + rng.integers(3, 20, returns.sum())
        new_per_day = rng.poisson(base * 0.0025, days).astype(float)

        share = footprint["cells"].get(f"{c['q']},{c['r']}", {}).get("share", 0.0)
        hit = (rng.random(base) < share) & (gone > crest)
        if hit.any():
            n = int(hit.sum())
            fate = rng.random(n)
            off = np.where(fate < 0.35, rng.integers(1, 5, n),            # power back in days
                  np.where(fate < 0.55, rng.integers(7, 29, n),           # closed for weeks
                           rng.integers(14, 50, n)))                      # destroyed, replaced later
            destroyed = fate >= 0.55
            forget = lag_forget(n)
            dropped = off > forget
            idx = np.flatnonzero(hit)
            gone[idx[dropped]] = crest + forget[dropped]
            ok = dropped & ~destroyed
            back[idx[ok]] = crest + off[ok] + lag_learn(ok.sum())
            # A destroyed router never returns; its replacement is a new router.
            seen_new = crest + off[destroyed] + lag_new(destroyed.sum())
            for d in seen_new[seen_new < days]:
                new_per_day[d] += 1
        d = np.arange(days)[:, None]
        present = (d < gone[None, :]) | (d >= back[None, :])
        c["baseline"] = base
        c["alive"] = present.sum(axis=1).astype(int).tolist()
        c["new"] = np.cumsum(new_per_day).astype(int).tolist()


def build(cells: list[dict], city: dict, days: int, seed: int, refresh: bool) -> tuple[dt.date, dict]:
    print("Ida 2021 replay: gathering real inputs")
    gauge = _cached("gauge.json", refresh, lambda: fetch_gauge(days))
    hwms = _cached("hwms.json", refresh, lambda: fetch_hwms(city))
    samples = _cached("samples.json", refresh, lambda: sample_grid(cells, hwms))
    footprint = _cached("footprint.json", refresh, lambda: build_footprint(samples, hwms, city))
    simulate(cells, np.random.default_rng(seed), footprint, days)
    flooded_km2 = len(footprint["points"]) * SAMPLE_M ** 2 / 1e6
    print(f"  {len(hwms)} high-water marks, crest {gauge['crest']['stageFt']} ft, "
          f"~{flooded_km2:.2f} km² flooded across {len(footprint['cells'])} hexagons")
    crest = (CREST - START).days
    scenario = {
        "id": "ida-2021",
        "title": "Ida flood, September 2021",
        "eventDay": crest,
        "focusDay": crest + 10,
        "gauge": gauge,
        "hwms": [{k: h[k] for k in ("label", "lon", "lat", "depthFt", "note")} for h in hwms],
        "flood": {"sampleM": SAMPLE_M, "points": footprint["points"], "km2": round(flooded_km2, 2)},
        "sources": [
            {"label": "USGS gauge 01474500", "url": f"https://waterdata.usgs.gov/monitoring-location/{GAUGE}/"},
            {"label": "USGS high-water marks, Ida 2021", "url": "https://stn.wim.usgs.gov/FEV/#2021Ida"},
            {"label": "USGS 3DEP elevation", "url": "https://www.usgs.gov/3d-elevation-program"},
            {"label": "NWS flood categories (PADP1)", "url": "https://water.noaa.gov/gauges/padp1"},
        ],
    }
    return START, scenario
