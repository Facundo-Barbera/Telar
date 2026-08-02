import { z } from "zod";
import {
  upsertAccount,
} from "@telar/core/accounts";
import { AccountProfile } from "@telar/core/schemas";
import { readAccountsEnvelope } from "@/lib/accounts-server";

export const dynamic = "force-dynamic";

// One account = one provider instance. The registry holds no secrets (tokens
// live in credentials.json), so the profile list is safe to hand to the local
// UI — with one exception handled below: a SENSITIVE env var's value never
// leaves the server. Each account is enriched with
//   · health   — on-disk liveness (accountHealth), the status dot
//   · isMain   — the one account Telar detects rather than the user adding
//   · identity — who is signed in, read from Claude's .claude.json profile
//                block (a config file, never a credential)
//   · signInHint — the command to run in a terminal if it isn't signed in
export async function GET() {
  return Response.json(readAccountsEnvelope());
}

// Account names key the secret store and can seed a config-dir path, so keep
// them to a filesystem-safe alphabet.
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = AccountProfile.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  if (!NAME_RE.test(parsed.data.name)) {
    return Response.json(
      { error: "Account name may only contain letters, numbers, dot, dash, or underscore." },
      { status: 400 },
    );
  }
  // upsertAccount enforces the adoption rules (a Claude account needs its own
  // existing config folder, ~/.claude is reserved for the main login, Codex is
  // single-account for now) and moves sensitive env values into the secret
  // store. Those messages are written for the user, so they are handed back
  // verbatim as a 400 rather than collapsed into a generic one.
  try {
    return Response.json({ account: upsertAccount(parsed.data) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
