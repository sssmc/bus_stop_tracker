'use strict';

// Shared by the map page (app.js) and the stop list page (stops.js): turns the
// visited_at / ridden_at timestamps the server already stores into a recent-activity
// feed and "momentum" figures (today / this week / streak).
const Activity = (() => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function startOfLocalDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // "just now" / "6m" / "3h" / "yesterday" / "5d" / "Aug 12"
  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.round((Date.now() - then) / 1000);
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${Math.max(mins, 1)}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.round(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // stopTimestamps / routeTimestamps: arrays of ISO strings (nulls are ignored).
  // streakDays counts back from today (or yesterday, if nothing yet today) over
  // consecutive local-date days that have at least one stop visit.
  function momentum(stopTimestamps, routeTimestamps) {
    const todayStart = startOfLocalDay(Date.now());
    const weekStart = todayStart - 6 * DAY_MS;
    const since = (list, from) =>
      list.filter((t) => t && new Date(t).getTime() >= from).length;

    const visitDays = new Set(
      stopTimestamps.filter(Boolean).map((t) => startOfLocalDay(t))
    );
    let streakDays = 0;
    let cursor = todayStart;
    if (!visitDays.has(cursor)) cursor -= DAY_MS; // a streak can still be "alive" from yesterday
    while (visitDays.has(cursor)) {
      streakDays += 1;
      cursor -= DAY_MS;
    }

    return {
      stopsToday: since(stopTimestamps, todayStart),
      stopsWeek: since(stopTimestamps, weekStart),
      routesToday: since(routeTimestamps, todayStart),
      routesWeek: since(routeTimestamps, weekStart),
      streakDays,
    };
  }

  // Compact "· +3 today · 🔥 5-day streak" suffix for the stats line. Empty when
  // there's nothing noteworthy so the line stays short.
  function momentumSummary(m) {
    const parts = [];
    const newToday = m.stopsToday + m.routesToday;
    if (newToday > 0) parts.push(`+${newToday} today`);
    if (m.streakDays >= 2) parts.push(`🔥 ${m.streakDays}-day streak`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  function eventText(ev) {
    if (ev.type === 'route') {
      return `Rode route ${ev.shortName}${ev.longName ? ` — ${ev.longName}` : ''}`;
    }
    return `Visited ${ev.stopname}${ev.muni ? ` · ${ev.muni}` : ''}`;
  }

  function renderFeed(listEl, events) {
    listEl.innerHTML = '';
    if (!events.length) {
      const li = document.createElement('li');
      li.className = 'activity-empty';
      li.textContent = 'No check-ins yet.';
      listEl.appendChild(li);
      return;
    }
    for (const ev of events) {
      const li = document.createElement('li');
      li.className = 'activity-row';

      const icon = document.createElement('span');
      icon.className = 'activity-icon';
      icon.textContent = ev.type === 'route' ? '🚌' : '📍';

      const text = document.createElement('span');
      text.className = 'activity-text';
      text.textContent = eventText(ev);

      const time = document.createElement('span');
      time.className = 'activity-time';
      time.textContent = relativeTime(ev.at);
      time.title = new Date(ev.at).toLocaleString();

      li.append(icon, text, time);
      listEl.appendChild(li);
    }
  }

  return { relativeTime, momentum, momentumSummary, renderFeed };
})();
