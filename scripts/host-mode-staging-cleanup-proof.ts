import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { completeFollowupRunLifecycle, type FollowupRun } from "../src/auto-reply/reply/queue.js";
import { stageSandboxMedia } from "../src/auto-reply/reply/stage-sandbox-media.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../src/auto-reply/stage-sandbox-media.test-harness.js";

async function runHostModeStagingCleanupProof(): Promise<void> {
  console.log("=== Host-Mode Staging Media Lifecycle Proof ===");

  await withSandboxMediaTempHome("host-staging-proof", async (tempHome) => {
    const mediaDir = path.join(tempHome, ".openclaw", "media", "inbound");
    await fs.mkdir(mediaDir, { recursive: true });

    const sampleFile = path.join(mediaDir, "sample.jpg");
    const mediaContent = Buffer.from("JPEG_SAMPLE_HOST_MODE_ATTACHMENT_DATA_STREAM");
    await fs.writeFile(sampleFile, mediaContent);

    const mediaUri = "media://inbound/sample.jpg";
    const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
    const cfg = {
      ...createSandboxMediaStageConfig(tempHome),
      agents: {
        defaults: {
          sandbox: { mode: "off" },
        },
      },
    } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
    const workspaceDir = path.join(tempHome, "openclaw");

    // Step 1: Stage Sandbox Media in Host Mode (sandbox: off)
    const result = await stageSandboxMedia({
      ctx,
      sessionCtx,
      cfg,
      sessionKey: "proof-session-128454",
      workspaceDir,
    });

    const stagingDir = result.hostWorkspaceStagingDir;
    assert.ok(stagingDir, "Staging directory must be defined");
    console.log(
      `[1/4] Media staged to host-mode directory: ${stagingDir.replace(tempHome, "<TMP_HOME>")}`,
    );

    // Step 2: Verify staged attachment is readable prior to settlement
    const stagedFilePaths = Array.from(result.staged.values());
    assert.equal(stagedFilePaths.length, 1, "Exactly one file should be staged");
    const stagedFilePath = stagedFilePaths[0];
    assert.ok(stagedFilePath, "Staged file path must exist");

    const preStat = await fs.stat(stagedFilePath);
    assert.ok(preStat.isFile(), "Staged media must be a file");
    console.log(
      `[2/4] Staged media file readable before settlement: exists=true, size=${String(preStat.size)} bytes`,
    );

    // Step 3: Attach staging directory to FollowupRun & simulate settlement / lifecycle completion
    const followupRun: FollowupRun = {
      run: {
        agentId: "main",
        agentDir: path.join(tempHome, "agent"),
        sessionId: "session-128454",
        sessionKey: "proof-session-128454",
        workspaceDir,
        config: cfg as unknown as FollowupRun["run"]["config"],
      } as unknown as FollowupRun["run"],
      hostWorkspaceStagingDir: stagingDir,
    };

    console.log("[3/4] Active operation settled. Calling completeFollowupRunLifecycle...");
    completeFollowupRunLifecycle(followupRun);

    // Poll for directory removal
    let postExists = true;
    const start = Date.now();
    while (Date.now() - start < 3000) {
      postExists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      if (!postExists) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }

    // Step 4: Verify post-settlement directory deletion
    console.log(
      `[4/4] Host-mode staging directory post-settlement verification: exists=${String(postExists)} (directory successfully cleaned)`,
    );
    assert.equal(postExists, false, "Host staging directory must be deleted post-settlement");
  });

  console.log("=== Proof Execution Complete: SUCCESS ===");
}

runHostModeStagingCleanupProof().catch((err: unknown) => {
  console.error("Proof Execution Failed:", err);
  process.exit(1);
});
