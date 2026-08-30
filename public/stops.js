'use strict';

let allStops = [];
let allStopsById = new Map();
let routesMeta = [];
let routesMetaByShortName = new Map();
let scheduleByRoute = new Map();
const rowsByStopId = new Map();
let routeGroups = []; // { wrapper, heading, baseTitle, stopIds }
let riddenCheckboxByRoute = new Map();

const searchInput = document.getElementById('search');
const groupToggle = document.getElementById('toggle-group');
const listContainer = document.getElementById('stop-list');
const activityListEl = document.getElementById('activity-list');
const muniBoardEl = document.getElementById('muni-board');
const badgesEl = document.getElementById('badges');
const ACTIVITY_LIMIT = 40;
let activityEvents = [];
let earnedAchievements = new Set();
let achievementsReady = false;

function toggleVisited(stopid, currentlyVisited) {
  fetch(`/api/stops/${stopid}/visited`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visited: !currentlyVisited }),
  }).catch((err) => console.error('Failed to update visited state', err));
}

function setRidden(shortName, ridden) {
  fetch(`/api/routes/${encodeURIComponent(shortName)}/ridden`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ridden }),
  }).catch((err) => console.error('Failed to update ridden state', err));
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

  group.headingText.textContent = `${group.baseTitle} (${visitedCount}/${total})`;
  group.wrapper.classList.remove('group-none', 'group-partial', 'group-all');
  if (visitedCount === 0) {
    group.wrapper.classList.add('group-none');
  } else if (visitedCount === total) {
    group.wrapper.classList.add('group-all');
  } else {
    group.wrapper.classList.add('group-partial');
  }
}

function buildRouteGroup(title, stops, route) {
  if (stops.length === 0) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'route-group';

  const heading = document.createElement('div');
  heading.className = 'route-group-heading';
  heading.addEventListener('click', () => wrapper.classList.toggle('expanded'));

  if (route) {
    const swatch = document.createElement('span');
    swatch.className = 'route-color-swatch';
    swatch.style.background = route.color;
    heading.appendChild(swatch);
  }
  const headingText = document.createElement('span');
  headingText.className = 'route-group-heading-text';
  heading.appendChild(headingText);

  if (route) {
    const sched = scheduleByRoute.get(route.shortName);
    if (sched && sched.tripsToday > 0) {
      const badge = document.createElement('span');
      badge.className = 'route-sched';
      badge.textContent = `${sched.tripsToday} trips · ${sched.firstDep}–${sched.lastDep}${sched.night ? ' 🌙' : ''}`;
      heading.appendChild(badge);
    }
  }

  if (route) {
    const riddenLabel = document.createElement('label');
    riddenLabel.className = 'ridden-toggle';
    riddenLabel.title = 'Mark this route as ridden';

    const riddenCheckbox = document.createElement('input');
    riddenCheckbox.type = 'checkbox';
    riddenCheckbox.checked = route.ridden;

    riddenLabel.append(riddenCheckbox, document.createTextNode(' Ridden'));
    riddenLabel.addEventListener('click', (event) => {
      // Stay in sync via the WebSocket echo (like stop visits) rather than
      // toggling optimistically, so the checkbox always reflects server state.
      // Read route.ridden (our own tracked state), not checkbox.checked: clicking
      // the checkbox directly flips checkbox.checked natively before this handler
      // runs, so checkbox.checked can't be trusted as "the value before this click".
      event.stopPropagation();
      event.preventDefault();
      setRidden(route.shortName, !route.ridden);
    });
    heading.appendChild(riddenLabel);
    riddenCheckboxByRoute.set(route.shortName, riddenCheckbox);
  }

  const rows = document.createElement('div');
  rows.className = 'route-group-rows';
  for (const stop of stops) {
    rows.appendChild(createStopRow(stop));
  }

  wrapper.append(heading, rows);
  listContainer.appendChild(wrapper);

  const group = { wrapper, heading, headingText, baseTitle: title, stopIds: stops.map((s) => s.stopid) };
  routeGroups.push(group);
  updateGroupHeading(group);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const grouped = groupToggle.checked;

  rowsByStopId.clear();
  routeGroups = [];
  riddenCheckboxByRoute.clear();
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
    buildRouteGroup(`Route ${route.shortName} — ${route.longName}`, stopsOnRoute, route);
  }

  const unassigned = filtered
    .filter((stop) => stop.routes.length === 0)
    .sort((a, b) => a.stopname.localeCompare(b.stopname));
  buildRouteGroup('Unassigned', unassigned, null);

  updateStats(filtered.length);
}

