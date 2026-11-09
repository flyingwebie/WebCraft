# syntax=docker/dockerfile:1
# The worker (Node LTS, ADR 0006): the job queue, image processing, email, Webhooks, Domain checks.
# Built from the repo root:
#
#   docker build -f apps/worker/Dockerfile -t webcraft-worker .
#
# Node runs the TypeScript sources as they are. Runs as the unprivileged `node` user (uid 1000, as the
# web image's `bun` user, so both can share the storage volume). It answers no HTTP, so it has no
# health check: Docker restarts it when it stops. See docs/deploy/.

ARG BUN_VERSION=1.4.2
ARG NODE_VERSION=26

# Bun installs the dependencies from the lockfile (the image library's native files for this platform).
FROM oven/bun:${BUN_VERSION}-slim AS runtime-files
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --filter @webcraft/worker \
	&& sh scripts/prune-image-dependencies.sh \
	&& rm -rf scripts tests apps/server apps/cli packages/ui

FROM node:${NODE_VERSION}-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="WebCraft worker" \
	org.opencontainers.image.description="WebCraft's background worker: jobs, image processing, email and Webhooks." \
	org.opencontainers.image.licenses="AGPL-3.0-or-later" \
	org.opencontainers.image.version="${VERSION}"
WORKDIR /app
ENV NODE_ENV=production \
	WEBCRAFT_STORAGE_DIR=/var/lib/webcraft/storage
COPY --from=runtime-files /app /app
RUN install -d -o node -g node /var/lib/webcraft/storage
USER node
VOLUME /var/lib/webcraft/storage
CMD ["node", "apps/worker/src/main.ts"]
