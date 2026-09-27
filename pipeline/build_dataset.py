"""Build the aggregated Wi-Fi churn dataset that powers the PhillyPulse map.

The idea comes from "Surveilling the Masses with Wi-Fi-Based Positioning Systems"
(Rye & Levin, 2024): when a Wi-Fi access point loses power or is destroyed, it
drops out of Wi-Fi positioning databases roughly a week later. Tracking the
fraction of a neighborhood's *baseline* APs that are still present, and comparing
it against a citywide control, surfaces outages and disasters (their Lahaina and
Gaza case studies).

This script only ever emits AGGREGATES:
  * APs are bucketed into ~450 m hexagons clipped to the Philadelphia city limits.
  * Per cell and per day we store two integers: baseline APs still present, and
    newly-seen APs. No BSSIDs, SSIDs or per-device coordinates leave this script.
  * Cells with fewer than K_MIN baseline APs are suppressed.
  * In --snapshots mode, networks that opted out (_nomap / _optout SSIDs) and
    locally-administered (randomized / phone-hotspot) MACs are discarded before
    anything else happens, and BSSIDs are salted-hashed in memory.

Modes
-----
  python build_dataset.py --simulate            # synthetic demo (default)
  python build_dataset.py --snapshots DIR       # real, authorized observations

Snapshot CSVs (one file per day, named YYYY-MM-DD.csv) need the columns
  bssid,lat,lon[,ssid]
and must come from a source you are authorized to use: a city/campus network
inventory, consenting volunteer surveys, or a provider whose terms allow it.
This project intentionally does NOT include a client for scraping Apple's (or
anyone's) Wi-Fi positioning service.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import secrets
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT_DIR = HERE.parent / "data"

HEX_SIZE_M = 260.0  # hex circumradius -> ~450 m across flats, ~0.18 km^2
K_MIN = 25          # suppress cells with fewer baseline APs than this
DAYS = 60
LAT0, LON0 = 39.9526, -75.1652  # City Hall; origin of the local projection
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))


# ---------------------------------------------------------------- geometry

def to_xy(lon: float, lat: float) -> tuple[float, float]:
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def to_lonlat(x: float, y: float) -> tuple[float, float]:
    return LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT


def hex_center(q: int, r: int) -> tuple[float, float]:
    """Pointy-top axial hex -> projected meters."""
    x = HEX_SIZE_M * math.sqrt(3) * (q + r / 2)
    y = HEX_SIZE_M * 1.5 * r
    return x, y


def xy_to_hex(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    qf = (math.sqrt(3) / 3 * x - y / 3) / HEX_SIZE_M
    rf = (2 / 3 * y) / HEX_SIZE_M
    sf = -qf - rf
    q, r, s = np.round(qf), np.round(rf), np.round(sf)
    dq, dr, ds = np.abs(q - qf), np.abs(r - rf), np.abs(s - sf)
    fix_q = (dq > dr) & (dq > ds)
    fix_r = ~fix_q & (dr > ds)
    q = np.where(fix_q, -r - s, q)
    r = np.where(fix_r, -q - s, r)
    return q.astype(int), r.astype(int)


def hex_polygon(q: int, r: int) -> list[list[float]]:
    cx, cy = hex_center(q, r)
    ring = []
    for i in range(6):
        a = math.radians(60 * i - 30)
        lon, lat = to_lonlat(cx + HEX_SIZE_M * math.cos(a), cy + HEX_SIZE_M * math.sin(a))
        ring.append([round(lon, 6), round(lat, 6)])
    ring.append(ring[0])
    return ring


def point_in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geom(lon: float, lat: float, geom: dict) -> bool:
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, h) for h in poly[1:]):
            return True
    return False


def load_boundaries():
    city = json.loads((RAW / "city_limits.geojson").read_text())["features"][0]["geometry"]
    hoods = json.loads((RAW / "neighborhoods.geojson").read_text())["features"]
    return city, hoods


def build_grid(city: dict, hoods: list) -> list[dict]:
    ring = city["coordinates"][0] if city["type"] == "Polygon" else city["coordinates"][0][0]
    xs, ys = zip(*(to_xy(lon, lat) for lon, lat in ring))
    cells = []
    rmin = int(min(ys) / (HEX_SIZE_M * 1.5)) - 2
    rmax = int(max(ys) / (HEX_SIZE_M * 1.5)) + 2
    for r in range(rmin, rmax + 1):
        span = HEX_SIZE_M * math.sqrt(3)
        q_lo = int((min(xs) / span) - r / 2) - 2
        q_hi = int((max(xs) / span) - r / 2) + 2
        for q in range(q_lo, q_hi + 1):
            cx, cy = hex_center(q, r)
            lon, lat = to_lonlat(cx, cy)
            if not point_in_geom(lon, lat, city):
                continue
            hood = next((h["properties"]["MAPNAME"] for h in hoods if point_in_geom(lon, lat, h["geometry"])), None)
            cells.append({"q": q, "r": r, "center": [round(lon, 6), round(lat, 6)], "hood": hood or "Philadelphia"})
    return cells


# ---------------------------------------------------------------- simulation

# Relative AP density: (lon, lat, sigma_m, weight). Rowhouse neighborhoods are dense,
# Center City / University City densest, parks, rail yards and the airport sparse.
DENSITY_PEAKS = [
    (-75.1652, 39.9526, 1300, 9.0),   # Center City
    (-75.1930, 39.9530, 900, 6.0),    # University City
    (-75.1550, 39.9810, 700, 4.0),    # Temple / North Broad
    (-75.1700, 39.9300, 2200, 4.0),   # South Philly
    (-75.2250, 39.9600, 2200, 3.2),   # West Philly
    (-75.1300, 39.9900, 1800, 3.6),   # Kensington / Fishtown
    (-75.1600, 40.0050, 2200, 3.0),   # North Philly
    (-75.0900, 40.0200, 2500, 2.6),   # Frankford / Lower NE
    (-75.0500, 40.0600, 3500, 1.8),   # Northeast
    (-75.1800, 40.0400, 2200, 2.0),   # Germantown
    (-75.2250, 40.0250, 1200, 1.8),   # Manayunk / Roxborough
    (-75.2350, 39.9250, 1800, 1.8),   # Southwest
]
SPARSE = [  # (lon, lat, radius_m, multiplier)
    (-75.2420, 39.8740, 2600, 0.03),  # PHL airport
    (-75.2100, 40.0550, 1800, 0.08),  # Wissahickon
    (-75.2000, 39.9900, 1200, 0.15),  # East/West Fairmount Park
    (-75.1800, 39.9000, 1100, 0.10),  # FDR Park / sports complex
    (-75.1750, 39.8900, 1500, 0.08),  # Navy Yard
    (-75.2500, 39.8950, 1300, 0.06),  # Heinz Refuge
    (-75.0150, 40.0800, 1500, 0.30),  # Pennypack
]

# Scenario events, day offsets into the 60-day window (day 59 == today).
# offline_frac: share of the cell's baseline APs that lose power/are destroyed.
# restore_day: when power returns (None = not yet). WPS reflects both with ~7 day lag.
EVENTS = [
    dict(kind="outage", center=(-75.1120, 39.9920), radius=1500, start=18, restore=27, offline=0.62,
         note="Storm-driven outage, Port Richmond / Kensington"),
    dict(kind="structural", center=(-75.2280, 39.9665), radius=160, start=36, restore=None, offline=0.16,
         note="Rowhome block fire, Haddington"),
    dict(kind="outage", center=(-75.2330, 39.9030), radius=1200, start=43, restore=None, offline=0.48,
         note="Flood-related outage, Eastwick"),
    dict(kind="outage", center=(-75.2230, 40.0240), radius=550, start=50, restore=None, offline=0.40,
         note="Main St flooding, Manayunk"),
    dict(kind="influx", center=(-75.1560, 39.9810), radius=800, start=22, restore=None, offline=-0.38,
         note="Semester move-in, Temple"),
]


def density_at(lon: float, lat: float) -> float:
    x, y = to_xy(lon, lat)
    d = 0.35
    for plon, plat, sig, w in DENSITY_PEAKS:
        px, py = to_xy(plon, plat)
        d += w * math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * sig ** 2))
    for slon, slat, rad, mult in SPARSE:
        sx, sy = to_xy(slon, slat)
        if (x - sx) ** 2 + (y - sy) ** 2 < rad ** 2:
            d *= mult
    return d


def simulate(cells: list[dict], rng: np.random.Generator) -> None:
    lag_on = lambda n: rng.integers(5, 10, n)  # days until WPS forgets / learns an AP
    for c in cells:
        base = int(rng.poisson(38 * density_at(*c["center"]) + 4))
        cx, cy = to_xy(*c["center"])
        # Per-AP day on which it disappears from the WPS (DAYS == never), and returns.
        gone = np.full(base, DAYS, dtype=int)
        back = np.full(base, DAYS * 2, dtype=int)
        # Natural churn: ~8% of APs vanish per month (paper, Fig. 5), some come back.
        churn = rng.random(base) < 0.08 * DAYS / 30
        gone[churn] = rng.integers(0, DAYS, churn.sum())
        returns = churn & (rng.random(base) < 0.25)
        back[returns] = gone[returns] + rng.integers(3, 20, returns.sum())
        new_rate = 0.0025  # newly-seen APs per baseline AP per day
        influx = np.zeros(DAYS)
        for ev in EVENTS:
            ex, ey = to_xy(*ev["center"])
            dist = math.hypot(cx - ex, cy - ey)
            if dist > ev["radius"] + HEX_SIZE_M:
                continue
            strength = 1.0 if dist <= ev["radius"] else max(0.0, 1 - (dist - ev["radius"]) / HEX_SIZE_M)
            frac = ev["offline"] * strength * rng.uniform(0.85, 1.1)
            if ev["kind"] == "influx":
                # New APs appear over ~8 days, once the WPS lag has passed.
                d = np.arange(DAYS)
                influx += np.where((d >= ev["start"] + 6) & (d < ev["start"] + 14), -frac / 8, 0.0)
                continue
            hit = (rng.random(base) < frac) & (gone >= ev["start"])
            gone[hit] = ev["start"] + lag_on(hit.sum())
            if ev["restore"] is not None:
                # Destroyed devices never return; powered-off ones do once power is back.
                comes_back = hit & (rng.random(base) < 0.93)
                back[comes_back] = np.maximum(gone[comes_back] + 1, ev["restore"] + lag_on(comes_back.sum()))
        days = np.arange(DAYS)[:, None]
        present = (days < gone[None, :]) | (days >= back[None, :])
        c["baseline"] = base
        c["alive"] = present.sum(axis=1).astype(int).tolist()
        lam = base * (new_rate + np.maximum(influx, 0))
        c["new"] = np.cumsum(rng.poisson(lam)).astype(int).tolist()


# ---------------------------------------------------------------- real ingestion

def is_locally_administered(bssid: str) -> bool:
    try:
        return bool(int(bssid.replace("-", ":").split(":")[0], 16) & 0x02)
    except ValueError:
        return True


def ingest(cells: list[dict], snap_dir: Path, baseline_days: int) -> tuple[dt.date, int]:
    files = sorted(snap_dir.glob("*.csv"))
    if len(files) <= baseline_days:
        raise SystemExit(f"need more than {baseline_days} daily snapshots in {snap_dir}")
    salt = secrets.token_bytes(16)  # per-run, never written anywhere
    index = {(c["q"], c["r"]): c for c in cells}
    daily: list[dict[bytes, tuple[int, int]]] = []
    for f in files:
        seen: dict[bytes, tuple[int, int]] = {}
        with f.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                ssid = (row.get("ssid") or "").lower()
                if ssid.endswith("_nomap") or "_optout" in ssid or is_locally_administered(row["bssid"]):
                    continue
                x, y = to_xy(float(row["lon"]), float(row["lat"]))
                q, r = xy_to_hex(np.array([x]), np.array([y]))
                key = (int(q[0]), int(r[0]))
                if key in index:
                    h = hashlib.blake2b(row["bssid"].lower().encode(), key=salt, digest_size=12).digest()
                    seen[h] = key
        daily.append(seen)
    baseline: dict[bytes, tuple[int, int]] = {}
    for seen in daily[:baseline_days]:
        baseline.update(seen)
    for c in cells:
        c["baseline"], c["alive"], c["new"] = 0, [0] * (len(daily) - baseline_days), [0] * (len(daily) - baseline_days)
    for key in baseline.values():
        index[key]["baseline"] += 1
    ever: set[bytes] = set(baseline)
    for i, seen in enumerate(daily[baseline_days:]):
        for h, key in seen.items():
            if h in baseline:
                index[baseline[h]]["alive"][i] += 1
            elif h not in ever:
                ever.add(h)
                index[key]["new"][i] += 1
    for c in cells:
        c["new"] = np.cumsum(c["new"]).astype(int).tolist()
    start = dt.date.fromisoformat(files[baseline_days].stem)
    return start, len(daily) - baseline_days


# ---------------------------------------------------------------- output

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshots", type=Path, help="directory of daily YYYY-MM-DD.csv snapshots")
    ap.add_argument("--baseline-days", type=int, default=7)
    ap.add_argument("--seed", type=int, default=215)
    ap.add_argument("--end", type=dt.date.fromisoformat, default=dt.date.today(), help="last day (simulate mode)")
    args = ap.parse_args()

    city, hoods = load_boundaries()
    cells = build_grid(city, hoods)

    if args.snapshots:
        start, days = ingest(cells, args.snapshots, args.baseline_days)
        simulated = False
    else:
        simulate(cells, np.random.default_rng(args.seed))
        start, days, simulated = args.end - dt.timedelta(days=DAYS - 1), DAYS, True

    kept = [c for c in cells if c["baseline"] >= K_MIN]
    out = {
        "meta": {
            "simulated": simulated,
            "start": start.isoformat(),
            "days": days,
            "hexSizeM": HEX_SIZE_M,
            "origin": [LON0, LAT0],
            "mPerDeg": [M_PER_DEG_LON, M_PER_DEG_LAT],
            "kMin": K_MIN,
            "suppressedCells": len(cells) - len(kept),
            "wpsLagDays": 7,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        },
        "cells": [
            {
                "id": i,
                "q": c["q"],
                "r": c["r"],
                "center": c["center"],
                "poly": hex_polygon(c["q"], c["r"]),
                "hood": c["hood"],
                "baseline": c["baseline"],
                "alive": c["alive"],
                "new": c["new"],
            }
            for i, c in enumerate(kept)
        ],
    }
    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "wifi_churn.json").write_text(json.dumps(out, separators=(",", ":")))

    # Lightweight copies of the boundaries for the map (5-decimal precision).
    def rounded(o):
        if isinstance(o, float):
            return round(o, 5)
        if isinstance(o, list):
            return [rounded(v) for v in o]
        return o

    hood_fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": h["properties"]["MAPNAME"]},
             "geometry": {"type": h["geometry"]["type"], "coordinates": rounded(h["geometry"]["coordinates"])}}
            for h in hoods
        ],
    }
    (OUT_DIR / "neighborhoods.geojson").write_text(json.dumps(hood_fc, separators=(",", ":")))
    (OUT_DIR / "city_limits.geojson").write_text(json.dumps(
        {"type": "Feature", "properties": {}, "geometry": {"type": city["type"], "coordinates": rounded(city["coordinates"])}},
        separators=(",", ":")))

    total = sum(c["baseline"] for c in kept)
    print(f"{'simulated' if simulated else 'ingested'}: {len(kept)} cells ({out['meta']['suppressedCells']} suppressed), "
          f"{total:,} baseline APs, {days} days from {start}")


if __name__ == "__main__":
    main()
