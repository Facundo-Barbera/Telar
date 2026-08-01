import {
  detectProviders,
  listAccounts,
  readProviderCache,
  writeProviderCache,
  type ProviderId,
  type ProviderStatus,
} from "@telar/core";
import { readPlanUsage } from "@/lib/store";

export const dynamic = "force-dynamic";

// Provider detection, the surface that replaced in-app login. GET serves the
// last cached answer (detection spawns a subprocess per provider, so it is not
// something to redo on every paint); POST re-probes.
//
// The plan a provider is signed in as is NOT probed here — it is read off the
// usage snapshots we already capture for the meters (Claude's subscription_type
// from the SDK handshake, Codex's plan_type from its rollout payload). That
// keeps detection to one `--version` call per provider and keeps this route
// away from anything that could read a credential.

function planTypes(): Partial<Record<ProviderId, string | null>> {
  const plan = readPlanUsage();
  const out: Partial<Record<ProviderId, string | null>> = {};
  // Newest snapshot wins per provider: with several Claude accounts, the plan
  // shown for the PROVIDER should be the one we most recently confirmed.
  const newest: Partial<Record<ProviderId, number>> = {};
  for (const account of listAccounts()) {
    const snap = plan[account.name];
    if (!snap?.subscriptionType) continue;
    const id = (account.provider ?? "claude") as ProviderId;
    if ((newest[id] ?? -1) >= snap.capturedAt) continue;
    newest[id] = snap.capturedAt;
    out[id] = snap.subscriptionType;
  }
  return out;
}

async function detect(): Promise<ProviderStatus[]> {
  const providers = await detectProviders(planTypes());
  writeProviderCache(providers);
  return providers;
}

export async function GET() {
  const cached = readProviderCache();
  // Nothing cached yet (first run) → probe once so the surface has something
  // real to render instead of an empty state that needs a manual click.
  return Response.json({ providers: cached.length ? cached : await detect() });
}

export async function POST() {
  return Response.json({ providers: await detect() });
}
