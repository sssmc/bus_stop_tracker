# Install to /etc/cron.d/bst   (root-owned, mode 644)
#
#   sudo cp deploy/cron.d.bst /etc/cron.d/bst
#   sudo sed -i 's#/path/to/bus_stop_tracker#/your/actual/checkout#' /etc/cron.d/bst
#
# See DEPLOYMENT.md.

CHECKOUT=/path/to/bus_stop_tracker

# Weekly: pull a fresh BC Transit GTFS feed into the `gtfs` volume, then restart
# so the app adopts it.
17 4 * * 1 root cd $CHECKOUT && { docker compose exec -T app scripts/refresh-gtfs.sh && docker compose restart app ; } >> /var/log/bst-gtfs.log 2>&1

# Nightly: back up data.sqlite (visited/ridden state) out of the `state` volume,
# keep 14 days.
30 3 * * * root cd $CHECKOUT && docker compose exec -T app sh -c 'sqlite3 /data/data.sqlite ".backup /data/backup.sqlite"' && docker compose cp app:/data/backup.sqlite "$CHECKOUT/backups/data-$(date +\%F).sqlite" && docker compose exec -T app rm -f /data/backup.sqlite && find "$CHECKOUT/backups" -name 'data-*.sqlite' -mtime +14 -delete
