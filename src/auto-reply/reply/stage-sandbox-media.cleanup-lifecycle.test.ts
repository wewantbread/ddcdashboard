import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import {
  cleanHostWorkspaceStaging,
  completeFollowupRunLifecycle,
  type FollowupRun,
} from "./queue/types.js";
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
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      // Verify directory has been completely cleaned up
      const exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
    });
  });

  it("cleans up staging directory when a turn is dropped directly on the active-run path", async () => {
    await withSandboxMediaTempHome("dropped-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample2.jpg");
      await fs.writeFile(sampleFile, "dropped-turn-media-content");

      const mediaUri = `media://inbound/sample2.jpg`;
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
        sessionKey: "session-2",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Simulate active-run drop disposition triggering completeFollowupRunLifecycle directly
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
    });
  });

  it("cleans up staging directory on direct non-queued reply completion without firing queue abandonment callbacks", async () => {
    await withSandboxMediaTempHome("direct-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample3.jpg");
      await fs.writeFile(sampleFile, "direct-turn-media-content");

      const mediaUri = `media://inbound/sample3.jpg`;
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
        sessionKey: "session-3",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      const onAbandoned = vi.fn();
      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
        turnAdoptionLifecycle: {
          onAdopted: vi.fn(),
          onAbandoned,
        } as unknown as FollowupRun["turnAdoptionLifecycle"],
      };

      // Direct terminal cleanup removes staging directory without triggering queue abandonment
      cleanHostWorkspaceStaging(followupRun as unknown as FollowupRun);

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(onAbandoned).not.toHaveBeenCalled();
    });
  });

  it("defers staging directory cleanup on pre-accepted message injection until active operation settlement", async () => {
    await withSandboxMediaTempHome("preaccepted-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample4.jpg");
      await fs.writeFile(sampleFile, "preaccepted-turn-media-content");

      const mediaUri = `media://inbound/sample4.jpg`;
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
        sessionKey: "session-4",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      let resolveSettlement: (() => void) | undefined;
      const ownerSettlement = new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      });

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Simulate pre-accepted injection transferring staging ownership to ownerSettlement
      const hostStagingDir = followupRun.hostWorkspaceStagingDir;
      delete followupRun.hostWorkspaceStagingDir;
      void ownerSettlement.then(() => {
        completeFollowupRunLifecycle({ hostWorkspaceStagingDir: hostStagingDir });
      });

      // Verify directory exists before settlement
      let exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Settle active operation
      resolveSettlement!();
      await ownerSettlement;
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });
});
