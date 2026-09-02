# Install to /etc/cron.d/bst   (root-owned, mode 644)
#
#   sudo cp deploy/cron.d.bst /etc/cron.d/bst
#
# Adjust the /opt/bus_stop_tracker paths and the "bst" user if you changed them.

# Weekly: pull a fresh BC Transit GTFS feed and restart the service.
17 4 * * 1 root /opt/bus_stop_tracker/scripts/refresh-gtfs.sh >> /var/log/bst-gtfs.log 2>&1

# Nightly: back up the database (only visited/ridden state lives here), keep 14 days.
30 3 * * * bst sqlite3 /opt/bus_stop_tracker/data.sqlite ".backup '/opt/bus_stop_tracker/backups/data-$(date +\%F).sqlite'" && find /opt/bus_stop_tracker/backups -name 'data-*.sqlite' -mtime +14 -delete
