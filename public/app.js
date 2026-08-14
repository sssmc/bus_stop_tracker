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

function buildRouteLayers(geojson) {
  const featuresByRoute = new Map();
  for (const feature of geojson.features) {
    const route = feature.properties.route;
    if (!featuresByRoute.has(route)) featuresByRoute.set(route, []);
    featuresByRoute.get(route).push(feature);
  }

  const initialWeight = routeWeightForZoom(map.getZoom());
  const layersByRoute = new Map();
  for (const [route, features] of featuresByRoute) {
    const layer = L.geoJSON(
      { type: 'FeatureCollection', features },
      { style: (feature) => ({ color: feature.properties.color, weight: initialWeight, opacity: 0.85 }) }
    );
    layer.eachLayer((l) => l.bindTooltip(`Route ${route}`));
    layersByRoute.set(route, layer);
  }

  map.on('zoomend', () => {
    const zoom = map.getZoom();
    const weight = routeWeightForZoom(zoom);
    for (const layer of layersByRoute.values()) {
      layer.setStyle({ weight });
      if (map.hasLayer(layer)) applyRouteZOrder(layer, zoom);
    }
  });

  return layersByRoute;
}

function setupRouteSidebar(routesMeta, layersByRoute) {
  const listEl = document.getElementById('route-list');
  const toggleAllBtn = document.getElementById('toggle-all-routes');
  const checkboxes = [];

  function updateToggleAllLabel() {
    const allChecked = checkboxes.length > 0 && checkboxes.every((cb) => cb.checked);
    toggleAllBtn.textContent = allChecked ? 'Hide all routes' : 'Show all routes';
  }

  for (const route of routesMeta) {
    const layer = layersByRoute.get(route.shortName);
    if (!layer) continue; // route has no scheduled trips/shapes in this GTFS feed

    const item = document.createElement('label');
    item.className = 'route-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        layer.addTo(map);
        applyRouteZOrder(layer, map.getZoom());
      } else {
        map.removeLayer(layer);
      }
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
      if (checkbox.checked !== shouldShow) {
        checkbox.checked = shouldShow;
        checkbox.dispatchEvent(new Event('change'));
      }
    }
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
  fetch('/api/routes-meta').then((res) => res.json()),
]).then(([stops, routesGeoJson, routesMeta]) => {
  renderStops(stops);
  const layersByRoute = buildRouteLayers(routesGeoJson);
  setupRouteSidebar(routesMeta, layersByRoute);
  connectWebSocket();
});
