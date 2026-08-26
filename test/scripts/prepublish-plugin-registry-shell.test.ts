import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const HELPER = "scripts/e2e/lib/prepublish-plugin-registry.sh";

describe("prepublish plugin registry shell helper", () => {
  it("builds Docker mount args and package registry args from the manifest", () => {
    const registryDir = tempDirs.make("openclaw-prepublish-registry-");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, "prepublish-plugin-registry.json"),
      JSON.stringify({
        packages: [
          { name: "@openclaw/codex", version: "2026.7.2", tarball: "codex.tgz" },
          { name: "@openclaw/telegram", version: "2026.7.2", tarball: "telegram.tgz" },
        ],
      }),
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source "${HELPER}"
mount_args=()
registry_args=()
prepublish_plugin_registry_mount_args "$1" mount_args
prepublish_plugin_registry_append_manifest_args "$1/prepublish-plugin-registry.json" registry_args "@openclaw/codex"
printf 'mount=%s\\n' "\${mount_args[*]}"
printf 'registry=%s\\n' "\${registry_args[*]}"
`,
        "helper-test",
        registryDir,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/openclaw-prepublish-plugin-registry",
    );
    expect(result.stdout).toContain(`${registryDir}:/tmp/openclaw-prepublish-plugin-registry:ro`);
    expect(result.stdout).toContain(`registry=@openclaw/codex 2026.7.2 ${registryDir}/codex.tgz`);
    expect(result.stdout).not.toContain("@openclaw/telegram");
  });
});
