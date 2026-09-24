export const dynamic = "force-dynamic";

// /wallet opens this URL with ?bot_id=&session_id=; keep the query so the
// home screen sees the same launch context the command views do.
export function GET(request: Request): Response {
  const target = new URL("/t/world", request.url);
  target.search = new URL(request.url).search;
  return Response.redirect(target, 307);
}

