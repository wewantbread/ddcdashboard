import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  type WorkerGitHubPublishParams,
  type WorkerSessionsSendParams,
  WorkerSessionsSendParamsSchema,
  type WorkerSessionsSpawnParams,
  WorkerSessionsSpawnParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  buildBlockedToolResult,
  runBeforeToolCallHook,
} from "../../agents/agent-tools.before-tool-call.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sha256Base64Url, sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerPortalToolRequest } from "./worker-portal-tool-executor.js";
import type { WorkerSessionToolSource } from "./worker-session-tool-topology.js";

export type WorkerSessionOperationRequest = {
  identity: WorkerConnectionIdentity;
  signal?: AbortSignal;
} & (
  | { toolName: "sessions_spawn"; request: WorkerSessionsSpawnParams }
  | { toolName: "sessions_send"; request: WorkerSessionsSendParams }
);

export type WorkerSessionToolRequest =
  | WorkerPortalToolRequest
  | WorkerSessionOperationRequest
  | ({ identity: WorkerConnectionIdentity; signal?: AbortSignal } & {
      toolName: "github_publish";
      request: WorkerGitHubPublishParams;
    });

export class WorkerSessionToolOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Worker session operation outcome is unknown; it was not replayed", { cause });
    this.name = "WorkerSessionToolOutcomeUnknownError";
  }
}

export function computeWorkerSessionToolRequestDigest(value: unknown): string {
  return sha256Base64Url(`openclaw.worker-session-tool-request.v1\0${JSON.stringify(value)}`);
}

export function workerSessionToolOperationKey(operationSeed: string, purpose: string): string {
  return sha256Base64Url(`openclaw.worker-session-tool-operation.v1\0${operationSeed}\0${purpose}`);
}

export function workerChildSessionKey(operationSeed: string, targetAgentId: string): string {
  return `agent:${targetAgentId}:dashboard:cloud-${sha256HexPrefixCore(
    `openclaw.worker-session-tool-operation.v1\0${operationSeed}\0child-session`,
    32,
  )}`;
}

export async function applyWorkerSessionToolPolicy(params: {
  request: WorkerSessionOperationRequest;
  source: Pick<WorkerSessionToolSource, "agentId" | "sessionId" | "sessionKey">;
}): Promise<
  { request: WorkerSessionOperationRequest } | { result: ReturnType<typeof buildBlockedToolResult> }
> {
  const { toolCallId, ...toolParams } = params.request.request;
  const runId = params.request.identity.runId ?? undefined;
  const blocked = (
    reason: string,
    deniedReason?: Parameters<typeof buildBlockedToolResult>[0]["deniedReason"],
  ) => ({
    result: buildBlockedToolResult({ reason, deniedReason, toolCallId, runId }),
  });
  const outcome = await runBeforeToolCallHook({
    toolName: params.request.toolName,
    params: toolParams,
    toolCallId,
    ctx: {
      agentId: params.source.agentId,
      config: getRuntimeConfig(),
      sessionKey: params.source.sessionKey,
      sessionId: params.source.sessionId,
      runId,
    },
    ...(params.request.signal ? { signal: params.request.signal } : {}),
    approvalMode: "deny",
  });
  if (outcome.blocked) {
    return blocked(outcome.reason, outcome.deniedReason);
  }

  const adjustedRequest = { ...asNonArrayRecord(outcome.params), toolCallId };
  const schema =
    params.request.toolName === "sessions_spawn"
      ? WorkerSessionsSpawnParamsSchema
      : WorkerSessionsSendParamsSchema;
  if (!Value.Check(schema, adjustedRequest)) {
    return blocked(
      `Tool call blocked because before_tool_call returned invalid ${params.request.toolName} input.`,
    );
  }
  return {
    request: {
      ...params.request,
      request: adjustedRequest,
      // SAFETY: the matching worker protocol schema validated the adjusted request above.
    } as WorkerSessionOperationRequest,
  };
}
