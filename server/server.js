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
  getRiddenRouteNames,
  setRouteRidden,
} = require('./db');
const { parseStopsCsv } = require('./loadStopsCsv');
const { loadRouteLines, loadRawRouteLines } = require('./loadRouteLines');
const { loadStopRoutes, naturalRouteCompare } = require('./loadStopRoutes');
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

  const { geojson: routesGeoJson, colorByShortName } = loadRouteLines(DATA_DIR);
  console.log(`Loaded and bundled ${routesGeoJson.features.length} route shapes`);

  const routesRawGeoJson = loadRawRouteLines(DATA_DIR);
  console.log(`Loaded ${routesRawGeoJson.features.length} raw (unbundled) route shapes`);

  const { routesByStopId, routeLongNameByShortName } = loadStopRoutes(DATA_DIR);
  console.log(`Derived route associations for ${routesByStopId.size} stops from GTFS data`);
  const routesMetaBase = Array.from(routeLongNameByShortName, ([shortName, longName]) => ({
    shortName,
    longName,
    color: colorByShortName.get(shortName) || '#999999',
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
      const riddenRouteNames = getRiddenRouteNames(db);
      const routesMeta = routesMetaBase.map((route) => ({
        ...route,
        ridden: riddenRouteNames.has(route.shortName),
      }));
      sendJson(res, 200, routesMeta);
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
