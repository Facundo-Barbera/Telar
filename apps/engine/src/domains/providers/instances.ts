import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderDriverKind, ProviderInstance, ProviderProbe, ProviderSignIn, ProviderUpdate } from "@telar/engine-client";
import { cliUsable, resolveCliAsync, type CliId } from "./cli";
import { cliUpdateFor } from "./cli-updates";

const VERSION_CACHE_MS = 60_000;

const LOGIN_ARTIFACT: Record<ProviderDriverKind, string> = {
  opencode: "auth.json",
  claude: ".credentials.json",
  codex: "auth.json",
};

const CONFIG_DIR_ENV: Record<ProviderDriverKind, string> = {
  opencode: "OPENCODE_CONFIG_DIR",
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

function expandHome(target: string): string {
  return target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
}

const OWNED_ENV: Record<ProviderDriverKind, readonly string[]> = {
  opencode: ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"],
  claude: [
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: ["CODEX_HOME", "OPENAI_BASE_URL", "OPENAI_API_KEY"],
};

const CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
]);

function providerInstanceConfigured(instance: Pick<ProviderInstance, "configDir" | "env">): boolean {
  return instance.configDir !== undefined || instance.env.length > 0;
}

export function inheritedOwnedEnv(
  driver: ProviderDriverKind,
  ambient: Record<string, string | undefined> = process.env,
): string[] {
  return OWNED_ENV[driver].filter((name) => (ambient[name] ?? "").trim() !== "");
}

export function providerEnvIsCredential(name: string): boolean {
  return CREDENTIAL_ENV.has(name);
}

export function providerOwnsEnv(driver: ProviderDriverKind, name: string): boolean {
  return OWNED_ENV[driver].includes(name);
}

export function stoppedInheriting(input: {
  before: Pick<ProviderInstance, "configDir" | "env"> | undefined;
  after: Pick<ProviderInstance, "driver" | "configDir" | "env">;
  ambient?: Record<string, string | undefined>;
}): string[] {
  if (input.before && providerInstanceConfigured(input.before)) return [];
  if (!providerInstanceConfigured(input.after)) return [];
  const supplied = new Set(input.after.env.map((variable) => variable.name));
  if (input.after.configDir !== undefined) supplied.add(CONFIG_DIR_ENV[input.after.driver]);
  return inheritedOwnedEnv(input.after.driver, input.ambient ?? process.env).filter((name) => !supplied.has(name));
}

export function providerProcessEnv(instance: ProviderInstance): Record<string, string | undefined> {
  const configured = providerInstanceConfigured(instance);
  const patch: Record<string, string | undefined> = {};
  if (configured) for (const name of OWNED_ENV[instance.driver]) patch[name] = undefined;
  if (instance.configDir) patch[CONFIG_DIR_ENV[instance.driver]] = expandHome(instance.configDir);
  for (const variable of instance.env) patch[variable.name] = variable.value;
  return patch;
}

export type VersionProbe = {
  installed: boolean;
  version?: string;
  message?: string;
  usable?: boolean;
  update?: ProviderUpdate;
};

async function probeVersion(driver: CliId, binaryPath?: string, force = false): Promise<VersionProbe> {
  const resolution = await resolveCliAsync(driver, binaryPath ? { binaryPath } : {});
  if (resolution.status === "missing") {
    return { installed: false, ...(resolution.message ? { message: resolution.message } : {}) };
  }
  return {
    installed: true,
    ...(resolution.version ? { version: resolution.version } : {}),
    update: await cliUpdateFor(resolution, { force }),
    ...(resolution.message ? { message: resolution.message } : {}),
    usable: cliUsable(resolution),
  };
}

export function signInOf(instance: Pick<ProviderInstance, "driver" | "configDir">): { signIn: ProviderSignIn; message?: string } {
  if (instance.driver === "opencode") return { signIn: "unknown", message: "OpenCode authentication uses the CLI login. A config directory does not isolate credentials." };
  if (!instance.configDir) {
    return { signIn: "unknown", message: "Base login — sign-in state cannot be verified from disk." };
  }
  const dir = expandHome(instance.configDir);
  if (!fs.existsSync(dir)) {
    return { signIn: "missing-config-dir", message: "Config directory not found on this machine." };
  }
  if (fs.existsSync(path.join(dir, LOGIN_ARTIFACT[instance.driver]))) {
    return { signIn: "signed-in" };
  }
  if (instance.driver === "codex") {
    return { signIn: "signed-out", message: "Config directory holds no Codex login (auth.json is missing)." };
  }
  return {
    signIn: "unknown",
    message: "Claude keeps credentials in the Keychain, so sign-in cannot be confirmed from disk.",
  };
}

export function statusOf(input: {
  enabled: boolean;
  installed: boolean;
  signIn: ProviderSignIn;
  usable?: boolean;
}): ProviderProbe["status"] {
  if (!input.enabled) return "disabled";
  if (!input.installed) return "error";
  if (input.usable === false) return "error";
  if (input.signIn === "missing-config-dir" || input.signIn === "signed-out") return "warning";
  return "ready";
}

type ProviderProbeDeps = {
  version?: (driver: CliId, binaryPath: string | undefined, force: boolean) => Promise<VersionProbe>;
  now?: () => number;
};

export function createProviderProber(deps: ProviderProbeDeps = {}) {
  const version = deps.version ?? probeVersion;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; probe: VersionProbe }>();

  const keyFor = (driver: ProviderDriverKind, binaryPath: string | undefined): string => `${driver}\u0000${binaryPath ?? ""}`;

  const versionFor = async (driver: ProviderDriverKind, binaryPath: string | undefined, force: boolean): Promise<VersionProbe> => {
    const key = keyFor(driver, binaryPath);
    const hit = cache.get(key);
    if (!force && hit && now() - hit.at < VERSION_CACHE_MS) return hit.probe;
    const probe = await version(driver, binaryPath, force);
    cache.set(key, { at: now(), probe });
    return probe;
  };

  return async function probe(
    instances: readonly ProviderInstance[],
    options: { force?: boolean } = {},
  ): Promise<ProviderProbe[]> {
    const wanted = new Map<string, { driver: ProviderDriverKind; binaryPath?: string }>();
    for (const instance of instances) {
      wanted.set(keyFor(instance.driver, instance.binaryPath), {
        driver: instance.driver,
        ...(instance.binaryPath ? { binaryPath: instance.binaryPath } : {}),
      });
    }
    const versions = new Map<string, VersionProbe>();
    await Promise.all(
      [...wanted].map(async ([key, target]) => {
        versions.set(key, await versionFor(target.driver, target.binaryPath, options.force === true));
      }),
    );
    const checkedAt = now();
    return instances.map((instance) => {
      const found = versions.get(keyFor(instance.driver, instance.binaryPath)) ?? { installed: false };
      const sign = signInOf(instance);
      const status = statusOf({
        enabled: instance.enabled,
        installed: found.installed,
        signIn: sign.signIn,
        ...(found.usable === undefined ? {} : { usable: found.usable }),
      });
      const message = found.installed
        ? (found.message ?? sign.message)
        : (found.message ?? `${instance.driver} was not found on PATH.`);
      return {
        instanceId: instance.id,
        driver: instance.driver,
        status,
        installed: found.installed,
        signIn: sign.signIn,
        checkedAt,
        ...(found.version ? { version: found.version } : {}),
        ...(found.update ? { update: found.update } : {}),
        ...(message ? { message } : {}),
      };
    });
  };
}
