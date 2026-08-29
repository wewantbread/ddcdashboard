import { isDeepStrictEqual } from "node:util";
import type {
  WorkerSessionsSendParams,
  WorkerSessionsSpawnParams,
  WorkerSessionToolResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
  type InProcessGatewayCaller,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { jsonResult } from "../../agents/tools/tool-results.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { inheritSessionCreationPolicy } from "../../config/sessions/session-entry-provenance.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { WORKER_TOOL_NAMES } from "../../worker/tool-authority.js";
import type { GitHubPublicationCoordinator } from "../github-publication.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  getWorkerTurnExecutionIdentityCapability,
  type WorkerTurnExecutionIdentity,
} from "./placement-turn-claim-events.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  createWorkerPortalToolExecutor,
  type WorkerPortalToolExecutorDependencies,
} from "./worker-portal-tool-executor.js";
import {
  applyWorkerSessionToolPolicy,
  computeWorkerSessionToolRequestDigest as computeRequestDigest,
  createWorkerSessionToolGatewayCaller,
  runWithWorkerSessionToolExecutionIdentity,
  workerChildSessionKey as childSessionKey,
  WorkerSessionToolOutcomeUnknownError,
  workerSessionToolOperationKey as operationKey,
  type WorkerSessionToolRequest,
} from "./worker-session-tool-operation.js";
import {
  serializeWorkerSessionToolResult as serializeResult,
  workerSessionToolErrorResult as errorResult,
} from "./worker-session-tool-result.js";
import {
  assertWorkerSessionToolChild as assertExactChild,
  resolveWorkerSessionToolSource as exactSource,
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  workerSessionRelationKey as relationKey,
  type WorkerSessionToolSource as ExactSource,
  type WorkerSessionToolTarget as ExactTarget,
} from "./worker-session-tool-topology.js";

