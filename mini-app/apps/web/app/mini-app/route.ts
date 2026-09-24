export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return Response.redirect(new URL("/t/world", request.url), 307);
}

