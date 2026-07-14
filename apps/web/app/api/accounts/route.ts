import { z } from "zod";
import {
  AccountProfile,
  accountHealth,
  getDefaultAccountName,
  listAccounts,
  upsertAccount,
} from "@telar/core";

export const dynamic = "force-dynamic";

// The registry holds no secrets (tokens live in credentials.json), so the whole
// profile list is safe to hand to the local UI. Each account is enriched with
// its on-disk liveness (accountHealth) so the UI can show a real Logged-in /
// Not-on-this-machine / Unknown badge instead of guessing.
export async function GET() {
  const accounts = listAccounts().map((a) => ({ ...a, health: accountHealth(a) }));
  return Response.json({ accounts, default: getDefaultAccountName() });
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
  return Response.json({ account: upsertAccount(parsed.data) });
}
