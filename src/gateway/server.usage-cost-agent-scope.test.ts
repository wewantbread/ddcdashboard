import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withGatewayClient } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway usage.cost agent scope", () => {
  it("rejects combining agentScope=all with agentId", async () => {
    await withGatewayClient(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq(ws, "usage.cost", {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        agentId: "main",
        agentScope: "all",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "agentScope=all cannot be combined with key or agentId",
      );
    });
  });

  it("still aggregates when agentScope=all is sent without agentId", async () => {
    await withGatewayClient(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq<{ totals?: { totalTokens?: number } }>(ws, "usage.cost", {
        startDate: "2026-02-01",
        endDate: "2026-02-02",
        agentScope: "all",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.totals).toEqual(expect.any(Object));
    });
  });
});
