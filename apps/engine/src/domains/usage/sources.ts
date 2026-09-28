import { UsageLimitSource as UsageLimitSourceSchema, type UsageLimitSource } from "@telar/engine-client";
import { EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";

// Caps how many outbound requests one usage read can make.
const MAX_USAGE_LIMIT_SOURCES = 16;

export type ResolvedUsageLimitSource = { id: string; kind: "cliproxy"; label?: string; url: string; managementKey: string };

export type UsageLimitSourceInput = {
  id: string;
  kind?: unknown;
  label?: string | null;
  url?: unknown;
  managementKey?: unknown;
  enabled?: boolean;
};

function redact(source: UsageLimitSource, secrets: Record<string, string>): UsageLimitSource {
  return { ...source, managementKey: "", ...(secrets[source.id] ? { keyRedacted: true } : {}) };
}

function assertSourceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new EngineStateError(
      "invalid_request",
      "usage limit source id must start with a letter and contain only letters, numbers, underscores, or hyphens",
    );
  }
}

/**
 * The quota hubs to read, configuration only; what a hub reports is live state
 * the usage routes fetch. Management keys live in their own document, and only
 * `resolve` returns them. A malformed document reads as empty.
 */
export class UsageLimitSources {
  constructor(private readonly kernel: Kernel) {}

  list(): UsageLimitSource[] {
    const secrets = this.readSecrets();
    return this.read().map((source) => redact(source, secrets));
  }

  /** A redacted key round-trips: only a non-empty key replaces a stored one. */
  save(input: UsageLimitSourceInput): UsageLimitSource {
    assertSourceId(input.id);
    const sources = this.read();
    const existing = sources.find((source) => source.id === input.id);
    const at = this.kernel.now();
    const url = input.url === undefined ? existing?.url : input.url;
    if (typeof url !== "string" || url.trim().length === 0) throw new EngineStateError("invalid_request", "a usage limit source needs a hub URL");
    let origin: URL;
    try {
      origin = new URL(url.trim());
    } catch {
      throw new EngineStateError("invalid_request", "the hub URL is not a valid URL");
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") throw new EngineStateError("invalid_request", "the hub URL must be http or https");
    const kind = input.kind === undefined ? (existing?.kind ?? "cliproxy") : input.kind;
    if (kind !== "cliproxy") throw new EngineStateError("invalid_request", "usage limit source kind must be cliproxy");
    const secrets = this.readSecrets();
    if (input.managementKey !== undefined) {
      if (typeof input.managementKey !== "string") throw new EngineStateError("invalid_request", "the management key must be a string");
      if (input.managementKey !== "") secrets[input.id] = input.managementKey;
      else if (!(input.id in secrets)) secrets[input.id] = "";
    } else if (!(input.id in secrets)) {
      secrets[input.id] = "";
    }
    const label = input.label === undefined ? existing?.label : input.label === null ? undefined : input.label.trim() || undefined;
    const source = {
      id: input.id,
      kind,
      ...(label ? { label } : {}),
      url: origin.toString(),
      managementKey: "",
      enabled: typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const parsed = UsageLimitSourceSchema.safeParse(source);
    if (!parsed.success) throw new EngineStateError("invalid_request", "usage limit source configuration is invalid");
    const next = existing ? sources.map((entry) => (entry.id === source.id ? parsed.data : entry)) : [...sources, parsed.data];
    if (next.length > MAX_USAGE_LIMIT_SOURCES) {
      throw new EngineStateError("invalid_request", `at most ${MAX_USAGE_LIMIT_SOURCES} usage limit sources can be configured`);
    }
    this.write(next, secrets);
    return redact(parsed.data, secrets);
  }

  /** Forgets a hub and its key; false for an unknown id. */
  remove(id: string): boolean {
    assertSourceId(id);
    const sources = this.read();
    const next = sources.filter((source) => source.id !== id);
    if (next.length === sources.length) return false;
    const secrets = this.readSecrets();
    delete secrets[id];
    this.write(next, secrets);
    return true;
  }

  /** The enabled hubs with keys resolved; never route-reachable. */
  resolve(): ResolvedUsageLimitSource[] {
    const secrets = this.readSecrets();
    return this.read()
      .filter((source) => source.enabled)
      .map((source) => ({ id: source.id, kind: source.kind, ...(source.label ? { label: source.label } : {}), url: source.url, managementKey: secrets[source.id] ?? "" }));
  }

  private write(usageLimitSources: UsageLimitSource[], secrets: Record<string, string>): void {
    this.kernel.writeDocument(this.kernel.paths.usageLimitSources, { version: STATE_VERSION, usageLimitSources });
    this.kernel.writeDocument(this.kernel.paths.usageLimitSecrets, { version: STATE_VERSION, secrets });
  }

  private read(): UsageLimitSource[] {
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.usageLimitSources) as { usageLimitSources?: unknown } | undefined;
      const parsed = UsageLimitSourceSchema.array().safeParse(stored?.usageLimitSources ?? []);
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private readSecrets(): Record<string, string> {
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.usageLimitSecrets) as { secrets?: unknown } | undefined;
      const secrets = stored?.secrets;
      if (typeof secrets !== "object" || secrets === null) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
}
