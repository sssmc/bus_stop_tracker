'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stripBom, stripCr, parseGtfsCsv, findGtfsDir } = require('./gtfs');

// "H:MM:SS" (GTFS allows hours >= 24 for trips past midnight) -> seconds since
// noon-minus-12, i.e. seconds from the service day's midnight. Returns null for
// blank/garbled values so the caller can skip the row.
function hmsToSeconds(value) {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length !== 3) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return h * 3600 + m * 60 + s;
}

// Builds (or refreshes) the schedule index tables from the local GTFS feed. Cheap
// on every startup after the first: it's skipped unless the feed directory has
// changed. The one-time build streams the ~136 MB stop_times.txt and bulk-inserts
// ~2M rows in a single transaction (a few seconds).
function buildScheduleIndex(db, dataDir) {
  const gtfsDir = findGtfsDir(dataDir);
  if (!gtfsDir) {
    console.log('No GTFS feed found — schedule features disabled');
    return;
  }

  const feedVersion = path.basename(gtfsDir);
  const storedVersion = db
    .prepare("SELECT value FROM schedule_meta WHERE key = 'feed_version'")
    .get();
  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM stop_times_idx').get().c;
  if (storedVersion && storedVersion.value === feedVersion && rowCount > 0) {
    console.log(`Schedule index up to date (${rowCount} stop-times, feed ${feedVersion})`);
    return;
  }

  const startedAt = Date.now();
  console.log('Building schedule index…');
  db.exec('DELETE FROM stop_times_idx; DELETE FROM service_dates; DELETE FROM schedule_meta;');

  const routeShortNameById = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'routes.txt'))) {
    routeShortNameById.set(row.route_id, row.route_short_name);
  }

  const tripInfoById = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'trips.txt'))) {
    tripInfoById.set(row.trip_id, {
      routeShortName: routeShortNameById.get(row.route_id) || '',
      headsign: row.trip_headsign || '',
      directionId: row.direction_id === '' ? null : Number(row.direction_id),
      serviceId: row.service_id,
    });
  }

  const stopTimesText = stripBom(
    fs.readFileSync(path.join(gtfsDir, 'stop_times.txt'), 'utf8')
  );
  const lines = stopTimesText.split('\n');
  const header = stripCr(lines[0]).split(',');
  const tripIdx = header.indexOf('trip_id');
  const stopIdx = header.indexOf('stop_id');
  const depIdx = header.indexOf('departure_time');

  const insert = db.prepare(
    `INSERT INTO stop_times_idx
       (stopid, trip_id, route_short_name, headsign, direction_id, service_id, dep_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const fields = line.split(',');
      const trip = tripInfoById.get(fields[tripIdx]);
      if (!trip || !trip.routeShortName) continue;
      const depSec = hmsToSeconds(fields[depIdx]);
      if (depSec == null) continue;

      insert.run(
        Number(fields[stopIdx]),
        fields[tripIdx],
        trip.routeShortName,
        trip.headsign,
        trip.directionId,
        trip.serviceId,
        depSec
      );
      inserted += 1;
    }

    // This feed is calendar_dates-only (no calendar.txt): every service day is an
    // explicit exception_type=1 row.
    const svcInsert = db.prepare(
      'INSERT INTO service_dates (service_id, yyyymmdd) VALUES (?, ?)'
    );
    let svcDays = 0;
    for (const row of parseGtfsCsv(path.join(gtfsDir, 'calendar_dates.txt'))) {
      if (row.exception_type !== '1') continue;
      svcInsert.run(row.service_id, row.date);
      svcDays += 1;
    }

    db.prepare('INSERT INTO schedule_meta (key, value) VALUES (?, ?)').run(
      'feed_version',
      feedVersion
    );
    db.exec('COMMIT');
    console.log(
      `Schedule index built: ${inserted} stop-times, ${svcDays} service-days ` +
        `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { buildScheduleIndex, hmsToSeconds };
