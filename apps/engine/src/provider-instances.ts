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
import type { ProviderDriverKind, ProviderInstance, ProviderProbe, ProviderSignIn, ProviderUpdate } from "@telar/engine-client";
import { cliUsable, resolveCliAsync, type CliId } from "./cli-resolution";
import { cliUpdateFor } from "./cli-updates";
import { TELAR_ENGINE_VERSION } from "./version";

/**
 * A version probe costs a subprocess, and this is read from a settings page
 * that repaints.
 *
 * CACHED PER (DRIVER, BINARY PATH) rather than per driver. It used to be per
 * driver, on the reasoning that two instances of one driver run the same binary
 * and only their config folders differ. That stopped being true the moment a
 * login could pin its own `binaryPath` — and the failure would have been
 * silent: the second login would report the first one's version, which is
 * precisely the "the pane is not describing the binary that answers you" bug
 * this file already carries a warning about.
 */
const VERSION_CACHE_MS = 60_000;

/** The file whose PRESENCE means this provider has been logged in inside a
 *  config folder. Never opened. */
const LOGIN_ARTIFACT: Record<ProviderDriverKind, string> = {
  opencode: "auth.json",
  claude: ".credentials.json",
  codex: "auth.json",
};

/** The variable that relocates a provider's whole config and credential
 *  directory. Claude: creds in the macOS Keychain, keyed per directory. Codex:
 *  creds in `auth.json` inside it — file-based, and therefore portable. */
const CONFIG_DIR_ENV: Record<ProviderDriverKind, string> = {
  opencode: "OPENCODE_CONFIG_DIR",
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

/**
 * OF THE OWNED NAMES, THE ONES THAT CARRY A CREDENTIAL.
 *
 * Used for one decision only: when a variable is CARRIED OVER from the engine's
 * own environment into an instance's declarations, this is what decides whether
 * the value goes to the 0600 secret store (never read back, redacted on every
 * list) or stays a plain row a person can read on the settings page.
 *
 * AN EXPLICIT LIST RATHER THAN A HEURISTIC over the name, because both ways of
 * being wrong cost something real and they are not symmetrical: a credential
 * filed as plain text is echoed to whoever opens the pane, and a routing fact
 * filed as a secret becomes unreadable to the person who set it. A name spelled
 * out here is a decision somebody made and a reviewer can check.
 */
const CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
]);

/**
 * WHAT MAKES AN INSTANCE "CONFIGURED" — one spelling, because two places now
 * ask.
 *
 * The scrub below asks so it knows whether to run; `stoppedInheriting` asks so
 * it knows whether this save is the TRANSITION. A second copy of the predicate
 * would let the warning and the behaviour it warns about drift apart, which is
 * the one bug a warning must not have.
 */
export function providerInstanceConfigured(instance: Pick<ProviderInstance, "configDir" | "env">): boolean {
  return instance.configDir !== undefined || instance.env.length > 0;
}

/**
 * THE OWNED VARIABLES THIS ENGINE IS ACTUALLY PASSING DOWN — NAMES, NEVER
 * VALUES.
 *
 * Reads the engine's OWN environment, which is the whole trick: what a child
 * would have inherited is what this process carries, so nothing has to be
 * spawned or inspected to find out.
 *
 * AN EMPTY VALUE IS NOT AN INHERITANCE. `ANTHROPIC_BASE_URL=` reaches a child as
 * a variable the CLI reads as unset, so losing it loses nothing — and warning
 * about it would be a warning nobody can act on, which is the failure the issue
 * spends a paragraph on.
 *
 * ON A DOCK-LAUNCHED MAC THIS IS EMPTY for every driver, and that is the
 * expected answer rather than a degenerate one.
 */
export function inheritedOwnedEnv(
  driver: ProviderDriverKind,
  ambient: Record<string, string | undefined> = process.env,
): string[] {
  return OWNED_ENV[driver].filter((name) => (ambient[name] ?? "").trim() !== "");
}

/** Whether a carried-over value belongs in the 0600 store rather than in the
 *  registry a settings page reads. */
export function providerEnvIsCredential(name: string): boolean {
  return CREDENTIAL_ENV.has(name);
}

/** Whether this driver owns the name at all — the guard on a carry-over
 *  request, so a name outside the scrub's reach is refused rather than written
 *  as a declaration that protects nothing. */
export function providerOwnsEnv(driver: ProviderDriverKind, name: string): boolean {
  return OWNED_ENV[driver].includes(name);
}

/**
 * WHICH VARIABLES A CHANGE WOULD STOP THIS LOGIN INHERITING — names, never
 * values.
 *
 * This is the whole of #594. The scrub is right and does not change; what was
 * wrong is that it fired in SILENCE, and after #593 it fires from a control
 * ("compact after N tokens") whose reader was thinking about compaction and
 * nothing else. So the engine now says, at the moment of the change, which
 * variables this login is about to stop receiving.
 *
 * THREE CONDITIONS, AND EVERY ONE OF THEM NARROWS:
 *
 *   · ONLY ON THE TRANSITION. An instance that was already configured has
 *     already stopped inheriting; a second variable changes nothing for it, and
 *     re-announcing on every later save is how a warning becomes wallpaper.
 *   · ONLY IF SOMETHING IS ACTUALLY INHERITED. A Mac launched from the Dock
 *     carries none of these, so this is empty and nothing is said.
 *   · NEVER ABOUT A VARIABLE THE CHANGE ITSELF SUPPLIES. A declared variable
 *     survives the scrub (it is applied last, below), and a config folder
 *     REPLACES the config-dir variable on purpose — that is what a config
 *     folder is for. Neither is a loss, and naming them would send someone to
 *     fix something that is working.
 *
 * NAMES ONLY, AND THAT IS A RULE RATHER THAN A CHOICE OF FORMAT. Three of the
 * names this can return are `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and
 * `CLAUDE_CODE_OAUTH_TOKEN`. A warning that helpfully showed what was about to
 * be lost would be a credential printed on a settings page, in an HTTP
 * response, and in whatever log caught it.
 */
