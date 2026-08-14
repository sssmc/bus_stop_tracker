'use strict';

// Client-side port of server/loadRouteLines.js's bundling algorithm, used to
// re-bundle just the currently-visible subset of routes (the server only
// precomputes the "all routes visible" case for speed — see app.js).
const RouteBundling = (() => {
  const RESAMPLE_STEP_METERS = 15;
  const GRID_CELL_METERS = 15;
  const OFFSET_SPACING_METERS = 4;
  const SIMPLIFY_TOLERANCE_METERS = 3;

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

  // shapes: [{shapeId, route, points: [[lat, lon], ...]}] — only the currently
  // visible subset. Returns [{shapeId, route, coordinates: [[lon, lat], ...]}].
  function bundleRoutes(shapes) {
    const prepared = shapes.map((s) => ({
      shapeId: s.shapeId,
      route: s.route,
      resampled: resample(s.points.map(([lat, lon]) => toMeters(lat, lon)), RESAMPLE_STEP_METERS),
    }));

    const grid = new Map();
    for (const shape of prepared) {
      for (const point of shape.resampled) {
        const [cx, cy] = cellIndex(point);
        const key = cellKey(cx, cy);
        let set = grid.get(key);
        if (!set) {
          set = new Set();
          grid.set(key, set);
        }
        set.add(shape.route);
      }
    }

    return prepared.map((shape) => {
      const pts = shape.resampled;
      const offsetPoints = pts.map((point, i) => {
        const routesHere = Array.from(routesNear(grid, point)).sort(naturalRouteCompare);
        const slot = routesHere.indexOf(shape.route);
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

      return { shapeId: shape.shapeId, route: shape.route, coordinates };
    });
  }

  return { bundleRoutes };
})();
