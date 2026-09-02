#!/usr/bin/env bash
#
# Download the current BC Transit (Victoria) static GTFS feed and unpack it into
# a fresh Data/bctransit_gtfs_<timestamp>/ directory, pruning older copies.
#
# The server (server/gtfs.js:findGtfsDir) uses the newest sub-directory of Data/
# that contains a stop_times.txt, so the directory name only needs to match the
# *_gtfs_* glob. Restart the app afterwards to pick up the new feed.
#
# Intended to run inside the container:
#   docker compose exec app scripts/refresh-gtfs.sh && docker compose restart app
# Run once during setup, then weekly from cron (see deploy/cron.d.bst).

set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
DATA_DIR="$APP_DIR/Data"
GTFS_URL="${GTFS_URL:-https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=48}"
KEEP="${KEEP:-2}"   # how many feed directories to retain

stamp="$(date +%Y%m%d_%H%M%S)"
dest="$DATA_DIR/bctransit_gtfs_$stamp"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $GTFS_URL"
curl -fSL "$GTFS_URL" -o "$tmp/gtfs.zip"

mkdir -p "$dest"
unzip -q "$tmp/gtfs.zip" -d "$dest"

# Sanity: the files the server actually reads at startup.
for f in stop_times.txt shapes.txt trips.txt routes.txt; do
  if [ ! -s "$dest/$f" ]; then
    echo "ERROR: $dest/$f missing or empty — aborting, leaving previous feed in place" >&2
    rm -rf "$dest"
    exit 1
  fi
done
echo "Unpacked feed to $dest"

# Keep only the $KEEP newest feed directories.
# shellcheck disable=SC2012
ls -1dt "$DATA_DIR"/*_gtfs_* 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  echo "Pruning old feed $old"
  rm -rf "$old"
done

echo "Done. Restart the app to load the new feed:  docker compose restart app"
