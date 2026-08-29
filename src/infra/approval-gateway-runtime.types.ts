import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import type { ApprovalRequest, ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";

export type GatewayApprovalRequest = ApprovalRequest;
export type GatewayApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

export type GatewayApprovalEventSubscriber = {
  eventKinds: ReadonlySet<ChannelApprovalKind>;
  shouldHandle: (request: GatewayApprovalRequest) => boolean;
  onRequested: (request: GatewayApprovalRequest) => void;
  onResolved: (resolved: GatewayApprovalResolved) => void;
};

export type GatewayNativeApprovalDeliveryReceiptKey = {
  approvalId: string;
  channel: string;
  accountId: string;
  targetKey: string;
};

/** Gateway-owned durable delivery state; intentionally not part of the public protocol. */
export type GatewayNativeApprovalDeliveryReceipts = {
  read: (key: GatewayNativeApprovalDeliveryReceiptKey) => unknown | null;
  write: (key: GatewayNativeApprovalDeliveryReceiptKey, entry: unknown) => void;
  remove: (key: GatewayNativeApprovalDeliveryReceiptKey) => void;
};

/** Gateway-owned authority and event transport for channel-native approval runtimes. */
export type GatewayNativeApprovalRuntime = {
  request: <T = unknown>(
    method: GatewayNativeApprovalMethod,
    params: Record<string, unknown>,
    options?: { clientDisplayName?: string },
  ) => Promise<T>;
  requestRoute: <T = unknown>(method: "send", params: Record<string, unknown>) => Promise<T>;
  deliveryReceipts?: GatewayNativeApprovalDeliveryReceipts;
  routeCoordinator: ApprovalNativeRouteCoordinator;
  subscribe: (subscriber: GatewayApprovalEventSubscriber) => () => void;
};
