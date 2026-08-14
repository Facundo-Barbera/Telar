/**
 * WHETHER A CONFIGURED PROVIDER INSTANCE CAN ACTUALLY RUN.
 *
 * TELAR DISCOVERS LOGINS; IT DOES NOT CREATE THEM. There is no sign-in here and
 * no route that leads to one. This module answers three questions about a
 * machine and stops:
 *
 *   1. Is the CLI on this machine, and which version — `<bin> --version`, and
 *      nothing else. The old cockpit's `packages/core/src/detect.ts` learned
 *      this the hard way and wrote the rule down: an auth subcommand's prose is
 *      not a contract, and scraping sign-in state out of it turns a phrasing
 *      change into a confident wrong answer.
 *   2. Does this instance's config folder exist.
 *   3. Is the provider's login artefact inside it.
 *
 * NO CREDENTIAL IS EVER OPENED. (3) is `existsSync`, not a read — the file's
 * PRESENCE is the signal and its contents are none of Telar's business. This
 * also bounds what the answer can be: on macOS Claude keeps its token in the
 * Keychain, so a Claude folder with no file credentials is `unknown`, never
 * `signed-out`. Reporting "not signed in" there would be a confident wrong
 * answer about somebody's working account, which is exactly the failure (1)
 * exists to avoid.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderDriverKind, ProviderInstance, ProviderProbe, ProviderSignIn } from "@telar/engine-client";
import { cliUsable, resolveCliAsync } from "./cli-resolution";

/**
 * A version probe costs a subprocess per driver, and this is read from a
 * settings page that repaints. Cached per driver — not per instance, because
 * two instances of one driver run the same binary; only their config folders
 * differ, and that check is a stat.
 */
const VERSION_CACHE_MS = 60_000;

/** The file whose PRESENCE means this provider has been logged in inside a
 *  config folder. Never opened. */
const LOGIN_ARTIFACT: Record<ProviderDriverKind, string> = {
  claude: ".credentials.json",
  codex: "auth.json",
};

/** The variable that relocates a provider's whole config and credential
 *  directory. Claude: creds in the macOS Keychain, keyed per directory. Codex:
 *  creds in `auth.json` inside it — file-based, and therefore portable. */
const CONFIG_DIR_ENV: Record<ProviderDriverKind, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/**
 * THE SIGN-IN COMMAND IS NOT HERE, deliberately. It is a sentence shown to a
 * person, it is never executed by anything in this process, and the cockpit is
 * what renders it — see `apps/web/lib/provider-instances.ts`. A second
 * copy in the engine would be a second place for the wording to drift with
 * nothing that could notice.
 */

/** `~` is stored rather than an absolute home so a registry survives being
 *  copied between machines; it is expanded here, at the moment it is used. */
export function expandHome(target: string): string {
  return target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
}

/**
 * THE ENVIRONMENT VARIABLES AN ISOLATED INSTANCE OWNS.
 *
 * Ported from `packages/core/src/providers.ts`, where the rule was learned the
 * expensive way. The config-dir guard exists because an inherited
 * `CLAUDE_CONFIG_DIR` silently put the `personal` account on the work login; an
 * inherited `ANTHROPIC_BASE_URL` silently puts EVERY instance behind a local
 * proxy, and an inherited `ANTHROPIC_API_KEY` silently moves a subscription
 * account onto metered API billing. Same failure, same fix: the instance
 * declares, the ambient environment does not.
 *
 * An instance that WANTS one of these sets it explicitly in `env`, which is
 * applied after the deletion — so declaring still works and only inheriting
 * stops.
 */
