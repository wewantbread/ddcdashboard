const MAX_WORKSPACE_ATTESTATION_FILENAME_LENGTH = 255;
// A closed ASCII basename excludes traversal, NUL, and Win32 device aliases.
const SAFE_ATTESTATION_BASENAME = /^[A-Za-z0-9._-]+\.md$/u;
const WINDOWS_RESERVED_DEVICE_STEMS = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

export function isSafeWorkspaceAttestationFilename(filename: string): boolean {
  return (
    filename.length <= MAX_WORKSPACE_ATTESTATION_FILENAME_LENGTH &&
    SAFE_ATTESTATION_BASENAME.test(filename) &&
    !filename.startsWith(".") &&
    !WINDOWS_RESERVED_DEVICE_STEMS.test(filename.split(".")[0] ?? "")
  );
}
