'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripCr(field) {
  return field.endsWith('\r') ? field.slice(0, -1) : field;
}

function parseGtfsCsv(filePath) {
  const text = stripBom(fs.readFileSync(filePath, 'utf8'));
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = stripCr(lines[0]).split(',');
  return lines.slice(1).map((line) => {
    const fields = stripCr(line).split(',');
    const row = {};
    header.forEach((key, i) => {
      row[key] = fields[i];
    });
    return row;
  });
}

function findGtfsDir(dataDir) {
  const candidates = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dataDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'stop_times.txt')));

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function naturalRouteCompare(a, b) {
  const parse = (s) => {
    const match = s.match(/^(\d+)(.*)$/);
    return match ? [Number(match[1]), match[2]] : [Infinity, s];
  };
  const [aNum, aSuffix] = parse(a);
  const [bNum, bSuffix] = parse(b);
  if (aNum !== bNum) return aNum - bNum;
  return aSuffix.localeCompare(bSuffix);
}

// Derives stop_id -> [route_short_name, ...] by joining stop_times.txt (trip -> stop)
// with trips.txt (trip -> route) and routes.txt (route -> short name). The static
// GTFS feed has no direct stop-to-route table, so this join is the real source of truth.
// Also returns route_short_name -> route_long_name for readable group headings.
function loadStopRoutes(dataDir) {
  const gtfsDir = findGtfsDir(dataDir);
  if (!gtfsDir) return { routesByStopId: new Map(), routeLongNameByShortName: new Map() };

  const routeShortNameById = new Map();
  const routeLongNameByShortName = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'routes.txt'))) {
    routeShortNameById.set(row.route_id, row.route_short_name);
    routeLongNameByShortName.set(row.route_short_name, row.route_long_name);
  }

  const routeIdByTripId = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'trips.txt'))) {
    routeIdByTripId.set(row.trip_id, row.route_id);
  }

  const stopTimesText = stripBom(fs.readFileSync(path.join(gtfsDir, 'stop_times.txt'), 'utf8'));
  const lines = stopTimesText.split('\n');
  const header = stripCr(lines[0]).split(',');
  const tripIdx = header.indexOf('trip_id');
  const stopIdx = header.indexOf('stop_id');

  const routeSetByStopId = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = line.split(',');
    const routeId = routeIdByTripId.get(fields[tripIdx]);
    if (!routeId) continue;
    const shortName = routeShortNameById.get(routeId);
    if (!shortName) continue;

    const stopId = fields[stopIdx];
    let routeSet = routeSetByStopId.get(stopId);
    if (!routeSet) {
      routeSet = new Set();
      routeSetByStopId.set(stopId, routeSet);
    }
    routeSet.add(shortName);
  }

  const routesByStopId = new Map();
  for (const [stopId, routeSet] of routeSetByStopId) {
    routesByStopId.set(stopId, Array.from(routeSet).sort(naturalRouteCompare));
  }
  return { routesByStopId, routeLongNameByShortName };
}

module.exports = { loadStopRoutes, naturalRouteCompare };
