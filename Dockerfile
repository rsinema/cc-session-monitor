# syntax=docker/dockerfile:1.7
#
# Two stages: a build stage that resolves deps + bundles the React frontend,
# and a slim runtime stage that runs the Bun server. Image is ~150 MB.
#
# Pinned to a specific Bun version so teammates get reproducible behavior.

# ---- build stage --------------------------------------------------------
# Pinned to $BUILDPLATFORM (the host arch) so vite/esbuild run natively rather
# than under QEMU emulation. esbuild's prebuilt binaries crash mid-build under
# emulation ("Error: The service was stopped"), and we don't need cross-arch
# output from this stage anyway: the bundler produces platform-independent
# JavaScript in /app/web/dist that works in either runtime arch.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.13 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY postcss.config.js tailwind.config.js ./
COPY src ./src
COPY web ./web

# Short git SHA stamped into the web bundle so the footer shows the same tag
# that's published to Docker Hub. `.git` isn't COPY'd into the build context,
# so we accept it as a build-arg from scripts/publish-image.sh.
ARG APP_COMMIT=dev
ENV APP_COMMIT=${APP_COMMIT}

RUN bun run build

# ---- runtime stage ------------------------------------------------------
FROM oven/bun:1.3.13-slim AS runtime
WORKDIR /app

# Carry only what the runtime needs.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/web/dist ./web/dist

# Both directories are bind-mounted by docker-compose. The defaults make the
# image self-explanatory if it's run with --rm directly via `docker run`.
ENV CC_PROJECTS_DIR=/host/.claude/projects \
    CC_MONITOR_DB=/host/.claude-monitor/db.sqlite \
    PORT=3737 \
    NODE_ENV=production

EXPOSE 3737

# bun:sqlite + chokidar both work on Linux. macOS-only osascript notifications
# silently no-op (the spawn fails inside the container's try/catch); browser
# notifications via the React app continue to work.
CMD ["bun", "run", "src/server.ts"]
