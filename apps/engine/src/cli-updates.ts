/**
 * WHETHER A NEWER CLI EXISTS, AND WHAT WOULD INSTALL IT.
 *
 * `cli-resolution.ts` answers "where is it and can we talk to it". This answers
 * the question that follows: is it the newest one, and — because "yes, update
 * it" is useless without saying how — what exact command updates THIS install.
 *
 * PORTED FROM T3 Code's `src/provider/providerMaintenance.ts` and
 * `providerMaintenanceRunner.ts`, which had already learned the shape: classify
 * the resolved path to infer the package manager, ask a registry for the newest
 * version, and offer one command derived from the first two. Three deliberate
 * departures, each with a reason:
 *
 *   1. CODEX HAS A NATIVE UPDATE. The donor declares `nativeUpdate: null` for
 *      Codex. `codex --help` on this machine lists `update  Update Codex to the
 *      latest version`, and the install here is the standalone one
 *      (`~/.codex/packages/standalone/`), which no package manager owns. Asking
 *      the binary beat inheriting the claim.
 *   2. A BREW INSTALL IS COMPARED AGAINST BREW. The donor asks npm for the
 *      latest version whatever the install method, so a Homebrew user whose cask
 *      trails npm by a few patches is told an update exists, updates, and is
 *      told again — for ever. The ceiling is whatever the registry you install
 *      FROM has, so that is the one asked.
 *   3. THE PAIRING OUTRANKS THE REGISTRY — see `updateStatusFor`. The donor has
 *      no equivalent because it pins no wrapper version.
 *
 * NOTHING HERE RUNS ON A TIMER. The advisory is computed while the Providers
 * pane is being read (the only caller of the probe) and cached for an hour;
 * `TELAR_NO_UPDATE_CHECKS=1` switches the network half off entirely and leaves
 * everything else — resolution, versions, install method — working.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderUpdateRun } from "@telar/engine-client";
import {
  candidatePathsFor,
  cliLabel,
  findExecutable,
  forgetCliVersions,
  resolveCliAsync,
  type CliId,
  type CliResolution,
} from "./cli-resolution";
import { EngineStateError } from "./state";

const execFileP = promisify(execFile);

/** How the CLI got onto this machine, which is the same question as "what
 *  would replace it". `unknown` is a real answer, not a failure: a binary at a
 *  path nobody recognises is one Telar must not guess an installer for. */
export type InstallMethod = "native" | "homebrew" | "npm" | "bun" | "pnpm" | "vite-plus" | "unknown";

export type UpdateStatus =
  /** Nothing newer is published, as far as the registry was willing to say. */
  | "current"
  /** Something newer is published, and Telar will hand over the command. */
  | "behind"
  /** Something newer is published AND the installed one is exactly what this
   *  build of Telar pairs with. See `updateStatusFor`. */
  | "pinned"
  /** No installed version, no published version, or the check was switched
   *  off. Says nothing rather than guessing "up to date". */
  | "unknown";

/** Where a version number is published, for the install method in hand. */
export type Registry = { kind: "npm"; name: string } | { kind: "homebrew"; cask: string };

export type UpdatePlan = {
  method: InstallMethod;
  /** The command as a person would type it — shown, copied, and run. */
  command: string;
  executable: string;
  args: readonly string[];
  /** Two updates that drive the same package manager are serialized on this.
   *  Concurrent `npm install -g` runs corrupt each other's tree. */
  lockKey: string;
};

export type CliUpdate = {
  status: UpdateStatus;
  /** The newest published version, when a registry answered. */
  latest?: string;
  /** How it was installed, when the path said so. */
  method?: InstallMethod;
  /** The command that updates it. ABSENT ON `pinned` ON PURPOSE — the whole
   *  point of that state is that Telar declines to hand over the gun. */
  command?: string;
};

// ── what installs what ─────────────────────────────────────────────────────

const NPM_PACKAGE: Record<CliId, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/** Both are casks rather than formulae, and `brew upgrade` is explicit about
 *  which so a machine with a same-named formula cannot be sent to the wrong
 *  one. Verified with `brew info --cask`. */
const HOMEBREW_CASK: Record<CliId, string> = {
  claude: "claude-code",
  codex: "codex",
};

/**
 * The CLI's own updater, for the installs no package manager owns.
 *
 * BOTH CLIs HAVE ONE, which is where this departs from the donor. `claude
 * update|upgrade — Check for updates and install if available`; `codex update —
 * Update Codex to the latest version`. Each was read out of `--help` rather
 * than assumed.
 */
const NATIVE_UPDATE: Record<CliId, readonly string[]> = {
  claude: ["update"],
  codex: ["update"],
};