export function stoppedInheriting(input: {
  /** The instance as it stands, or undefined when this save creates it. */
  before: Pick<ProviderInstance, "configDir" | "env"> | undefined;
  /** The instance this save would produce. */
  after: Pick<ProviderInstance, "driver" | "configDir" | "env">;
  ambient?: Record<string, string | undefined>;
}): string[] {
  if (input.before && providerInstanceConfigured(input.before)) return [];
  if (!providerInstanceConfigured(input.after)) return [];
  const supplied = new Set(input.after.env.map((variable) => variable.name));
  if (input.after.configDir !== undefined) supplied.add(CONFIG_DIR_ENV[input.after.driver]);
  return inheritedOwnedEnv(input.after.driver, input.ambient ?? process.env).filter((name) => !supplied.has(name));
}

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
 *
 * THE TRIGGER IS SHARED WITH THE WARNING (`providerInstanceConfigured`), so the
 * sentence a person reads and the deletion it describes cannot disagree — #594.
 */
export function providerProcessEnv(instance: ProviderInstance): Record<string, string | undefined> {
  const configured = providerInstanceConfigured(instance);
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
  /** Whether something newer is published, and what would install it. A fact
   *  about the BINARY, so every instance of a driver carries the same one. */
  update?: ProviderUpdate;
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
 *
 * TAKES A `CliId` RATHER THAN A DRIVER KIND, since `telar` names no CLI: the
 * caller answers for that one before it gets here (see `versionFor`), and the
 * narrower parameter is what makes "before" a rule the compiler keeps rather
 * than a comment.
 */
async function probeVersion(driver: CliId, binaryPath?: string, force = false): Promise<VersionProbe> {
  const resolution = await resolveCliAsync(driver, { ...(binaryPath ? { binaryPath } : {}) });
  if (resolution.status === "missing") {
    return { installed: false, ...(resolution.message ? { message: resolution.message } : {}) };
  }
  return {
    installed: true,
    ...(resolution.version ? { version: resolution.version } : {}),
    // The one network call on this path, capped at four seconds and failing
    // soft to `unknown` — a settings page that cannot load without the network
    // would be a worse thing than an absent advisory.
    update: await cliUpdateFor(resolution, { force }),
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
  /** `CliId`, not `ProviderDriverKind`: a deployment's own probe answers "which
   *  CLI is on this machine", and `telar` is not one — see `versionFor`. */
  version?: (driver: CliId, binaryPath: string | undefined, force: boolean) => Promise<VersionProbe>;
  now?: () => number;
};

export function createProviderProber(deps: ProviderProbeDeps = {}) {
  const version = deps.version ?? probeVersion;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; probe: VersionProbe }>();

  /** What two instances must agree on to share one probe. An unpinned login and
   *  one pinned to the same bare name are still two keys — cheap, and the
   *  alternative is normalising a string whose meaning depends on PATH. */
  const keyFor = (driver: ProviderDriverKind, binaryPath: string | undefined): string => `${driver} ${binaryPath ?? ""}`;

  const versionFor = async (driver: ProviderDriverKind, binaryPath: string | undefined, force: boolean): Promise<VersionProbe> => {
    /**
     * THERE IS NO BINARY TO FIND, so nobody is asked — not `resolveCliAsync`,
     * which knows only the three real CLIs, and not an injected `version`
     * either. Telar's own loop runs inside this process: "installed" is true by
     * construction and the version that answers a turn is this build's. A
     * deployment (or a test) that supplies its own probe is answering "which
     * CLI is on this machine", which is not a question about this driver.
     *
     * NOT CACHED, for the same reason: there is nothing that could change.
     */
    const key = keyFor(driver, binaryPath);
    const hit = cache.get(key);
    if (!force && hit && now() - hit.at < VERSION_CACHE_MS) return hit.probe;
    // `force` reaches all the way down: Re-check means ask the machine AND the
    // registry again, not "re-run the subprocess and re-read an hour-old
    // answer about what is published".
    const probe = await version(driver, binaryPath, force);
    cache.set(key, { at: now(), probe });
    return probe;
  };

  return async function probe(
    instances: readonly ProviderInstance[],
    options: { force?: boolean } = {},
  ): Promise<ProviderProbe[]> {
    // ONE PROBE PER DISTINCT BINARY, not per instance and no longer per driver:
    // five logins sharing the default `claude` cost one subprocess between them,
    // and a login that pinned its own gets its own answer.
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
        // A fact about the BINARY, so it is shared by every login that resolves
        // to the same one and differs for a login that pinned its own.
        ...(found.update ? { update: found.update } : {}),
        ...(message ? { message } : {}),
      };
    });
  };
}
