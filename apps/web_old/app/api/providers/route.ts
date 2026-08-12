import {
  detectProviders,
  readProviderCache,
  writeProviderCache,
  type ProviderStatus,
} from "@telar/core/detect";

export const dynamic = "force-dynamic";

// Provider detection, the surface that replaced in-app login. GET serves the
// last cached answer (detection spawns a subprocess per provider, so it is not
// something to redo on every paint); POST re-probes.
//
async function detect(): Promise<ProviderStatus[]> {
  const providers = await detectProviders();
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
