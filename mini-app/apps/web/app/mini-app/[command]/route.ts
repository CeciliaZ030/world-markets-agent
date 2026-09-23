import { world } from "@aomi-telegram/tenant-world";
import { runTenantCommand } from "../../../lib/tenant-command.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ command: string }> }): Promise<Response> {
  const { command } = await context.params;
  try {
    return await runTenantCommand(request, command, world);
  } catch (error) {
    console.error(JSON.stringify({ event: "tenant.command_error", command, error: String(error) }));
    return Response.json({ error: "lookup_unavailable" }, { status: 502 });
  }
}

export async function GET(request: Request, context: { params: Promise<{ command: string }> }): Promise<Response> {
  const { command } = await context.params;
  const routes: Record<string, string> = {
    portfolio: "/t/world/portfolio",
    chart: "/t/world/chart",
    ledger: "/t/world/ledger",
    signing: "/t/world",
  };
  const destination = routes[command];
  if (!destination) return new Response("Not found", { status: 404 });
  const target = new URL(destination, request.url);
  target.search = new URL(request.url).search;
  return Response.redirect(target, 307);
}

