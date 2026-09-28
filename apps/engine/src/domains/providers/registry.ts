import {
  AUTO_COMPACT_MAX_TOKENS,
  AutoCompact as AutoCompactSchema,
  defaultInstanceIdForDriver,
  ProviderDriverKind as ProviderDriverKindSchema,
  ProviderInstance as ProviderInstanceSchema,
  ProviderInstanceEnvVar as ProviderInstanceEnvVarSchema,
  type AutoCompact,
  type ProviderDriverKind,
  type ProviderInstance,
  type ProviderInstanceEnvVar,
} from "@telar/engine-client";
import { EngineStateError, SECRET_KEY_SEPARATOR, STATE_VERSION, type Kernel } from "../../platform/kernel";
import { inheritedOwnedEnv, providerEnvIsCredential, providerOwnsEnv, stoppedInheriting } from "./instances";

const MAX_ENV_VARS = 64;
const BUILT_IN_DRIVERS: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"];

/** An instance id must start with a letter: it rides in URLs, and `-force` would read as a flag. */
export function assertInstanceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new EngineStateError(
      "invalid_request",
      "provider instance id must start with a letter and contain only letters, numbers, underscores, or hyphens",
    );
  }
}

function secretKey(instanceId: string, name: string): string {
  return instanceId + SECRET_KEY_SEPARATOR + name;
}

/** The built-in slot. No `configDir`: for Claude, setting it at all points at a different, empty Keychain entry. */
function seedProviderInstance(driver: ProviderDriverKind, at: number): ProviderInstance {
  return { id: defaultInstanceIdForDriver(driver), driver, enabled: driver !== "opencode", env: [], createdAt: at, updatedAt: at };
}

/** `null` clears, `undefined` keeps, anything else is normalised and set; a blank string also clears. */
function optionalPatch<K extends string>(
  key: K,
  submitted: string | null | undefined,
  existing: string | undefined,
  normalise: (value: string) => string,
): Partial<Record<K, string>> {
  if (submitted === null) return {};
  const raw = submitted === undefined ? existing : submitted;
  if (raw === undefined || raw.trim() === "") return {};
  return { [key]: normalise(raw) } as Partial<Record<K, string>>;
}

function optionalNumberPatch<K extends string>(
  key: K,
  submitted: number | null | undefined,
  existing: number | undefined,
  normalise: (value: number) => number,
): Partial<Record<K, number>> {
  if (submitted === null) return {};
  const raw = submitted === undefined ? existing : submitted;
  if (raw === undefined) return {};
  return { [key]: normalise(raw) } as Partial<Record<K, number>>;
}

function autoCompactPatch(submitted: unknown, existing: AutoCompact | undefined): { autoCompact?: AutoCompact } {
  if (submitted === null) return {};
  if (submitted === undefined) return existing ? { autoCompact: existing } : {};
  const parsed = AutoCompactSchema.safeParse(submitted);
  if (!parsed.success) {
    throw new EngineStateError("invalid_request", `auto-compaction limits must be whole token counts from 1 to ${AUTO_COMPACT_MAX_TOKENS}`);
  }
  return { autoCompact: parsed.data };
}

export type ProviderInstanceInput = {
  id: string;
  driver?: unknown;
  displayName?: string | null;
  accentColor?: string | null;
  contextNoticePercent?: number | null;
  autoCompact?: unknown;
  enabled?: boolean;
  configDir?: string | null;
  binaryPath?: string | null;
  env?: unknown;
  /** Names of inherited variables to keep as this login's own; their values come from the engine's environment, never the request. */
  carryOverInherited?: unknown;
};

/**
 * The provider logins and their secrets. Sensitive values live in a separate
 * 0600 document and only `resolve` returns them; every other read redacts.
 */
export class ProviderRegistry {
  constructor(
    private readonly kernel: Kernel,
    private readonly ambientEnv: Record<string, string | undefined>,
  ) {}

  list(): ProviderInstance[] {
    return this.read().map((instance) => ({
      ...instance,
      env: instance.env.map((variable) => (variable.sensitive ? { ...variable, value: "", valueRedacted: true } : variable)),
    }));
  }

