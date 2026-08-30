/** Shared cron SQLite store and quarantine types. */
import type { CronStoreFile } from "../types.js";

/** Invalid config-backed cron job captured for quarantine instead of runtime load. */
export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

/** Durable recovery record for a cron job skipped during store loading. */
export type CronQuarantinedJob = QuarantinedCronConfigJob & { quarantinedAtMs: number };

/** Runtime state retained for config-sourced jobs that are not persisted as canonical jobs. */
export type CronConfigJobRuntimeEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

/**
 * Runtime snapshot captured when scheduler-disabled CRUD reloads the shared
 * store, used to detect and preserve foreign runtime commits (#131401).
 */
export type CronRuntimeBaseline = {
  state: Record<string, unknown>;
  runtimeUpdatedAtMs: number | undefined;
  scheduleIdentity: string | undefined;
  /** Trigger and payload script definitions whose state is definition-owned. */
  triggerScript: string | null;
  payloadScript: string | null;
  /** The upcoming write explicitly owns this row's runtime state. */
  localRuntimeOwner?: boolean;
};

/** Combined cron store load result with canonical jobs and config-backed metadata. */
export type LoadedCronStore = {
  store: CronStoreFile;
  configJobs: Array<Record<string, unknown>>;
  configJobIndexes: number[];
  configJobRuntimeEntries: CronConfigJobRuntimeEntry[];
  invalidConfigRows: QuarantinedCronConfigJob[];
};
