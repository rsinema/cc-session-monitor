#!/usr/bin/env bash
#
# Build the monitor image as a multi-arch (amd64 + arm64) bundle and push it
# to Docker Hub. Teammates pull from there.
#
# Defaults to docker.io/rsinema/claude-session-monitor — the canonical repo
# for this project. Override DOCKER_HUB_USER (env or first arg) if you want
# to push to your own account/fork instead.
#
# Optional env vars:
#   DOCKER_HUB_USER  defaults to rsinema
#   IMAGE_NAME       defaults to claude-session-monitor
#   PLATFORMS        defaults to linux/amd64,linux/arm64
#   EXTRA_TAG        additional tag (e.g. v0.3) — pushed alongside latest + SHA

set -euo pipefail

DEFAULT_USER="rsinema"
USER_INPUT="${DOCKER_HUB_USER:-${1:-$DEFAULT_USER}}"
IMAGE_NAME="${IMAGE_NAME:-claude-session-monitor}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
EXTRA_TAG="${EXTRA_TAG:-}"

# ── pre-flight ───────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || {
  echo "error: docker not found in PATH" >&2; exit 1;
}
if ! docker info >/dev/null 2>&1; then
  echo "error: docker daemon not reachable." >&2
  echo "  Docker Desktop: launch the app." >&2
  echo "  Colima:         'colima start' (with --vm-type=vz on Apple Silicon for speed)" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "error: 'docker buildx' not available." >&2
  echo "  Docker Desktop ≥ 4.x bundles it; Colima ships it via the docker CLI plugin." >&2
  echo "  Try: docker buildx install   (or: brew install docker-buildx)" >&2
  exit 1
fi

# Login if we don't see a stored credential. `docker info` exposes Username
# only when authed against a Docker Hub session.
if ! docker info 2>/dev/null | grep -q "^ Username:"; then
  echo "Not logged in to Docker Hub. Running 'docker login'…"
  docker login
fi

# ── tagging ──────────────────────────────────────────────────────────────
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
REPO="docker.io/$USER_INPUT/$IMAGE_NAME"

TAGS=("--tag" "$REPO:latest" "--tag" "$REPO:$SHA")
if [[ -n "$EXTRA_TAG" ]]; then
  TAGS+=("--tag" "$REPO:$EXTRA_TAG")
fi

# Warn if the working tree is dirty — published image won't reflect committed code.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "warning: working tree has uncommitted changes; image will include them." >&2
    echo "         tag :$SHA may overlap with a future clean build."             >&2
  fi
fi

# ── builder ──────────────────────────────────────────────────────────────
# A docker-container driver builder is required for multi-arch buildx pushes.
# Two Colima-on-Apple-Silicon gotchas the script handles automatically:
#   1. The Lima VM doesn't ship with QEMU binfmt handlers for amd64. We
#      register them via tonistiigi/binfmt (idempotent — re-running is cheap).
#   2. Even with handlers registered, buildx's auto-detection skips amd64 on
#      arm64 hosts. We pass --platform explicitly at builder-create time so
#      the platform is reported as supported.
BUILDER="monitor-builder"

# Install QEMU/Rosetta binfmt registrations in the daemon's VM. Idempotent.
echo "→ ensuring QEMU binfmt handlers are registered (multi-arch emulation)"
docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null 2>&1 || {
  echo "warning: binfmt install failed — multi-arch may not work" >&2
}

# Recreate the builder if it doesn't already cover the requested PLATFORMS.
# (Existing builders cache their detected-platform list at create time, so a
# binfmt install after the fact won't expand it without a recreate.)
needs_recreate=true
if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  current_platforms="$(docker buildx inspect "$BUILDER" 2>/dev/null \
    | awk -F'Platforms:[[:space:]]*' '/^Platforms:/{print $2}')"
  needs_recreate=false
  IFS=',' read -ra wanted <<< "$PLATFORMS"
  for p in "${wanted[@]}"; do
    p_trimmed="${p// /}"
    # Check both bare and asterisked forms (buildx prints e.g. linux/amd64*).
    if ! echo "$current_platforms" | grep -qE "(^|, )${p_trimmed}\*?(,|$)"; then
      needs_recreate=true
      break
    fi
  done
fi

if $needs_recreate; then
  docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
  echo "→ creating buildx builder '$BUILDER' for $PLATFORMS"
  docker buildx create \
    --name "$BUILDER" \
    --driver docker-container \
    --platform "$PLATFORMS" \
    --use >/dev/null
else
  docker buildx use "$BUILDER" >/dev/null
fi
docker buildx inspect --bootstrap "$BUILDER" >/dev/null

# ── build + push ─────────────────────────────────────────────────────────
echo "→ building $REPO for $PLATFORMS"
echo "  tags: latest, $SHA${EXTRA_TAG:+, $EXTRA_TAG}"
docker buildx build \
  --platform "$PLATFORMS" \
  "${TAGS[@]}" \
  --push \
  .

echo
echo "✓ pushed to Docker Hub"
echo "    $REPO:latest"
echo "    $REPO:$SHA"
[[ -n "$EXTRA_TAG" ]] && echo "    $REPO:$EXTRA_TAG"
echo
echo "Teammates pull and run with:"
echo "    export MONITOR_IMAGE=$REPO:latest"
echo "    docker compose pull && docker compose up -d"
