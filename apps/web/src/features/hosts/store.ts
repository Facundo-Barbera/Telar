import fs from "node:fs";
import path from "node:path";
import { remoteHome } from "@/lib/remote/store";

export type Host = { id: string; name: string; baseUrl: string; deviceToken: string };

export function findHost(id: string): Host | undefined {
  const file = path.join(remoteHome(), "hosts.json");
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; hosts?: Host[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return undefined;
  return parsed.hosts.find((host) => host.id === id);
}
