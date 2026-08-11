# Issue #119977 / PR #120443 — orchestration + recovery-seam proof

This directory holds a standalone proof for PR #120443 that runs inside a
Docker container. It is **not** a Vitest unit test, and **not** a live
app-server proof: it imports the actual fix modules from the built repository
and drives them (OpenClaw's compaction orchestration) against a **simulated**
Codex app-server client + in-memory binding store, printing the observed
runtime result shapes and asserting the recovery/skip recognisers agree.
Scenarios (a)-(c) exercise OpenClaw orchestration only; scenario (d)
additionally makes the simulated client raise the real upstream error shape so
the actual dead-thread recovery seam runs.

## What it proves

| Scenario                                           | What it demonstrates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) binding changed under the guarded native lease | The guarded native request rereads the binding under lease; when it changed, `maybeCompactCodexAppServerSession` returns `ok:false`, `failure.reason:"stale_thread_binding"`, no native `thread/compact/start` is issued, and `isRecoverableNativeHarnessBindingFailure(result) === true`, so both reply preflight and CLI compaction enter recovery instead of throwing or skipping. This is OpenClaw's orchestration guard against a simulated client, not a live app-server error.                        |
| (b) blocked-native / harness-owned deferral        | Result carries `harnessCompactionDisposition:"harness_owned_automatic_compaction"` with `details.reason:"native_execution_unavailable"`, `isHarnessOwnedAutomaticCompactionSkip(result) === true`, the public `EmbeddedAgentCompactResult` type in `src/agents/embedded-agent-runner/types.ts` **declares** the neutral `harnessCompactionDisposition` field, and it does **not** declare a Codex-named `harnessOwnedAutomaticCompaction` boolean (the Codex-specific label stays a plugin-internal detail). |
| (c) native-request stage telemetry                 | Primary automatic/preflight requests record `result.details.request === "before_context_engine"`; passing `nativeCompactionRequest:"after_context_engine"` records `"after_context_engine"` instead of the previously hard-coded string.                                                                                                                                                                                                                                                                     |
| (d) real dead-thread app-server error recovery     | The simulated client throws the real `CodexAppServerRpcError` (code `-32600`, message `thread not found: <id>` — the exact codex-rs `thread/compact/start` contract). The real recovery seam (`isCodexThreadNotFoundError` + `clearDeadCodexThreadBinding`) classifies it as `failure.reason:"stale_thread_binding"` **and** clears the dead binding so the next turn rebinds.                                                                                                                               |

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

The script builds a lean image (`node:24-bookworm-slim`, pinned by digest, +
`tsx` + a Linux esbuild binary matching the host version), bind-mounts the
host-built tree read-only,
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
