import { engineForward } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FORWARDED_QUERY = ["all", "since"];

export async function GET(request: Request) {
  const query = new URLSearchParams();
  const incoming = new URL(request.url).searchParams;
  for (const name of FORWARDED_QUERY) {
    const value = incoming.get(name);
    if (value !== null) query.set(name, value);
  }
  const search = query.size > 0 ? `?${query}` : "";
  return engineForward(request, `/v2/sessions/live${search}`);
}
