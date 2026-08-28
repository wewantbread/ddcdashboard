import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillCommandSpecs } from "../../../skills/discovery/command-specs.js";
import { loadWorkspaceSkills } from "../../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../../skills/loading/workspace-skill-prompt.js";
import {
  consumeRunSkillUsage,
  hasRunWorkspaceSkillUsage,
} from "../../../skills/runtime/run-usage.js";
import { writeSkill } from "../../../skills/test-support/e2e-test-helpers.js";
import { withTempDir } from "../../../test-utils/temp-dir.js";
import { recordExplicitSkillSelectionsForRun } from "./skill-selection-usage.js";

describe("explicit run skill usage", () => {
  it.runIf(process.platform !== "win32")(
    "matches a canonical selection to an allowed workspace symlink snapshot",
    async () => {
      await withTempDir("openclaw-run-skill-usage-", async (rootDir) => {
        const workspacePath = path.join(rootDir, "workspace");
        await fs.mkdir(workspacePath, { recursive: true });
        const workspaceDir = await fs.realpath(workspacePath);
        const targetRoot = path.join(rootDir, "allowed-targets");
        const targetSkillDir = path.join(targetRoot, "release");
        const unrelatedTargetSkillDir = path.join(targetRoot, "unrelated");
        const linkedSkillDir = path.join(workspaceDir, "skills", "release");
        const unrelatedLinkedSkillDir = path.join(workspaceDir, "skills", "unrelated");
        await writeSkill({
          dir: targetSkillDir,
          name: "release",
          description: "Release safely",
        });
        await writeSkill({
          dir: unrelatedTargetSkillDir,
          name: "unrelated",
          description: "Unrelated skill",
        });
        await fs.mkdir(path.dirname(linkedSkillDir), { recursive: true });
        await fs.symlink(targetSkillDir, linkedSkillDir, "dir");
        await fs.symlink(unrelatedTargetSkillDir, unrelatedLinkedSkillDir, "dir");
        const config = { skills: { load: { allowSymlinkTargets: [targetRoot] } } };
        const entries = loadWorkspaceSkills(workspaceDir, {
          config,
          managedSkillsDir: path.join(rootDir, "managed"),
          bundledSkillsDir: "",
          pluginSkillsDir: path.join(rootDir, "plugins"),
        });
        const snapshot = buildSkillSnapshot(workspaceDir, { config, entries });
        const selection = buildWorkspaceSkillCommandSpecs(workspaceDir, {
          config,
          entries,
        }).find((command) => command.skillName === "release");
        const snapshotSkillFile = path.join(linkedSkillDir, "SKILL.md");
        const unrelatedSkillFile = path.join(unrelatedLinkedSkillDir, "SKILL.md");
        const snapshotSkill = snapshot.resolvedSkills?.find((skill) => skill.name === "release");
        const runId = "allowed-symlink-run";

        expect(selection?.skillFile).toBe(await fs.realpath(snapshotSkillFile));
        expect(snapshotSkill?.filePath).toBe(snapshotSkillFile);

        recordExplicitSkillSelectionsForRun({
          runId,
          selections: selection?.skillFile
            ? [{ name: selection.name, path: selection.skillFile }]
            : [],
          skillsSnapshot: snapshot,
        });

        expect(
          hasRunWorkspaceSkillUsage({ runId, name: "release", skillFile: snapshotSkillFile }),
        ).toBe(true);
        expect(
          hasRunWorkspaceSkillUsage({
            runId,
            name: "unrelated",
            skillFile: unrelatedSkillFile,
          }),
        ).toBe(false);
        consumeRunSkillUsage(runId);
      });
    },
  );
});
