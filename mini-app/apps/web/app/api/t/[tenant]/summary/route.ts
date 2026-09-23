import { json, route } from "@/lib/auth.ts";
import { buildSummary } from "@/lib/summary.ts";

export const GET = route(async (auth) => json(await buildSummary(auth)));
