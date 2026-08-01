import { accountEnv, getAccount, getDefaultAccountName } from "@telar/core";
import { fetchModels } from "@/lib/model-registry";
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL } from "@/lib/models";

export const dynamic = "force-dynamic";

// The live model catalog for a provider, resolved THROUGH AN ACCOUNT.
//
// The account matters because it decides the endpoint: a proxy-routed account
// carries a gateway base URL, and that gateway serves a different — usually
// larger, cross-harness — catalog than the provider does directly. Asking with
// the default account's env and handing the answer to a proxied session would
// offer models that session cannot reach, and hide the ones it can.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") === "codex" ? "codex" : "claude";
  // Unknown/absent account falls back to the default — the old behavior, kept
  // so every existing caller keeps working without passing the parameter.
  const requested = searchParams.get("account");
  const account = (requested && getAccount(requested)) || getAccount(getDefaultAccountName());

  const env = accountEnv(account);
  // A pinned account sees only the models of the upstream it is pinned to.
  const models = await fetchModels(provider, env, { prefix: account?.proxy?.prefix });

  return Response.json({
    models,
    default: provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
    // Named so a surface can say WHERE this catalog came from rather than
    // implying every account sees the same list.
    account: account?.name ?? null,
    proxied: Boolean(account?.proxy),
    prefix: account?.proxy?.prefix ?? null,
  });
}
