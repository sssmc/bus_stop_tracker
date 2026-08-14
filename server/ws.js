'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

// Excludes hues near red (0/360°), which is reserved for the current user's own
// location marker on the client, so another user's random color never clashes.
const RED_EXCLUSION_DEGREES = 20;

function randomUserColor() {
  const hue = RED_EXCLUSION_DEGREES + Math.floor(Math.random() * (360 - 2 * RED_EXCLUSION_DEGREES));
  return `hsl(${hue}, 80%, 45%)`;
}

function createWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  // Last known position per connected client, so a newly-joined client can see
  // where everyone already online is without waiting for their next GPS update.
  const lastLocationByClientId = new Map();

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.clientId = crypto.randomUUID();
    ws.userColor = randomUserColor();

    ws.send(JSON.stringify({ type: 'hello', clientId: ws.clientId, color: ws.userColor }));
    for (const [clientId, loc] of lastLocationByClientId) {
      ws.send(JSON.stringify({ type: 'user-location', clientId, color: loc.color, lat: loc.lat, lon: loc.lon }));
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'location-update' && Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        lastLocationByClientId.set(ws.clientId, { lat: msg.lat, lon: msg.lon, color: ws.userColor });
        broadcast({
          type: 'user-location',
          clientId: ws.clientId,
          color: ws.userColor,
          lat: msg.lat,
          lon: msg.lon,
        });
      }
    });

    ws.on('close', () => {
      lastLocationByClientId.delete(ws.clientId);
      broadcast({ type: 'user-left', clientId: ws.clientId });
    });
  });

  return { wss, broadcast };
}

module.exports = { createWsServer };
