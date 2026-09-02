# Deploying Bus Stop Tracker

A guide to hosting this app in a Docker container on your home server and reaching
it over **Tailscale** — no public exposure, no port-forwarding, no domain.

The model:

- **The server is on your tailnet already** (you run a Tailscale exit node on it).
- **Each user installs Tailscale** and signs into your tailnet. From then on they
  reach the app at the server's Tailscale address.
- **TLS is terminated by `tailscale serve`**, which gets a real, auto-renewing
  Let's Encrypt certificate for the server's `*.ts.net` name — so no browser
  warning, and the live shared-location feature (which needs a secure context)
  just works.
- **No app-level authentication.** Your tailnet membership *is* the access
  control — only devices you've added can reach the app. See [Security](#security).
- **Transit data is re-downloaded on the server** from BC Transit's public GTFS
  feed and refreshed weekly.

## What runs

A single Node process (`node server/server.js`), one npm dependency (`ws`), no
build step. It listens on one port for both HTTP and the WebSocket used for
real-time sync.

| | |
|---|---|
| Runtime | Node 24 — bundled in the image (`node:24-alpine`) |
| Port | container `3000`, published on the host as `127.0.0.1:3000` (loopback only); `tailscale serve` re-exposes it on the tailnet as HTTPS `:443` |
| TLS | terminated by `tailscale serve` (trusted cert). The app itself speaks plain HTTP — it only does its own HTTPS if you mount `certs/*.pem`, which the Tailscale path doesn't need. |
| Disk | image ~200 MB; the GTFS feed in the `gtfs` volume ~150 MB; the database ~300 KB |
| Outbound | none from the server. Browsers load Leaflet from `unpkg.com` and map tiles from `*.tile.openstreetmap.org`. |

### Files and state

- **`data.sqlite`** — created automatically on first run. Holds the only real
  state: which stops are marked visited and which routes are marked ridden
  (~300 KB). Everything else is derived at startup. Lives in the `state` volume
  (symlinked from `/app/data.sqlite` to `/data/data.sqlite`). **Back this up.**
- **`Data/Victoria_Regional_Transit_System_stops.csv`** — in the repo, baked
  into the image, and seeded into the `gtfs` volume on first run. Seeds the stop
  list on every boot.
- **`Data/*_gtfs_*/`** — the GTFS feed extract, **not** in the image. The server
  reads `routes.txt`, `trips.txt`, `shapes.txt`, and `stop_times.txt`
  (~130 MB) from the newest such directory at startup, for route lines/colours
  and the route-grouped list view. Without it the app still runs — you just get
  bare stop markers, no route lines, and an ungrouped list. Provisioned by
  `scripts/refresh-gtfs.sh` (step 4).

## Setup

On the home server. Assumes Docker Engine + the Compose plugin and Tailscale are
already installed and running.

### 1. Prerequisites

```bash
docker version            # Engine present and running
docker compose version    # v2+ (the `compose` subcommand)
tailscale status          # this box is signed into your tailnet
```

In the Tailscale **admin console** (login.tailscale.com):

- **DNS → MagicDNS**: enabled.
- **DNS → HTTPS Certificates**: enabled. (`tailscale serve` needs this to issue
  the cert in step 5.)

Note the server's MagicDNS name — `tailscale status` shows it, e.g.
`homeserver.tailnet-name.ts.net`.

### 2. Get the code

```bash
git clone https://github.com/sssmc/bus_stop_tracker.git
cd bus_stop_tracker
```

Everything below runs from this directory.

### 3. Start the container

```bash
docker compose up -d --build
docker compose logs -f app         # watch the boot lines, then Ctrl-C
```

A healthy boot logs: `Seeded N stops`, `Loaded and bundled N route shapes`,
`Derived route associations for N stops from GTFS data` (this one is `0` until
step 4), and `Listening on http://0.0.0.0:3000`.

`compose.yaml` publishes the app on **`127.0.0.1:3000`** (loopback only — nothing
off-box can reach it directly) and keeps state in two named volumes:

| Volume | Mounted at | Holds |
|---|---|---|
| `bus-stop-tracker_state` | `/data` (← `data.sqlite` symlinked here) | your visited/ridden ticks — **back this up** |
| `bus-stop-tracker_gtfs` | `/app/Data` | the stops CSV (seeded from the image) + the GTFS feed |

### 4. Load the transit data

The GTFS feed isn't in the image. Pull it into the `gtfs` volume and restart:

```bash
docker compose exec app scripts/refresh-gtfs.sh
docker compose restart app
```

`scripts/refresh-gtfs.sh` downloads BC Transit's current Victoria feed —
`https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48`, no API key
— unpacks it into a fresh `Data/bctransit_gtfs_<timestamp>/` inside the volume,
and prunes older copies. The server adopts whichever `*_gtfs_*` directory is
newest, so the restart is what picks up the new feed.

Schedule a weekly refresh on the host — copy the lines from `deploy/cron.d.bst`
into `/etc/cron.d/bst`, editing `CHECKOUT` to your clone path:

```
CHECKOUT=/path/to/bus_stop_tracker
17 4 * * 1 root cd $CHECKOUT && { docker compose exec -T app scripts/refresh-gtfs.sh && docker compose restart app ; } >> /var/log/bst-gtfs.log 2>&1
```

### 5. Expose it on your tailnet

