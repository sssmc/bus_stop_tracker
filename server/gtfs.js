'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripCr(field) {
  return field.endsWith('\r') ? field.slice(0, -1) : field;
}

function parseGtfsCsv(filePath) {
  const text = stripBom(fs.readFileSync(filePath, 'utf8'));
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = stripCr(lines[0]).split(',');
  return lines.slice(1).map((line) => {
    const fields = stripCr(line).split(',');
    const row = {};
    header.forEach((key, i) => {
      row[key] = fields[i];
    });
    return row;
  });
}

function findGtfsDir(dataDir) {
  const candidates = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dataDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'stop_times.txt')));

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function naturalRouteCompare(a, b) {
  const parse = (s) => {
    const match = s.match(/^(\d+)(.*)$/);
    return match ? [Number(match[1]), match[2]] : [Infinity, s];
  };
  const [aNum, aSuffix] = parse(a);
  const [bNum, bSuffix] = parse(b);
  if (aNum !== bNum) return aNum - bNum;
  return aSuffix.localeCompare(bSuffix);
}

module.exports = { stripBom, stripCr, parseGtfsCsv, findGtfsDir, naturalRouteCompare };
