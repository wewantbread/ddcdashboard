import path from "node:path";
import { resolveLlamaCppDataDir } from "./defaults.js";

export const LLAMA_SERVER_RELEASE = "b10488";
export const LLAMA_SERVER_BUILD = 10_488;
export const LLAMA_SERVER_COMMIT = "9d77fa17254e1dee4b9e92504c91611a60b1359f";

type RegularFileAliases = ReadonlyArray<readonly [source: string, aliases: readonly string[]]>;

export type LlamaServerAsset = {
  platform: NodeJS.Platform;
  arch: string;
  backend: "metal" | "cpu";
  archive: "tar.gz" | "zip";
  archiveRoot: string;
  name: string;
  sha256: string;
  executable: string;
  regularFileAliases: RegularFileAliases;
};

// These basenames are authenticated by the adjacent release checksum. Archive-provided
// links are ignored; update this manifest together with each pinned llama.cpp release.
const MACOS_ALIASES = [
  ["libggml-rpc.0.20.2.dylib", ["libggml-rpc.0.dylib", "libggml-rpc.dylib"]],
  ["libllama.0.1.2.dylib", ["libllama.0.dylib", "libllama.dylib"]],
  ["libmtmd.0.1.2.dylib", ["libmtmd.0.dylib", "libmtmd.dylib"]],
  ["libggml.0.20.2.dylib", ["libggml.0.dylib", "libggml.dylib"]],
  ["libggml-base.0.20.2.dylib", ["libggml-base.0.dylib", "libggml-base.dylib"]],
  ["libggml-blas.0.20.2.dylib", ["libggml-blas.0.dylib", "libggml-blas.dylib"]],
  ["libllama-common.0.1.2.dylib", ["libllama-common.0.dylib", "libllama-common.dylib"]],
  ["libggml-cpu.0.20.2.dylib", ["libggml-cpu.0.dylib", "libggml-cpu.dylib"]],
] as const satisfies RegularFileAliases;

const MACOS_METAL_ALIASES = [
  ...MACOS_ALIASES,
  ["libggml-metal.0.20.2.dylib", ["libggml-metal.0.dylib", "libggml-metal.dylib"]],
] as const satisfies RegularFileAliases;

const LINUX_ALIASES = [
  ["libllama.so.0.1.2", ["libllama.so.0", "libllama.so"]],
  ["libggml.so.0.20.2", ["libggml.so.0", "libggml.so"]],
  ["libmtmd.so.0.1.2", ["libmtmd.so.0", "libmtmd.so"]],
  ["libggml-base.so.0.20.2", ["libggml-base.so.0", "libggml-base.so"]],
  ["libllama-common.so.0.1.2", ["libllama-common.so.0", "libllama-common.so"]],
] as const satisfies RegularFileAliases;

const LLAMA_SERVER_ASSETS: LlamaServerAsset[] = [
  {
    platform: "darwin",
    arch: "arm64",
    backend: "metal",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: "ada90bbc4787caac49fbb95ed2487a03fb4bbb456057a31e316878e1a895827a",
    executable: "llama-server",
    regularFileAliases: MACOS_METAL_ALIASES,
  },
  {
    platform: "darwin",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: "80567f47511d5e11872835614b99cd678fa276b05553563e8aab3f2cb6b90abd",
    executable: "llama-server",
    regularFileAliases: MACOS_ALIASES,
  },
  {
    platform: "linux",
    arch: "arm64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    sha256: "e977e13e9d72b8ee0068336bb9196f4f8158e8b53b8d502dc8bdb55eaea1222f",
    executable: "llama-server",
    regularFileAliases: LINUX_ALIASES,
  },
  {
    platform: "linux",
    arch: "x64",
    backend: "cpu",
    archive: "tar.gz",
    archiveRoot: `llama-${LLAMA_SERVER_RELEASE}`,
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-ubuntu-x64.tar.gz`,
    sha256: "5a7073371d5a9b8e39978b35f49b2ff244f7a064edb92f0326d94e12b52261dd",
    executable: "llama-server",
    regularFileAliases: LINUX_ALIASES,
  },
  {
    platform: "win32",
    arch: "arm64",
    backend: "cpu",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: "97a883831728862568a0e7e38380e7a179b6bcb292167f648a5598586dd65635",
    executable: "llama-server.exe",
    regularFileAliases: [],
  },
  {
    platform: "win32",
    arch: "x64",
    backend: "cpu",
    archive: "zip",
    archiveRoot: ".",
    name: `llama-${LLAMA_SERVER_RELEASE}-bin-win-cpu-x64.zip`,
    sha256: "6c938f6d79aac96cb90fda673aade20cff9b1b6c1e97de04f4d5d60bca107082",
    executable: "llama-server.exe",
    regularFileAliases: [],
  },
];

export function selectLlamaServerAsset(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): LlamaServerAsset {
  const asset = LLAMA_SERVER_ASSETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!asset) {
    throw new Error(
      `No verified llama-server ${LLAMA_SERVER_RELEASE} build is available for ${platform}/${arch}. Install a compatible llama-server manually, then rerun llama.cpp setup with its absolute path.`,
    );
  }
  return asset;
}

export function resolveManagedLlamaServerPaths(asset = selectLlamaServerAsset()): {
  installDir: string;
  command: string;
  presetPath: string;
} {
  const installDir = path.join(
    resolveLlamaCppDataDir(),
    LLAMA_SERVER_RELEASE,
    `${asset.platform}-${asset.arch}`,
  );
  return {
    installDir,
    command: path.join(installDir, asset.executable),
    presetPath: path.join(resolveLlamaCppDataDir(), "models.ini"),
  };
}
