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
};
