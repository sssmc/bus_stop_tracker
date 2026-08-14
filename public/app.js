'use strict';

const BASE_RADIUS_UNVISITED = 5;
const BASE_RADIUS_VISITED = 6;
const COLOR_UNVISITED = { color: '#3388ff', weight: 1, fillColor: '#3388ff', fillOpacity: 0.6 };
const COLOR_VISITED = { color: '#2e7d32', weight: 1, fillColor: '#4caf50', fillOpacity: 0.9 };

// Markers grow up to 6x their base size as you zoom in, reaching full size
// ZOOM_SCALE_RANGE levels past the initial (zoomed-out, whole-region) view.
const ZOOM_SCALE_RANGE = 8;
const MAX_ZOOM_SCALE = 6;
let baseZoom = null;

// Route lines are widest at the zoomed-out region view (where they're otherwise
// easy to miss) and taper down to a normal weight as you zoom in.
const ROUTE_WEIGHT_MAX = 15;
const ROUTE_WEIGHT_MIN = 4;
const ROUTE_WEIGHT_ZOOM_RANGE = 6;

function routeWeightForZoom(zoom) {
  if (baseZoom == null) return ROUTE_WEIGHT_MIN;
  const t = Math.min(Math.max((zoom - baseZoom) / ROUTE_WEIGHT_ZOOM_RANGE, 0), 1);
  return ROUTE_WEIGHT_MAX - t * (ROUTE_WEIGHT_MAX - ROUTE_WEIGHT_MIN);
}

// At low zoom, routes are drawn thick to stay visible, so they need to sit above
// the (comparatively tiny) stop markers or they'd be hidden underneath them. Once
// zoomed in past this (shorter than the weight taper) range, routes go back below
// markers so clicking a stop stays reliable even where a route passes through it.
const ROUTE_ZORDER_ZOOM_RANGE = 2;

function isLowZoom(zoom) {
  return baseZoom != null && zoom < baseZoom + ROUTE_ZORDER_ZOOM_RANGE;
}

function applyRouteZOrder(layer, zoom) {
  if (isLowZoom(zoom)) {
    layer.bringToFront();
  } else {
    layer.bringToBack();
  }
}

const POPUP_AUTO_CLOSE_MS = 1200;

const markersByStopId = new Map();

const map = L.map('map', { renderer: L.canvas() });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

function baseRadiusFor(visited) {
  return visited ? BASE_RADIUS_VISITED : BASE_RADIUS_UNVISITED;
}

function colorStyleFor(visited) {
  return visited ? COLOR_VISITED : COLOR_UNVISITED;
}

function zoomScale(zoom) {
  if (baseZoom == null) return 1;
  const t = Math.min(Math.max((zoom - baseZoom) / ZOOM_SCALE_RANGE, 0), 1);
  return 1 + t * (MAX_ZOOM_SCALE - 1);
}

function updateMarkerRadius(marker) {
  marker.setRadius(baseRadiusFor(marker._visited) * zoomScale(map.getZoom()));
}

function updateAllMarkerRadii() {
  for (const marker of markersByStopId.values()) {
    updateMarkerRadius(marker);
  }
}

function updateStats() {
  const total = markersByStopId.size;
  let visitedCount = 0;
  for (const marker of markersByStopId.values()) {
    if (marker._visited) visitedCount += 1;
  }
  document.getElementById('stats').textContent = `${visitedCount} / ${total} visited`;
}

function applyVisitedChange(stopid, visited) {
  const marker = markersByStopId.get(stopid);
  if (!marker) return;
  marker._visited = visited;
  marker.setStyle(colorStyleFor(visited));
  updateMarkerRadius(marker);
  updateStats();
}

