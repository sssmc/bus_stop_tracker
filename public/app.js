'use strict';

const MOBILE_BREAKPOINT_PX = 700;

// Markers are smaller on mobile, where screen space is tight and stops render
// much closer together relative to the viewport.
const BASE_RADIUS_UNVISITED_DESKTOP = 5;
const BASE_RADIUS_VISITED_DESKTOP = 6;
const BASE_RADIUS_UNVISITED_MOBILE = 3;
const BASE_RADIUS_VISITED_MOBILE = 4;
const COLOR_UNVISITED = { color: '#3388ff', weight: 1, fillColor: '#3388ff', fillOpacity: 0.6 };
const COLOR_VISITED = { color: '#2e7d32', weight: 1, fillColor: '#4caf50', fillOpacity: 0.9 };

// Markers start at half their base size at the zoomed-out region view and grow
// up to 6x their base size as you zoom in, reaching full size ZOOM_SCALE_RANGE
// levels past that initial view.
const ZOOM_SCALE_RANGE = 8;
const MIN_ZOOM_SCALE = 0.5;
const MAX_ZOOM_SCALE = 6;
let baseZoom = null;

// Route lines are widest at the zoomed-out region view (where they're otherwise
// easy to miss) and taper down to a normal weight as you zoom in.
const ROUTE_WEIGHT_MAX = 11;
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
// Mobile screens show less of the map per zoom level, so stops stay dominant
// (routes on top) for a few extra zoom levels there before handing priority back.
const ROUTE_ZORDER_ZOOM_RANGE_DESKTOP = 2;
const ROUTE_ZORDER_ZOOM_RANGE_MOBILE = 5;

function routeZOrderZoomRange() {
  return window.innerWidth < MOBILE_BREAKPOINT_PX
    ? ROUTE_ZORDER_ZOOM_RANGE_MOBILE
    : ROUTE_ZORDER_ZOOM_RANGE_DESKTOP;
}

