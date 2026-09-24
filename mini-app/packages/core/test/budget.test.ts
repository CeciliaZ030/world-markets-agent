import { describe, expect, it } from "vitest";
import { BudgetError, enforceBudget } from "../src/index.ts";

describe("budget", () => {
  it("passes text at or under budget", () => {
    expect(enforceBudget("b", "Portfolio 1,204.10.", 60)).toBe("Portfolio 1,204.10.");
  });
  it("counts code points, not UTF-16 units", () => {
    expect(() => enforceBudget("p", "◆".repeat(60), 60)).not.toThrow();
  });
  it("counts visible characters, not HTML tags", () => {
    expect(() => enforceBudget("b", "<b>Portfolio</b> <code>$1.00</code>.", 17)).not.toThrow();
  });
  it("throws instead of trimming", () => {
    expect(() => enforceBudget("b", "x".repeat(61), 60)).toThrow(BudgetError);
  });
});
