import { json, route } from "@/lib/auth.ts";

export const GET = route(async ({ tenant }) => json({ products: await tenant.adapter.products() }));
