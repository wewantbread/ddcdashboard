# Issue #119977 / PR #120443 — real-behavior proof

This directory holds a standalone real-behavior proof for PR #120443 that
runs inside a Docker container. It is **not** a Vitest unit test; it imports
the actual fix modules from the built repository and drives them against a
simulated Codex app-server client + in-memory binding store, printing the
observed runtime result shapes and asserting the recovery/skip recognisers
agree.

## What it proves

| Scenario                                                | What it demonstrates                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) stale thread binding under the guarded native lease | `maybeCompactCodexAppServerSession` returns `ok:false`, `failure.reason:"stale_thread_binding"`, no native `thread/compact/start` is issued, and `isRecoverableNativeHarnessBindingFailure(result) === true`, so both reply preflight and CLI compaction enter recovery instead of throwing or skipping.                                                                            |
| (b) blocked-native / harness-owned deferral             | Result carries the plugin-private `harnessOwnedAutomaticCompaction:true` flag with `details.reason:"native_execution_unavailable"`, `isHarnessOwnedAutomaticCompactionSkip(result) === true`, and the public `EmbeddedAgentCompactResult` type in `src/agents/embedded-agent-runner/types.ts` does **not** declare the field (option-b narrowing keeps the SDK contract unchanged). |
| (c) native-request stage telemetry                      | Primary automatic/preflight requests record `result.details.request === "before_context_engine"`; passing `nativeCompactionRequest:"after_context_engine"` records `"after_context_engine"` instead of the previously hard-coded string.                                                                                                                                            |

## How to run

Prerequisite: build the repository on the host so `dist/plugin-sdk/*` and
workspace dists exist:

```
pnpm install
pnpm build
```

Then, from the repo root:

```
bash scripts/proof/run-issue-119977-docker.sh
```

The script builds a lean image (`node:24-bookworm` + `tsx` + a Linux esbuild
binary matching the host version), bind-mounts the host-built tree read-only,
and executes `scripts/proof/issue-119977-proof.mts` inside the container.
Full log is captured to `/tmp/proof-119977-docker.log`; exit status is
non-zero if any assertion fails.

## Why a lean container + host build

`pnpm install` inside the container repeatedly hit ARM64 tarball timeouts on
the npm registry, so the build is done on the host and mounted in. The
container still executes the runtime scenarios — that is the "inside Docker"
requirement — and the host build ensures the `openclaw/plugin-sdk/*` seam is
served by the same compiled bytes we would ship. tsx additionally prefers the
TypeScript sources under `src/plugin-sdk/*` when both exist; either resolution
is acceptable because the fix modules' runtime behaviour depends only on the
code they import through the alias.
