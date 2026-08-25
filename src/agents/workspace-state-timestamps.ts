export function assertWorkspaceStateTimestamp(value: string | null, label: string): void {
  if (value === null) {
    return;
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}

export function assertWorkspaceStateIntegerTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`workspace ${label} timestamp is invalid`);
  }
}
