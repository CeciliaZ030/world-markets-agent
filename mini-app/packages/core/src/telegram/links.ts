/**
 * Opens the bot chat with `text` pre-entered in the input bar. The user still
 * presses send, which is the consent moment. Telegram documents `?text=` for
 * username links; behaviour on bot usernames is verified in M0.
 */
export function draftLink(botUsername: string, text: string): string {
  return `https://t.me/${botUsername}?text=${encodeURIComponent(text)}`;
}

/** Deep link that delivers `/start <param>` to the bot. Param is at most 64 base64url chars. */
export function startLink(botUsername: string, param: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(param)) throw new Error("start param must be 1-64 base64url chars");
  return `https://t.me/${botUsername}?start=${param}`;
}

export function miniAppUrl(publicWebUrl: string, tenant: string, view: string, query: Record<string, string> = {}): string {
  const url = new URL(`/t/${tenant}${view ? `/${view}` : ""}`, publicWebUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}
