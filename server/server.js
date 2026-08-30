'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const {
  initDb,
  seedStopsFromCsv,
  getAllStopsWithVisited,
  setVisited,
  stopExists,
  getRiddenRoutes,
  getRecentActivity,
  setRouteRidden,
} = require('./db');
const { parseStopsCsv } = require('./loadStopsCsv');
const { loadRouteLines, loadRawRouteLines } = require('./loadRouteLines');
const { loadStopRoutes, naturalRouteCompare } = require('./loadStopRoutes');
const { buildScheduleIndex } = require('./loadSchedule');
const { createWsServer } = require('./ws');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data.sqlite');
const DATA_DIR = path.join(ROOT, 'Data');
const STOPS_CSV = path.join(DATA_DIR, 'Victoria_Regional_Transit_System_stops.csv');
const CERTS_DIR = path.join(ROOT, 'certs');
const TLS_KEY_PATH = path.join(CERTS_DIR, 'key.pem');
const TLS_CERT_PATH = path.join(CERTS_DIR, 'cert.pem');

const PORT = process.env.PORT || 3000;

// Browser geolocation (used for the live user-location feature) only works over
// a secure context, so we serve HTTPS whenever a cert/key pair is present in
// certs/ — self-signed for local/LAN use today, swap in a real cert (e.g. from
// Let's Encrypt) at the same paths for a production deployment. Falls back to
// plain HTTP if no cert is found, so this still runs with zero setup.
function loadTlsOptions() {
  if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) return null;
  return { key: fs.readFileSync(TLS_KEY_PATH), cert: fs.readFileSync(TLS_CERT_PATH) };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const VISITED_PATH_RE = /^\/api\/stops\/(\d+)\/visited$/;
const ROUTE_RIDDEN_PATH_RE = /^\/api\/routes\/([^/]+)\/ridden$/;
const DEPARTURES_PATH_RE = /^\/api\/stops\/(\d+)\/departures$/;

// "now" in the transit agency's timezone, as { yyyymmdd, nowSec } — the shape the
// schedule queries need (service_dates keys on yyyymmdd, dep_sec is seconds from
// the service day's midnight).
function agencyNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour'); // Intl can emit hour "24"
  return {
    yyyymmdd: `${get('year')}${get('month')}${get('day')}`,
    nowSec: Number(hour) * 3600 + Number(get('minute')) * 60 + Number(get('second')),
  };
}

