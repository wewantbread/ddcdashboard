import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectPackageTarballBytes } from "../plugin-publication-artifact.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const PROTECTED_TOOLING_REF_PATTERN = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;

type PluginMatrixEntry = {
  artifactName: string;
  packageName: string;
  version: string;
};

export type ClawHubPackageTransaction = {
  inventoryDigest: string;
  name: string;
  version: string;
};

export type ClawHubTransactionManifest = {
  candidateRepository: string;
  candidateSha: string;
  childFullRef: string;
  childHeadSha: string;
  childRef: string;
  childRepository: string;
  childRunAttempt: string;
  childRunId: string;
  childWorkflow: ".github/workflows/plugin-clawhub-release.yml";
  packages: ClawHubPackageTransaction[];
  toolingFullRef: string;
  toolingRef: string;
  toolingSha: string;
  version: 2;
};

export type ClawHubParentAuthorization = {
  authorizationRoute: "automated-awaited" | "automated-detached";
  candidateRepository: string;
  candidateSha: string;
  childFullRef: string;
  childHeadSha: string;
  childRef: string;
  childRepository: string;
  childRunAttempt: string;
  childRunId: string;
  childWorkflow: ".github/workflows/plugin-clawhub-release.yml";
  fullRef: string;
  headSha: string;
  kind: "openclaw-clawhub-parent-authorization";
  packages: ClawHubPackageTransaction[];
  ref: string;
  repository: string;
  runAttempt: string;
  runId: string;
  toolingFullRef: string;
  toolingRef: string;
  toolingSha: string;
  version: 2;
  workflow: ".github/workflows/openclaw-release-publish.yml";
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireSha(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${label} must be a full lowercase commit SHA.`);
  }
  return sha;
}

function requirePositiveInteger(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!POSITIVE_INTEGER_PATTERN.test(result)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return result;
}

function requireRepository(value: unknown, label: string): string {
  const repository = requireString(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`${label} must be an owner/repository pair.`);
  }
  return repository;
}

function requireRefPair(refValue: unknown, fullRefValue: unknown, label: string) {
  const ref = requireString(refValue, `${label} ref`);
  const fullRef = requireString(fullRefValue, `${label} full ref`);
  if (fullRef !== `refs/heads/${ref}` && fullRef !== `refs/tags/${ref}`) {
    throw new Error(`${label} ref does not match its full ref.`);
  }
  return { ref, fullRef };
}

function requireToolingIdentity(refValue: unknown, fullRefValue: unknown, shaValue: unknown) {
  const { ref, fullRef } = requireRefPair(refValue, fullRefValue, "tooling");
  const sha = requireSha(shaValue, "tooling SHA");
  if (ref === "main" && fullRef === "refs/heads/main") {
    return { ref, fullRef, sha };
  }
  const match = PROTECTED_TOOLING_REF_PATTERN.exec(ref);
  if (!match || fullRef !== `refs/tags/${ref}` || match[1] !== sha.slice(0, 12)) {
    throw new Error(
      "tooling must use current main or an exact SHA-prefixed protected release-publish tag.",
    );
  }
  return { ref, fullRef, sha };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildClawHubInventoryDigest(
  inventory: readonly {
    path: string;
    sizeBytes: number;
    sha256?: string;
    type: string;
  }[],
): string {
  const files = inventory
    .filter((entry) => entry.type === "file")
    .map((entry) => {
      if (!entry.path.startsWith("package/") || !entry.sha256) {
        throw new Error(`ClawHub package inventory contains an invalid file: ${entry.path}`);
      }
      return {
        path: entry.path.slice("package/".length),
        size: entry.sizeBytes,
        sha256: entry.sha256.toLowerCase(),
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw new Error("ClawHub package inventory must contain at least one file.");
  }
  const payload = files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function parsePluginMatrix(raw: string): PluginMatrixEntry[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw new Error("ClawHub plugin matrix must contain 1 through 512 entries.");
  }
  const entries = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`ClawHub plugin matrix entry ${index} is invalid.`);
    }
    const record = item as Record<string, unknown>;
    const entry = {
      artifactName: requireString(record.artifactName, `matrix entry ${index} artifactName`),
      packageName: requireString(record.packageName, `matrix entry ${index} packageName`),
      version: requireString(record.version, `matrix entry ${index} version`),
    };
    if (
      entry.artifactName === "." ||
      entry.artifactName === ".." ||
      entry.artifactName.includes("/") ||
      entry.artifactName.includes("\\")
    ) {
      throw new Error(`ClawHub plugin matrix entry ${index} artifactName is unsafe.`);
    }
    return entry;
  });
  const packageNames = new Set(entries.map((entry) => entry.packageName));
  const artifactNames = new Set(entries.map((entry) => entry.artifactName));
  if (packageNames.size !== entries.length || artifactNames.size !== entries.length) {
    throw new Error("ClawHub plugin matrix contains duplicate packages or artifacts.");
  }
  return entries.toSorted((left, right) => compareCodeUnits(left.packageName, right.packageName));
}

function findOnlyTarball(artifactDir: string): string {
  const names = readdirSync(artifactDir).filter((name) => name.endsWith(".tgz"));
  if (names.length !== 1) {
    throw new Error(`Expected exactly one .tgz in ${artifactDir}; found ${names.length}.`);
  }
  return join(artifactDir, names[0]!);
}

export function buildClawHubTransactionManifest(params: {
  artifactsDir: string;
  matrix: PluginMatrixEntry[];
  candidateRepository: string;
  candidateSha: string;
  childRepository: string;
  childRunId: string;
  childRunAttempt: string;
  childRef: string;
  childFullRef: string;
  childHeadSha: string;
  toolingRef: string;
  toolingFullRef: string;
  toolingSha: string;
}): ClawHubTransactionManifest {
  const candidateRepository = requireRepository(params.candidateRepository, "candidate repository");
  const candidateSha = requireSha(params.candidateSha, "candidate SHA");
  const childRepository = requireRepository(params.childRepository, "child repository");
  const childRunId = requirePositiveInteger(params.childRunId, "child run id");
  const childRunAttempt = requirePositiveInteger(params.childRunAttempt, "child run attempt");
  const child = requireRefPair(params.childRef, params.childFullRef, "child");
  const childHeadSha = requireSha(params.childHeadSha, "child head SHA");
  const tooling = requireToolingIdentity(
    params.toolingRef,
    params.toolingFullRef,
    params.toolingSha,
  );
  if (
    candidateRepository !== childRepository ||
    child.ref !== tooling.ref ||
    child.fullRef !== tooling.fullRef ||
    childHeadSha !== tooling.sha
  ) {
    throw new Error("ClawHub child, candidate, and tooling identity are inconsistent.");
  }

  const artifactsDir = resolve(params.artifactsDir);
  const packages = params.matrix.map((entry) => {
    const tarballPath = findOnlyTarball(join(artifactsDir, entry.artifactName));
    const inspection = inspectPackageTarballBytes(readFileSync(tarballPath));
    if (
      inspection.packageManifest.name !== entry.packageName ||
      inspection.packageManifest.version !== entry.version
    ) {
      throw new Error(
        `Packed ClawHub identity does not match ${entry.packageName}@${entry.version}.`,
      );
    }
    return {
      inventoryDigest: buildClawHubInventoryDigest(inspection.inventory),
      name: entry.packageName,
      version: entry.version,
    };
  });

  return {
    version: 2,
    candidateRepository,
    candidateSha,
    childRepository,
    childWorkflow: ".github/workflows/plugin-clawhub-release.yml",
    childRunId,
    childRunAttempt,
    childRef: child.ref,
    childFullRef: child.fullRef,
    childHeadSha,
    toolingRef: tooling.ref,
    toolingFullRef: tooling.fullRef,
    toolingSha: tooling.sha,
    packages,
  };
}

export function buildClawHubParentAuthorization(params: {
  manifest: ClawHubTransactionManifest;
  repository: string;
  runId: string;
  runAttempt: string;
  childRunId: string;
  childRunAttempt: string;
  ref: string;
  fullRef: string;
  headSha: string;
  authorizationRoute?: "automated-awaited" | "automated-detached";
}): ClawHubParentAuthorization {
  if (
    params.manifest.version !== 2 ||
    params.manifest.childWorkflow !== ".github/workflows/plugin-clawhub-release.yml"
  ) {
    throw new Error("ClawHub transaction manifest contract is invalid.");
  }
  const candidateRepository = requireRepository(
    params.manifest.candidateRepository,
    "manifest candidate repository",
  );
  const candidateSha = requireSha(params.manifest.candidateSha, "manifest candidate SHA");
  const childRepository = requireRepository(
    params.manifest.childRepository,
    "manifest child repository",
  );
  const childRunId = requirePositiveInteger(params.manifest.childRunId, "manifest child run id");
  const childRunAttempt = requirePositiveInteger(
    params.manifest.childRunAttempt,
    "manifest child run attempt",
  );
  const expectedChildRunId = requirePositiveInteger(params.childRunId, "expected child run id");
  const expectedChildRunAttempt = requirePositiveInteger(
    params.childRunAttempt,
    "expected child run attempt",
  );
  const child = requireRefPair(
    params.manifest.childRef,
    params.manifest.childFullRef,
    "manifest child",
  );
  const childHeadSha = requireSha(params.manifest.childHeadSha, "manifest child head SHA");
  if (
    !Array.isArray(params.manifest.packages) ||
    params.manifest.packages.length === 0 ||
    params.manifest.packages.length > 512
  ) {
    throw new Error("ClawHub transaction manifest package inventory is invalid.");
  }
  const packageNames = new Set<string>();
  const packages = params.manifest.packages.map((entry, index) => {
    const name = requireString(entry?.name, `manifest package ${index} name`);
    const version = requireString(entry?.version, `manifest package ${index} version`);
    const inventoryDigest = requireString(
      entry?.inventoryDigest,
      `manifest package ${index} inventory digest`,
    );
    if (!/^[a-f0-9]{64}$/u.test(inventoryDigest) || packageNames.has(name)) {
      throw new Error(`ClawHub transaction manifest package ${index} is invalid.`);
    }
    packageNames.add(name);
    return { name, version, inventoryDigest };
  });
  const sortedPackages = packages.toSorted((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
  if (JSON.stringify(packages) !== JSON.stringify(sortedPackages)) {
    throw new Error("ClawHub transaction manifest packages must use canonical name ordering.");
  }
  const repository = requireRepository(params.repository, "parent repository");
  const runId = requirePositiveInteger(params.runId, "parent run id");
  const runAttempt = requirePositiveInteger(params.runAttempt, "parent run attempt");
  const parent = requireRefPair(params.ref, params.fullRef, "parent");
  const headSha = requireSha(params.headSha, "parent head SHA");
  const tooling = requireToolingIdentity(
    params.manifest.toolingRef,
    params.manifest.toolingFullRef,
    params.manifest.toolingSha,
  );
  if (
    repository !== childRepository ||
    candidateRepository !== childRepository ||
    child.ref !== tooling.ref ||
    child.fullRef !== tooling.fullRef ||
    childHeadSha !== tooling.sha ||
    childRunId !== expectedChildRunId ||
    childRunAttempt !== expectedChildRunAttempt ||
    parent.ref !== tooling.ref ||
    parent.fullRef !== tooling.fullRef ||
    headSha !== tooling.sha
  ) {
    throw new Error("ClawHub parent authorization does not match the protected tooling identity.");
  }
  return {
    version: 2,
    kind: "openclaw-clawhub-parent-authorization",
    repository,
    workflow: ".github/workflows/openclaw-release-publish.yml",
    runId,
    runAttempt,
    ref: parent.ref,
    fullRef: parent.fullRef,
    headSha,
    childWorkflow: params.manifest.childWorkflow,
    childRepository,
    childRunId,
    childRunAttempt,
    childRef: child.ref,
    childFullRef: child.fullRef,
    childHeadSha,
    candidateRepository,
    candidateSha,
    toolingRef: tooling.ref,
    toolingFullRef: tooling.fullRef,
    toolingSha: tooling.sha,
    packages,
    authorizationRoute: params.authorizationRoute ?? "automated-awaited",
  };
}

function parseArgs(argv: string[]): { command: string; values: Map<string, string> } {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error("Expected transactions or authorization command.");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${flag ?? "<end>"}.`);
    }
    values.set(flag.slice(2), value);
  }
  return { command, values };
}