export function createWorkerSessionToolExecutor(params: {
  resolveGatewayContext: GatewayContextResolver;
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatchChild: WorkerPlacementDispatchContract["dispatch"];
  githubPublication: Pick<GitHubPublicationCoordinator, "requestForClaim">;
  portals: WorkerPortalToolExecutorDependencies["portals"];
}) {
  const inFlight = new Map<string, Promise<string>>();
  const executePortal = createWorkerPortalToolExecutor(params);

  const spawn = async (operation: {
    source: ExactSource;
    identity: WorkerConnectionIdentity;
    request: WorkerSessionsSpawnParams;
    operationSeed: string;
    childSessionKey: string;
    signal?: AbortSignal;
    workerIdentity?: WorkerTurnExecutionIdentity;
  }) => {
    operation.signal?.throwIfAborted();
    const sourceEnvironment = params.environments.get(operation.identity.environmentId);
    if (
      !sourceEnvironment ||
      sourceEnvironment.state !== "attached" ||
      sourceEnvironment.ownerEpoch !== operation.identity.ownerEpoch ||
      !isDeepStrictEqual(sourceEnvironment.attachedSessionIds, [operation.source.sessionId])
    ) {
      throw new Error("Worker source environment changed before child spawn");
    }
    const targetAgentId = normalizeAgentId(operation.request.agentId ?? operation.source.agentId);
    const authorizedTools = WORKER_TOOL_NAMES.filter((name) =>
      params.placements.isWorkerTurnToolAuthorized(operation.source.turnClaim, name),
    );
    const lineageCapability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    const workerIdentity = operation.workerIdentity;
    const gatewayCall: InProcessGatewayCaller = async <T = Record<string, unknown>>(
      method: string,
      requestParams: Record<string, unknown>,
    ): Promise<T> => {
      if (method !== "sessions.create") {
        return await callAgentToolGatewayRequest<T>({
          method,
          params: requestParams,
          ...(operation.signal ? { signal: operation.signal } : {}),
          timeoutMs: null,
        });
      }
      operation.signal?.throwIfAborted();
      exactSource({ identity: operation.identity, placements: params.placements });
      let loaded = loadGatewaySessionEntryReadOnly(operation.childSessionKey, {
        agentId: targetAgentId,
      });
      let createResponse: Record<string, unknown>;
      let creationAttempted = false;
      if (loaded.entry?.sessionId) {
        const parent =
          relationKey(loaded.entry.parentSessionKey) ?? relationKey(loaded.entry.spawnedBy);
        const parentSessionId = relationKey(loaded.entry.parentSessionId);
        if (
          loaded.canonicalKey !== operation.childSessionKey ||
          parent !== operation.source.sessionKey ||
          parentSessionId !== operation.source.sessionId
        ) {
          throw new Error("Cloud child idempotency key is already owned by another session");
        }
        createResponse = {
          ok: true,
          key: loaded.canonicalKey,
          sessionId: loaded.entry.sessionId,
          entry: loaded.entry,
        };
      } else {
        const { source } = operation;
        const createParams: Record<string, unknown> = {
          ...requestParams,
          ...(source.entry.permissionMode ? { permissionMode: source.entry.permissionMode } : {}),
          key: operation.childSessionKey,
        };
        delete createParams.task;
        creationAttempted = true;
        try {
          createResponse = await callInProcessGatewayToolWithCreation(
            "sessions.create",
            createParams,
            {
              via: "spawn",
              ...inheritSessionCreationPolicy(source.entry, { type: "agent", id: source.agentId }),
              requesterSessionKey: source.sessionKey,
              inheritedToolPolicy: { version: 1, allow: authorizedTools, deny: [] },
            },
            {
              resolveGatewayContext: params.resolveGatewayContext,
              sessionMutationCommitGuard: () => {
                workerIdentity?.receiptAuthority();
                exactSource({ identity: operation.identity, placements: params.placements });
              },
              ...(operation.signal ? { signal: operation.signal } : {}),
              timeoutMs: null,
            },
          );
        } catch (error) {
          loaded = loadGatewaySessionEntryReadOnly(operation.childSessionKey, {
            agentId: targetAgentId,
          });
          if (!loaded.entry?.sessionId) {
            throw error;
          }
          createResponse = {
            ok: true,
            key: loaded.canonicalKey,
            sessionId: loaded.entry.sessionId,
            entry: loaded.entry,
          };
        }
        loaded = loadGatewaySessionEntryReadOnly(operation.childSessionKey, {
          agentId: targetAgentId,
        });
      }
      const childSessionId = loaded.entry?.sessionId;
      if (!childSessionId) {
        const error = new Error("Cloud child session creation did not persist an incarnation");
        throw creationAttempted ? new WorkerSessionToolOutcomeUnknownError(error) : error;
      }
      try {
        assertExactChild({
          childSessionKey: operation.childSessionKey,
          childSessionId,
          sourceSessionKey: operation.source.sessionKey,
          sourceSessionId: operation.source.sessionId,
          targetAgentId,
        });
      } catch (error) {
        if (creationAttempted) {
          throw new WorkerSessionToolOutcomeUnknownError(error);
        }
        throw error;
      }
      try {
        const assertActiveChildPlacement = () => {
          const placement = params.placements.get(childSessionId);
          if (placement?.state !== "active" || placement.sessionKey !== operation.childSessionKey) {
            throw new Error("Cloud child placement did not become active");
          }
          const environment = params.environments.get(placement.environmentId);
          if (
            environment?.state !== "attached" ||
            environment.ownerEpoch !== placement.activeOwnerEpoch ||
            environment.attachedSessionIds.length !== 1 ||
            environment.attachedSessionIds[0] !== childSessionId ||
            environment.profileId !== sourceEnvironment.profileId ||
            environment.providerId !== sourceEnvironment.providerId ||
            !isDeepStrictEqual(environment.profileSnapshot, sourceEnvironment.profileSnapshot)
          ) {
            throw new Error("Cloud child placement does not match its parent profile");
          }
        };
        const childPlacement = params.placements.get(childSessionId);
        operation.signal?.throwIfAborted();
        exactSource({ identity: operation.identity, placements: params.placements });
        if (childPlacement?.state !== "active") {
          try {
            await params.dispatchChild({
              sessionId: childSessionId,
              sessionKey: operation.childSessionKey,
              agentId: targetAgentId,
              profileId: sourceEnvironment.profileId,
              executionMode: "worker-turn",
              inheritedProfile: {
                providerId: sourceEnvironment.providerId,
                profileSnapshot: sourceEnvironment.profileSnapshot,
              },
            });
          } catch (error) {
            try {
              assertActiveChildPlacement();
            } catch {
              throw new WorkerSessionToolOutcomeUnknownError(error);
            }
          }
        }
        assertActiveChildPlacement();
        exactSource({ identity: operation.identity, placements: params.placements });
        operation.signal?.throwIfAborted();
        assertExactChild({
          childSessionKey: operation.childSessionKey,
          childSessionId,
          sourceSessionKey: operation.source.sessionKey,
          sourceSessionId: operation.source.sessionId,
          targetAgentId,
        });
        const childRunId = operationKey(operation.operationSeed, "initial-task");
        const config = getRuntimeConfig();
        const gatewayCaller = getGatewayToolCallerIdentity();
        const sessionSpawnContext = lineageCapability
          ? buildSubagentExecutionSessionSpawnContext({
              enabled: true,
              backend: "subagent",
              parentAgentId: operation.source.agentId,
              requesterRef: operation.source.sessionKey,
              controllerRef: operation.source.sessionKey,
              depth: (operation.source.entry.spawnDepth ?? 0) + 1,
              maxDepth:
                config.agents?.defaults?.subagents?.maxSpawnDepth ??
                DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
              targetAgentId,
              sandbox: "inherit",
              inheritedToolAllowlist: authorizedTools,
              inheritedToolDenylist: [],
            })
          : undefined;
        const run = await runWithScopedSessionAccess({
          cfg: config,
          expectedSessionId: childSessionId,
          targetSessionKey: operation.childSessionKey,
          ...(operation.signal ? { signal: operation.signal } : {}),
          run: async () => {
            let sendResult: Record<string, unknown> | undefined;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                operation.signal?.throwIfAborted();
                exactSource({ identity: operation.identity, placements: params.placements });
                assertExactChild({
                  childSessionKey: operation.childSessionKey,
                  childSessionId,
                  sourceSessionKey: operation.source.sessionKey,
                  sourceSessionId: operation.source.sessionId,
                  targetAgentId,
                });
                assertActiveChildPlacement();
                const request = {
                  method: "agent",
                  agentRunTracking: "native_subagent",
                  params: {
                    sessionKey: operation.childSessionKey,
                    sessionId: childSessionId,
                    expectedExistingSessionId: childSessionId,
                    message: operation.request.task,
                    deliver: false,
                    sessionEffects: "visible",
                    // A lost response is replayed with this same downstream key;
                    // the child turn is never started under a fresh identity.
                    idempotencyKey: `worker-session-spawn:${childRunId}`,
                  },
                  ...(operation.signal ? { signal: operation.signal } : {}),
                  timeoutMs: null,
                } as const;
                sendResult =
                  lineageCapability && workerIdentity
                    ? await lineageCapability.run(async (identity) => {
                        if (
                          identity !== workerIdentity ||
                          gatewayCaller?.agentId !== identity.agentId ||
                          gatewayCaller.sessionKey !== identity.sessionKey ||
                          gatewayCaller.operationalRunInstance !==
                            identity.operationalRunInstance ||
                          gatewayCaller.executionIdentityToken !==
                            identity.executionIdentityToken ||
                          gatewayCaller.workerTurnClaim !== identity.turnClaim
                        ) {
                          throw new Error("worker child admission identity changed");
                        }
                        return await callAgentToolGatewayRequest(
                          withAgentToolGatewayRuntimeIdentity(request, {
                            kind: "agentRuntime",
                            agentId: identity.agentId,
                            sessionKey: identity.sessionKey,
                            operationalRunInstance: identity.operationalRunInstance,
                            delegatedAuthority: {
                              kind: "worker",
                              ...identity.delegatedAuthority,
                              turnClaim: identity.turnClaim,
                            },
                            executionIdentity: identity.executionIdentityToken,
                            sessionSpawnContext,
                          }),
                        );
                      })
                    : await callAgentToolGatewayRequest(request);
                break;
              } catch (error) {
                if (attempt === 1) {
                  throw new WorkerSessionToolOutcomeUnknownError(error);
                }
              }
            }
            if (!sendResult) {
              throw new WorkerSessionToolOutcomeUnknownError(
                new Error("Cloud child initial task did not return a result"),
              );
            }
            return sendResult;
          },
        });
        const runId = typeof run.runId === "string" ? run.runId : undefined;
        return {
          ...createResponse,
          ...run,
          runStarted: Boolean(runId),
          ...(runId ? { runId } : {}),
        } as T;
      } catch (error) {
        throw error instanceof WorkerSessionToolOutcomeUnknownError
          ? error
          : new WorkerSessionToolOutcomeUnknownError(error);
      }
    };
    const tool = createSessionsSpawnTool({
      agentSessionKey: operation.source.sessionKey,
      requesterTurnRunId: operation.identity.runId ?? undefined,
      requesterAgentIdOverride: operation.source.agentId,
      inheritedToolAllowlist: authorizedTools,
      inheritedToolDenylist: [],
      callGateway: gatewayCall,
      expectedParentSessionId: operation.source.sessionId,
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    const executeSpawn = () =>
      tool.execute(operation.request.toolCallId, {
        task: operation.request.task,
        ...(operation.request.label ? { label: operation.request.label } : {}),
        ...(operation.request.agentId ? { agentId: operation.request.agentId } : {}),
        ...(operation.request.model ? { model: operation.request.model } : {}),
        ...(operation.request.runTimeoutSeconds === undefined
          ? {}
          : { runTimeoutSeconds: operation.request.runTimeoutSeconds }),
        expectsCompletionMessage: false,
        visible: true,
        worktree: true,
      });
    return await executeSpawn();
  };

  const send = async (operation: {
    source: ExactSource;
    identity: WorkerConnectionIdentity;
    target: ExactTarget;
    request: WorkerSessionsSendParams;
    idempotencyKey: string;
    signal?: AbortSignal;
    workerIdentity?: WorkerTurnExecutionIdentity;
  }) => {
    operation.signal?.throwIfAborted();
    exactSource({ identity: operation.identity, placements: params.placements });
    const config = getRuntimeConfig();
    const executeFencedSend = async () => {
      const assertCurrentTarget = () => {
        const target = exactAuthorizedTarget({
          source: operation.source,
          requestedSessionKey: operation.request.sessionKey,
        });
        if (
          target.sessionId !== operation.target.sessionId ||
          target.topologyParent?.sessionKey !== operation.target.topologyParent?.sessionKey ||
          target.topologyParent?.sessionId !== operation.target.topologyParent?.sessionId
        ) {
          throw new Error("Worker sessions_send target incarnation changed");
        }
      };
      assertCurrentTarget();
      const tool = createSessionsSendTool({
        agentSessionKey: operation.source.sessionKey,
        expectedTargetSessionId: operation.target.sessionId,
        idempotencyKey: operation.idempotencyKey,
        config,
        ...(operation.signal ? { signal: operation.signal } : {}),
        callGateway: createWorkerSessionToolGatewayCaller({
          ...(operation.workerIdentity ? { identity: operation.workerIdentity } : {}),
          ...(operation.signal ? { signal: operation.signal } : {}),
        }),
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        operation.workerIdentity?.receiptAuthority();
        try {
          operation.signal?.throwIfAborted();
          exactSource({ identity: operation.identity, placements: params.placements });
          assertCurrentTarget();
          return await tool.execute(operation.request.toolCallId, {
            sessionKey: operation.target.sessionKey,
            message: operation.request.message,
            ...(operation.request.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: operation.request.timeoutSeconds }),
          });
        } catch (error) {
          if (attempt === 1) {
            throw new WorkerSessionToolOutcomeUnknownError(error);
          }
        }
      }
      throw new WorkerSessionToolOutcomeUnknownError(
        new Error("Worker sessions_send did not return a result"),
      );
    };
    const executeWithTopologyFence = async () => {
      if (!operation.target.topologyParent) {
        return await executeFencedSend();
      }
      // Hold the sibling authority's shared-parent incarnation through target admission and delivery.
      return await runWithScopedSessionAccess({
        cfg: config,
        expectedSessionId: operation.target.topologyParent.sessionId,
        targetSessionKey: operation.target.topologyParent.sessionKey,
        ...(operation.signal ? { signal: operation.signal } : {}),
        run: executeFencedSend,
      });
    };
    return await executeWithTopologyFence();
  };

  return async (request: WorkerSessionToolRequest): Promise<WorkerSessionToolResult> => {
    const source = exactSource({ identity: request.identity, placements: params.placements });
    if (request.toolName === "portal") {
      return await executePortal(request);
    }
    if (request.toolName === "github_publish") {
      const assertPublicationAuthority = () => {
        const current = exactSource({ identity: request.identity, placements: params.placements });
        if (!params.placements.isWorkerTurnToolAuthorized(current.turnClaim, request.toolName)) {
          throw new Error("Worker session tool authority changed");
        }
      };
      assertPublicationAuthority();
      request.signal?.throwIfAborted();
      const publication = await params.githubPublication.requestForClaim({
        claim: source.turnClaim,
        sessionKey: source.sessionKey,
        agentId: source.agentId,
        idempotencyKey: request.request.toolCallId,
        ...(request.request.title ? { title: request.request.title } : {}),
        ...(request.request.body ? { body: request.request.body } : {}),
        assertCurrent: assertPublicationAuthority,
      });
      assertPublicationAuthority();
      return { resultJson: serializeResult(jsonResult(publication)) };
    }
    const requestDigest = computeRequestDigest(
      request.toolName === "sessions_spawn"
        ? {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            task: request.request.task,
            label: request.request.label ?? null,
            agentId: request.request.agentId ?? null,
            model: request.request.model ?? null,
            runTimeoutSeconds: request.request.runTimeoutSeconds ?? null,
          }
        : {
            toolName: request.toolName,
            sourceSessionId: source.sessionId,
            sessionKey: request.request.sessionKey,
            message: request.request.message,
            timeoutSeconds: request.request.timeoutSeconds ?? null,
          },
    );
    const started = params.placements.beginWorkerSessionToolOperation({
      claim: source.turnClaim,
      toolName: request.toolName,
      toolCallId: request.request.toolCallId,
      requestDigest,
    });
    if (started.kind === "completed") {
      return { resultJson: started.resultJson };
    }
    if (started.kind === "unknown") {
      return {
        resultJson: serializeResult(
          errorResult(new Error("The prior operation outcome is unknown; it was not replayed")),
        ),
      };
    }
    if (started.kind === "conflict") {
      return {
        resultJson: serializeResult(errorResult(new Error("Worker tool call id was reused"))),
      };
    }
    if (started.kind === "capacity") {
      return {
        resultJson: serializeResult(
          errorResult(new Error("Too many worker session operations are already in progress")),
        ),
      };
    }
    if (started.kind === "unauthorized") {
      throw new Error("Worker session tool authority changed");
    }
    const sourceClaimId = source.turnClaim.claimId;
    const inFlightKey = `${source.sessionId}\0${sourceClaimId}\0${request.request.toolCallId}`;
    if (started.kind === "in-progress") {
      const existing = inFlight.get(inFlightKey);
      return {
        resultJson:
          (existing ? await existing : undefined) ??
          serializeResult(
            errorResult(new Error("Worker session operation is already in progress")),
          ),
      };
    }
    const completeOperation = (result: unknown, failed = false) => {
      const resultJson = serializeResult(result);
      return params.placements.completeWorkerSessionToolOperation({
        sourceSessionId: source.sessionId,
        sourceClaimId,
        toolCallId: request.request.toolCallId,
        requestDigest,
        resultJson,
        failed,
      })
        ? resultJson
        : serializeResult(errorResult(new Error("Worker session operation lost ownership")));
    };
    const operation = runWithWorkerSessionToolExecutionIdentity({
      agentId: source.agentId,
      claim: source.turnClaim,
      placements: params.placements,
      resolveGatewayContext: params.resolveGatewayContext,
      sessionKey: source.sessionKey,
      run: async (workerIdentity) => {
        let operationRequest = request;
        let result: unknown;
        let failed = false;
        try {
          // Only the elected durable owner runs policy; retries reuse its terminal result.
          const policy = await applyWorkerSessionToolPolicy({ request, source });
          if ("result" in policy) {
            return completeOperation(policy.result);
          }
          operationRequest = policy.request;
          const target =
            operationRequest.toolName === "sessions_send"
              ? exactAuthorizedTarget({
                  source,
                  requestedSessionKey: operationRequest.request.sessionKey,
                  placements: params.placements,
                })
              : undefined;
          let childKey = started.childSessionKey;
          if (operationRequest.toolName === "sessions_spawn" && !childKey) {
            const targetAgentId = normalizeAgentId(
              operationRequest.request.agentId ?? source.agentId,
            );
            childKey = childSessionKey(started.operationSeed, targetAgentId);
            if (
              !params.placements.bindWorkerSessionToolOperationChild({
                sourceSessionId: source.sessionId,
                sourceClaimId,
                toolCallId: operationRequest.request.toolCallId,
                requestDigest,
                childSessionKey: childKey,
              })
            ) {
              throw new Error("Worker child spawn operation changed before execution");
            }
          }
          result =
            operationRequest.toolName === "sessions_spawn"
              ? await spawn({
                  source,
                  identity: operationRequest.identity,
                  request: operationRequest.request,
                  operationSeed: started.operationSeed,
                  childSessionKey: childKey!,
                  ...(operationRequest.signal ? { signal: operationRequest.signal } : {}),
                  ...(workerIdentity ? { workerIdentity } : {}),
                })
              : await send({
                  source,
                  identity: operationRequest.identity,
                  target: target!,
                  request: operationRequest.request,
                  idempotencyKey: `worker-session-send:${operationKey(
                    started.operationSeed,
                    "target-send",
                  )}`,
                  ...(operationRequest.signal ? { signal: operationRequest.signal } : {}),
                  ...(workerIdentity ? { workerIdentity } : {}),
                });
        } catch (error) {
          if (
            error instanceof WorkerSessionToolOutcomeUnknownError ||
            operationRequest.signal?.aborted
          ) {
            if (
              !params.placements.abandonWorkerSessionToolOperation({
                sourceSessionId: source.sessionId,
                sourceClaimId,
                toolCallId: operationRequest.request.toolCallId,
                requestDigest,
              })
            ) {
              return serializeResult(
                errorResult(new Error("Worker session operation lost ownership")),
              );
            }
            return serializeResult(
              errorResult(
                error instanceof WorkerSessionToolOutcomeUnknownError
                  ? error
                  : new Error("Worker session operation outcome is unknown after cancellation"),
              ),
            );
          }
          failed = true;
          result = errorResult(error);
        }
        return completeOperation(result, failed);
      },
    });
    inFlight.set(inFlightKey, operation);
    try {
      return { resultJson: await operation };
    } finally {
      if (inFlight.get(inFlightKey) === operation) {
        inFlight.delete(inFlightKey);
      }
    }
  };
}
