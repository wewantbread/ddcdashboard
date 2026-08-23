import type { ApplicationContext } from "../../app/context.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import type { SessionPlacementTarget } from "../../lib/sessions/session-placement-recovery.ts";
import { sessionPlacementDispatchParams } from "../../lib/sessions/session-placement-startup.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";

export function readDraftSubmissionAccess(params: {
  createParams: Record<string, unknown>;
  fallbackAgentId: string;
  gateway: ApplicationContext["gateway"]["snapshot"] | undefined;
  pendingPlacement: PendingSessionPlacementRecoveryState;
  remoteProject: { projectId?: string } | null;
  target: SessionPlacementTarget | null;
}): SessionMethodAccess {
  const pendingPlacement = Boolean(params.pendingPlacement.sessionKey);
  if (!pendingPlacement && params.remoteProject && !params.remoteProject.projectId) {
    return readSessionMethodAccess(params.gateway, {
      method: "projects.add",
      requiredScope: "operator.write",
    });
  }
  if (!pendingPlacement || params.pendingPlacement.phase === "creating") {
    const createAccess = readSessionMethodAccess(params.gateway, {
      method: "sessions.create",
      params: params.createParams,
    });
    if (!createAccess.allowed || !params.target) {
      return createAccess;
    }
  }
  if (!params.target) {
    return readSessionMethodAccess(params.gateway, {
      method: "sessions.create",
      params: params.createParams,
    });
  }
  return readSessionMethodAccess(params.gateway, {
    method: "sessions.dispatch",
    requiredScope: params.target.kind === "profile" ? "operator.admin" : "operator.write",
    params: sessionPlacementDispatchParams({
      key: params.pendingPlacement.sessionKey,
      agentId: params.pendingPlacement.agentId || params.fallbackAgentId,
      target: params.target,
    }),
  });
}
