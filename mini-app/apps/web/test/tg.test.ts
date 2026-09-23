import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("Telegram launch authentication without SDK blocking hydration", () => {
  it("reads the exact signed launch payload before the remote SDK is available", async () => {
    const payload = 'user=%7B%22id%22%3A4242%7D&auth_date=123&signature=a_b-c&hash=abc';
    vi.stubGlobal("window", { location: { hash: '#tgWebAppData=' + encodeURIComponent(payload) + '&tgWebAppVersion=8.0' } });
    const { initData } = await import("../lib/tg.ts");
    expect(initData()).toBe(payload);
    window.location.hash = "";
    expect(initData()).toBe(payload);
  });

  it("prefers the SDK payload when it becomes available", async () => {
    vi.stubGlobal("window", { location: { hash: '#tgWebAppData=old' }, Telegram: { WebApp: { initData: 'current' } } });
    const { initData } = await import("../lib/tg.ts");
    expect(initData()).toBe('current');
  });

  it("does not treat unsigned user or start parameters as authentication", async () => {
    vi.stubGlobal("window", { location: { hash: '#tgWebAppStartParam=account21&user=4242' } });
    const { initData } = await import("../lib/tg.ts");
    expect(initData()).toBe('');
  });
});
