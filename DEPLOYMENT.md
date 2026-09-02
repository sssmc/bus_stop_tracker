# Deploying Bus Stop Tracker

A guide to hosting this app on a Linux box you control (a home server, a
Raspberry Pi, a small VPS) so a handful of trusted people can reach it over the
internet.

This setup deliberately keeps things minimal:

- **No domain.** People connect to `https://<your-public-ip>/`.
- **Self-signed TLS.** HTTPS is required for the live shared-location feature to
  work; visitors click past a one-time browser warning.
- **No authentication.** Anyone with the IP can use — and write to — the app.
  Fine for a small trusted group; see [Security](#security).
- **Transit data is re-downloaded on the server** from BC Transit's public GTFS
  feed and refreshed weekly.

## What runs

A single Node process (`node server/server.js`), one npm dependency (`ws`), no
build step. It listens on one port for both HTTP(S) and the WebSocket used for
real-time sync.

| | |
|---|---|
| Node | **24 LTS** recommended (anything ≥ 22.13 works — that's when `node:sqlite` stopped needing a flag) |
| Port | `PORT` env var, default `3000` |
| TLS | enabled when `certs/key.pem` **and** `certs/cert.pem` exist, otherwise plain HTTP |
| Disk | ~200 MB (mostly the GTFS `stop_times.txt`); the database is ~300 KB |
| Outbound | none from the server. Browsers load Leaflet from `unpkg.com` and map tiles from `*.tile.openstreetmap.org`. |

### Files and state

- **`data.sqlite`** — created automatically on first run. Holds the only real
  state: which stops are marked visited and which routes are marked ridden
  (~300 KB). Everything else is derived at startup. **Back this up.**
- **`Data/Victoria_Regional_Transit_System_stops.csv`** — in the repo. Seeds the
  stop list on every boot.
- **`Data/*_gtfs_*/`** — the GTFS feed extract, **not** in the repo (its
  `stop_times.txt` is ~130 MB). The server reads `routes.txt`, `trips.txt`,
  `shapes.txt`, and `stop_times.txt` from the newest such directory at startup,
  for route lines/colours and the route-grouped list view. Without it the app
  still runs — you just get bare stop markers, no route lines, and an
  ungrouped list. Provisioned by `scripts/refresh-gtfs.sh` below.
- **`certs/`** — TLS key/cert, **not** in the repo. Generated on the box.

## Setup

Commands assume Ubuntu / Debian / Raspberry Pi OS (`apt` + `ufw` + `systemd`).
The guide uses `/opt/bus_stop_tracker` and a dedicated `bst` service user —
adjust to taste.

### 1. Prepare the box

```bash
# dedicated unprivileged user, no login shell
sudo useradd --system --home /opt/bus_stop_tracker --shell /usr/sbin/nologin bst

# Node 24 LTS via NodeSource (clean /usr/bin/node for systemd)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git unzip sqlite3

node --version   # expect v24.x
```

On a Raspberry Pi, NodeSource has arm64/armhf builds. If it won't install on
old 32-bit hardware, use [nvm](https://github.com/nvm-sh/nvm) and point
`ExecStart` in the service file at the absolute path to that `node` binary.

### 2. Get the code

```bash
sudo git clone https://github.com/sssmc/bus_stop_tracker.git /opt/bus_stop_tracker
cd /opt/bus_stop_tracker
sudo npm ci --omit=dev        # installs just `ws`
sudo mkdir -p Data certs backups
sudo chown -R bst:bst /opt/bus_stop_tracker
```

### 3. Transit data

`scripts/refresh-gtfs.sh` (in the repo) downloads BC Transit's current Victoria
GTFS feed — `https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48`,
no API key — unpacks it into a fresh `Data/bctransit_gtfs_<timestamp>/`, prunes
old copies, and restarts the service.

```bash
sudo chmod +x scripts/refresh-gtfs.sh
sudo -u bst scripts/refresh-gtfs.sh    # run once now (the restart step is a no-op
                                       # until the service exists — that's fine)
```

Schedule a weekly refresh — copy the GTFS line from `deploy/cron.d.bst` into
`/etc/cron.d/bst`:

```
17 4 * * 1 root /opt/bus_stop_tracker/scripts/refresh-gtfs.sh >> /var/log/bst-gtfs.log 2>&1
```

The server adopts whichever `*_gtfs_*` directory is newest, so a restart is all
it takes to pick up a fresh feed.

### 4. TLS certificate

```bash
IP=<your-public-ip>
sudo -u bst openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /opt/bus_stop_tracker/certs/key.pem \
  -out    /opt/bus_stop_tracker/certs/cert.pem \
  -days 825 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP"
sudo chmod 600 /opt/bus_stop_tracker/certs/key.pem
```

Browsers will still show a warning (self-signed issuer) — unavoidable without a
domain. The IP in the SAN just makes the cert name the right host once someone
clicks through. **Set a ~2-year calendar reminder** to regenerate before it
expires.

### 5. systemd service

Copy `deploy/bus-stop-tracker.service` to
`/etc/systemd/system/bus-stop-tracker.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bus-stop-tracker
sudo systemctl status bus-stop-tracker
journalctl -u bus-stop-tracker -n 20
```

A healthy boot logs four lines: `Seeded N stops`, `Loaded and bundled N route
shapes`, `Derived route associations for N stops from GTFS data`, and
`Listening on https://0.0.0.0:443`.

The service file sets `PORT=443` for a clean `https://<ip>/` URL, which needs
the `AmbientCapabilities=CAP_NET_BIND_SERVICE` line it already includes. For a
zero-fuss alternative, remove that line, change `Environment=PORT=443` to
`PORT=3000`, and hand out `https://<ip>:3000/`.

### 6. Firewall and reaching the box

```bash
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp        # or 3000/tcp
sudo ufw enable
```

(Fedora/RHEL: `sudo firewall-cmd --add-port=443/tcp --permanent && sudo firewall-cmd --reload`.)

**Home network:** forward external TCP 443 to `<box-LAN-IP>:443` in your router.

**Check for CGNAT first.** Many residential connections (cellular, some fibre)
sit behind carrier-grade NAT, which makes inbound port-forwarding impossible:

```bash
curl -s https://api.ipify.org        # your real public IP
```

If that doesn't match the WAN IP shown in your router's admin page, you're
behind CGNAT — port-forwarding won't work. Use a free tunnel instead
([Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).

**Residential IPs change.** If yours does, you'll need to re-share it. A free
[DuckDNS](https://www.duckdns.org/) hostname avoids that (at the cost of sharing
a name instead of an IP).

### 7. Share the URL

Give people `https://<your-public-ip>/` plus:

> Your browser will show a security warning because this is a personal server
> with a self-signed certificate. Click **Advanced → Proceed** once. The
> connection is still encrypted.

On a phone, they should also **allow the location permission** for their live
dot to appear on the map.

## Backups

`data.sqlite` is the only file worth backing up. Copy the backup line from
`deploy/cron.d.bst` into `/etc/cron.d/bst`:

```
30 3 * * * bst sqlite3 /opt/bus_stop_tracker/data.sqlite ".backup '/opt/bus_stop_tracker/backups/data-$(date +\%F).sqlite'" && find /opt/bus_stop_tracker/backups -name 'data-*.sqlite' -mtime +14 -delete
```

It's ~300 KB. On a Pi especially, copy `backups/` off the box periodically
(`rclone`, `scp`, a cron to a second machine) — SD cards fail without warning.

## Updating the app

```bash
cd /opt/bus_stop_tracker
sudo -u bst git pull
sudo -u bst npm ci --omit=dev
sudo systemctl restart bus-stop-tracker
journalctl -u bus-stop-tracker -n 20
```

`data.sqlite`, `Data/*_gtfs_*/`, and `certs/` are gitignored, so `git pull`
never disturbs them.

## Verifying it works

1. `systemctl is-active bus-stop-tracker` → `active`, and the journal shows
   non-zero "route shapes" / "route associations" counts (confirms the GTFS
   download landed).
2. `curl -sk https://localhost/api/stops | head -c 200` → a JSON array of stops.
   `curl -sk https://localhost/api/routes-meta | head -c 200` → a non-empty
   route list.
3. From a phone on cellular (not your wifi): open `https://<public-ip>/`, click
   through the warning → map with stop dots **and** coloured route lines;
   `…/stops.html` → list grouped by route.
4. Open the map on two devices; tick a stop on one → it turns green on the other
   within about a second.
5. Allow location on the phone → your dot appears, and the second device shows a
   differently-coloured dot for you.
6. `sudo reboot` → the service comes back on its own.

## Security

The write API has **no authentication** — this is a deliberate trade-off for a
small trusted group. Anyone who has the IP can toggle any stop or route and
broadcast location dots. The nightly backup is the recovery path if someone
bulk-toggles.

If you later want a light lock, none of these need app changes:

- put **Caddy or nginx in front** doing HTTP Basic Auth;
- `ufw`-allowlist your users' source IPs;
- serve the app from a hard-to-guess path prefix.

Otherwise: keep the box patched (`unattended-upgrades`). The server has one
dependency and makes no outbound calls, so the surface is small.

## Optional improvements

Not needed for a working deploy:

1. **Drop the 130 MB `stop_times.txt` dependency.** Precompute the
   stop → routes join into a small committed `Data/stop-routes.json` and load
   that when no `*_gtfs_*` directory is present. Shrinks the deploy to a few MB
   and makes boot instant. Route polylines still need `shapes.txt` (~2 MB).
2. **Graceful shutdown.** Add
   `process.on('SIGTERM', () => server.close(() => process.exit(0)))` to
   `server/server.js` so restarts close connections cleanly.
3. **Pin the runtime.** Add `"engines": { "node": ">=22.13" }` to `package.json`
   and an `.nvmrc`.
4. **Trusted HTTPS, still free.** If the click-through warning becomes annoying:
   a free DuckDNS subdomain + Caddy reverse proxy (automatic Let's Encrypt), or
   Tailscale Funnel (`*.ts.net`, also solves CGNAT). Both mean sharing a
   hostname instead of an IP.
