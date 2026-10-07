# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @browserlace/server
COPY apps/server apps/server
RUN pnpm --filter @browserlace/server build

# Optional continuous backups of the SQLite file; see docker-entrypoint.sh.
FROM litestream/litestream:0.5.17 AS litestream

# The bundle has no dependencies beyond Node itself (SQLite is built into Node 24).
FROM node:24-slim
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY apps/server/litestream.yml /etc/litestream.yml
COPY apps/server/docker-entrypoint.sh /usr/local/bin/
COPY --from=build /repo/apps/server/dist/index.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/browserlace.db
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
