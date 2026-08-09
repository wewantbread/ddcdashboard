import { createDeferred } from "../shared/deferred.js";

export type RuntimeConfigWriteApplicationOutcome =
  | { status: "applied" }
  | { status: "restart-required" }
  | { status: "reload-disabled" }
  | { status: "writer-intent" }
  | { status: "superseded" }
  | { status: "failed" }
  | { status: "stopped" };

export type RuntimeConfigWriteApplicationClaim = {
  /** RPC-owned restarts cannot begin until the persisted-write response is delivered. */
  responseAcknowledged: Promise<void>;
  /** Shared-auth eviction stays with the RPC's post-response follow-up when true. */
  deferSharedAuthDisconnect: boolean;
  settle: (outcome: RuntimeConfigWriteApplicationOutcome) => void;
};

type RuntimeConfigWriteApplication = {
  result: Promise<RuntimeConfigWriteApplicationOutcome>;
  claimed: boolean;
  claim: () => RuntimeConfigWriteApplicationClaim | null;
  acknowledgeResponse: () => void;
};

const runtimeConfigWriteApplication = Symbol("runtimeConfigWriteApplication");

export function createRuntimeConfigWriteApplication(options?: {
  deferSharedAuthDisconnect?: boolean;
}): RuntimeConfigWriteApplication {
  let claimed = false;
  const result = createDeferred<RuntimeConfigWriteApplicationOutcome>();
  const response = createDeferred();
  return {
    result: result.promise,
    get claimed() {
      return claimed;
    },
    claim: () => {
      if (claimed) {
        return null;
      }
      claimed = true;
      return {
        responseAcknowledged: response.promise,
        deferSharedAuthDisconnect: options?.deferSharedAuthDisconnect === true,
        // Promise resolution is idempotent, so repeated lifecycle cleanup cannot double-settle.
        settle: result.resolve,
      };
    },
    acknowledgeResponse: () => response.resolve(),
  };
}

type RuntimeConfigWriteApplicationCarrier = {
  [runtimeConfigWriteApplication]?: RuntimeConfigWriteApplication;
};

export function attachRuntimeConfigWriteApplication<T extends object>(
  target: T,
  application: RuntimeConfigWriteApplication | undefined,
): T {
  return Object.assign(target, application ? { [runtimeConfigWriteApplication]: application } : {});
}

export function getRuntimeConfigWriteApplication(
  target: object,
): RuntimeConfigWriteApplication | undefined {
  return (target as RuntimeConfigWriteApplicationCarrier)[runtimeConfigWriteApplication];
}
