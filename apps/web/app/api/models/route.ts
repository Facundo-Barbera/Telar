import { resolveEnabledAccount } from "@telar/core/accounts";
import { accountEnv } from "@telar/core/engine";
import { providerOf } from "@telar/core/providers";
import { getProject } from "@telar/core";
import { fetchModels } from "@/lib/model-registry";
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL } from "@/lib/models";

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
  const project = searchParams.get("project");
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
  let cwd = process.cwd();
  if (project) {
    try {
      cwd = getProject(project).manifest.root;
    } catch {
      // Catalog discovery can still use the harness's global configuration.
    }
  }
  // Both catalogs come from the selected harness. Claude's control protocol
  // resolves configured aliases to concrete versions; Codex owns its local
  // cache. A transport integration never becomes a competing model registry.
  const models = await fetchModels(provider, env, cwd);
  const harnessDefault = models.find((model) => model.isDefault)?.id;

  return Response.json({
    models,
    default: harnessDefault ?? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL),
    // Named so a surface can say WHERE this catalog came from rather than
    // implying every account sees the same list.
    account: account?.name ?? null,
    available: true,
    proxied: Boolean(env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL),
    source: providerOf(provider).modelCatalog,
  });
}
