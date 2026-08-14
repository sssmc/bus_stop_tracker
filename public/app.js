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

const POPUP_AUTO_CLOSE_MS = 1200;

const markersByStopId = new Map();
let routesLayer = null;

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

function setupRoutesToggle(geojson) {
  routesLayer = L.geoJSON(geojson, {
    style: (feature) => ({ color: feature.properties.color, weight: 3, opacity: 0.85 }),
  });
  routesLayer.eachLayer((layer) => layer.bindTooltip(`Route ${layer.feature.properties.route}`));
  document.getElementById('toggle-routes').addEventListener('change', (event) => {
    if (event.target.checked) {
      routesLayer.addTo(map);
      routesLayer.bringToBack();
    } else {
      map.removeLayer(routesLayer);
    }
  });
}

Promise.all([
  fetch('/api/stops').then((res) => res.json()),
  fetch('/api/routes').then((res) => res.json()),
]).then(([stops, routesGeoJson]) => {
  renderStops(stops);
  setupRoutesToggle(routesGeoJson);
  connectWebSocket();
});
