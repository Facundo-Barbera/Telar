import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/features/remote/server";

export const config = {
  matcher: ["/api/:path*", "/((?!pair|_next/static|_next/image|favicon.ico).*)"],
};

const DENIALS = {
  cockpit_forbidden: { status: 403, message: "This device is paired for viewing only. Give it full access from Remote access on the Mac." },
  cockpit_unauthorized: { status: 401, message: "Pair this device with the Telar cockpit to use it." },
} as const;

/** The engine decides; an engine that cannot answer denies. */
export async function proxy(request: NextRequest): Promise<Response | undefined> {
  const { pathname } = request.nextUrl;
  let decision;
  try {
    decision = await decideAccess(request, pathname);
  } catch {
    return Response.json({ error: { code: "engine_unavailable", message: "The engine is not answering." } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (decision.allow) return undefined;
  if (decision.code === "cockpit_unauthorized" && !pathname.startsWith("/api/")) return NextResponse.redirect(new URL("/pair", request.url));
  const denial = DENIALS[decision.code];
  return Response.json({ error: { code: decision.code, message: denial.message } }, { status: denial.status, headers: { "cache-control": "no-store" } });
}
