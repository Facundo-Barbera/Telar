import { createHash } from "node:crypto";

const UNDEFINED = "undefined";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return UNDEFINED;
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? UNDEFINED;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function canonicalServers<T extends { id: string; enabled?: boolean; spec: unknown }>(
  servers: readonly T[] | undefined,
): { id: string; enabled: boolean | undefined; spec: unknown }[] | null {
  if (!servers) return null;
  const byId = new Map<string, { id: string; enabled: boolean | undefined; spec: unknown }>();
  for (const server of servers) byId.set(server.id, { id: server.id, enabled: server.enabled, spec: server.spec });
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function resolveChildEnv(
  base: Record<string, string | undefined>,
  ...patches: (Record<string, string | undefined> | undefined)[]
): Record<string, string> | undefined {
  if (patches.every((patch) => patch === undefined)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value;
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined) delete out[key];
      else out[key] = value;
    }
  }
  return out;
}

export function canonicalEnvPatch(...patches: (Record<string, string | undefined> | undefined)[]): Record<string, string | undefined> | null {
  if (patches.every((patch) => patch === undefined)) return null;
  const out: Record<string, string | undefined> = {};
  for (const patch of patches) for (const [key, value] of Object.entries(patch ?? {})) out[key] = value;
  return out;
}

export function fieldDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 12);
}

export function fieldDigests(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = fieldDigest(value);
  return out;
}

export function changedFields(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}
