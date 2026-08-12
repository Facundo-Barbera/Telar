/**
 * Node-only engine discovery. This is a separate entry point, not part of
 * `./index`, because the root export is imported by browser code (the cockpit
 * pulls `displayToolName` and the protocol types into client components), and
 * a top-level `node:fs/promises` import in that graph is a hard Turbopack
 * error — browser chunks cannot reference node externals. Anything that reads
 * the filesystem lives here and is imported as `@telar/engine-client/node`
 * from server/worker code only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineClient, EngineClientError, type FetchLike } from "./index";
import { EngineDiscovery } from "./protocol";

const discoveryFile = (vnextRoot: string): string => path.join(vnextRoot, "engine.json");

/**
 * Reads only the vNext discovery document; it never touches legacy Telar state.
 *
 * VALIDATION IS THE SCHEMA'S JOB NOW. This used to be `isDiscovery()`, fifteen
 * hand-written checks ending in a `value is EngineDiscovery` assertion the
 * compiler took on trust — so adding a field to the type and forgetting a line
 * here silently weakened the check. The schema carries the same rules (a
 * 32-character minimum token, a real port) and cannot drift from the type,
 * because the type is derived from it.
 */
export async function discoverEngine(vnextRoot: string): Promise<EngineDiscovery> {
  try {
    const raw = await fs.readFile(discoveryFile(vnextRoot), "utf8");
    const discovery = EngineDiscovery.safeParse(JSON.parse(raw) as unknown);
    if (!discovery.success) {
      throw new EngineClientError("engine_unavailable", "vNext engine discovery is invalid");
    }
    return discovery.data;
  } catch (error) {
    if (error instanceof EngineClientError) throw error;
    throw new EngineClientError("engine_unavailable", "vNext engine is not discoverable");
  }
}

export async function connectEngine(vnextRoot: string, fetchImpl?: FetchLike): Promise<EngineClient> {
  return new EngineClient(await discoverEngine(vnextRoot), fetchImpl);
}
