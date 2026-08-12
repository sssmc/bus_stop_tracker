'use strict';

let allStops = [];
let allStopsById = new Map();
let routesMeta = [];
const rowsByStopId = new Map();
let routeGroups = []; // { wrapper, heading, baseTitle, stopIds }

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

function updateGroupHeading(group) {
  const stopsInGroup = group.stopIds.map((id) => allStopsById.get(id)).filter(Boolean);
  const total = stopsInGroup.length;
  const visitedCount = stopsInGroup.filter((s) => s.visited).length;

  group.heading.textContent = `${group.baseTitle} (${visitedCount}/${total})`;
  group.wrapper.classList.remove('group-none', 'group-partial', 'group-all');
  if (visitedCount === 0) {
    group.wrapper.classList.add('group-none');
  } else if (visitedCount === total) {
    group.wrapper.classList.add('group-all');
  } else {
    group.wrapper.classList.add('group-partial');
  }
}

function buildRouteGroup(title, stops) {
  if (stops.length === 0) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'route-group';

  const heading = document.createElement('div');
  heading.className = 'route-group-heading';
  heading.addEventListener('click', () => wrapper.classList.toggle('expanded'));

  const rows = document.createElement('div');
  rows.className = 'route-group-rows';
  for (const stop of stops) {
    rows.appendChild(createStopRow(stop));
  }

  wrapper.append(heading, rows);
  listContainer.appendChild(wrapper);

  const group = { wrapper, heading, baseTitle: title, stopIds: stops.map((s) => s.stopid) };
  routeGroups.push(group);
  updateGroupHeading(group);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const grouped = groupToggle.checked;

  rowsByStopId.clear();
  routeGroups = [];
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
    buildRouteGroup(`Route ${route.shortName} — ${route.longName}`, stopsOnRoute);
  }

  const unassigned = filtered
    .filter((stop) => stop.routes.length === 0)
    .sort((a, b) => a.stopname.localeCompare(b.stopname));
  buildRouteGroup('Unassigned', unassigned);

  updateStats(filtered.length);
}

function updateStats(filteredCount) {
  const visitedCount = allStops.filter((s) => s.visited).length;
  const total = allStops.length;
  const percent = total > 0 ? ((visitedCount / total) * 100).toFixed(1) : '0.0';
  const showing = filteredCount === total ? '' : ` (showing ${filteredCount})`;
  document.getElementById('stats').textContent = `${visitedCount} / ${total} visited (${percent}%)${showing}`;
}

function applyVisitedChange(stopid, visited) {
  const stop = allStopsById.get(stopid);
  if (stop) stop.visited = visited;

  const rows = rowsByStopId.get(stopid) || [];
  for (const row of rows) {
    row.classList.toggle('visited', visited);
    row.querySelector('input[type="checkbox"]').checked = visited;
  }

  for (const group of routeGroups) {
    if (group.stopIds.includes(stopid)) updateGroupHeading(group);
  }

  updateStats(listContainer.querySelectorAll('.stop-row').length);
}

function setAllStops(stops) {
  allStops = stops;
  allStopsById = new Map(stops.map((s) => [s.stopid, s]));
}

function resyncStops() {
  fetch('/api/stops')
    .then((res) => res.json())
    .then((stops) => {
      setAllStops(stops);
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
  setAllStops(stops);
  routesMeta = meta;
  render();
  connectWebSocket();
});
