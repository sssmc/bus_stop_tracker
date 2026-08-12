'use strict';

const fs = require('node:fs');

function parseStopsCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = lines[0].split(',');

  return lines.slice(1).map((line) => {
    const fields = line.split(',');
    const row = {};
    header.forEach((key, i) => {
      row[key] = fields[i];
    });
    return {
      stopid: Number(row.stopid),
      stopname: row.stopname,
      stopsite: row.stopsite,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      syscode: row.syscode,
      system: row.system,
      muni: row.muni,
    };
  });
}

module.exports = { parseStopsCsv };
