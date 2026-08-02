import { resolveEnabledAccount } from "@telar/core/accounts";
import { accountEnv } from "@telar/core/engine";
import { providerOf } from "@telar/core/providers";
import { fetchModels } from "@/lib/model-registry";
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL, modelsForProvider } from "@/lib/models";

export const dynamic = "force-dynamic";

// The live model catalog for a provider, resolved THROUGH AN ACCOUNT.
//
// The account matters because its resolved runtime environment decides the
// endpoint. The native Claude account may inherit a gateway from ~/.claude;
// isolated config-dir accounts deliberately do not.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") === "codex" ? "codex" : "claude";
  const requested = searchParams.get("account");
  const account = resolveEnabledAccount(requested || undefined, provider);
  if (!account) {
    return Response.json({
      models: [],
      default: provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
      account: null,
      available: false,
      proxied: false,
      source: "unavailable",
    });
  }

  const env = accountEnv(account);
  // Model vocabulary belongs to the HARNESS, not to an optional transport.
  // Claude accepts its native slots here; ~/.claude may map those slots to any
  // concrete model the user's router supports. Feeding a gateway's raw model
  // inventory into this picker exposed bare GPT ids that Claude could not
  // actually start. Codex owns a local models cache, so that remains its
  // authoritative selectable catalog.
  const models =
    provider === "claude"
      ? modelsForProvider("claude")
      : await fetchModels("codex", env);

  return Response.json({
    models,
    default: provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
    // Named so a surface can say WHERE this catalog came from rather than
    // implying every account sees the same list.
    account: account?.name ?? null,
    available: true,
    proxied: Boolean(env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL),
    source: providerOf(provider).modelCatalog,
  });
}
