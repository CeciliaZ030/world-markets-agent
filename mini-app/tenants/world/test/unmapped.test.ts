import { describe, expect, it } from "vitest";
import { enforceBudget } from "@aomi-telegram/core";
import { world } from "../src/index.ts";

describe("unlinked World commands", () => {
  for (const name of ["b", "p", "r", "a", "d"]) {
    it(`/${name} delivers setup guidance within its message budget`, async () => {
      const command = world.commands.find((item) => item.name === name)!;
      const reply = await command.render({
        binding: null, account: null, args: [], chatId: "1",
        message: { message_id: 1, date: 0, chat: { id: 1, type: "private" } },
        miniAppUrl: () => null,
      });
      expect(reply.text).toContain("World Markets");
      expect(() => enforceBudget(name, reply.text, command.budget)).not.toThrow();
    });
  }
});
