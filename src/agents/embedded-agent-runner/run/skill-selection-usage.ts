import path from "node:path";
import { resolveSkillTelemetrySource } from "../../../skills/loading/source.js";
import { recordRunSkillUsage } from "../../../skills/runtime/run-usage.js";
import type { ExplicitSkillSelection, SkillSnapshot } from "../../../skills/types.js";
import { canonicalizePath } from "../../utils/paths.js";

function comparableSkillPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    return undefined;
  }
  const resolved = canonicalizePath(path.resolve(trimmed));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Records core-resolved explicit skill commands against the admitted run. */
export function recordExplicitSkillSelectionsForRun(params: {
  runId?: string;
  selections?: readonly ExplicitSkillSelection[];
  skillsSnapshot?: SkillSnapshot;
}): void {
  if (!params.runId || !params.selections?.length) {
    return;
  }
  const skillsByPath = new Map(
    (params.skillsSnapshot?.resolvedSkills ?? []).flatMap((skill) => {
      const skillFile = comparableSkillPath(skill.filePath);
      return skillFile ? [[skillFile, skill] as const] : [];
    }),
  );
  for (const selection of params.selections) {
    const selectedPath = comparableSkillPath(selection.path);
    const skill = selectedPath ? skillsByPath.get(selectedPath) : undefined;
    if (!skill) {
      continue;
    }
    recordRunSkillUsage({
      runId: params.runId,
      name: skill.name,
      source: resolveSkillTelemetrySource(skill),
      activation: "command",
      skillFile: skill.filePath,
    });
  }
}