const OWNED_ENV: Record<ProviderDriverKind, readonly string[]> = {
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

/**
 * What this instance's provider process should run with, as a patch over the
 * worker's own environment.
 *
 * THE BUILT-IN SLOT SCRUBS NOTHING, and that is deliberate rather than an
 * oversight. It represents `claude` (or `codex`) as the user launches it
 * normally: it declares no config dir and no credential, so it must load the
 * provider's own user settings exactly as a plain terminal launch would. Only
 * an instance that has been CONFIGURED — a folder, or variables of its own —
 * gets the ambient values removed first, because that is the instance whose
 * identity an inherited variable would silently replace.
 *
 * A key mapped to `undefined` means "delete this from the child's environment".
 * Both drivers merge the patch over `process.env` and drop undefined keys.
 */
export function providerProcessEnv(instance: ProviderInstance): Record<string, string | undefined> {
  const configured = instance.configDir !== undefined || instance.env.length > 0;
  const patch: Record<string, string | undefined> = {};
  if (configured) for (const name of OWNED_ENV[instance.driver]) patch[name] = undefined;
  if (instance.configDir) patch[CONFIG_DIR_ENV[instance.driver]] = expandHome(instance.configDir);
  // Last, so an instance that explicitly declares one of its own owned
  // variables gets it back after the scrub.
  for (const variable of instance.env) patch[variable.name] = variable.value;
  return patch;
}

export type VersionProbe = {
  installed: boolean;
  version?: string;
  message?: string;
  /** Found, and a turn would still be refused — see `statusOf`. */
  usable?: boolean;
};

/**
 * ASKS THE SAME RESOLVER A TURN DOES, and that is the whole point of this
 * function existing rather than an `execFile(driver, ["--version"])`.
 *
 * It used to run the bare binary name, which resolves off PATH. A turn does not:
 * it spawns the path `cli-resolution.ts` picked (`CLAUDE_CODE_EXECUTABLE`, then
 * `~/.local/bin`, the brew prefixes, and PATH last), and before this file was
 * changed, a Claude turn did not spawn a binary at all — the Agent SDK resolved
 * its own bundled one. So the version somebody read on this pane was not the
 * version that answered them, and in a packaged app the pane could report a
 * healthy install for a provider that could not start.
 */
async function probeVersion(driver: ProviderDriverKind): Promise<VersionProbe> {
  const resolution = await resolveCliAsync(driver);
  if (resolution.status === "missing") {
    return { installed: false, ...(resolution.message ? { message: resolution.message } : {}) };
  }
  return {
    installed: true,
    ...(resolution.version ? { version: resolution.version } : {}),
    // Carried through for every status that has something to say — a drifted or
    // incompatible CLI is installed AND worth a sentence.
    ...(resolution.message ? { message: resolution.message } : {}),
    // `installed` alone would paint an incompatible CLI green while every turn
    // on it is refused. The resolver already knows the difference; this is the
    // one place it has to be told.
    usable: cliUsable(resolution),
  };
}

/**
 * Where an instance's login lives, and what can be said about it.
 *
 * ABSENT `configDir` IS THE BASE LOGIN and is deliberately unverifiable: there
 * is nothing on disk to inspect, because the credentials belong to the
 * provider's own default location — and for Claude, pointing the variable at
 * that location is precisely what breaks it (a different, empty Keychain
 * entry). So the honest answer is `unknown`, not a green tick.
 */
export function signInOf(instance: Pick<ProviderInstance, "driver" | "configDir">): { signIn: ProviderSignIn; message?: string } {
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
    // Codex is purely file-based, so a missing auth.json is DEFINITIVE rather
    // than merely unproven — which is why this is the one branch allowed to say
    // somebody is signed out.
    return { signIn: "signed-out", message: "Config directory holds no Codex login (auth.json is missing)." };
  }
  return {
    signIn: "unknown",
    message: "Claude keeps credentials in the Keychain, so sign-in cannot be confirmed from disk.",
  };
}

/**
 * Fold the three facts into one status.
 *
 * `disabled` OUTRANKS EVERYTHING, including a missing binary: an instance the
 * user switched off is not failing, and painting it red would send them to fix
 * something they had already decided not to use.
 */
export function statusOf(input: {
  enabled: boolean;
  installed: boolean;
  signIn: ProviderSignIn;
  /**
   * Found, but a turn would be REFUSED — a CLI whose control protocol this
   * build does not speak (`cli-resolution.ts`). Optional because the sign-in
   * half of this function has no opinion about it.
   *
   * IT IS AN ERROR, NOT A WARNING, and not "ready with a note": every session
   * on this provider fails at submit. Painting it green because a binary
   * exists is the same class of wrong answer as reporting a version from PATH
   * while a different binary does the work.
   */
  usable?: boolean;
}): ProviderProbe["status"] {
  if (!input.enabled) return "disabled";
  if (!input.installed) return "error";
  if (input.usable === false) return "error";
  if (input.signIn === "missing-config-dir" || input.signIn === "signed-out") return "warning";
  return "ready";
}

export type ProviderProbeDeps = {
  version?: (driver: ProviderDriverKind) => Promise<VersionProbe>;
  now?: () => number;
};

export function createProviderProber(deps: ProviderProbeDeps = {}) {
  const version = deps.version ?? probeVersion;
  const now = deps.now ?? Date.now;
  const cache = new Map<ProviderDriverKind, { at: number; probe: VersionProbe }>();

  const versionFor = async (driver: ProviderDriverKind, force: boolean): Promise<VersionProbe> => {
    const hit = cache.get(driver);
    if (!force && hit && now() - hit.at < VERSION_CACHE_MS) return hit.probe;
    const probe = await version(driver);
    cache.set(driver, { at: now(), probe });
    return probe;
  };

  return async function probe(
    instances: readonly ProviderInstance[],
    options: { force?: boolean } = {},
  ): Promise<ProviderProbe[]> {
    // One version probe per DRIVER even when five instances share it: the
    // binary is the same and the answer cannot differ between them.
    const drivers = [...new Set(instances.map((instance) => instance.driver))];
    const versions = new Map<ProviderDriverKind, VersionProbe>();
    await Promise.all(
      drivers.map(async (driver) => {
        versions.set(driver, await versionFor(driver, options.force === true));
      }),
    );
    const checkedAt = now();
    return instances.map((instance) => {
      const found = versions.get(instance.driver) ?? { installed: false };
      const sign = signInOf(instance);
      const status = statusOf({
        enabled: instance.enabled,
        installed: found.installed,
        signIn: sign.signIn,
        ...(found.usable === undefined ? {} : { usable: found.usable }),
      });
      // The message says the most actionable true thing, in that order: a
      // missing binary, then anything the CLI resolution has to report about the
      // one it found, then the sign-in note.
      //
      // THE RESOLUTION OUTRANKS THE SIGN-IN NOTE because of what they say. "This
      // CLI is a protocol version this build was not tested against — suspect it
      // first if tool calls are cancelled" is a thing to act on; "sign-in cannot
      // be confirmed from disk" is a statement that nothing can be known, shown
      // on every healthy Claude instance there is. Left in the old order, the
      // drift warning existed and was never once displayed.
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
        ...(message ? { message } : {}),
      };
    });
  };
}
