import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  verify: vi.fn(), fetch: vi.fn(), resolveAccount: vi.fn(),
}));
vi.mock("@aomi-telegram/core", () => ({ verifyTelegramInitData: fixture.verify }));
vi.mock("../lib/server.ts", () => ({
  tenants: new Map([["world", { adapter: { resolveAccount: fixture.resolveAccount } }]]),
}));
import { authorize } from "../lib/auth.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TELEGRAM_BOT_ID", "bot-1");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "worldbot");
  vi.stubEnv("AOMI_TELEGRAM_BINDING_URL", "https://api.aomi.test/binding");
  fixture.verify.mockReturnValue({ ok: true, launch: { telegramUserId: "123" } });
  fixture.fetch.mockResolvedValue(Response.json({ binding: null }));
  vi.stubGlobal("fetch", fixture.fetch);
});

describe("canonical mini-app authorization", () => {
  it("rejects invalid Telegram identity before canonical lookup", async () => {
    fixture.verify.mockReturnValue({ ok: false, reason: "invalid signature" });
    await expect(authorize(new Request("https://mini.example/api/t/world/portfolio"), "world")).rejects.toMatchObject({ status: 401 });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("derives the subject from verified initData, ignoring caller account and user parameters", async () => {
    fixture.fetch.mockResolvedValue(Response.json({ binding: { account_id: "42", owner_address: "0x1111111111111111111111111111111111111111", chain_id: 1, state: "active" } }));
    fixture.resolveAccount.mockResolvedValue({ accountId: 42n });
    await authorize(new Request("https://mini.example/api/t/world/portfolio?telegram_user_id=999&account_id=victim", { headers: { "x-telegram-init-data": "signed-launch" } }), "world");
    expect(fixture.verify).toHaveBeenCalledWith("signed-launch", "bot-1");
    expect(fixture.fetch).toHaveBeenCalledWith(
      "https://api.aomi.test/binding",
      expect.objectContaining({ body: JSON.stringify({ telegram_user_id: "123" }) }),
    );
    expect(fixture.resolveAccount).toHaveBeenCalledWith(expect.objectContaining({ accountId: "42" }));
  });
  it("does not read venue data while unclaimed or after revocation", async () => {
    expect(await authorize(new Request("https://mini.example"), "world")).toMatchObject({ binding: null, account: null });
    expect(fixture.resolveAccount).not.toHaveBeenCalled();
  });
  it("does not fall back to venue data when the canonical lookup fails", async () => {
    fixture.fetch.mockRejectedValue(new Error("unavailable"));
    await expect(authorize(new Request("https://mini.example"), "world")).rejects.toThrow("unavailable");
    expect(fixture.resolveAccount).not.toHaveBeenCalled();
  });
});
