import { createHmac } from "node:crypto";
import type { Tenant } from "@aomi-telegram/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTenantCommand } from "../lib/tenant-command.ts";

const tenant: Tenant<{ id: string }> = {
  id: "world",
  adapter: {
    resolveAccount: async (binding) => ({ id: binding.accountId }),
    portfolio: async () => { throw new Error("unused"); },
    positions: async () => { throw new Error("unused"); },
    openOrders: async () => [],
    fills: async () => [],
    markPrice: async () => "1",
    riskBand: async () => ({ score: 0, band: "safe" }),
    products: async () => [],
    chart: async () => [],
  },
  commands: [{
    name: "b",
    description: "balance",
    budget: 60,
    render: async ({ account, miniAppUrl }) => ({
      text: account?.id ?? "unmapped",
      context: { accountId: account?.id ?? null },
      button: { text: "Open", url: miniAppUrl("portfolio") },
    }),
  }],
  watches: [],
  copy: { unmapped: "unmapped", renderFailed: "failed", title: "World", tagline: "" },
  compose: {
    buy: () => "", sell: () => "", long: () => "", short: () => "", lend: () => "", cancelOrder: () => "",
  },
};

function signedRequest(body: object, timestamp = Math.floor(Date.now() / 1_000).toString()): Request {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", "test-secret").update(timestamp).update(".").update(raw).digest("hex");
  return new Request("https://api.world.inc/mini-app/b", {
    method: "POST",
    body: raw,
    headers: { "content-type": "application/json", "x-aomi-timestamp": timestamp, "x-aomi-signature": `sha256=${signature}` },
  });
}

const body = {
  application: { id: 1, name: "world" },
  thread_id: "thread-1",
  command: "b",
  arguments: "",
  args: [],
  binding: { account_ref: "21", chain_id: 2092151908, owner_address: "0x1111111111111111111111111111111111111111" },
  telegram: { user_id: "42", chat_id: "42", message_id: 1 },
};

describe("tenant command endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("verifies Aomi and renders through the tenant adapter", async () => {
    vi.stubEnv("AOMI_TELEGRAM_TENANT_SECRET", "test-secret");
    const response = await runTenantCommand(signedRequest(body), "b", tenant);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "21",
      context: { accountId: "21" },
      button: { text: "Open", url: "https://api.world.inc/mini-app/portfolio" },
    });
  });

  it("rejects unsigned and stale requests", async () => {
    vi.stubEnv("AOMI_TELEGRAM_TENANT_SECRET", "test-secret");
    expect((await runTenantCommand(new Request("https://api.world.inc/mini-app/b", { method: "POST", body: JSON.stringify(body) }), "b", tenant)).status).toBe(401);
    expect((await runTenantCommand(signedRequest(body, "1"), "b", tenant)).status).toBe(401);
  });
});