function updateStats(filteredCount) {
  const visitedCount = allStops.filter((s) => s.visited).length;
  const total = allStops.length;
  const percent = total > 0 ? ((visitedCount / total) * 100).toFixed(1) : '0.0';
  const showing = filteredCount === total ? '' : ` (showing ${filteredCount})`;

  const riddenCount = routesMeta.filter((r) => r.ridden).length;
  const routeTotal = routesMeta.length;
  const score = Score.compute(visitedCount, riddenCount);

  const m = Activity.momentum(
    allStops.map((s) => s.visitedAt),
    routesMeta.map((r) => r.riddenAt)
  );
  const km = Score.kmSummary(routesMeta);

  document.getElementById('stats').textContent =
    `${score} pts${Activity.momentumSummary(m)} · ${visitedCount} / ${total} visited (${percent}%)${showing} · ${riddenCount} / ${routeTotal} routes ridden · ${Math.round(km.ridden)} / ${Math.round(km.total)} km`;
}

// The municipality board and achievements only change when a stop or route is
// checked off — not on every search keystroke — so they refresh separately from
// the (cheap) stats line.
function refreshProgress() {
  const m = Activity.momentum(
    allStops.map((s) => s.visitedAt),
    routesMeta.map((r) => r.riddenAt)
  );
  const km = Score.kmSummary(routesMeta);
  renderMuniBoard();
  updateAchievements(m.streakDays, km.ridden);
}

function renderMuniBoard() {
  const totals = new Map(); // muni -> { visited, total }
  for (const stop of allStops) {
    const key = stop.muni || 'Unknown';
    let entry = totals.get(key);
    if (!entry) {
      entry = { visited: 0, total: 0 };
      totals.set(key, entry);
    }
    entry.total += 1;
    if (stop.visited) entry.visited += 1;
  }

  const rows = [...totals.entries()]
    .map(([muni, e]) => ({ muni, ...e, pct: e.total ? e.visited / e.total : 0 }))
    .sort((a, b) => b.pct - a.pct || b.total - a.total);

  muniBoardEl.innerHTML = '';
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'muni-row' + (row.visited === row.total ? ' muni-done' : '');

    const name = document.createElement('span');
    name.className = 'muni-name';
    name.textContent = row.muni;

    const bar = document.createElement('span');
    bar.className = 'muni-bar';
    const fill = document.createElement('span');
    fill.className = 'muni-bar-fill';
    fill.style.width = `${Math.round(row.pct * 100)}%`;
    bar.appendChild(fill);

    const count = document.createElement('span');
    count.className = 'muni-count';
    count.textContent = `${row.visited} / ${row.total}`;

    el.append(name, bar, count);
    muniBoardEl.appendChild(el);
  }
}

function updateAchievements(streakDays, kmRidden) {
  const result = Achievements.evaluate({
    stops: allStops,
    riddenCount: routesMeta.filter((r) => r.ridden).length,
    kmRidden,
    streakDays,
    nightRouteRidden: routesMeta.some((r) => r.ridden && r.night),
  });
  Achievements.renderBadges(badgesEl, result, { compact: false });

  if (achievementsReady) {
    for (const rule of result.rules) {
      if (result.earned.has(rule.id) && !earnedAchievements.has(rule.id)) {
        Achievements.toast(rule.name);
      }
    }
  }
  earnedAchievements = result.earned;
  achievementsReady = true;
}

function renderActivity() {
  Activity.renderFeed(activityListEl, activityEvents);
}

function pushActivityEvent(event) {
  activityEvents = [
    event,
    ...activityEvents.filter(
      (e) =>
        e.type !== event.type ||
        (event.type === 'stop' ? e.stopid !== event.stopid : e.shortName !== event.shortName)
    ),
  ].slice(0, ACTIVITY_LIMIT);
  renderActivity();
}

function dropActivityEvent(predicate) {
  const next = activityEvents.filter((e) => !predicate(e));
  if (next.length !== activityEvents.length) {
    activityEvents = next;
    renderActivity();
  }
}

