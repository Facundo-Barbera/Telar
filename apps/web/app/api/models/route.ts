import { accountEnv, getAccount, getDefaultAccountName } from "@telar/core";
import { fetchModels } from "@/lib/model-registry";
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL } from "@/lib/models";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") === "codex" ? "codex" : "claude";

  const env = accountEnv(getAccount(getDefaultAccountName()));
  const models = await fetchModels(provider, env);

  return Response.json({
    models,
    default: provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
  });
}