const normalize = (candidate: string): string => candidate.replaceAll("\\", "/").toLowerCase();

/**
 * The native installers, which drop a launcher in `~/.local/bin` and keep the
 * real versions elsewhere.
 *
 * MATCHED ON EITHER THE LINK OR ITS TARGET. `~/.local/bin/claude` is a symlink
 * into `~/.local/share/claude/versions/2.1.229`, and Codex's standalone
 * installer links `~/.local/bin/codex` into `~/.codex/packages/standalone/`.
 * Recognising only one of the two would miss whichever the caller happened to
 * hold.
 */
const NATIVE_PATHS: Record<CliId, (candidate: string) => boolean> = {
  claude: (candidate) => candidate.endsWith("/.local/bin/claude") || candidate.includes("/.local/share/claude/"),
  codex: (candidate) => candidate.endsWith("/.local/bin/codex") || candidate.includes("/.codex/packages/"),
};

const isBunGlobal = (candidate: string): boolean => candidate.includes("/.bun/bin/");

const isVitePlusGlobal = (candidate: string): boolean => candidate.includes("/.vite-plus/bin/");

const isPnpmGlobal = (candidate: string): boolean =>
  candidate.includes("/.local/share/pnpm/") ||
  candidate.includes("/library/pnpm/") ||
  candidate.includes("/local/share/pnpm/") ||
  candidate.includes("/appdata/local/pnpm/") ||
  candidate.includes("/pnpm/global/");

const isNpmGlobal = (candidate: string): boolean =>
  candidate.includes("/node_modules/.bin/") || candidate.includes("/lib/node_modules/") || candidate.includes("/npm/node_modules/");

/**
 * Homebrew, checked LAST of the recognisers.
 *
 * The bare-prefix arms (`/opt/homebrew/bin/`, `/usr/local/bin/`) are why the
 * order matters: npm's own global prefix on an Intel Mac is
 * `/usr/local/lib/node_modules`, linked from `/usr/local/bin`. Reached before
 * the npm test, every npm-installed CLI on that machine would be offered
 * `brew upgrade` for a cask it does not have — which is exactly what following
 * the symlink first prevents.
 */
const isHomebrew = (candidate: string): boolean =>
  candidate.includes("/cellar/") ||
  candidate.includes("/caskroom/") ||
  candidate.startsWith("/opt/homebrew/bin/") ||
  candidate.startsWith("/usr/local/bin/");

function plan(method: InstallMethod, executable: string, args: readonly string[], lockKey: string): UpdatePlan {
  return { method, command: [executable, ...args].join(" "), executable, args, lockKey };
}

/**
 * What would update the install at these paths, or nothing.
 *
 * TAKES BOTH THE PATH AND ITS TARGET because a link and its target say
 * different true things, and either may be the one that identifies the
 * installer. Every recogniser is asked about both.
 *
 * NOTHING IS RETURNED FOR AN UNRECOGNISED PATH, and that is the honest answer
 * rather than a gap: the donor falls back to "assume npm global", which on a
 * machine where somebody built the CLI themselves would offer a command that
 * silently replaces their build with a published one.
 */
export function updatePlanFor(id: CliId, paths: { path?: string; realPath?: string }): UpdatePlan | undefined {
  const candidates = [paths.path, paths.realPath].filter((candidate): candidate is string => Boolean(candidate)).map(normalize);
  if (candidates.length === 0) return undefined;

  const native = NATIVE_PATHS[id];
  if (candidates.some(native)) {
    // The CLI's own updater, spawned by its RESOLVED path rather than its name:
    // the whole reason `cli-resolution.ts` exists is that a packaged app cannot
    // count on finding it any other way.
    return plan("native", paths.path ?? id, NATIVE_UPDATE[id], `native-${id}`);
  }
  if (candidates.some(isVitePlusGlobal)) return plan("vite-plus", "vp", ["i", "-g", NPM_PACKAGE[id]], "vite-plus-global");
  if (candidates.some(isBunGlobal)) return plan("bun", "bun", ["i", "-g", `${NPM_PACKAGE[id]}@latest`], "bun-global");
  if (candidates.some(isPnpmGlobal)) return plan("pnpm", "pnpm", ["add", "-g", `${NPM_PACKAGE[id]}@latest`], "pnpm-global");
  if (candidates.some(isNpmGlobal)) return plan("npm", "npm", ["install", "-g", `${NPM_PACKAGE[id]}@latest`], "npm-global");
  if (candidates.some(isHomebrew)) return plan("homebrew", "brew", ["upgrade", "--cask", HOMEBREW_CASK[id]], "homebrew");
  return undefined;
}

