'use strict';

// Single source of truth for the scoring rule, shared by the map page (app.js)
// and the stop list page (stops.js): each unique stop visited is worth 1 point,
// each bus route ridden is worth 10.
const Score = {
  POINTS_PER_STOP: 1,
  POINTS_PER_ROUTE: 10,
  compute(visitedStopCount, riddenRouteCount) {
    return visitedStopCount * this.POINTS_PER_STOP + riddenRouteCount * this.POINTS_PER_ROUTE;
  },
  // Kilometres of route ridden vs. the whole network. A separate progress stat —
  // it does NOT feed compute(). routesMeta entries carry `lengthKm` and `ridden`.
  kmSummary(routesMeta) {
    let ridden = 0;
    let total = 0;
    for (const route of routesMeta) {
      const km = route.lengthKm || 0;
      total += km;
      if (route.ridden) ridden += km;
    }
    return { ridden, total };
  },
};
