#!/usr/bin/env bash
#
# Builds the lean proof image (Node + tsx) and runs the proof runner inside a
# container against the HOST-BUILT repository, bind-mounted read-only.
#
# Prereq: run `pnpm install && pnpm build` on the host so dist/plugin-sdk/*
# and workspace dists exist. This keeps the container's job to executing Node
# on a compiled tree, isolating the proof from host toolchain differences
# while still meeting the "run inside Docker" requirement.
#
# Usage:  bash scripts/proof/run-issue-119977-docker.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile.issue-119977"
IMAGE_TAG="openclaw-proof-119977:latest"
LOG_FILE="/tmp/proof-119977-docker.log"

export DOCKER_BUILDKIT=1

if [ ! -d "${REPO_ROOT}/dist/plugin-sdk" ]; then
  echo "ERROR: ${REPO_ROOT}/dist/plugin-sdk missing — run pnpm install && pnpm build on the host first." >&2
  exit 2
fi

echo "Building lean proof image ${IMAGE_TAG}" | tee "${LOG_FILE}"
docker build -f "${DOCKERFILE}" -t "${IMAGE_TAG}" "${SCRIPT_DIR}" 2>&1 | tee -a "${LOG_FILE}"

echo "Running proof runner in container (host tree bind-mounted read-only)" | tee -a "${LOG_FILE}"
docker run --rm \
  -v "${REPO_ROOT}:/app:ro" \
  -w /app \
  "${IMAGE_TAG}" 2>&1 | tee -a "${LOG_FILE}"

status="${PIPESTATUS[0]}"
echo "Proof runner exit status: ${status}" | tee -a "${LOG_FILE}"
echo "Full log captured at ${LOG_FILE}"
exit "${status}"
