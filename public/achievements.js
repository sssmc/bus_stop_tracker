'use strict';

// Shared by both pages. Achievements are *derived* from current state on every
// change — nothing is stored server-side. Each page keeps its own "already
// earned" set to decide when to toast a newly-unlocked badge.
const Achievements = (() => {
  // A municipality needs at least this many stops before "visit them all" counts,
  // so a 2-stop hamlet doesn't hand out the Local badge for free.
  const MIN_MUNI_STOPS = 5;

  const RULES = [
    { id: 'first-stop', name: 'First Stop', desc: 'Visit your first stop', test: (s) => s.visitedCount >= 1 },
    { id: 'stops-25', name: 'Getting Around', desc: 'Visit 25 stops', test: (s) => s.visitedCount >= 25 },
    { id: 'stops-100', name: 'Century', desc: 'Visit 100 stops', test: (s) => s.visitedCount >= 100 },
    { id: 'stops-500', name: 'Explorer', desc: 'Visit 500 stops', test: (s) => s.visitedCount >= 500 },
    {
      id: 'stops-all',
      name: 'Completionist',
      desc: 'Visit every stop',
      test: (s) => s.totalStops > 0 && s.visitedCount >= s.totalStops,
    },
    { id: 'first-route', name: 'First Route', desc: 'Ride your first route', test: (s) => s.riddenCount >= 1 },
    {
      id: 'route-complete',
      name: 'Full Route',
      desc: 'Visit every stop on any one route',
      test: (s) => s.routeComplete.size >= 1,
    },
    {
      id: 'muni-complete',
      name: 'Local',
      desc: 'Visit every stop in any one municipality',
      test: (s) => s.muniComplete.size >= 1,
    },
    { id: 'streak-7', name: 'Week Warrior', desc: 'Keep a 7-day visit streak', test: (s) => s.streakDays >= 7 },
    { id: 'km-100', name: 'Road Warrior', desc: 'Ride 100 km of the network', test: (s) => s.kmRidden >= 100 },
    { id: 'night-owl', name: 'Night Owl', desc: 'Ride a night route', test: (s) => s.nightRouteRidden },
  ];

  // input: { stops: [{ visited, muni, routes:[shortName] }], riddenCount, kmRidden,
  //          streakDays, nightRouteRidden }
  function evaluate(input) {
    const stops = input.stops || [];
    let visitedCount = 0;
    const routeTotal = new Map();
    const routeSeen = new Map();
    const muniTotal = new Map();
    const muniSeen = new Map();

    for (const stop of stops) {
      if (stop.visited) visitedCount += 1;
      for (const r of stop.routes || []) {
        routeTotal.set(r, (routeTotal.get(r) || 0) + 1);
        if (stop.visited) routeSeen.set(r, (routeSeen.get(r) || 0) + 1);
      }
      const m = stop.muni || '';
      if (m) {
        muniTotal.set(m, (muniTotal.get(m) || 0) + 1);
        if (stop.visited) muniSeen.set(m, (muniSeen.get(m) || 0) + 1);
      }
    }

    const routeComplete = new Set();
    for (const [r, total] of routeTotal) {
      if (total > 0 && (routeSeen.get(r) || 0) === total) routeComplete.add(r);
    }
    const muniComplete = new Set();
    for (const [m, total] of muniTotal) {
      if (total >= MIN_MUNI_STOPS && (muniSeen.get(m) || 0) === total) muniComplete.add(m);
    }

    const state = {
      visitedCount,
      totalStops: stops.length,
      riddenCount: input.riddenCount || 0,
      kmRidden: input.kmRidden || 0,
      streakDays: input.streakDays || 0,
      nightRouteRidden: Boolean(input.nightRouteRidden),
      routeComplete,
      muniComplete,
    };

    const earned = new Set();
    for (const rule of RULES) {
      if (rule.test(state)) earned.add(rule.id);
    }
    return { earned, state, rules: RULES };
  }

  function renderBadges(containerEl, result, opts = {}) {
    if (!containerEl) return;
    const compact = Boolean(opts.compact);
    containerEl.innerHTML = '';

    const earnedRules = result.rules.filter((r) => result.earned.has(r.id));
    const lockedRules = result.rules.filter((r) => !result.earned.has(r.id));

    const show = compact ? earnedRules : result.rules;
    for (const rule of show) {
      const earned = result.earned.has(rule.id);
      const pill = document.createElement('span');
      pill.className = `badge${earned ? ' badge-earned' : ' badge-locked'}`;
      pill.textContent = `${earned ? '🏅' : '🔒'} ${rule.name}`;
      pill.title = rule.desc;
      containerEl.appendChild(pill);
    }
    if (compact && lockedRules.length) {
      const more = document.createElement('span');
      more.className = 'badge badge-more';
      more.textContent = `🔒 ${lockedRules.length} more`;
      more.title = lockedRules.map((r) => `${r.name} — ${r.desc}`).join('\n');
      containerEl.appendChild(more);
    }
    if (!show.length && !lockedRules.length) {
      containerEl.textContent = '';
    }
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'achievement-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = `🏅 Achievement unlocked — ${text}`;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
  }

  return { RULES, evaluate, renderBadges, toast };
})();
