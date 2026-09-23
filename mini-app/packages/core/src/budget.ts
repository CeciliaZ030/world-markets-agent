export class BudgetError extends Error {
  constructor(
    readonly command: string,
    readonly budget: number,
    readonly length: number,
  ) {
    super(`${command}: rendered ${length} visible chars, budget is ${budget}`);
  }
}

/** Characters a reader sees: HTML tags stripped, entities counted as one. */
export function visibleLength(html: string): number {
  return [...html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, "x")].length;
}

/** Enforce a command's character budget on the visible text. Over budget is an error, never a trim. */
export function enforceBudget(command: string, html: string, budget: number): string {
  const length = visibleLength(html);
  if (length > budget) throw new BudgetError(command, budget, length);
  return html;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