/** Ask the registry this install would actually come from — see departure (2)
 *  in the header. An unrecognised install is compared against npm, which is
 *  where both CLIs publish and the best available guess at a ceiling. */
function registryFor(id: CliId, method: InstallMethod | undefined): Registry {
  return method === "homebrew" ? { kind: "homebrew", cask: HOMEBREW_CASK[id] } : { kind: "npm", name: NPM_PACKAGE[id] };
}

// ── comparing two version strings ──────────────────────────────────────────

function versionParts(version: string): { numbers: number[]; pre: string } {
  const [core, ...rest] = version.trim().replace(/^v/i, "").split("-");
  return {
    numbers: (core ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: rest.join("-"),
  };
}

/**
 * `-1`, `0` or `1`, on the dotted numbers and then the prerelease tag.
 *
 * NOT A FULL SEMVER IMPLEMENTATION and does not need to be: the inputs are two
 * CLIs that publish `2.1.229` and `0.147.0`. The prerelease arm is here for the
 * one case that would otherwise be actively wrong — `2.2.0-beta.1` must not
 * read as newer than `2.2.0`, or a beta tester is told for ever that they are
 * behind a version they already passed.
 */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const width = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * THE VERDICT, AND THE ONE RULE THE DONOR CANNOT EXPRESS.
 *
 * `pinned` is what happens when the installed version is EXACTLY the one this
 * build of Telar pairs with (`cli-resolution.ts` derives it from the Agent
 * SDK's wrapper) and something newer exists. The donor would call that "behind
 * latest" and offer a button.
 *
 * It must not. The wrapper and the CLI speak a control protocol to each other,
 * and the failure when they disagree is not a clean error — it is phantom tool
 * cancellations nobody can attribute. An install sitting exactly on the tested
 * pairing is in the best state Telar can verify, and a one-click button that
 * moves it off that state would be Telar breaking its own pairing, on its own
 * advice. So the newer version is REPORTED and no command is handed over; the
 * user can still update the CLI themselves, and Telar's own auto-update will
 * bring a newer pairing in its own time.
 */
export function updateStatusFor(input: { installed?: string | undefined; latest?: string | undefined; expected?: string | undefined }): UpdateStatus {
  if (!input.installed || !input.latest) return "unknown";
  if (compareVersions(input.installed, input.latest) >= 0) return "current";
  return input.expected && input.installed === input.expected ? "pinned" : "behind";
}

// ── what the registry says ─────────────────────────────────────────────────

/** An hour. The registries are asked while somebody reads a settings pane, and
 *  a CLI does not ship often enough for a fresher answer to be worth a request
 *  per repaint. */
const LATEST_TTL_MS = 60 * 60 * 1_000;

/** Short on purpose: this is on the path of a page load, and an advisory is the
 *  least important thing on it. A registry that has not answered in four
 *  seconds is one this probe does without. */
const LATEST_TIMEOUT_MS = 4_000;

const latestCache = new Map<string, { at: number; version: string | null }>();

/** Cleared between tests, and after an update in case a cask and its npm
 *  package disagree about what "latest" now means. */
export function forgetLatestVersions(): void {
  latestCache.clear();
}

/** The one switch. Off, everything else still works — the version, the install
 *  method and the pairing verdict are all local facts. */
export function updateChecksEnabled(): boolean {
  return process.env.TELAR_NO_UPDATE_CHECKS !== "1";
}

/** A cask version can carry a build after a comma (`1.2.3,456`); npm's never
 *  does. Taking the part before it keeps the two comparable. */
const cleanVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.split(",")[0]?.trim();
  return trimmed ? trimmed : null;
};

/**
 * The transport, and nothing else.
 *
 * THE CACHE IS NOT IN HERE, deliberately: it is a policy about how often to ask
 * and this is the one part a test has to replace. With the two together, every
 * test that injected a fetcher would silently skip the caching — which is
 * exactly the code most worth pinning, since it is what stands between a
 * settings repaint and a request per repaint.
 */
async function fetchLatest(registry: Registry): Promise<string | null> {
  const url =
    registry.kind === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(registry.name)}/latest`
      : `https://formulae.brew.sh/api/cask/${encodeURIComponent(registry.cask)}.json`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
    });
    // FAIL SOFT, ALWAYS. Every way this can go wrong — offline, rate-limited,
    // a package renamed out from under us — ends as `unknown`, which the pane
    // renders as silence. An advisory is a nicety; a settings page that cannot
    // load without the network is not.
    return response.ok ? cleanVersion(((await response.json()) as { version?: unknown }).version) : null;
  } catch {
    return null;
  }
}

