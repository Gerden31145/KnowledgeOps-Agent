# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f deploy/Dockerfile --target web .
ARG NODE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# The full toolchain exists only in the build stage.
FROM runtime AS build
ENV NODE_ENV=development PNPM_HOME=/pnpm NUXT_TELEMETRY_DISABLED=1
ENV PATH=/pnpm:$PATH
RUN npm install --global pnpm@10.34.5
WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=knowledgeops-pnpm,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir /pnpm/store
COPY . .
RUN node --input-type=module -e "import {readFileSync} from 'node:fs'; if (process.versions.node !== readFileSync('.node-version','utf8').trim()) throw new Error('Node version differs from .node-version')"
# Prisma generate needs a valid URL, but does not connect to a database.
RUN --mount=type=cache,id=knowledgeops-pnpm,target=/pnpm/store \
    export DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build_only \
    && pnpm install --offline --frozen-lockfile --store-dir /pnpm/store \
    && pnpm build \
    && pnpm --filter @knowledgeops/api deploy --legacy --prod /out/api \
    && pnpm --filter @knowledgeops/worker deploy --legacy --prod /out/worker \
    && pnpm --filter @knowledgeops/migrate deploy --legacy --prod /out/migrate

FROM runtime AS api
COPY --from=build --chown=node:node /out/api/ ./
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker/ ./
USER node
CMD ["node", "dist/main.js"]

FROM runtime AS web
COPY --from=build --chown=node:node /workspace/apps/web/.output/ ./
ENV NITRO_HOST=0.0.0.0 NITRO_PORT=3200
USER node
EXPOSE 3200
CMD ["node", "server/index.mjs"]

# Run explicitly once per release; application restarts do not run migrations.
FROM runtime AS migrate
COPY --from=build --chown=node:node /out/migrate/ ./
COPY --from=build --chown=node:node /workspace/prisma/ ./prisma/
COPY --from=build --chown=node:node /workspace/prisma.config.ts ./
# Resolve/check the platform-specific schema engine during build, not on the VPS.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build_only \
    node node_modules/prisma/build/index.js --version
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