function toggleVisited(stopid) {
  const marker = markersByStopId.get(stopid);
  if (!marker) return;
  const nextVisited = !marker._visited;
  fetch(`/api/stops/${stopid}/visited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visited: nextVisited }),
  }).catch((err) => console.error('Failed to update visited state', err));
}

function renderStops(stops) {
  const bounds = [];
  for (const stop of stops) {
    const style = { radius: baseRadiusFor(stop.visited), ...colorStyleFor(stop.visited) };
    const marker = L.circleMarker([stop.latitude, stop.longitude], style);
    marker._visited = stop.visited;
    marker.bindPopup(stop.stopname);
    marker.on('click', () => {
      toggleVisited(stop.stopid);
      setTimeout(() => marker.closePopup(), POPUP_AUTO_CLOSE_MS);
    });
    marker.addTo(map);
    markersByStopId.set(stop.stopid, marker);
    bounds.push([stop.latitude, stop.longitude]);
  }
  if (bounds.length > 0) {
    map.fitBounds(bounds);
  }
  baseZoom = map.getZoom();
  map.on('zoomend', updateAllMarkerRadii);
  updateStats();
}

function resyncStops() {
  fetch('/api/stops')
    .then((res) => res.json())
    .then((stops) => {
      for (const stop of stops) {
        applyVisitedChange(stop.stopid, stop.visited);
      }
    })
    .catch((err) => console.error('Failed to resync stops', err));
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'visited-changed') {
      applyVisitedChange(msg.stopid, msg.visited);
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(() => {
      connectWebSocket();
      resyncStops();
    }, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

// Groups the precomputed (server-bundled, all-routes-at-once) GeoJSON by route,
// as [lon, lat] coordinate lists — the fast path used when every route is visible.
function groupBundledCoordsByRoute(geojson) {
  const byRoute = new Map();
  for (const feature of geojson.features) {
    const route = feature.properties.route;
    if (!byRoute.has(route)) byRoute.set(route, []);
    byRoute.get(route).push(feature.geometry.coordinates);
  }
  return byRoute;
}

// Groups the raw (unbundled) GeoJSON by route as [lat, lon] point lists — the
// source geometry used to bundle an arbitrary subset of routes on the fly.
function groupRawShapesByRoute(geojson) {
  const byRoute = new Map();
  for (const feature of geojson.features) {
    const route = feature.properties.route;
    const points = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (!byRoute.has(route)) byRoute.set(route, []);
    byRoute.get(route).push({ shapeId: feature.properties.shapeId, route, points });
  }
  return byRoute;
}

// Manages which routes are shown and how their lines are bundled. When every
// available route is visible, it uses the precomputed (server-bundled) geometry
// instantly. Any partial subset is re-bundled client-side — using only the
// visible routes' raw geometry — so overlapping routes stay tightly separated
// from each other instead of using their offset slots from the full 69-route set.
// Partial-subset recomputation is debounced so rapid toggling (or "Show all
// routes" checking boxes one by one) doesn't trigger it dozens of times.
const ROUTE_RECOMPUTE_DEBOUNCE_MS = 300;

function setupRoutes(routesMeta, bundledGeoJson, rawGeoJson) {
  const rawShapesByRoute = groupRawShapesByRoute(rawGeoJson);
  const precomputedCoordsByRoute = groupBundledCoordsByRoute(bundledGeoJson);
  const allRouteNames = new Set(rawShapesByRoute.keys());
  const colorByRoute = new Map(routesMeta.map((r) => [r.shortName, r.color]));

  const visibleRoutes = new Set();
  let currentLineLayers = [];
  let recomputeTimer = null;

  function addRouteLine(route, latLngs, zoom) {
    const layer = L.polyline(latLngs, {
      color: colorByRoute.get(route) || '#999999',
      weight: routeWeightForZoom(zoom),
      opacity: 0.85,
    });
    layer.bindTooltip(`Route ${route}`);
    layer.addTo(map);
    applyRouteZOrder(layer, zoom);
    currentLineLayers.push(layer);
  }

  function renderVisibleRoutes() {
    for (const layer of currentLineLayers) map.removeLayer(layer);
    currentLineLayers = [];
    if (visibleRoutes.size === 0) return;

    const zoom = map.getZoom();

    if (visibleRoutes.size === allRouteNames.size) {
      // Fast path: every route is visible, so the server's precomputed bundling
      // (already correct for "all routes at once") can be used directly.
      for (const route of visibleRoutes) {
        for (const coordinates of precomputedCoordsByRoute.get(route) || []) {
          addRouteLine(route, coordinates.map(([lon, lat]) => [lat, lon]), zoom);
        }
      }
      return;
    }

    const subsetShapes = [];
    for (const route of visibleRoutes) {
      for (const shape of rawShapesByRoute.get(route) || []) subsetShapes.push(shape);
    }
    for (const shape of RouteBundling.bundleRoutes(subsetShapes)) {
      addRouteLine(shape.route, shape.coordinates.map(([lon, lat]) => [lat, lon]), zoom);
    }
  }

  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(renderVisibleRoutes, ROUTE_RECOMPUTE_DEBOUNCE_MS);
  }

  map.on('zoomend', () => {
    const zoom = map.getZoom();
    const weight = routeWeightForZoom(zoom);
    for (const layer of currentLineLayers) {
      layer.setStyle({ weight });
      applyRouteZOrder(layer, zoom);
    }
  });

  const listEl = document.getElementById('route-list');
  const toggleAllBtn = document.getElementById('toggle-all-routes');
  const checkboxes = [];

  function updateToggleAllLabel() {
    const allChecked = checkboxes.length > 0 && checkboxes.every((cb) => cb.checked);
    toggleAllBtn.textContent = allChecked ? 'Hide all routes' : 'Show all routes';
  }

  for (const route of routesMeta) {
    if (!allRouteNames.has(route.shortName)) continue; // no scheduled trips/shapes in this GTFS feed

    const item = document.createElement('label');
    item.className = 'route-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        visibleRoutes.add(route.shortName);
      } else {
        visibleRoutes.delete(route.shortName);
      }
      scheduleRecompute();
      updateToggleAllLabel();
    });

    const swatch = document.createElement('span');
    swatch.className = 'route-color-swatch';
    swatch.style.background = route.color;

    const label = document.createElement('span');
    label.className = 'route-label';
    label.textContent = `${route.shortName} — ${route.longName}`;
    label.title = label.textContent;

    item.append(checkbox, swatch, label);
    listEl.appendChild(item);
    checkboxes.push(checkbox);
  }

  toggleAllBtn.addEventListener('click', () => {
    const shouldShow = toggleAllBtn.textContent === 'Show all routes';
    for (const checkbox of checkboxes) {
      checkbox.checked = shouldShow;
    }
    visibleRoutes.clear();
    if (shouldShow) {
      for (const route of allRouteNames) visibleRoutes.add(route);
    }
    // Bypass the debounce: both the empty and full-set cases render instantly.
    clearTimeout(recomputeTimer);
    renderVisibleRoutes();
    updateToggleAllLabel();
  });

  updateToggleAllLabel();

  const sidebar = document.getElementById('route-sidebar');
  const collapseToggle = document.getElementById('sidebar-collapse-toggle');
  function setCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    collapseToggle.textContent = collapsed ? '☰' : '☰ Routes';
  }
  collapseToggle.addEventListener('click', () => {
    setCollapsed(!sidebar.classList.contains('collapsed'));
  });
  // Start collapsed on small screens so the sidebar doesn't block the map.
  setCollapsed(window.innerWidth < 700);
}

Promise.all([
  fetch('/api/stops').then((res) => res.json()),
  fetch('/api/routes').then((res) => res.json()),
  fetch('/api/routes-raw').then((res) => res.json()),
  fetch('/api/routes-meta').then((res) => res.json()),
]).then(([stops, routesGeoJson, routesRawGeoJson, routesMeta]) => {
  renderStops(stops);
  setupRoutes(routesMeta, routesGeoJson, routesRawGeoJson);
  connectWebSocket();
});
