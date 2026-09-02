# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bus Stop Tracker — a self-hosted web app for logging which stops on the Victoria
Regional Transit System you've physically visited and which routes you've ridden.
It shows every stop on a Leaflet map (and a companion list view), lets you tick
stops/routes off, and syncs those ticks in real time to every other open client
over WebSocket. It also shares the live GPS location of each connected client on
the map.

## Running the app

```bash
npm install        # first time only — installs the one dependency (ws)
npm start          # => node server/server.js
```

Then open **https://localhost:3000** (accept the self-signed-cert warning).

- **Node 22+ is required** — the server uses the built-in `node:sqlite`
  (`DatabaseSync`) and `node:http`/`node:https` core modules. No build step, no
  bundler, no framework.
- **Port**: `3000` by default; override with `PORT=8080 npm start`.
- **HTTPS vs HTTP**: if `certs/key.pem` and `certs/cert.pem` both exist the server
  runs HTTPS, otherwise plain HTTP. The repo already has a self-signed pair
  (gitignored). Browser geolocation only works over HTTPS or on `localhost`, so
  keep the certs for LAN/mobile testing. To regenerate:
  ```bash
  mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem \
    -out certs/cert.pem -days 825 -subj '/CN=localhost' \
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ```
- The server binds `0.0.0.0`, so it's reachable from other devices on the LAN at
  `https://<your-ip>:3000` — that's the intended way to tick off stops from a
  phone while out riding.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for hosting this with Docker
(`Dockerfile` + `compose.yaml`) behind Tailscale — `tailscale serve` for TLS,
plus GTFS auto-refresh and backups.

### Smoke test without a browser

```bash
curl -sk https://localhost:3000/api/stops        | head -c 300   # stop list + visited flags
curl -sk https://localhost:3000/api/routes-meta  | head -c 200   # route names, colors, ridden flags
curl -sk https://localhost:3000/api/routes                        # bundled route shapes (GeoJSON)
```

Startup logs `Seeded N stops`, `Loaded and bundled N route shapes`, and
`Listening on https://0.0.0.0:3000` when healthy.

## Data

- **`data.sqlite`** (gitignored, ~300 KB) — the live database. Schema is created
  on startup by `server/db.js`. Only `visited` and `ridden_routes` hold user
  state; `stops` is re-seeded from CSV every start. Deleting it loses your ticks;
  it is rebuilt empty on next launch.
- **`Data/Victoria_Regional_Transit_System_stops.csv`** — checked in; seeds the
  `stops` table.
- **`Data/*_gtfs_*/`** (gitignored — `stop_times.txt` exceeds GitHub's 100 MB
  limit) — a raw GTFS feed extract. `server/loadRouteLines.js` and
  `server/loadStopRoutes.js` read it at startup for route geometry, colors, and
  stop↔route associations. Without a GTFS dir present the map still loads stops
  but route lines/associations will be empty.

## Architecture

Plain Node core-module HTTP(S) server + vanilla-JS static frontend. No
transpile, no client build.

**Server (`server/`)**
- `server.js` — entrypoint. Wires up the DB, loads route/stop data from GTFS into
  memory once at boot, defines the request handler, and starts HTTP or HTTPS.
  Routes:
  - `GET /api/stops` — every stop with its `visited` flag and associated route
    short-names.
  - `GET /api/routes` — bundled route polylines (GeoJSON); `/api/routes-raw` for
    unbundled.
  - `GET /api/routes-meta` — route short/long names, per-route color, `ridden`
    flag.
  - `POST /api/stops/:stopid/visited` — body `{ "visited": bool }`; persists and
    broadcasts `visited-changed`.
  - `POST /api/routes/:shortName/ridden` — body `{ "ridden": bool }`; persists and
    broadcasts `route-ridden-changed`.
  - anything else `GET` — static file from `public/`.
- `db.js` — `node:sqlite` wrapper. Tables: `stops`, `visited`,
  `ridden_routes`.
- `ws.js` — `ws` WebSocketServer sharing the same HTTP server. Broadcasts
  visited/ridden changes to all clients, and relays per-client `location-update`
  messages as `user-location` (assigning each client a random non-red HSL color;
  red is reserved for "you").
- `gtfs.js`, `loadRouteLines.js`, `loadStopRoutes.js`, `loadStopsCsv.js` — pure
  parsing/loading helpers, no state.

**Frontend (`public/`)** — served as-is.
- `index.html` + `app.js` — the Leaflet map, route sidebar, live location
  markers, WebSocket client. Leaflet is loaded from unpkg CDN.
- `stops.html` + `stops.js` — the list view, grouped by route.
- `routeBundling.js` — shared route-color / bundling logic used by the map.
- `style.css`.

## Conventions

- CommonJS (`"type": "commonjs"`), `'use strict'` at the top of every server
  file, 2-space indent, semicolons, single quotes.
- Keep to Node built-ins where possible — `ws` is deliberately the only runtime
  dependency.
- No test suite exists (`npm test` is a stub). Verify changes by running the app
  and exercising the affected route/page as described above.