```bash
sudo tailscale serve --bg 3000
sudo tailscale serve status
```

`tailscale serve --bg 3000` makes `https://<server>.<tailnet>.ts.net/` proxy to
`http://127.0.0.1:3000`, provisions a trusted certificate on first run, and
persists across reboots. WebSocket upgrades pass through, so real-time sync
works.

- Check it: `tailscale serve status` should list `https://…ts.net (tailnet only)
  → http://127.0.0.1:3000`.
- Undo it: `sudo tailscale serve reset`.
- No port-forwarding and no public firewall rules — Tailscale carries the
  traffic and the container port is loopback-only. If you run a host firewall
  that default-denies inbound, make sure it permits the `tailscale0` interface
  (Tailscale normally configures this for you).

### 6. Add your users

For each user:

1. Install Tailscale on their device and sign into **your** tailnet (invite them
   from the admin console). The exit node they use for general traffic already
   puts them on the tailnet; reaching this app doesn't require the exit node to
   be *enabled*, just tailnet membership.
2. Give them the URL: **`https://<server>.<tailnet>.ts.net/`**.
3. On a phone, they should **allow the location permission** for their live dot
   to appear on the map.

No security warning — it's a real certificate.

## Updating

```bash
cd /path/to/bus_stop_tracker
git pull
docker compose up -d --build
```

The named volumes are untouched by a rebuild. `tailscale serve` config also
persists — no need to re-run step 5.

## Backups

`data.sqlite` (in the `state` volume) is the only thing worth backing up:

```bash
mkdir -p backups
docker compose exec -T app sh -c 'sqlite3 /data/data.sqlite ".backup /data/backup.sqlite"'
docker compose cp app:/data/backup.sqlite "backups/data-$(date +%F).sqlite"
docker compose exec -T app rm -f /data/backup.sqlite
```

The backup line in `deploy/cron.d.bst` wraps this in a nightly cron with a
14-day `find -mtime` prune. It's ~300 KB — on a Pi especially, copy `backups/`
off the box periodically (`rclone`, `scp`, a cron to a second machine); SD cards
fail without warning.

## Verifying it works

1. `docker compose ps` → the `app` service is `running` / `healthy`.
   `docker compose logs app` shows non-zero "route shapes" / "route
   associations" counts (confirms the GTFS download in step 4 landed).
2. On the box: `curl -s http://127.0.0.1:3000/api/stops | head -c 200` → a JSON
   array of stops; `…/api/routes-meta` → a non-empty route list.
3. `tailscale serve status` lists the `https://…ts.net` → `127.0.0.1:3000` proxy.
4. From another device on the tailnet: open
   `https://<server>.<tailnet>.ts.net/` → map with stop dots **and** coloured
   route lines, no certificate warning; `…/stops.html` → list grouped by route.
5. Open the map on two tailnet devices; tick a stop on one → it turns green on
   the other within about a second.
6. Allow location on a phone → your dot appears, and the second device shows a
   differently-coloured dot for you.
7. `sudo reboot` → `restart: unless-stopped` brings the container back and
   `tailscale serve` resumes on its own.

## Security

Access control is **your tailnet**: only devices you've added can reach the app
at all. Within that boundary the app has **no authentication of its own** —
anyone on the tailnet can toggle any stop or route and broadcast location dots.
For a small trusted group that's the intended trade-off; the nightly backup is
the recovery path if someone bulk-toggles.

Tighter options, none needing app changes:

- a **Tailscale ACL** that only grants the relevant users/tags access to the
  server node on port 443;
- put **Caddy or nginx** between `tailscale serve` and the app doing HTTP Basic
  Auth (point `tailscale serve` at the proxy instead of `127.0.0.1:3000`).

Otherwise: keep the box, Docker, and Tailscale patched. The server has one
dependency and makes no outbound calls, so the surface is small.

## Alternative: skip `tailscale serve`, let the app do HTTPS

If you'd rather not enable MagicDNS/HTTPS in the tailnet and just hand out the
server's raw Tailscale IP, run the app's own self-signed HTTPS instead:

1. In `compose.yaml`, change `ports:` to `"443:3000"` and uncomment the
   `./certs:/app/certs:ro` volume line.
2. Generate a self-signed cert naming the Tailscale IP (`tailscale ip -4`):

   ```bash
   IP=$(tailscale ip -4)
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout certs/key.pem -out certs/cert.pem \
     -days 825 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP"
   chmod 600 certs/key.pem
   ```

3. `docker compose up -d`. Skip step 5. Users connect to `https://<tailscale-ip>/`
   and click through a one-time browser warning (**Advanced → Proceed**); the
   connection is still encrypted. Set a ~2-year reminder to regenerate the cert.

## Optional improvements

Not needed for a working deploy:

1. **Drop the 130 MB `stop_times.txt` dependency.** Precompute the
   stop → routes join into a small committed `Data/stop-routes.json` and load
   that when no `*_gtfs_*` directory is present. Shrinks the feed download to a
   few MB and makes boot instant. Route polylines still need `shapes.txt`
   (~2 MB).
2. **Graceful shutdown.** Add
   `process.on('SIGTERM', () => server.close(() => process.exit(0)))` to
   `server/server.js` so `docker compose restart` drains in-flight requests
   instead of dropping them (`tini` already makes the stop itself prompt).
