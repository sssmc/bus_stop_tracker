'use strict';

let allStops = [];
let routesMeta = [];
const rowsByStopId = new Map();

const searchInput = document.getElementById('search');
const groupToggle = document.getElementById('toggle-group');
const listContainer = document.getElementById('stop-list');

function toggleVisited(stopid, currentlyVisited) {
  fetch(`/api/stops/${stopid}/visited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visited: !currentlyVisited }),
  }).catch((err) => console.error('Failed to update visited state', err));
}

function createStopRow(stop) {
  const row = document.createElement('div');
  row.className = 'stop-row' + (stop.visited ? ' visited' : '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = stop.visited;

  const name = document.createElement('span');
  name.className = 'stop-name';
  name.textContent = stop.stopname;

  const muni = document.createElement('span');
  muni.className = 'stop-muni';
  muni.textContent = stop.muni || '';

  row.append(checkbox, name, muni);
  row.addEventListener('click', () => toggleVisited(stop.stopid, stop.visited));

  if (!rowsByStopId.has(stop.stopid)) rowsByStopId.set(stop.stopid, []);
  rowsByStopId.get(stop.stopid).push(row);

  return row;
}

function matchesSearch(stop, query) {
  return !query || stop.stopname.toLowerCase().includes(query);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const grouped = groupToggle.checked;

  rowsByStopId.clear();
  listContainer.innerHTML = '';

  const filtered = allStops.filter((stop) => matchesSearch(stop, query));

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-message';
    empty.textContent = 'No stops match your search.';
    listContainer.appendChild(empty);
    updateStats(filtered.length);
    return;
  }

  if (!grouped) {
    const sorted = [...filtered].sort((a, b) => a.stopname.localeCompare(b.stopname));
    for (const stop of sorted) {
      listContainer.appendChild(createStopRow(stop));
    }
    updateStats(filtered.length);
    return;
  }

  for (const route of routesMeta) {
    const stopsOnRoute = filtered
      .filter((stop) => stop.routes.includes(route.shortName))
      .sort((a, b) => a.stopname.localeCompare(b.stopname));
    if (stopsOnRoute.length === 0) continue;

    const heading = document.createElement('div');
    heading.className = 'route-group-heading';
    heading.textContent = `Route ${route.shortName} — ${route.longName}`;
    listContainer.appendChild(heading);

    for (const stop of stopsOnRoute) {
      listContainer.appendChild(createStopRow(stop));
    }
  }

  const unassigned = filtered
    .filter((stop) => stop.routes.length === 0)
    .sort((a, b) => a.stopname.localeCompare(b.stopname));
  if (unassigned.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'route-group-heading';
    heading.textContent = 'Unassigned';
    listContainer.appendChild(heading);
    for (const stop of unassigned) {
      listContainer.appendChild(createStopRow(stop));
    }
  }

  updateStats(filtered.length);
}

function updateStats(filteredCount) {
  const visitedCount = allStops.filter((s) => s.visited).length;
  const total = allStops.length;
  const showing = filteredCount === total ? '' : ` (showing ${filteredCount})`;
  document.getElementById('stats').textContent = `${visitedCount} / ${total} visited${showing}`;
}

function applyVisitedChange(stopid, visited) {
  const stop = allStops.find((s) => s.stopid === stopid);
  if (stop) stop.visited = visited;

  const rows = rowsByStopId.get(stopid) || [];
  for (const row of rows) {
    row.classList.toggle('visited', visited);
    row.querySelector('input[type="checkbox"]').checked = visited;
  }
  updateStats(listContainer.querySelectorAll('.stop-row').length);
}

function resyncStops() {
  fetch('/api/stops')
    .then((res) => res.json())
    .then((stops) => {
      allStops = stops;
      render();
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

searchInput.addEventListener('input', render);
groupToggle.addEventListener('change', render);

Promise.all([
  fetch('/api/stops').then((res) => res.json()),
  fetch('/api/routes-meta').then((res) => res.json()),
]).then(([stops, meta]) => {
  allStops = stops;
  routesMeta = meta;
  render();
  connectWebSocket();
});