function isLowZoom(zoom) {
  return baseZoom != null && zoom < baseZoom + routeZOrderZoomRange();
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

// Short names of routes marked ridden. Kept current from route-ridden-changed
// WebSocket events (the map page has no ridden toggle of its own — those come
// from the list page) so the score stays live. Feeds updateStats() only.
const riddenRoutes = new Set();

let activeWs = null;
let myClientId = null;
const userLocationMarkers = new Map(); // clientId -> L.CircleMarker

const map = L.map('map', { renderer: L.canvas() });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

// All stop markers live in this group so the "Hide stops" button can pull them
// off the map (and put them back) in one call. Marker state — visited colour,
// radius, stats — keeps updating from WebSocket events while hidden, so toggling
// back shows the current picture.
const stopLayer = L.layerGroup().addTo(map);

function baseRadiusFor(visited) {
  const isMobile = window.innerWidth < MOBILE_BREAKPOINT_PX;
  if (visited) return isMobile ? BASE_RADIUS_VISITED_MOBILE : BASE_RADIUS_VISITED_DESKTOP;
  return isMobile ? BASE_RADIUS_UNVISITED_MOBILE : BASE_RADIUS_UNVISITED_DESKTOP;
}

function colorStyleFor(visited) {
  return visited ? COLOR_VISITED : COLOR_UNVISITED;
}

function zoomScale(zoom) {
  if (baseZoom == null) return MIN_ZOOM_SCALE;
  const t = Math.min(Math.max((zoom - baseZoom) / ZOOM_SCALE_RANGE, 0), 1);
  return MIN_ZOOM_SCALE + t * (MAX_ZOOM_SCALE - MIN_ZOOM_SCALE);
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
  const score = Score.compute(visitedCount, riddenRoutes.size);
  document.getElementById('stats').textContent = `${score} pts · ${visitedCount} / ${total} visited`;
}

function setRiddenRoutes(routesMeta) {
  riddenRoutes.clear();
  for (const route of routesMeta) {
    if (route.ridden) riddenRoutes.add(route.shortName);
  }
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
    marker.addTo(stopLayer);
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

function setupStopsToggle() {
  const btn = document.getElementById('toggle-stops');
  btn.addEventListener('click', () => {
    if (map.hasLayer(stopLayer)) {
      map.removeLayer(stopLayer);
      btn.textContent = 'Show stops';
    } else {
      stopLayer.addTo(map);
      btn.textContent = 'Hide stops';
    }
  });
}

function resyncStops() {
  Promise.all([
    fetch('/api/stops').then((res) => res.json()),
    fetch('/api/routes-meta').then((res) => res.json()),
  ])
    .then(([stops, routesMeta]) => {
      for (const stop of stops) {
        applyVisitedChange(stop.stopid, stop.visited);
      }
      // Catches any ridden-route changes missed while the socket was down.
      setRiddenRoutes(routesMeta);
      updateStats();
    })
    .catch((err) => console.error('Failed to resync stops', err));
}

const SELF_LOCATION_COLOR = '#e53935';
const SELF_LOCATION_RADIUS = 12;
const OTHER_LOCATION_RADIUS = 8;

function upsertUserLocationMarker(clientId, lat, lon, color) {
  const isSelf = clientId === myClientId;
  const style = {
    radius: isSelf ? SELF_LOCATION_RADIUS : OTHER_LOCATION_RADIUS,
    color: '#ffffff',
    weight: 2,
    fillColor: isSelf ? SELF_LOCATION_COLOR : color,
    fillOpacity: 0.95,
  };

  let marker = userLocationMarkers.get(clientId);
  if (!marker) {
    marker = L.circleMarker([lat, lon], style);
    marker.addTo(map);
    userLocationMarkers.set(clientId, marker);
  } else {
    marker.setLatLng([lat, lon]);
    marker.setStyle(style);
  }
  marker.bindTooltip(isSelf ? 'You' : 'Live user', { sticky: true });
  marker.bringToFront();
}

function removeUserLocationMarker(clientId) {
  const marker = userLocationMarkers.get(clientId);
  if (marker) {
    map.removeLayer(marker);
    userLocationMarkers.delete(clientId);
  }
}

function clearUserLocationMarkers() {
  for (const marker of userLocationMarkers.values()) map.removeLayer(marker);
  userLocationMarkers.clear();
}

function shareLocationOverWebSocket() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition(
    (position) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(
          JSON.stringify({
            type: 'location-update',
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          })
        );
      }
    },
    (err) => console.warn('Geolocation unavailable:', err.message),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  activeWs = ws;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'visited-changed') {
      applyVisitedChange(msg.stopid, msg.visited);
    } else if (msg.type === 'route-ridden-changed') {
      if (msg.ridden) riddenRoutes.add(msg.shortName);
      else riddenRoutes.delete(msg.shortName);
      updateStats();
    } else if (msg.type === 'hello') {
      myClientId = msg.clientId;
    } else if (msg.type === 'user-location') {
      upsertUserLocationMarker(msg.clientId, msg.lat, msg.lon, msg.color);
    } else if (msg.type === 'user-left') {
      removeUserLocationMarker(msg.clientId);
    }
  });

  ws.addEventListener('close', () => {
    clearUserLocationMarkers();
    myClientId = null;
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
    const baseWeight = routeWeightForZoom(zoom);
    const layer = L.polyline(latLngs, {
      color: colorByRoute.get(route) || '#999999',
      weight: baseWeight,
      opacity: 0.85,
    });
    layer._baseWeight = baseWeight;
    layer.bindTooltip(`Route ${route}`, { sticky: true });
    layer.on('mouseover', () => {
      layer.setStyle({ weight: layer._baseWeight + 4, opacity: 1 });
      layer.bringToFront();
    });
    layer.on('mouseout', () => {
      layer.setStyle({ weight: layer._baseWeight, opacity: 0.85 });
      applyRouteZOrder(layer, map.getZoom());
    });
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
      layer._baseWeight = weight;
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
  setCollapsed(window.innerWidth < MOBILE_BREAKPOINT_PX);
}

Promise.all([
  fetch('/api/stops').then((res) => res.json()),
  fetch('/api/routes').then((res) => res.json()),
  fetch('/api/routes-raw').then((res) => res.json()),
  fetch('/api/routes-meta').then((res) => res.json()),
]).then(([stops, routesGeoJson, routesRawGeoJson, routesMeta]) => {
  setRiddenRoutes(routesMeta);
  renderStops(stops);
  setupStopsToggle();
  setupRoutes(routesMeta, routesGeoJson, routesRawGeoJson);
  connectWebSocket();
  shareLocationOverWebSocket();
});
