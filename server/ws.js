'use strict';

const { WebSocketServer } = require('ws');

function createWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  return { wss, broadcast };
}

module.exports = { createWsServer };