  /**
   * Creates or replaces one instance. The driver is fixed for an instance's
   * life. Reports which inherited variables the save stopped inheriting, since
   * a configured instance no longer inherits what its driver owns.
   */
  save(input: ProviderInstanceInput): { instance: ProviderInstance; stoppedInheriting: string[] } {
    assertInstanceId(input.id);
    const instances = this.read();
    const existing = instances.find((instance) => instance.id === input.id);
    const driver = input.driver === undefined ? existing?.driver : input.driver;
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") {
      throw new EngineStateError("invalid_request", "provider instance driver must be claude, codex, opencode or telar");
    }
    if (existing && existing.driver !== driver) throw new EngineStateError("conflict", "a provider instance cannot change driver");
    const at = this.kernel.now();
    const env = this.applyEnvEdits(input.id, this.withCarriedInheritance(input, driver, existing), existing?.env ?? [], this.readSecrets());
    const instance: ProviderInstance = {
      id: input.id,
      driver,
      enabled: input.enabled ?? existing?.enabled ?? true,
      env: env.stored,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...optionalPatch("displayName", input.displayName, existing?.displayName, (value) => value.trim().slice(0, 120)),
      ...optionalPatch("accentColor", input.accentColor, existing?.accentColor, (value) => {
        const colour = value.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw new EngineStateError("invalid_request", "accent colour must be #rrggbb");
        return colour;
      }),
      ...optionalNumberPatch("contextNoticePercent", input.contextNoticePercent, existing?.contextNoticePercent, (value) => {
        if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
          throw new EngineStateError("invalid_request", "context notice must be a whole percentage from 1 to 100");
        }
        return value;
      }),
      ...autoCompactPatch(input.autoCompact, existing?.autoCompact),
      ...optionalPatch("configDir", input.configDir, existing?.configDir, (value) => {
        const dir = value.trim();
        if (!dir.startsWith("/") && !dir.startsWith("~")) {
          throw new EngineStateError("invalid_request", "config directory must be an absolute or ~-relative path");
        }
        return dir;
      }),
      // A path or a bare command name; a relative path would resolve per worker cwd.
      ...optionalPatch("binaryPath", input.binaryPath, existing?.binaryPath, (value) => {
        const binary = value.trim();
        const looksLikePath = binary.includes("/") || binary.includes("\\");
        if (looksLikePath && !binary.startsWith("/") && !binary.startsWith("~")) {
          throw new EngineStateError("invalid_request", "binary path must be an absolute path, a ~-relative path, or a bare command name");
        }
        return binary;
      }),
    };
    const parsed = ProviderInstanceSchema.safeParse(instance);
    if (!parsed.success) throw new EngineStateError("invalid_request", "provider instance configuration is invalid");
    const next = existing ? instances.map((entry) => (entry.id === instance.id ? parsed.data : entry)) : [...instances, parsed.data];
    this.writeInstances(next);
    this.writeSecrets(env.secrets);
    return {
      instance: structuredClone(this.list().find((entry) => entry.id === instance.id)!),
      stoppedInheriting: stoppedInheriting({ before: existing, after: parsed.data, ambient: this.ambientEnv }),
    };
  }

  /** The built-in slots can't be removed. Sessions naming a removed instance fall back to the driver's default. */
  remove(id: string): boolean {
    assertInstanceId(id);
    if (BUILT_IN_DRIVERS.some((driver) => id === defaultInstanceIdForDriver(driver))) {
      throw new EngineStateError("conflict", "the built-in provider instance cannot be removed");
    }
    const instances = this.read();
    const next = instances.filter((instance) => instance.id !== id);
    if (next.length === instances.length) return false;
    const secrets = this.readSecrets();
    for (const key of Object.keys(secrets)) {
      if (key.slice(0, key.indexOf(SECRET_KEY_SEPARATOR)) === id) delete secrets[key];
    }
    this.writeInstances(next);
    this.writeSecrets(secrets);
    return true;
  }

  /** The instance a session runs as, secrets resolved; an unknown id falls back to the driver's slot. Never route-reachable. */
  resolve(instanceId: string, driver: ProviderDriverKind): ProviderInstance {
    const instances = this.read();
    const found =
      instances.find((instance) => instance.id === instanceId) ?? instances.find((instance) => instance.id === defaultInstanceIdForDriver(driver));
    if (!found) return seedProviderInstance(driver, this.kernel.now());
    const secrets = this.readSecrets();
    return {
      ...found,
      env: found.env.map((variable) => (variable.sensitive ? { ...variable, value: secrets[secretKey(found.id, variable.name)] ?? "" } : variable)),
    };
  }

  /** For creating a session: an id nobody configured is a client error, unlike resuming one that was removed. */
  require(id: string): ProviderInstance {
    assertInstanceId(id);
    const found = this.read().find((instance) => instance.id === id);
    if (!found) throw new EngineStateError("not_found", "provider instance does not exist");
    return found;
  }

  /**
   * Seeded on first read. A row naming a retired driver is dropped (its secret
   * left in place); any other malformed row still throws. Missing built-in
   * slots are backfilled once.
   */
  read(): ProviderInstance[] {
    const stored = this.kernel.readDocument(this.kernel.paths.providerInstances) as { providerInstances?: unknown } | undefined;
    if (stored === undefined) {
      const at = this.kernel.now();
      const seeded = BUILT_IN_DRIVERS.map((driver) => seedProviderInstance(driver, at));
      this.writeInstances(seeded);
      return seeded;
    }
    const rows = Array.isArray(stored.providerInstances) ? stored.providerInstances : [];
    const kept = rows.filter(
      (row) => !(typeof row === "object" && row !== null && !ProviderDriverKindSchema.safeParse((row as { driver?: unknown }).driver).success),
    );
    if (kept.length !== rows.length) {
      this.writeInstances(kept);
      stored.providerInstances = kept;
    }
    const parsed = ProviderInstanceSchema.array().safeParse(stored.providerInstances ?? []);
    if (!parsed.success) throw new EngineStateError("invalid_request", "invalid provider instance registry");
    const missing = (["opencode"] as const).filter((driver) => !parsed.data.some((instance) => instance.id === driver));
    if (missing.length > 0) {
      for (const driver of missing) parsed.data.push(seedProviderInstance(driver, this.kernel.now()));
      this.writeInstances(parsed.data);
    }
    return parsed.data;
  }

  private writeInstances(providerInstances: unknown[]): void {
    this.kernel.writeDocument(this.kernel.paths.providerInstances, { version: STATE_VERSION, providerInstances });
  }

  private writeSecrets(secrets: Record<string, string>): void {
    this.kernel.writeDocument(this.kernel.paths.providerSecrets, { version: STATE_VERSION, secrets });
  }

  private readSecrets(): Record<string, string> {
    const stored = this.kernel.readDocument(this.kernel.paths.providerSecrets) as { secrets?: unknown } | undefined;
    const secrets = stored?.secrets;
    if (secrets === undefined || secrets === null) return {};
    if (typeof secrets !== "object") throw new EngineStateError("invalid_request", "invalid provider secret store");
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  /**
   * The submitted environment plus carried-over inheritance. Refuses a name the
   * driver doesn't own, one the engine isn't inheriting, or one already declared.
   */
  private withCarriedInheritance(
    input: { env?: unknown; carryOverInherited?: unknown },
    driver: ProviderDriverKind,
    existing: ProviderInstance | undefined,
  ): unknown {
    if (input.carryOverInherited === undefined) return input.env;
    if (!Array.isArray(input.carryOverInherited) || input.carryOverInherited.some((name) => typeof name !== "string")) {
      throw new EngineStateError("invalid_request", "carryOverInherited must be an array of variable names");
    }
    const base = (input.env === undefined ? (existing?.env ?? []) : input.env) as ProviderInstanceEnvVar[];
    if (!Array.isArray(base)) throw new EngineStateError("invalid_request", "provider instance environment is invalid");
    const declared = new Set(base.map((variable) => variable?.name));
    const inherited = new Set(inheritedOwnedEnv(driver, this.ambientEnv));
    const carried: ProviderInstanceEnvVar[] = [];
    for (const name of input.carryOverInherited as string[]) {
      if (!providerOwnsEnv(driver, name)) throw new EngineStateError("invalid_request", `${name} is not a variable a ${driver} login owns`);
      if (!inherited.has(name)) throw new EngineStateError("invalid_request", `Telar is not inheriting ${name}, so there is nothing to carry over`);
      if (declared.has(name)) throw new EngineStateError("invalid_request", `${name} is already declared by this login`);
      declared.add(name);
      carried.push({ name, value: this.ambientEnv[name] ?? "", sensitive: providerEnvIsCredential(name) });
    }
    return [...base, ...carried];
  }

  /**
   * Folds a submitted env list into what is stored, moving secrets aside. A
   * redacted value round-trips: only a non-empty value replaces a stored secret.
   */
  private applyEnvEdits(
    instanceId: string,
    submitted: unknown,
    previous: ProviderInstanceEnvVar[],
    secrets: Record<string, string>,
  ): { stored: ProviderInstanceEnvVar[]; secrets: Record<string, string> } {
    if (submitted === undefined) return { stored: previous, secrets };
    const parsed = ProviderInstanceEnvVarSchema.array().max(MAX_ENV_VARS).safeParse(submitted);
    if (!parsed.success) throw new EngineStateError("invalid_request", "provider instance environment is invalid");
    const next = { ...secrets };
    const stored: ProviderInstanceEnvVar[] = [];
    const seen = new Set<string>();
    for (const variable of parsed.data) {
      if (seen.has(variable.name)) throw new EngineStateError("invalid_request", `duplicate environment variable ${variable.name}`);
      seen.add(variable.name);
      const key = secretKey(instanceId, variable.name);
      if (!variable.sensitive) {
        delete next[key];
        stored.push({ name: variable.name, value: variable.value, sensitive: false });
        continue;
      }
      if (variable.value !== "") next[key] = variable.value;
      else if (!(key in next)) next[key] = "";
      stored.push({ name: variable.name, value: "", sensitive: true });
    }
    for (const variable of previous) {
      if (!seen.has(variable.name)) delete next[secretKey(instanceId, variable.name)];
    }
    return { stored, secrets: next };
  }
}
