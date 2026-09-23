import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const deadlineMessage = "The request took too long. Check your connection and try again.";

describe("mini-app request deadline", () => {
  it("rejects a stalled request and aborts its transport", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => {
      signal = init.signal!;
      return new Promise(() => {});
    }));
    const result = api("world", "/summary").catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ message: deadlineMessage });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while the response body is stalled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })));
    const result = api("world", "/portfolio").catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ message: deadlineMessage });
  });

  it("preserves caller cancellation and its reason during body loading", async () => {
    const caller = new AbortController();
    const reason = new DOMException("View closed", "AbortError");
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      signal = init.signal!;
      return { ok: true, json: () => new Promise(() => {}) };
    }));
    const result = api("world", "/summary", { signal: caller.signal }).catch((error) => error);
    await Promise.resolve();
    caller.abort(reason);
    expect(await result).toBe(reason);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send an already cancelled request", async () => {
    const caller = new AbortController();
    caller.abort(new DOMException("View closed", "AbortError"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(api("world", "/summary", { signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry a timed-out write or claim that it failed", async () => {
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const result = api("world", "/watches", { method: "POST", body: "{}" }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ message: "The request timed out. Refresh to check whether it completed." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns successful data and clears its timer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mapped: true }))));
    expect(await api("world", "/summary")).toEqual({ mapped: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
