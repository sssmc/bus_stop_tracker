# Bus Stop Tracker — single-stage image.
#
#   docker compose up -d --build
#
# See DEPLOYMENT.md → "Setup — running with Docker".

FROM node:24-alpine

# curl + unzip: for scripts/refresh-gtfs.sh (pulls the GTFS feed)
# bash:         refresh-gtfs.sh uses `set -o pipefail` etc.
# sqlite:       backups / poking at data.sqlite
# tini:         real PID 1 so `docker stop` exits promptly instead of waiting out
#               the 10s kill timeout (the app installs no SIGTERM handler)
RUN apk add --no-cache curl unzip bash sqlite tini \
 && mkdir -p /app /data \
 && chown node:node /app /data

WORKDIR /app
ENV NODE_ENV=production \
    APP_DIR=/app \
    PORT=3000

USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# data.sqlite is hardcoded to <repo root>/data.sqlite; redirect it onto the
# /data volume so the visited/ridden state survives image rebuilds.
RUN ln -sfn /data/data.sqlite data.sqlite

# /data      -> data.sqlite (your state — back this up)
# /app/Data  -> the stops CSV (seeded from the image) + the GTFS feed extract
VOLUME ["/data", "/app/Data"]

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/server.js"]
