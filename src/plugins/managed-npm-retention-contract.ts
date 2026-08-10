/** Marker reason for packages preserved by an explicit `plugins uninstall --keep-files`. */
export const RETAINED_MANAGED_NPM_KEEP_FILES_REASON = "removed-managed-npm-install-retained";

/** Marker reason for an uncommitted Codex inference activation kept for later GC. */
export const RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON =
  "openclaw-inference-activation-not-committed";
