# True NENDY — parkrun road-distance planner (unofficial)

parkrun's NENDY (Nearest Event Not Done Yet) is measured as the crow flies.
This little web app computes your **true NENDY** — ranked by actual driving
distance or drive time — for all 550 Australian parkrun events.

## How to run

Any static file server works. Easiest:

```
python -m http.server 8017
```

then open http://localhost:8017. (Opening `index.html` directly in a browser
also works.)

## How to use

1. **Home base** — search a suburb/address, use your GPS location, or click the map.
2. **Events you've done** — two ways:
   - **Bulk import (recommended):** enter your parkrun ID; the app links to your
     results page (`parkrun.com.au/parkrunner/<id>/all/`). Select-all + copy that
     page, paste it into the box, and hit *Import & show my top 10* — every
     Australian event you've run is ticked off in one go and your top 10 true
     NENDY appears immediately. Names that aren't current Australian events
     (overseas or closed ones) are listed so nothing is silently dropped.
   - **Manual:** type to search, click to tick off; click a chip to remove.
     You can also mark events done from their map popups.

   Everything is saved in your browser (localStorage), so it persists between visits.
3. **Compute NENDY by road** — shortlists your nearest undone events by
   crow-flies, then queries OSRM for real driving distance and duration in a
   single matrix call. Rank by road distance or drive time; the Δ column shows
   how each event moved versus the official crow-flies ranking. Click any row
   to draw the driving route on the map.

## Data & services

- `events-au.js` — Australian events extracted from the official
  `https://images.parkrun.com/events.json` (snapshot 2026-07-20). Re-download
  and re-extract to refresh when new events launch.
- Routing: the free public [OSRM](https://project-osrm.org) demo server
  (per-request, no API key). Occasionally busy — just retry.
- Geocoding: OpenStreetMap Nominatim.
- Map: Leaflet + OpenStreetMap tiles.

Not affiliated with parkrun. Route times are OSRM estimates and ignore
Saturday-morning traffic.