function applyVisitedChange(stopid, visited, at) {
  const stop = allStopsById.get(stopid);
  if (stop) {
    stop.visited = visited;
    stop.visitedAt = visited ? at || stop.visitedAt || new Date().toISOString() : null;
  }

  const rows = rowsByStopId.get(stopid) || [];
  for (const row of rows) {
    row.classList.toggle('visited', visited);
    row.querySelector('input[type="checkbox"]').checked = visited;
  }

  for (const group of routeGroups) {
    if (group.stopIds.includes(stopid)) updateGroupHeading(group);
  }

  if (visited) {
    pushActivityEvent({
      type: 'stop',
      stopid,
      stopname: stop ? stop.stopname : `Stop ${stopid}`,
      muni: stop ? stop.muni : '',
      at: (stop && stop.visitedAt) || at || new Date().toISOString(),
    });
  } else {
    dropActivityEvent((e) => e.type === 'stop' && e.stopid === stopid);
  }

  updateStats(listContainer.querySelectorAll('.stop-row').length);
  refreshProgress();
}

function applyRiddenChange(shortName, ridden, at) {
  const route = routesMetaByShortName.get(shortName);
  if (route) {
    route.ridden = ridden;
    route.riddenAt = ridden ? at || route.riddenAt || new Date().toISOString() : null;
  }

  const checkbox = riddenCheckboxByRoute.get(shortName);
  if (checkbox) checkbox.checked = ridden;

  if (ridden) {
    pushActivityEvent({
      type: 'route',
      shortName,
      longName: route ? route.longName : '',
      at: (route && route.riddenAt) || at || new Date().toISOString(),
    });
  } else {
    dropActivityEvent((e) => e.type === 'route' && e.shortName === shortName);
  }

  updateStats(listContainer.querySelectorAll('.stop-row').length);
  refreshProgress();
}

function undoLastActivity() {
  const last = activityEvents[0];
  if (!last) return;
  if (last.type === 'stop') {
    toggleVisited(last.stopid, true);
  } else {
    setRidden(last.shortName, false);
  }
}

function setAllStops(stops) {
  allStops = stops;
  allStopsById = new Map(stops.map((s) => [s.stopid, s]));
}

function setRoutesMeta(meta) {
  routesMeta = meta;
  routesMetaByShortName = new Map(meta.map((r) => [r.shortName, r]));
}

function setSchedule(schedule) {
  scheduleByRoute = new Map(schedule.map((s) => [s.shortName, s]));
  // Fold the night flag onto routesMeta so the Night Owl achievement can see it.
  for (const route of routesMeta) {
    const sched = scheduleByRoute.get(route.shortName);
    route.night = Boolean(sched && sched.night);
  }
}

function loadActivity() {
  return fetch(`/api/activity?limit=${ACTIVITY_LIMIT}`)
    .then((res) => res.json())
    .then((events) => {
      activityEvents = events;
      renderActivity();
    })
    .catch((err) => console.error('Failed to load activity', err));
}

function resync() {
  Promise.all([
    fetch('/api/stops').then((res) => res.json()),
    fetch('/api/routes-meta').then((res) => res.json()),
    fetch('/api/routes-schedule').then((res) => res.json()),
  ])
    .then(([stops, meta, schedule]) => {
      setAllStops(stops);
      setRoutesMeta(meta);
      setSchedule(schedule);
      render();
      refreshProgress();
      loadActivity();
    })
    .catch((err) => console.error('Failed to resync', err));
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'visited-changed') {
      applyVisitedChange(msg.stopid, msg.visited, msg.visitedAt);
    } else if (msg.type === 'route-ridden-changed') {
      applyRiddenChange(msg.shortName, msg.ridden, msg.riddenAt);
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(() => {
      connectWebSocket();
      resync();
    }, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

searchInput.addEventListener('input', render);
groupToggle.addEventListener('change', render);
document.getElementById('undo-last').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  undoLastActivity();
});

Promise.all([
  fetch('/api/stops').then((res) => res.json()),
  fetch('/api/routes-meta').then((res) => res.json()),
  fetch('/api/routes-schedule').then((res) => res.json()),
]).then(([stops, meta, schedule]) => {
  setAllStops(stops);
  setRoutesMeta(meta);
  setSchedule(schedule);
  render();
  refreshProgress();
  loadActivity();
  connectWebSocket();
});
