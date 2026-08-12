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

module.exports = { initDb, seedStopsFromCsv, getAllStopsWithVisited, setVisited, stopExists };
