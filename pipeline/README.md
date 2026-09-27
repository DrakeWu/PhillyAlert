# Data pipeline

`build_dataset.py` produces `../data/wifi_churn.json`, the only Wi‑Fi data the website loads.

## Simulated demo (default)

```bash
python build_dataset.py --seed 215
```

This generates about 190k synthetic APs, with density shaped like Philadelphia (dense rowhouse neighborhoods, sparse parks, rail yards and airport). It adds natural churn of about 8% per month (the paper's Fig. 5) and the five scenario events listed in `EVENTS`. Edit `EVENTS` to stage your own: `start` and `restore` are day offsets into the 60-day window, and `offline` is the share of baseline APs affected. Use `--end YYYY-MM-DD` to pin the window's last day.

## Real observations

```bash
python build_dataset.py --snapshots path/to/daily_csvs --baseline-days 7
```

Provide one CSV per day, named `YYYY-MM-DD.csv`, with the columns `bssid,lat,lon[,ssid]`. The first `--baseline-days` files define the baseline; every later file becomes one day on the map.

On ingest the script:

1. drops `_nomap` / `_optout` SSIDs and locally administered (randomized or hotspot) MACs;
2. hashes every BSSID with a random per-run salt that is never written anywhere;
3. bins each observation into its hex cell;
4. writes only per-cell daily counts, and suppresses cells with fewer than 25 baseline APs.

### Where real data can legitimately come from

- **Networks the city or a partner operates.** Examples include municipal and library Wi‑Fi, PHLConnectED sites, and campus networks (such as Temple's). Their controllers already report which APs are up each day.
- **Consenting volunteer surveys.** Repeated drive or walk surveys by people who agreed to take part.
- **Providers whose terms allow this use.** Check the terms of service before pulling from any third-party dataset.
- **ISP or utility partners.** They can share already-aggregated per-area "devices online" counts; skip the hashing step and write the counts directly.

Do **not** harvest Apple's or Google's Wi‑Fi positioning APIs. Enumerating them is the privacy attack the paper describes, and it may violate those services' terms and computer-misuse laws.
