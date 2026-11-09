# syntax=docker/dockerfile:1
# The web process (Bun, ADR 0006): the admin, the APIs and every Site, plus the `webcraft` command for
# the server commands (`webcraft admin migrate`, the one-off migrate step). Built from the repo root:
#
#   docker build -f apps/server/Dockerfile -t webcraft-web .
#
# Runs as the unprivileged `bun` user (uid 1000, as the worker image's `node` user, so both can share
# the storage and Backups volumes). Listens on PORT (3000). See docs/deploy/.

ARG BUN_VERSION=1.4.2

# The admin and the server bundle, built with every dependency.
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/server build

# Only what the web process and the `webcraft` command load when they run.
FROM oven/bun:${BUN_VERSION}-slim AS runtime-files
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --filter @webcraft/server --filter @webcraft/cli \
	&& sh scripts/prune-image-dependencies.sh \
	&& rm -rf scripts tests apps/worker
COPY --from=build /app/apps/server/dist apps/server/dist

FROM oven/bun:${BUN_VERSION}-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="WebCraft web" \
	org.opencontainers.image.description="WebCraft's web process: the admin, the APIs and every Site." \
	org.opencontainers.image.licenses="AGPL-3.0-or-later" \
	org.opencontainers.image.version="${VERSION}"
WORKDIR /app
ENV NODE_ENV=production \
	PORT=3000 \
	WEBCRAFT_STORAGE_DIR=/var/lib/webcraft/storage \
	WEBCRAFT_BACKUP_DIR=/var/lib/webcraft/backups
COPY --from=runtime-files /app /app
# The Backups folder: `webcraft admin backup` and the migrate step write there (from this image).
RUN install -d -o bun -g bun /var/lib/webcraft/storage /var/lib/webcraft/backups \
	&& printf '#!/bin/sh\nexec bun /app/apps/cli/src/main.ts "$@"\n' > /usr/local/bin/webcraft \
	&& chmod 755 /usr/local/bin/webcraft
USER bun
VOLUME ["/var/lib/webcraft/storage", "/var/lib/webcraft/backups"]
EXPOSE 3000
# `/readyz` on the admin host: the database answers and has every migration this version expects.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "/app/apps/server/src/healthcheck.ts"]
CMD ["bun", "apps/server/src/serve.ts"]
