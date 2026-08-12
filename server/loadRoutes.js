'use strict';

const shapefile = require('shapefile');

async function loadRoutesAsGeoJson(shpPath, dbfPath) {
  const source = await shapefile.open(shpPath, dbfPath);
  const features = [];
  let result = await source.read();
  while (!result.done) {
    features.push(result.value);
    result = await source.read();
  }
  return { type: 'FeatureCollection', features };
}

module.exports = { loadRoutesAsGeoJson };
