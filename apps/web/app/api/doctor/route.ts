import { runDoctor } from "@/lib/server/doctor";

export const dynamic = "force-dynamic";

// The machine-readiness report — driver binaries, GitHub auth, provider account
// liveness, the verifier's browser, and the active TELAR_HOME. Read-only; the
// server lib never runs a login flow, reads a credential, or prints a token.
export async function GET() {
  return Response.json(await runDoctor());
}
