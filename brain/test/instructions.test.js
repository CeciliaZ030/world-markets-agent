import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aomi-ledger-"));
process.env.WORLD_BRAIN_DIR = dir;

import {
  composeDraft,
  confirmInstruction,
  getInstruction,
  listInstructions,
  pauseInstruction,
  resumeInstruction,
  summary,
  transition,
} from "../src/instructions.js";

test("compose creates with_aomi and questions do not", () => {
  const account = "17";
  const recorded = composeDraft(account, {
    kind: "conditional",
    message: "If ETH touches 3400, close half the perp",
    correlation_id: "c-1",
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.instruction.status, "with_aomi");
  const q = composeDraft(account, { kind: "question", message: "Walk me through ETH" });
  assert.equal(q.recorded, false);
  const listed = listInstructions(account);
  assert.equal(listed.filter((row) => row.status === "with_aomi").length, 1);
});

test("double compose with the same id does not duplicate", () => {
  const account = "18";
  const first = composeDraft(account, {
    instruction_id: "same-id",
    kind: "watch",
    message: "If funding turns positive, tell me",
    correlation_id: "c-2",
  });
  const second = composeDraft(account, {
    instruction_id: "same-id",
    kind: "watch",
    message: "If funding turns positive, tell me",
    correlation_id: "c-2",
  });
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(listInstructions(account).length, 1);
});

test("confirm then pause then resume is the only legal path", () => {
  const account = "19";
  const drafted = composeDraft(account, {
    kind: "watch",
    message: "If ETH drops 5% in a day, tell me",
    correlation_id: "c-3",
  });
  const id = drafted.instruction.instruction_id;
  confirmInstruction(account, {
    instruction_id: id,
    watch_id: "w-1",
    confirm_ref: "w-1",
  });
  assert.equal(getInstruction(account, id).status, "watching");
  pauseInstruction(account, id);
  assert.equal(getInstruction(account, id).status, "paused");
  resumeInstruction(account, id);
  assert.equal(getInstruction(account, id).status, "watching");
  assert.throws(() => {
    const item = { status: "done" };
    transition(item, "watching", 1);
  });
});

test("summary holding counts needs-you and heartbeat fields", () => {
  const account = "20";
  composeDraft(account, {
    kind: "conditional",
    message: "Roll the lend at maturity",
    correlation_id: "c-4",
  });
  const got = summary(account);
  assert.equal(got.holding, 1);
  assert.equal(got.needs_you, 1);
  assert.equal(got.last_check_at, null);
});

test("pause without a watching row fails", () => {
  const account = "21";
  const drafted = composeDraft(account, {
    kind: "watch",
    message: "If ETH touches 2000, tell me",
    correlation_id: "c-5",
  });
  assert.throws(() => pauseInstruction(account, drafted.instruction.instruction_id));
});
