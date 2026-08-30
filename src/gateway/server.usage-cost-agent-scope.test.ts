import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withGatewayClient } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway usage.cost agent scope", () => {
  it("rejects combining agentScope=all with agentId and still aggregates when agentScope=all is sent without agentId", async () => {
    await withGatewayClient(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const conflict = await rpcReq(ws, "usage.cost", {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        agentId: "main",
        agentScope: "all",
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.error?.message ?? "").toContain(
        "agentScope=all cannot be combined with key or agentId",
      );

      const allAgents = await rpcReq<{ totals?: { totalTokens?: number } }>(ws, "usage.cost", {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        agentScope: "all",
      });
      expect(allAgents.ok).toBe(true);
      expect(allAgents.payload?.totals).toEqual(expect.any(Object));
    });
  });
});
