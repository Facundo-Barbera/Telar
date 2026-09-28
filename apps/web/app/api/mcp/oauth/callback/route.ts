import { redirect } from "next/navigation";
import { engineClient } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FORWARDED_QUERY = ["state", "code", "error", "error_description"];

export async function GET(request: Request) {
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of FORWARDED_QUERY) {
    const value = incoming.get(name);
    if (value !== null) query.set(name, value);
  }
  let target: string;
  try {
    target = (await (await engineClient()).mcpOAuthCallback(query.toString())).redirect;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The sign-in could not be completed.";
    target = `/settings?${new URLSearchParams({ section: "tools", mcpOAuthError: message })}`;
  }
  redirect(target);
}
