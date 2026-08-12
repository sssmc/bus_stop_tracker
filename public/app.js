'use strict';

const STYLE_UNVISITED = { radius: 5, color: '#3388ff', weight: 1, fillColor: '#3388ff', fillOpacity: 0.6 };
const STYLE_VISITED = { radius: 6, color: '#2e7d32', weight: 1, fillColor: '#4caf50', fillOpacity: 0.9 };

const markersByStopId = new Map();
let routesLayer = null;

const map = L.map('map', { renderer: L.canvas() });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

function styleFor(visited) {
  return visited ? STYLE_VISITED : STYLE_UNVISITED;
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
  marker.setStyle(styleFor(visited));
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
    const marker = L.circleMarker([stop.latitude, stop.longitude], styleFor(stop.visited));
    marker._visited = stop.visited;
    marker.bindPopup(stop.stopname);
    marker.on('click', () => toggleVisited(stop.stopid));
    marker.addTo(map);
    markersByStopId.set(stop.stopid, marker);
    bounds.push([stop.latitude, stop.longitude]);
  }
  if (bounds.length > 0) {
    map.fitBounds(bounds);
  }
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
  routesLayer = L.geoJSON(geojson, { style: { color: '#e65100', weight: 2, opacity: 0.7 } });
  document.getElementById('toggle-routes').addEventListener('change', (event) => {
    if (event.target.checked) {
      routesLayer.addTo(map);
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
