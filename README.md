# PhillyPulse

PhillyPulse shows neighborhood disruption signals for Philadelphia, detected from aggregate Wi‑Fi access-point churn and cross-referenced with live Philly311 reports.

The core observation comes from *Surveilling the Masses with Wi‑Fi‑Based Positioning Systems* (Rye & Levin, 2024). When a Wi‑Fi access point (AP) loses power or is destroyed, it drops out of Wi‑Fi positioning databases about a week later. After the Maui fire, the APs that vanished from Apple's WPS lined up with the burn map. In Gaza, the share of still-visible APs fell far below a Tel Aviv control group. PhillyPulse turns that idea around for civic use: it watches Philadelphia at the neighborhood level for outages, floods, fires and sudden influxes. It never tracks individual devices.

## Run it

You only need Python 3. There is no Node or build step.

```bash
python pipeline/build_dataset.py
```

```bash
python -m http.server 8321
```

Then open http://localhost:8321.

`build_dataset.py` writes `data/wifi_churn.json` (a simulated demo ending today) plus the city and neighborhood boundaries. Re-run it any day to slide the window forward.

## What you're looking at

| Piece | What it does |
| --- | --- |
| **Map** | About 1,700 hexagons (roughly 450 m across) clipped to the city limits. They're colored by how each cell's share of *baseline* APs still visible compares with the city median. Red means more loss than the city; blue means more gain. |
| **Alert (top right)** | The most severe active incident, with suggested actions: zoom, show nearby 311 reports, PECO outage map, copy a text brief. |
| **Incident insights (bottom right)** | Every detected incident. Each has an area-vs-control chart (the same comparison as the paper's Figure 12), the signal onset, a likely event date after subtracting the lag, the number of APs dark, and live 311 reports in those cells. Click any hexagon to inspect it. |
| **Timeline** | Scrub or play through the 60-day window. Charts never show data after the selected day. |
| **Detection sliders** | Minimum drop vs. city, z-score threshold, and minimum APs per cell. Lower them to see the noise floor. |
| **311 layer** | Real, live infrastructure requests from `phl.carto.com`: street and alley light outages, traffic signal emergencies, dangerous buildings, fire safety, inlets, hydrants and manholes. |

### The simulated scenarios

The demo dataset contains these events, so you can see how each kind of signal looks:

| Scenario | What the signal does |
| --- | --- |
| Storm outage in Port Richmond / Kensington | Power is restored, so APs come back a week later and the incident resolves. |
| Rowhome fire in Haddington | One cell loses about 14% of its APs for good. |
| Flood outage in Eastwick / Penrose | Active and critical at the end of the window. |
| Main St flooding in Manayunk | Emerging: first flagged 3 days before the end of the window. |
| Semester move-in around Temple (Hartranft / North Central) | A surge of newly seen APs, flagged as a population influx. |

Every scenario includes the ~7-day positioning-database lag the paper measured (§7).

## Method

1. **Baseline.** Each cell's APs present during a baseline week.
2. **Daily counts per cell.** Baseline APs still present (`alive`) and cumulative newly seen APs (`new`). These two integers per cell per day are the *only* data the site receives.
3. **Control.** The baseline-weighted median cell. The paper used a separate region (Tel Aviv); inside one city a median does the same job, and a big outage can't drag it down.
4. **Flagging a loss.** The cell's surviving share is at least *X* points below the control, the binomial z-score is at or below −*z*, and at least 8 APs are involved.
5. **Flagging an influx.** The same test on new APs, using a Poisson model.
6. **Incidents.** Adjacent flagged cells are grouped, linked day to day, and kept once they persist for 3 days (or are happening on the latest day).
7. **Classification.** Four or more cells is a *widespread outage*; fewer is a *localized loss* (fire, collapse or demolition). An incident is *Restored* once its cells rejoin the control. Severity comes from the number of APs dark and the share of the area lost.

The detection runs in the browser (`js/detect.js`), so the sliders re-run it live.

## Privacy and ethics

The paper is primarily a warning. The same data that shows Lahaina burning also lets anyone follow a travel router across a border. This project keeps the useful half and designs out the harmful half:

- **Aggregate only.** No BSSID, SSID or per-AP coordinate reaches the browser. Cells with fewer than 25 baseline APs are suppressed.
- **Opt-outs are honored.** `_nomap` / `_optout` SSIDs, and locally administered (randomized or phone-hotspot) MACs, are dropped at ingest.
- **No linking.** BSSIDs are hashed with a per-run random salt that is never saved, so nothing can be linked across runs or used to track movement.
- **No scraping.** There is intentionally no client for Apple's (or Google's) positioning service here. Mass-querying it is exactly the abuse the paper disclosed, and Apple has since added mitigations. Real deployments should use data you're authorized to collect; see [`pipeline/README.md`](pipeline/README.md).

## Layout

```
index.html            page shell: map + three floating cards (mirrors the sample repo's UI)
css/styles.css        shadcn-style tokens, light + dark
js/app.js             map layers, timeline, alert, insights, 311 overlay
js/detect.js          control series, cell tests, incident tracking
js/chart.js           SVG area-vs-control chart with hover + table view
js/phl311.js          live Philly311 query (OpenDataPhilly Carto API)
js/icons.js           inline Lucide icons
pipeline/build_dataset.py   hex grid, simulator, and real-snapshot ingestion
pipeline/raw/         city limits + neighborhood boundaries (OpenDataPhilly)
data/                 generated dataset + simplified boundaries
```

## Credits

- Rye, E. & Levin, D. *Surveilling the Masses with Wi‑Fi‑Based Positioning Systems.* IEEE S&P 2024 (arXiv:2405.14975).
- Boundaries and 311 data: City of Philadelphia / OpenDataPhilly.
- Basemap: © CARTO, © OpenStreetMap contributors. Map rendering: MapLibre GL JS.
- UI structure adapted from [alangrewco/treehacks](https://github.com/alangrewco/treehacks).
