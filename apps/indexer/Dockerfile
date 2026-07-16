# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=25.0.0

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain

ARG PNPM_VERSION=9.15.1
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /workspace

RUN npm install --global "pnpm@${PNPM_VERSION}" \
  && test "$(node --version)" = "v${NODE_VERSION}" \
  && test "$(pnpm --version)" = "${PNPM_VERSION}"

FROM toolchain AS build

COPY . .
RUN --mount=type=cache,id=opentab-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile
RUN pnpm --filter @opentab/indexer build \
  && pnpm --offline --package-import-method=hardlink --filter @opentab/indexer deploy --prod .deploy/indexer

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3002
ENV INDEXER_HEALTH_HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /workspace/.deploy/indexer/package.json ./package.json
COPY --from=build --chown=node:node /workspace/.deploy/indexer/dist/ ./dist/
COPY --from=build --chown=node:node /workspace/.deploy/indexer/node_modules/ ./node_modules/

USER node
EXPOSE 3002

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "const port = process.env.INDEXER_HEALTH_PORT ?? process.env.PORT ?? '3002'; fetch('http://127.0.0.1:' + port + '/health/live').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/index.js"]
