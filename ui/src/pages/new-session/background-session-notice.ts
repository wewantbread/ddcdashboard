import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";

type AgentWaitResult = {
  status?: "error" | "ok" | "pending" | "timeout";
  endedAt?: number;
  error?: string;
  providerStarted?: boolean;
  stopReason?: string;
};

const RETRY_DELAY_MS = 1_000;

const delayRetry = () =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, RETRY_DELAY_MS);
  });

export async function notifyWhenBackgroundSessionEnds(params: {
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
  key: string;
  runId: string;
}): Promise<void> {
  let result: AgentWaitResult | undefined;
  while (!result) {
    try {
      const observed = await params.client.request<AgentWaitResult>(
        "agent.wait",
        { runId: params.runId, timeoutMs: 30_000 },
        { timeoutMs: null },
      );
      if (params.context.gateway.snapshot.client !== params.client) {
        return;
      }
      const observationalTimeout =
        observed.status === "timeout" &&
        observed.endedAt === undefined &&
        !observed.error &&
        !observed.stopReason &&
        observed.providerStarted !== true;
      if (observed.status === "pending" || observationalTimeout) {
        await delayRetry();
      } else {
        result = observed;
      }
    } catch {
      return;
    }
  }

  const gateway = params.context.gateway.snapshot;
  if (
    uiSessionEventMatches(
      { ...gateway, sessionKey: gateway.sessionKey },
      params.key,
      params.agentId,
    )
  ) {
    return;
  }
  const row = params.context.sessions.state.result?.sessions.find(
    (session) => session.key === params.key,
  );
  const status =
    result.status === "ok"
      ? t("sessionsView.statusDone")
      : result.status === "timeout"
        ? t("sessionsView.statusTimeout")
        : result.stopReason === "rpc"
          ? t("sessionsView.statusKilled")
          : t("sessionsView.statusFailed");
  showToast({
    fifo: true,
    message: `${resolveSessionDisplayName(params.key, row)}: ${status}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () => {
      selectApplicationSession({
        selection: params.context.agentSelection,
        gateway: params.context.gateway,
        sessionKey: params.key,
        agentId: params.agentId,
      });
      params.context.navigate(
        "chat",
        sessionNavigationTarget({
          context: params.context,
          face: "chat",
          sessionKey: params.key,
          agentId: params.agentId,
        }).options,
      );
    },
  });
}
