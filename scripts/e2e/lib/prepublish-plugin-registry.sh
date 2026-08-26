#!/usr/bin/env bash

prepublish_plugin_registry_mount_args() {
  local registry_dir="$1"
  local output_array_name="$2"
  local container_dir="${3:-/tmp/openclaw-prepublish-plugin-registry}"
  local resolved_registry_dir
  resolved_registry_dir="$(cd "$registry_dir" && pwd)"
  if [ ! -f "$resolved_registry_dir/prepublish-plugin-registry.json" ]; then
    echo "Prepublish plugin registry manifest is missing." >&2
    exit 1
  fi

  local -n output_args="$output_array_name"
  output_args=(
    -e "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=$container_dir"
    -v "$resolved_registry_dir:$container_dir:ro"
  )
}

prepublish_plugin_registry_append_manifest_args() {
  local manifest="$1"
  local output_array_name="$2"
  local required_package="${3:-}"
  local registry_rows
  registry_rows="$(
    PREPUBLISH_PLUGIN_REGISTRY_MANIFEST="$manifest" \
      PREPUBLISH_PLUGIN_REGISTRY_REQUIRED_PACKAGE="$required_package" \
      node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const manifestPath = process.env.PREPUBLISH_PLUGIN_REGISTRY_MANIFEST;
const requiredPackage = process.env.PREPUBLISH_PLUGIN_REGISTRY_REQUIRED_PACKAGE || "";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
let packages = Array.isArray(manifest.packages) ? manifest.packages : [];
if (requiredPackage) {
  packages = packages.filter((entry) => entry?.name === requiredPackage);
  if (packages.length !== 1) {
    throw new Error(`prepublish plugin registry must contain exactly one ${requiredPackage} package`);
  }
}
if (packages.length === 0) {
  throw new Error("prepublish plugin registry manifest must contain packages");
}
for (const entry of packages) {
  if (
    typeof entry.name !== "string" ||
    typeof entry.version !== "string" ||
    typeof entry.tarball !== "string" ||
    path.basename(entry.tarball) !== entry.tarball
  ) {
    throw new Error("invalid prepublish plugin registry package entry");
  }
  process.stdout.write(
    `${entry.name}\t${entry.version}\t${path.join(path.dirname(manifestPath), entry.tarball)}\n`,
  );
}
NODE
  )"

  local -n output_args="$output_array_name"
  local plugin_package_name plugin_package_version plugin_package_tarball
  while IFS=$'\t' read -r plugin_package_name plugin_package_version plugin_package_tarball; do
    output_args+=("$plugin_package_name" "$plugin_package_version" "$plugin_package_tarball")
  done <<<"$registry_rows"
}

prepublish_plugin_registry_start_npm_server() {
  local registry_root="$1"
  local log_label="$2"
  local pid_var_name="$3"
  local dist_tags="$4"
  shift 4

  if [ "$#" -eq 0 ]; then
    return 0
  fi

  local port_file="$registry_root/port"
  local log_file="$registry_root/server.log"
  mkdir -p "$registry_root" && rm -f "$port_file"
  OPENCLAW_NPM_REGISTRY_DIST_TAGS="$dist_tags" \
  OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
    node scripts/e2e/lib/plugins/npm-registry-server.mjs \
    "$port_file" \
    "$@" >"$log_file" 2>&1 &

  local -n pid_var="$pid_var_name"
  pid_var="$!"
  for _ in $(seq 1 100); do
    [ -s "$port_file" ] && break
    openclaw_e2e_process_alive "$pid_var" || break
    sleep 0.1
  done
  if [ ! -s "$port_file" ]; then
    openclaw_e2e_print_log "$log_file" >&2
    echo "Timed out waiting for $log_label." >&2
    return 1
  fi
  export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$port_file")"
  export npm_config_registry="$NPM_CONFIG_REGISTRY"
}