function secToHHMM(sec) {
  const wrapped = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function main() {
  const db = initDb(DB_PATH);
  const stopRows = parseStopsCsv(STOPS_CSV);
  seedStopsFromCsv(db, stopRows);
  console.log(`Seeded ${stopRows.length} stops`);

  buildScheduleIndex(db, DATA_DIR);

  const { geojson: routesGeoJson, colorByShortName, routeLengthKmByShortName } =
    loadRouteLines(DATA_DIR);
  console.log(`Loaded and bundled ${routesGeoJson.features.length} route shapes`);

  const routesRawGeoJson = loadRawRouteLines(DATA_DIR);
  console.log(`Loaded ${routesRawGeoJson.features.length} raw (unbundled) route shapes`);

  const { routesByStopId, routeLongNameByShortName } = loadStopRoutes(DATA_DIR);
  console.log(`Derived route associations for ${routesByStopId.size} stops from GTFS data`);
  const routesMetaBase = Array.from(routeLongNameByShortName, ([shortName, longName]) => ({
    shortName,
    longName,
    color: colorByShortName.get(shortName) || '#999999',
    lengthKm: Math.round((routeLengthKmByShortName.get(shortName) || 0) * 10) / 10,
  })).sort((a, b) => naturalRouteCompare(a.shortName, b.shortName));
  const routeShortNames = new Set(routesMetaBase.map((r) => r.shortName));

  const tlsOptions = loadTlsOptions();
  const requestHandler = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/stops') {
      const stops = getAllStopsWithVisited(db).map((stop) => ({
        ...stop,
        routes: routesByStopId.get(String(stop.stopid)) || [],
      }));
      sendJson(res, 200, stops);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/routes') {
      sendJson(res, 200, routesGeoJson);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/routes-raw') {
      sendJson(res, 200, routesRawGeoJson);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/routes-meta') {
      const riddenAtByShortName = new Map(
        getRiddenRoutes(db).map((r) => [r.shortName, r.riddenAt])
      );
      const routesMeta = routesMetaBase.map((route) => ({
        ...route,
        ridden: riddenAtByShortName.has(route.shortName),
        riddenAt: riddenAtByShortName.get(route.shortName) || null,
      }));
      sendJson(res, 200, routesMeta);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/activity') {
      const requested = Number(url.searchParams.get('limit')) || 50;
      const limit = Math.min(Math.max(requested, 1), 200);
      const events = getRecentActivity(db, limit).map((event) =>
        event.type === 'route'
          ? { ...event, longName: routeLongNameByShortName.get(event.shortName) || '' }
          : event
      );
      sendJson(res, 200, events);
      return;
    }

    const departuresMatch = url.pathname.match(DEPARTURES_PATH_RE);
    if (req.method === 'GET' && departuresMatch) {
      const stopid = Number(departuresMatch[1]);
      const requested = Number(url.searchParams.get('limit')) || 8;
      const limit = Math.min(Math.max(requested, 1), 20);
      const { yyyymmdd, nowSec } = agencyNow();
      const serviceIds = db
        .prepare('SELECT DISTINCT service_id FROM service_dates WHERE yyyymmdd = ?')
        .all(yyyymmdd)
        .map((r) => r.service_id);

      if (serviceIds.length === 0) {
        sendJson(res, 200, { scheduled: true, departures: [] });
        return;
      }

      const placeholders = serviceIds.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT route_short_name, headsign, direction_id, dep_sec
           FROM stop_times_idx
           WHERE stopid = ? AND service_id IN (${placeholders}) AND dep_sec >= ?
           ORDER BY dep_sec LIMIT ?`
        )
        .all(stopid, ...serviceIds, nowSec, limit);

      const departures = rows.map((row) => ({
        route: row.route_short_name,
        headsign: row.headsign,
        directionId: row.direction_id,
        time: secToHHMM(row.dep_sec),
        inMinutes: Math.max(0, Math.round((row.dep_sec - nowSec) / 60)),
      }));
      sendJson(res, 200, { scheduled: true, departures });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/routes-schedule') {
      const { yyyymmdd } = agencyNow();
      const serviceIds = db
        .prepare('SELECT DISTINCT service_id FROM service_dates WHERE yyyymmdd = ?')
        .all(yyyymmdd)
        .map((r) => r.service_id);

      const byRoute = new Map();
      if (serviceIds.length > 0) {
        const placeholders = serviceIds.map(() => '?').join(',');
        for (const row of db
          .prepare(
            `SELECT route_short_name,
                    COUNT(DISTINCT trip_id) AS trips,
                    MIN(dep_sec) AS firstSec,
                    MAX(dep_sec) AS lastSec
             FROM stop_times_idx
             WHERE service_id IN (${placeholders})
             GROUP BY route_short_name`
          )
          .all(...serviceIds)) {
          byRoute.set(row.route_short_name, row);
        }
      }

      const schedule = routesMetaBase.map((route) => {
        const row = byRoute.get(route.shortName);
        const isNightName = /N$/i.test(route.shortName);
        return {
          shortName: route.shortName,
          tripsToday: row ? row.trips : 0,
          firstDep: row ? secToHHMM(row.firstSec) : null,
          lastDep: row ? secToHHMM(row.lastSec) : null,
          night: isNightName || (row ? row.lastSec >= 24 * 3600 : false),
        };
      });
      sendJson(res, 200, schedule);
      return;
    }

    const visitedMatch = url.pathname.match(VISITED_PATH_RE);
    if (req.method === 'POST' && visitedMatch) {
      const stopid = Number(visitedMatch[1]);
      readJsonBody(req)
        .then((body) => {
          if (!stopExists(db, stopid)) {
            sendJson(res, 404, { error: 'stop not found' });
            return;
          }
          const visited = Boolean(body.visited);
          const visitedAt = setVisited(db, stopid, visited);
          const payload = { type: 'visited-changed', stopid, visited, visitedAt };
          broadcast(payload);
          sendJson(res, 200, { stopid, visited, visitedAt });
        })
        .catch(() => {
          sendJson(res, 400, { error: 'invalid JSON body' });
        });
      return;
    }

    const riddenMatch = url.pathname.match(ROUTE_RIDDEN_PATH_RE);
    if (req.method === 'POST' && riddenMatch) {
      const shortName = decodeURIComponent(riddenMatch[1]);
      readJsonBody(req)
        .then((body) => {
          if (!routeShortNames.has(shortName)) {
            sendJson(res, 404, { error: 'route not found' });
            return;
          }
          const ridden = Boolean(body.ridden);
          const riddenAt = setRouteRidden(db, shortName, ridden);
          const payload = { type: 'route-ridden-changed', shortName, ridden, riddenAt };
          broadcast(payload);
          sendJson(res, 200, { shortName, ridden, riddenAt });
        })
        .catch(() => {
          sendJson(res, 400, { error: 'invalid JSON body' });
        });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  };

  const server = tlsOptions
    ? https.createServer(tlsOptions, requestHandler)
    : http.createServer(requestHandler);

  const { broadcast } = createWsServer(server);

  server.listen(PORT, '0.0.0.0', () => {
    const scheme = tlsOptions ? 'https' : 'http';
    console.log(`Listening on ${scheme}://0.0.0.0:${PORT}${tlsOptions ? '' : ' (no TLS cert found in certs/ — geolocation will only work on localhost)'}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
