# Railway entrypoint for the self-hosted Executor image.
# Keep the install/build stages aligned with apps/host-selfhost/Dockerfile.
# The runtime stage deliberately stays on the root distroless image: Railway
# mounts the /data volume root-owned, so the nonroot user upstream's Dockerfile
# uses for local docker runs cannot write it.

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS prod-deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @executor-js/host-selfhost \
  && bun run apps/host-selfhost/scripts/package-runtime.ts

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/host-selfhost && bun run build

FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/UsefulSoftwareCo/executor" \
      org.opencontainers.image.description="Single-container self-hosted Executor" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=prod-deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=prod-deps /app/.selfhost-runtime /app
COPY --from=build /app/apps/host-selfhost/dist /app/apps/host-selfhost/dist
WORKDIR /app/apps/host-selfhost
EXPOSE 4788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "run", "dist-server/serve.js"]
