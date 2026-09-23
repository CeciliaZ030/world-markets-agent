import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dataCheckString, verifyTelegramInitData } from "../src/index.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const botId = "8184083135";

function initData(fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const sig = sign(null, Buffer.from(dataCheckString(params, botId), "utf8"), privateKey);
  params.set("signature", sig.toString("base64url"));
  return params.toString();
}

describe("initData", () => {
  const now = 1_800_000_000_000;
  it("accepts a fresh signed launch and reads the user and start_param", () => {
    const data = initData({ auth_date: String(now / 1000 - 10), user: JSON.stringify({ id: 42 }), start_param: "i_9" });
    expect(verifyTelegramInitData(data, botId, { now, publicKeyHex })).toEqual({ ok: true, launch: { botId, telegramUserId: "42", startParam: "i_9" } });
  });
  it("rejects a tampered field", () => {
    const data = initData({ auth_date: String(now / 1000 - 10), user: JSON.stringify({ id: 42 }) }).replace("%22id%22%3A42", "%22id%22%3A43");
    expect(verifyTelegramInitData(data, botId, { now, publicKeyHex })).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects a day-old launch", () => {
    const data = initData({ auth_date: String(now / 1000 - 90_000), user: JSON.stringify({ id: 42 }) });
    expect(verifyTelegramInitData(data, botId, { now, publicKeyHex })).toEqual({ ok: false, reason: "expired" });
  });
});
