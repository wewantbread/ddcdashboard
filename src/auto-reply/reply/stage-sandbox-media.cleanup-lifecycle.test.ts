import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import { completeFollowupRunLifecycle, type FollowupRun } from "./queue/types.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

describe("stageSandboxMedia host staging lifecycle cleanup", () => {
  it("returns hostWorkspaceStagingDir and cleans up staging directory on completeFollowupRunLifecycle", async () => {
    await withSandboxMediaTempHome("staging-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "test-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-1",
        workspaceDir,
      });

      expect(result.staged.size).toBe(1);
      expect(result.hostWorkspaceStagingDir).toBeDefined();

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toContain("openclaw-staged-");

      // Verify directory and staged file exist and are readable before cleanup
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const fileContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(fileContent).toBe("test-media-content");

      // Simulate followup run holding the staging directory reference
      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Trigger lifecycle completion
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      // Allow microtask / async fs.rm to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify directory has been completely cleaned up
      const exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
    });
  });
});
