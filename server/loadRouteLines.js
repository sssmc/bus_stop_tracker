'use strict';

const path = require('node:path');
const { parseGtfsCsv, findGtfsDir, naturalRouteCompare } = require('./gtfs');

// Points are resampled to roughly this spacing so grid-based overlap detection
// doesn't miss long, sparsely-vertexed straight stretches between shape points.
const RESAMPLE_STEP_METERS = 15;
// Grid cell size used to decide "these routes are on the same road here". Coarser
// than a lane width on purpose: shape GPS traces wobble a few meters road-to-road.
const GRID_CELL_METERS = 15;
// Real-world lateral spacing between adjacent bundled route lines.
const OFFSET_SPACING_METERS = 4;
// Post-bundling simplification tolerance (meters). The dense resampling above is
// only needed to compute correct offsets; most of those points are redundant for
// rendering, so we thin them back out before sending to the browser.
const SIMPLIFY_TOLERANCE_METERS = 3;

// Local planar approximation is fine at this scale (a single BC transit region).
const REFERENCE_LAT = 48.5;
const METERS_PER_DEG_LAT = 111320;
const METERS_PER_DEG_LON = 111320 * Math.cos((REFERENCE_LAT * Math.PI) / 180);

function toMeters(lat, lon) {
  return [lon * METERS_PER_DEG_LON, lat * METERS_PER_DEG_LAT];
}

function toLatLon(x, y) {
  return [y / METERS_PER_DEG_LAT, x / METERS_PER_DEG_LON];
}

function distance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

// Resamples a [lat, lon][] polyline to even spacing (in meters-space), preserving
// the endpoints. Returns points in the same [lat, lon] meters-projected form.
function resample(metersPoints, stepMeters) {
  if (metersPoints.length < 2) return metersPoints.slice();

  const result = [metersPoints[0]];
  let distSinceLastSample = 0;

  for (let i = 1; i < metersPoints.length; i++) {
    const a = metersPoints[i - 1];
    const b = metersPoints[i];
    const segLen = distance(a, b);
    if (segLen === 0) continue;

    const dirX = (b[0] - a[0]) / segLen;
    const dirY = (b[1] - a[1]) / segLen;
    let distIntoSeg = 0;
    let needed = stepMeters - distSinceLastSample;

    while (needed <= segLen - distIntoSeg) {
      distIntoSeg += needed;
      result.push([a[0] + dirX * distIntoSeg, a[1] + dirY * distIntoSeg]);
      distSinceLastSample = 0;
      needed = stepMeters;
    }
    distSinceLastSample += segLen - distIntoSeg;
  }

  const last = metersPoints[metersPoints.length - 1];
  const secondLast = result[result.length - 1];
  if (!secondLast || distance(secondLast, last) > 0.5) {
    result.push(last);
  }
  return result;
}

function cellIndex(point) {
  return [Math.floor(point[0] / GRID_CELL_METERS), Math.floor(point[1] / GRID_CELL_METERS)];
}

function cellKey(cx, cy) {
  return `${cx},${cy}`;
}

function routesNear(grid, point) {
  const [cx, cy] = cellIndex(point);
  const routes = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const set = grid.get(cellKey(cx + dx, cy + dy));
      if (set) for (const r of set) routes.add(r);
    }
  }
  return routes;
}

// Ramer-Douglas-Peucker simplification on meters-projected [x, y] points.
function simplify(points, toleranceMeters) {
  if (points.length < 3) return points;

  function perpendicularDistance(point, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return distance(point, a);
    const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (len * len);
    const projX = a[0] + t * dx;
    const projY = a[1] + t * dy;
    return distance(point, [projX, projY]);
  }

  function rdp(pts) {
    if (pts.length < 3) return pts;
    const a = pts[0];
    const b = pts[pts.length - 1];
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistance(pts[i], a, b);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxDist > toleranceMeters) {
      const left = rdp(pts.slice(0, maxIndex + 1));
      const right = rdp(pts.slice(maxIndex));
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  return rdp(points);
}

function perpendicularUnit(prev, next) {
  const dx = next[0] - prev[0];
  const dy = next[1] - prev[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [0, 0];
  return [-dy / len, dx / len];
}

// Auto-generates visually distinct colors, one per route, in a stable (natural
// sort) order so colors don't shuffle between server restarts. Hues are spaced
// by the golden angle (~137.5°) rather than evenly (360/N) so that adjacent
// route numbers — which are often physically close to each other — don't end
// up with similar-looking adjacent hues.
const GOLDEN_ANGLE_DEGREES = 137.508;

function assignRouteColors(routeShortNames) {
  const sorted = Array.from(routeShortNames).sort(naturalRouteCompare);
  const colorByShortName = new Map();
  sorted.forEach((name, i) => {
    const hue = Math.round((i * GOLDEN_ANGLE_DEGREES) % 360);
    colorByShortName.set(name, `hsl(${hue}, 75%, 42%)`);
  });
  return colorByShortName;
}

// Loads GTFS shapes joined to their route, and assigns each route a color. Shared
// by both the bundled (offset) and raw geometry builders below.
function loadGtfsShapes(dataDir) {
  const gtfsDir = findGtfsDir(dataDir);
  if (!gtfsDir) return { shapes: [], colorByShortName: new Map() };

  const routeShortNameById = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'routes.txt'))) {
    routeShortNameById.set(row.route_id, row.route_short_name);
  }

  const routeIdByShapeId = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'trips.txt'))) {
    if (!routeIdByShapeId.has(row.shape_id)) {
      routeIdByShapeId.set(row.shape_id, row.route_id);
    }
  }

  const pointsByShapeId = new Map();
  for (const row of parseGtfsCsv(path.join(gtfsDir, 'shapes.txt'))) {
    if (!routeIdByShapeId.has(row.shape_id)) continue; // shape unused by any trip
    let arr = pointsByShapeId.get(row.shape_id);
    if (!arr) {
      arr = [];
      pointsByShapeId.set(row.shape_id, arr);
    }
    arr.push({
      seq: Number(row.shape_pt_sequence),
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon),
    });
  }

  const shapes = [];
  for (const [shapeId, pts] of pointsByShapeId) {
    const routeId = routeIdByShapeId.get(shapeId);
    const routeShortName = routeShortNameById.get(routeId);
    if (!routeShortName) continue;
    pts.sort((a, b) => a.seq - b.seq);
    shapes.push({ shapeId, routeShortName, metersPoints: pts.map((p) => toMeters(p.lat, p.lon)) });
  }

  const colorByShortName = assignRouteColors(new Set(shapes.map((s) => s.routeShortName)));
  return { shapes, colorByShortName };
}

