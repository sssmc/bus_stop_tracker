'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stops (
  stopid    INTEGER PRIMARY KEY,
  stopname  TEXT NOT NULL,
  stopsite  TEXT,
  latitude  REAL NOT NULL,
  longitude REAL NOT NULL,
  syscode   TEXT,
  system    TEXT,
  muni      TEXT
);

CREATE TABLE IF NOT EXISTS visited (
  stopid     INTEGER PRIMARY KEY REFERENCES stops(stopid),
  visited_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ridden_routes (
  route_short_name TEXT PRIMARY KEY,
  ridden_at        TEXT NOT NULL
);

-- Precomputed GTFS schedule index (built once per feed by server/loadSchedule.js).
CREATE TABLE IF NOT EXISTS schedule_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS stop_times_idx (
  stopid           INTEGER NOT NULL,
  trip_id          TEXT NOT NULL,
  route_short_name TEXT NOT NULL,
  headsign         TEXT,
  direction_id     INTEGER,
  service_id       TEXT NOT NULL,
  dep_sec          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stx_stop ON stop_times_idx (stopid, dep_sec);
CREATE INDEX IF NOT EXISTS ix_stx_service ON stop_times_idx (service_id);

CREATE TABLE IF NOT EXISTS service_dates (
  service_id TEXT NOT NULL,
  yyyymmdd   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_svc_date ON service_dates (yyyymmdd);
`;

function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

function seedStopsFromCsv(db, stopRows) {
  const upsert = db.prepare(`
    INSERT INTO stops (stopid, stopname, stopsite, latitude, longitude, syscode, system, muni)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stopid) DO UPDATE SET
      stopname=excluded.stopname,
      stopsite=excluded.stopsite,
      latitude=excluded.latitude,
      longitude=excluded.longitude,
      syscode=excluded.syscode,
      system=excluded.system,
      muni=excluded.muni
  `);
  for (const stop of stopRows) {
    upsert.run(
      stop.stopid,
      stop.stopname,
      stop.stopsite,
      stop.latitude,
      stop.longitude,
      stop.syscode,
      stop.system,
      stop.muni
    );
  }
}

function getAllStopsWithVisited(db) {
  return db
    .prepare(
      `SELECT s.stopid, s.stopname, s.stopsite, s.latitude, s.longitude, s.muni,
              v.visited_at AS visitedAt
       FROM stops s
       LEFT JOIN visited v ON v.stopid = s.stopid
       ORDER BY s.stopid`
    )
    .all()
    .map((row) => ({
      stopid: row.stopid,
      stopname: row.stopname,
      stopsite: row.stopsite,
      latitude: row.latitude,
      longitude: row.longitude,
      muni: row.muni,
      visited: row.visitedAt != null,
      visitedAt: row.visitedAt,
    }));
}

function setVisited(db, stopid, visited) {
  if (visited) {
    const visitedAt = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO visited (stopid, visited_at) VALUES (?, ?)').run(
      stopid,
      visitedAt
    );
    return visitedAt;
  }
  db.prepare('DELETE FROM visited WHERE stopid = ?').run(stopid);
  return null;
}

function stopExists(db, stopid) {
  return db.prepare('SELECT 1 FROM stops WHERE stopid = ?').get(stopid) != null;
}

function getRiddenRouteNames(db) {
  return new Set(
    db
      .prepare('SELECT route_short_name FROM ridden_routes')
      .all()
      .map((row) => row.route_short_name)
  );
}

// [{ shortName, riddenAt }] — like getRiddenRouteNames but carrying the timestamp
// so the client can compute "routes ridden today / this week".
function getRiddenRoutes(db) {
  return db
    .prepare('SELECT route_short_name AS shortName, ridden_at AS riddenAt FROM ridden_routes')
    .all();
}

// Most recent check-ins across both stops and routes, newest first. Route entries
// carry only shortName; the caller fills in longName from its in-memory GTFS map.
function getRecentActivity(db, limit) {
  const stopEvents = db
    .prepare(
      `SELECT s.stopid, s.stopname, s.muni, v.visited_at AS at
       FROM visited v JOIN stops s ON s.stopid = v.stopid
       ORDER BY v.visited_at DESC LIMIT ?`
    )
    .all(limit)
    .map((row) => ({ type: 'stop', ...row }));

  const routeEvents = db
    .prepare(
      `SELECT route_short_name AS shortName, ridden_at AS at
       FROM ridden_routes ORDER BY ridden_at DESC LIMIT ?`
    )
    .all(limit)
    .map((row) => ({ type: 'route', ...row }));

  return [...stopEvents, ...routeEvents]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

function setRouteRidden(db, shortName, ridden) {
  if (ridden) {
    const riddenAt = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO ridden_routes (route_short_name, ridden_at) VALUES (?, ?)').run(
      shortName,
      riddenAt
    );
    return riddenAt;
  }
  db.prepare('DELETE FROM ridden_routes WHERE route_short_name = ?').run(shortName);
  return null;
}

module.exports = {
  initDb,
  seedStopsFromCsv,
  getAllStopsWithVisited,
  setVisited,
  stopExists,
  getRiddenRouteNames,
  getRiddenRoutes,
  getRecentActivity,
  setRouteRidden,
};
