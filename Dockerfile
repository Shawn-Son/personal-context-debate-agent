FROM node:22-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/context-debate.sqlite
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=20s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "src/server.js"]