function required(values: Map<string, string>, name: string): string {
  return requireString(values.get(name), `--${name}`);
}

export function runOpenClawClawHubAuthorizationCli(argv: string[]): void {
  const { command, values } = parseArgs(argv);
  if (command === "transactions") {
    const manifest = buildClawHubTransactionManifest({
      artifactsDir: required(values, "artifacts-dir"),
      matrix: parsePluginMatrix(required(values, "matrix-json")),
      candidateRepository: required(values, "candidate-repository"),
      candidateSha: required(values, "candidate-sha"),
      childRepository: required(values, "child-repository"),
      childRunId: required(values, "child-run-id"),
      childRunAttempt: required(values, "child-run-attempt"),
      childRef: required(values, "child-ref"),
      childFullRef: required(values, "child-full-ref"),
      childHeadSha: required(values, "child-head-sha"),
      toolingRef: required(values, "tooling-ref"),
      toolingFullRef: required(values, "tooling-full-ref"),
      toolingSha: required(values, "tooling-sha"),
    });
    writeFileSync(required(values, "output"), `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "authorization") {
    const manifest = JSON.parse(
      readFileSync(required(values, "manifest"), "utf8"),
    ) as ClawHubTransactionManifest;
    const authorization = buildClawHubParentAuthorization({
      manifest,
      repository: required(values, "repository"),
      runId: required(values, "run-id"),
      runAttempt: required(values, "run-attempt"),
      childRunId: required(values, "child-run-id"),
      childRunAttempt: required(values, "child-run-attempt"),
      ref: required(values, "ref"),
      fullRef: required(values, "full-ref"),
      headSha: required(values, "head-sha"),
      authorizationRoute: "automated-awaited",
    });
    writeFileSync(required(values, "output"), `${JSON.stringify(authorization, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOpenClawClawHubAuthorizationCli(process.argv.slice(2));
}