// Builds a bundled/offset GeoJSON of route lines from the GTFS shapes, so routes
// that share a road are drawn as visually separated parallel lines instead of
// stacking exactly on top of each other. This is a grid-based approximation (no
// real road-network topology): points within GRID_CELL_METERS of each other are
// treated as "the same road", which can occasionally over- or under-bundle at
// tight interchanges, parallel one-way pairs, or overpasses.
//
// This always bundles against ALL routes at once (not just a subset), so it's the
// precomputed "everything visible" case: fast to serve since it's computed once at
// startup. Showing an arbitrary subset of routes with correct (tighter) bundling
// among just those routes is done client-side instead — see public/routeBundling.js.
function loadRouteLines(dataDir) {
  const { shapes: rawShapes, colorByShortName } = loadGtfsShapes(dataDir);

  // Route length in km = the longest single shape on that route (a good proxy for
  // "one end-to-end trip"). Used for the "km ridden" stat, not for scoring.
  const routeLengthKmByShortName = new Map();
  for (const s of rawShapes) {
    const km = polylineLengthMeters(s.metersPoints) / 1000;
    if (km > (routeLengthKmByShortName.get(s.routeShortName) || 0)) {
      routeLengthKmByShortName.set(s.routeShortName, km);
    }
  }

  const shapes = rawShapes.map((s) => ({
    shapeId: s.shapeId,
    routeShortName: s.routeShortName,
    resampled: resample(s.metersPoints, RESAMPLE_STEP_METERS),
  }));

  const grid = new Map();
  for (const shape of shapes) {
    for (const point of shape.resampled) {
      const [cx, cy] = cellIndex(point);
      const key = cellKey(cx, cy);
      let set = grid.get(key);
      if (!set) {
        set = new Set();
        grid.set(key, set);
      }
      set.add(shape.routeShortName);
    }
  }

  const features = [];
  for (const shape of shapes) {
    const pts = shape.resampled;
    const offsetPoints = pts.map((point, i) => {
      const routesHere = Array.from(routesNear(grid, point)).sort(naturalRouteCompare);
      const slot = routesHere.indexOf(shape.routeShortName);
      const offsetSlots = slot - (routesHere.length - 1) / 2;
      const offsetMeters = offsetSlots * OFFSET_SPACING_METERS;

      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const [perpX, perpY] = perpendicularUnit(prev, next);

      return [point[0] + perpX * offsetMeters, point[1] + perpY * offsetMeters];
    });

    const simplified = simplify(offsetPoints, SIMPLIFY_TOLERANCE_METERS);
    const coordinates = simplified.map(([x, y]) => {
      const [lat, lon] = toLatLon(x, y);
      return [lon, lat];
    });

    features.push({
      type: 'Feature',
      properties: {
        shapeId: shape.shapeId,
        route: shape.routeShortName,
        color: colorByShortName.get(shape.routeShortName),
      },
      geometry: { type: 'LineString', coordinates },
    });
  }

  return {
    geojson: { type: 'FeatureCollection', features },
    colorByShortName,
    routeLengthKmByShortName,
  };
}

// Builds unbundled (no offset) simplified GeoJSON — the raw source geometry the
// browser bundles on the fly for whatever subset of routes is currently visible.
// No resampling needed here since there's no grid/offset step to feed.
function loadRawRouteLines(dataDir) {
  const { shapes, colorByShortName } = loadGtfsShapes(dataDir);

  const features = shapes.map((shape) => {
    const simplified = simplify(shape.metersPoints, SIMPLIFY_TOLERANCE_METERS);
    const coordinates = simplified.map(([x, y]) => {
      const [lat, lon] = toLatLon(x, y);
      return [lon, lat];
    });
    return {
      type: 'Feature',
      properties: {
        shapeId: shape.shapeId,
        route: shape.routeShortName,
        color: colorByShortName.get(shape.routeShortName),
      },
      geometry: { type: 'LineString', coordinates },
    };
  });

  return { type: 'FeatureCollection', features };
}

module.exports = { loadRouteLines, loadRawRouteLines };
