import fs from "node:fs/promises";
import path from "node:path";
import { EngineClient, EngineClientError, type FetchLike } from "./index";
import { EngineDiscovery } from "./protocol";

const discoveryFile = (engineRoot: string): string => path.join(engineRoot, "engine.json");

export async function discoverEngine(engineRoot: string): Promise<EngineDiscovery> {
  try {
    const raw = await fs.readFile(discoveryFile(engineRoot), "utf8");
    const discovery = EngineDiscovery.safeParse(JSON.parse(raw) as unknown);
    if (!discovery.success) {
      throw new EngineClientError("engine_unavailable", "engine discovery is invalid");
    }
    return discovery.data;
  } catch (error) {
    if (error instanceof EngineClientError) throw error;
    throw new EngineClientError("engine_unavailable", "engine is not discoverable");
  }
}

export async function connectEngine(engineRoot: string, fetchImpl?: FetchLike): Promise<EngineClient> {
  return new EngineClient(await discoverEngine(engineRoot), fetchImpl);
}