/** An hour's worth of one answer, and one more when a person asks. A failed
 *  lookup is cached too — a machine that is offline should not spend four
 *  seconds discovering it again on every repaint. */
async function latestVersion(
  registry: Registry,
  now: () => number,
  force: boolean,
  fetcher: (registry: Registry) => Promise<string | null>,
): Promise<string | null> {
  const key = registry.kind === "npm" ? `npm:${registry.name}` : `brew:${registry.cask}`;
  const cached = latestCache.get(key);
  if (!force && cached && now() - cached.at < LATEST_TTL_MS) return cached.version;
  const version = await fetcher(registry);
  latestCache.set(key, { at: now(), version });
  return version;
}

// ── the advisory ───────────────────────────────────────────────────────────

export type CliUpdateDeps = {
  /** The transport only — the hour cache wraps whatever is given, so a test
   *  that replaces this still exercises it. */
  latest?: (registry: Registry) => Promise<string | null>;
  now?: () => number;
  /** Past the hour cache. Set by the pane's Re-check button and by nothing on
   *  a repaint path — "ask again" is a gesture, never a render. */
  force?: boolean;
};

/**
 * The whole answer for one CLI, given what the resolver already found.
 *
 * TAKES A RESOLUTION rather than doing its own, so the version in the advisory
 * is the version on the row beside it. Two probes of the same binary answering
 * differently is the class of bug that put a PATH version on the pane while a
 * different binary did the work.
 */
export async function cliUpdateFor(resolution: CliResolution, deps: CliUpdateDeps = {}): Promise<CliUpdate> {
  const now = deps.now ?? Date.now;
  const fetcher = deps.latest ?? fetchLatest;

  const found = updatePlanFor(resolution.id, {
    ...(resolution.path ? { path: resolution.path } : {}),
    ...(resolution.realPath ? { realPath: resolution.realPath } : {}),
  });
  const method = found?.method;

  // No installed version means nothing to compare, and asking a registry would
  // spend a request to learn something unusable.
  if (!resolution.version || !updateChecksEnabled()) {
    return { status: "unknown", ...(method ? { method } : {}) };
  }

  const latest = await latestVersion(registryFor(resolution.id, method), now, deps.force === true, fetcher);
  const status = updateStatusFor({
    installed: resolution.version,
    ...(latest ? { latest } : {}),
    ...(resolution.expected ? { expected: resolution.expected } : {}),
  });
  return {
    status,
    ...(latest ? { latest } : {}),
    ...(method ? { method } : {}),
    // Withheld on `pinned`, and on every state with nothing to do.
    ...(status === "behind" && found ? { command: found.command } : {}),
  };
}

// ── running it ─────────────────────────────────────────────────────────────

/** Long enough for `npm install -g` on a cold cache and a slow link, short
 *  enough that a wedged installer does not hold a lock for ever. */
const RUN_TIMEOUT_MS = 5 * 60_000;

/** Enough to read what went wrong, capped so a chatty installer cannot put a
 *  megabyte of progress bars through the HTTP layer. */
const RUN_OUTPUT_MAX = 10_000;

/** THE WIRE SHAPE ITSELF, aliased rather than re-declared — this is what the
 *  route returns, and two structurally-similar definitions is how a field gets
 *  added on one side only. */
export type CliUpdateRun = ProviderUpdateRun;

/** One update per CLI at a time — a second press is refused rather than
 *  queued, because the first is already doing the thing being asked for. */
const running = new Set<CliId>();

/** Updates that drive the same package manager wait for each other. Concurrent
 *  `npm install -g` runs interleave writes into one global tree. */
const queues = new Map<string, Promise<unknown>>();

function truncate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= RUN_OUTPUT_MAX ? trimmed : `${trimmed.slice(0, RUN_OUTPUT_MAX)}\n…`;
}

/**
 * The executable, resolved the same way a CLI is.
 *
 * THE PACKAGED-APP FAILURE, ONE LAYER OUT. Finder hands an app an environment
 * with almost nothing on PATH, which is why `cli-resolution.ts` exists at all —
 * and `npm` is no more findable there than `claude` was. A bare spawn here
 * would fail with ENOENT in the one build where it matters most.
 */
function resolveRunner(plan: UpdatePlan): string {
  // A native update names its own resolved path, which is already absolute.
  if (plan.executable.includes("/")) return plan.executable;
  const found = findExecutable(plan.executable);
  if (!found) {
    throw new EngineStateError(
      "invalid_request",
      `Telar could not find \`${plan.executable}\` on this machine, so it cannot run \`${plan.command}\` for you. ` +
        `It looked in ${candidatePathsFor(plan.executable).slice(0, 3).join(", ")} and on PATH. Run the command in your own terminal instead.`,
    );
  }
  return found;
}

