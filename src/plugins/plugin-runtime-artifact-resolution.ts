/** Resolves the exact root and entry selected by the plugin runtime loader. */
import fs from "node:fs";
import path from "node:path";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import {
  isTypeScriptPackageEntry,
  listBuiltRuntimeEntryCandidates,
} from "./package-entrypoints.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "./runtime.js";

type PluginRuntimeArtifactEntryKind = "runtime" | "setup";

export function clearPluginRuntimeArtifactResolutionMemo(): void {
  getActivePluginRegistry()?.pluginRuntimeArtifacts.clear();
}

/** Canonical packaged runtime replaces staging-only dist-runtime artifacts. */
export function resolveCanonicalDistRuntimeSource(source: string): string {
  const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) {
    return source;
  }
  const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
  return fs.existsSync(candidate) ? candidate : source;
}

function rewriteBundledRuntimeArtifactRelativePath(relativePath: string): string {
  return relativePath.replace(/\.[^.]+$/u, ".js");
}

function resolvePackageLocalDistRuntimeArtifact(params: {
  source: string;
  rootDir: string;
}): string | null {
  const relativeSource = path.relative(params.rootDir, params.source);
  if (
    !isTypeScriptPackageEntry(relativeSource) ||
    relativeSource === "" ||
    relativeSource.startsWith("..") ||
    path.isAbsolute(relativeSource)
  ) {
    return null;
  }
  for (const artifactRelativePath of listBuiltRuntimeEntryCandidates(relativeSource)) {
    const artifactSource = path.resolve(params.rootDir, artifactRelativePath);
    if (fs.existsSync(artifactSource)) {
      return resolveRealpathOrAbsolute(artifactSource);
    }
  }
  return null;
}

function resolvePreferredBuiltRuntimeArtifact(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
}): { source: string; rootDir: string } {
  const rootDir = resolveRealpathOrAbsolute(params.rootDir);
  const source = resolveRealpathOrAbsolute(params.source);
  if (!params.preferBuiltPluginArtifacts) {
    return { source, rootDir };
  }
  if (params.origin !== "bundled") {
    const artifactSource = resolvePackageLocalDistRuntimeArtifact({ source, rootDir });
    if (artifactSource) {
      return { source: artifactSource, rootDir };
    }
    return { source, rootDir };
  }
  // Source-external plugins keep source authoritative over package-local output;
  // only the lifecycle-owned canonical root build may replace that pair.
  const sourceExternal = params.packageManifest?.build?.bundledDist === false;
  const packageLocalArtifactSource = sourceExternal
    ? null
    : resolvePackageLocalDistRuntimeArtifact({ source, rootDir });
  if (packageLocalArtifactSource) {
    return { source: packageLocalArtifactSource, rootDir };
  }
  const extensionsDir = path.dirname(rootDir);
  if (path.basename(extensionsDir) !== "extensions") {
    return { source, rootDir };
  }
  const packageRoot = path.dirname(extensionsDir);
  if (path.basename(packageRoot) === "dist" || path.basename(packageRoot) === "dist-runtime") {
    return { source, rootDir };
  }
  const relativeSource = path.relative(rootDir, source);
  if (relativeSource === "" || relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) {
    return { source, rootDir };
  }
  const artifactRelativePath = rewriteBundledRuntimeArtifactRelativePath(relativeSource);
  // Source-external packaging can replace the flat root build while leaving its
  // staging wrapper behind, so only bundled artifacts may fall back to dist-runtime.
  for (const artifactRootName of sourceExternal ? ["dist"] : ["dist-runtime", "dist"]) {
    const artifactRoot = path.join(
      packageRoot,
      artifactRootName,
      "extensions",
      path.basename(rootDir),
    );
    const artifactSource = path.join(artifactRoot, artifactRelativePath);
    if (fs.existsSync(artifactSource)) {
      return {
        source: resolveRealpathOrAbsolute(artifactSource),
        rootDir: resolveRealpathOrAbsolute(artifactRoot),
      };
    }
  }
  return { source, rootDir };
}

/** Applies both loader selection phases in their runtime order. */
export function resolvePluginRuntimeArtifact(params: {
  pluginId: string;
  entryKind: PluginRuntimeArtifactEntryKind;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
  registry?: PluginRegistry;
}): { source: string; rootDir: string } {
  const rootDir = resolveCanonicalDistRuntimeSource(resolveRealpathOrAbsolute(params.rootDir));
  const source = resolveCanonicalDistRuntimeSource(resolveRealpathOrAbsolute(params.source));
  const memoKey = JSON.stringify([params.pluginId, rootDir, params.entryKind]);
  const targetRegistry = params.registry ?? requireActivePluginRegistry();
  const cached = targetRegistry.pluginRuntimeArtifacts.get(memoKey);
  if (cached) {
    targetRegistry.pluginRuntimeArtifacts.set(memoKey, cached);
    return { ...cached };
  }

  const preferred = resolvePreferredBuiltRuntimeArtifact({ ...params, source, rootDir });
  const resolved = {
    source: resolveCanonicalDistRuntimeSource(preferred.source),
    rootDir: resolveCanonicalDistRuntimeSource(preferred.rootDir),
  };
  targetRegistry.pluginRuntimeArtifacts.set(memoKey, resolved);
  return { ...resolved };
}