async function spawnUpdate(plan: UpdatePlan): Promise<CliUpdateRun> {
  const executable = resolveRunner(plan);
  try {
    const { stdout, stderr } = await execFileP(executable, [...plan.args], {
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 1 << 20,
    });
    const output = truncate(`${stderr}\n\n${stdout}`);
    return {
      ok: true,
      command: plan.command,
      exitCode: 0,
      timedOut: false,
      ...(output ? { output } : {}),
      message: "Updated.",
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    const timedOut = failure.killed === true;
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    const output = truncate(`${failure.stderr ?? ""}\n\n${failure.stdout ?? ""}`);
    return {
      ok: false,
      command: plan.command,
      ...(exitCode === undefined ? {} : { exitCode }),
      timedOut,
      ...(output ? { output } : {}),
      message: timedOut
        ? `\`${plan.command}\` was still running after five minutes and was stopped.`
        : exitCode === undefined
          ? `\`${plan.command}\` could not be run.`
          : `\`${plan.command}\` exited with code ${exitCode}.`,
    };
  }
}

export type CliUpdateRunDeps = CliUpdateDeps & {
  /** INJECTED so a test can reach the refusals without a machine that happens
   *  to have the right CLI installed the right way. */
  resolve?: (id: CliId) => Promise<CliResolution>;
  /** INJECTED so a test never actually runs `npm install -g`. */
  spawn?: (plan: UpdatePlan) => Promise<CliUpdateRun>;
};

/**
 * Update one CLI, and say what happened.
 *
 * THE COMMAND IS DERIVED HERE AND NEVER ACCEPTED FROM A CALLER. The route above
 * this takes a driver name and nothing else. A route that took a command string
 * would be a remote shell wearing a settings button, and this daemon is already
 * reachable by anything on the tailnet.
 *
 * REFUSES RATHER THAN GUESSES, in four different ways — no install, an install
 * nobody recognises, a manager that is not here, and a pinned version. Each
 * throws with the sentence a person would need to fix it themselves.
 */
export async function runCliUpdate(id: CliId, deps: CliUpdateRunDeps = {}): Promise<CliUpdateRun> {
  /**
   * CLAIMED BEFORE THE FIRST `await`, and that placement is the whole guard.
   * Behind even one await, two requests arriving together both pass the check
   * and both spawn an installer — the exact race a lock exists to stop, made
   * invisible by the fact that a single-threaded runtime looks like it cannot
   * have one.
   */
  if (running.has(id)) {
    throw new EngineStateError("conflict", `An update of ${cliLabel(id)} is already running.`);
  }
  running.add(id);
  try {
    return await update(id, deps);
  } finally {
    running.delete(id);
  }
}

async function update(id: CliId, deps: CliUpdateRunDeps): Promise<CliUpdateRun> {
  const resolution = await (deps.resolve ?? resolveCliAsync)(id);
  if (resolution.status === "missing") {
    throw new EngineStateError("invalid_request", resolution.message ?? `No ${id} installation to update.`);
  }

  const advisory = await cliUpdateFor(resolution, deps);
  if (advisory.status === "pinned") {
    throw new EngineStateError(
      "conflict",
      `${resolution.label} ${resolution.version} is exactly the version this build of Telar pairs with. ` +
        `${advisory.latest} exists, but updating would move off the tested pairing — so Telar will not do it for you.`,
    );
  }

  const found = updatePlanFor(id, {
    ...(resolution.path ? { path: resolution.path } : {}),
    ...(resolution.realPath ? { realPath: resolution.realPath } : {}),
  });
  if (!found) {
    throw new EngineStateError(
      "invalid_request",
      `Telar could not tell how ${resolution.label} was installed (${resolution.path}), so it does not know what would update it. ` +
        "Update it the way you installed it.",
    );
  }

  // Chained on the lock key, and on the SETTLED previous run: a failed update
  // of one CLI must not cancel a queued update of another that happens to
  // share a package manager.
  const run = deps.spawn ?? spawnUpdate;
  const previous = queues.get(found.lockKey) ?? Promise.resolve();
  const mine = previous.then(
    () => run(found),
    () => run(found),
  );
  queues.set(
    found.lockKey,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  const result = await mine;
  // The next read must see the new binary, not the one just replaced — which
  // is the entire point of the caller re-probing straight afterwards.
  forgetCliVersions();
  forgetLatestVersions();
  return result;
}
