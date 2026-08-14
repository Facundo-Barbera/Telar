/**
 * WHERE THE CLIs ACTUALLY ARE, AND WHETHER WE CAN TALK TO THEM.
 *
 * Telar drives two CLIs it does not ship — Claude Code and Codex — and a
 * packaged app is where that stops being a detail. Finder gives an app a
 * minimal environment in which bare `claude` on PATH is simply not there, and
 * the Agent SDK's own fallback is a ~272MB platform binary this app does not
 * bundle. T3 Code makes the same call: its `app.asar` carries the SDK's three
 * JavaScript files and none of the binary, and resolves a real install instead.
 *
 * PORTED FROM `packages/core/src/cli-resolution.ts`, which learned all of this
 * the expensive way, and NOT imported from it: `apps/engine` deliberately does
 * not depend on `@telar/core`. `codex/app-server.ts` already carried a
 * transcription of the candidate order for the same reason and names this
 * module's arrival in its own header. That transcription now delegates here, so
 * there is one candidate list rather than two that can drift.
 *
 * WHAT THE VERSION CHECK IS FOR. The npm wrapper and the CLI speak a control
 * protocol to each other. Claude Code updates itself on its own schedule; this
 * app's wrapper updates when we ship. Unchecked, that drift is silent, and its
 * failure mode is not a clean error — it is protocol-level misbehaviour
 * surfacing as phantom tool cancellations nobody can attribute (a 0.3.204
 * wrapper was once found driving a 2.1.222 CLI). So this resolves the binary AND
 * says whether it is a version we expect to work with.
 */

import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Which CLI a resolution is about. Also the binary name on every candidate
 *  path below — kept as a field on the spec so a CLI whose binary name differs
 *  from its id would have one place to say so. */
export type CliId = "claude" | "codex";

export type CliStatus =
  /** Resolved, and (where a pairing exists) its version is the one expected. */
  | "ok"
  /** Resolved, same protocol family, different patch. Works in practice; worth
   *  surfacing because it is the first thing to suspect when the control
   *  protocol misbehaves. Only a CLI with a declared pairing reports this. */
  | "drifted"
  /** Resolved, but a different major/minor. Not a compatibility promise. */
  | "incompatible"
  /** Nothing found on any candidate path. */
  | "missing"
  /** Found, but it would not report a version. */
  | "unknown"
  /** Found AND versioned, but the version it pairs with was unreadable, so no
   *  compatibility check was made. Distinct from `unknown` on purpose: one is a
   *  CLI that would not answer, the other is a CLI that answered and had nothing
   *  to be judged against. Conflating them made a settings pane print "it would
   *  not report a version" directly above the version it reported. */
  | "unverified";

export type CliResolution = {
  id: CliId;
  /** Display name, e.g. "Claude Code" — so a surface never has to map ids. */
  label: string;
  status: CliStatus;
  /** Absent only when status is `missing`. */
  path?: string;
  /**
   * `path` with every symlink followed, when it could be read.
   *
   * BOTH ARE KEPT because the two answer different questions and the install
   * detector in `cli-updates.ts` needs each. `~/.local/bin/claude` is a symlink
   * into `~/.local/share/claude/versions/`, and an npm global install is a
   * symlink from a bin directory into `lib/node_modules/` — so the link says
   * where it is invoked from and the target says who put it there.
   */
  realPath?: string;
  /** The CLI's own reported version, e.g. `2.1.222`. */
  version?: string;
  /** What this build pairs with, when such a thing exists. Codex has no wrapper
   *  to derive one from, so it is always absent there — an ABSENT expectation is
   *  a fact a surface states, not a gap it fills in. */
  expected?: string;
  /** Set for every status except `ok` — user-facing and actionable, saying what
   *  to do rather than only what is wrong. */
  message?: string;
};

type CliSpec = {
  id: CliId;
  label: string;
  bin: string;
  /** Env var holding an explicit full path, which wins over everything. */
  overrideEnv: string;
  /** Appended to the `missing` message: what to install, and how. */
  installHint: string;
  /** The version this build pairs with, if the pairing is knowable at all.
   *  Omitted entirely for a CLI Telar speaks to directly. */
  expectedVersion?: () => string | undefined;
  /** Called only when BOTH a detected and an expected version exist. Absent ⇒
   *  any version that reports itself is `ok`: inventing a compatibility rule for
   *  a CLI with no declared pairing would be a guess wearing a verdict's
   *  clothes. */
  verdict?: (found: string, expected: string, executable: string) => { status: CliStatus; message?: string };
};

/**
 * THE CLAUDE PAIRING IS DERIVED, NOT HARDCODED. Wrapper and CLI are versioned
 * differently — wrapper 0.3.224 ships CLI 2.1.224 — but the PATCH component is
 * the same number, and that is the release-train identity. Reading it from the
 * installed wrapper means this updates itself on a dependency bump instead of
 * becoming a constant somebody forgets.
 */
export function expectedClaudeCliVersion(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url);
    /**
     * READ THROUGH THE DOOR THAT IS OPEN.
     *
     * This used to `require("@anthropic-ai/claude-agent-sdk/package.json")`,
     * which Node refuses with ERR_PACKAGE_PATH_NOT_EXPORTED: the SDK's
     * `exports` map lists `.`, `./extract`, `./browser`, `./bridge` and the
     * sdk-tools, and NOT `./package.json`. Bun's resolver allows the deep
     * import anyway — so the pairing check worked in dev and silently did not
     * in the packaged app, which reported `unverified` and ran every CLI
     * without a compatibility check. The one build where the check matters
     * most was the one build without it.
     *
     * The entry point IS exported, so resolve that and walk up to the manifest
     * beside it. `exports` governs specifiers, not the filesystem.
     */
    let dir = path.dirname(require_.resolve("@anthropic-ai/claude-agent-sdk"));
    // Bounded: a package entry is never far from its own manifest, and an
    // unbounded walk would climb out of node_modules and read somebody else's.
    for (let hop = 0; hop < 5; hop += 1) {
      const manifest = path.join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
        // Checked by name, so a nested manifest cannot be mistaken for the
        // SDK's own and pair us against the wrong version entirely.
        if (pkg.name === "@anthropic-ai/claude-agent-sdk") {
          const patch = pkg.version?.split(".")[2];
          return patch ? `2.1.${patch}` : undefined;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const SPECS: Record<CliId, CliSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    overrideEnv: "CLAUDE_CODE_EXECUTABLE",
    installHint:
      "Install Claude Code (https://claude.com/claude-code) and sign in, then restart Telar. " +
      "If it is installed somewhere unusual, set CLAUDE_CODE_EXECUTABLE to its full path.",
    expectedVersion: expectedClaudeCliVersion,
    verdict: (version, expected, executable) => {
      const [major, minor] = version.split(".");
      const [xMajor, xMinor] = expected.split(".");
      if (major !== xMajor || minor !== xMinor) {
        return {
          status: "incompatible",
          // SHORT ENOUGH TO READ ON A SETTINGS ROW. These are hints under a
          // name, not paragraphs; the earlier wording explained the control
          // protocol at length and buried the two facts that matter — which
          // version is wrong, and what to do.
          message: `Needs Claude Code ${xMajor}.${xMinor}.x, found ${version}. Update Telar, or install a matching Claude Code.`,
        };
      }
      if (version !== expected) {
        return {
          status: "drifted",
          // No path: this one is working, and the version pair is the point.
          message: `Tested against Claude Code ${expected}; you have ${version}. Usually fine — suspect it first if tool calls cancel themselves.`,
        };
      }
      return { status: "ok" };
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    // Kept as it was before this module existed. An env var is an instruction
    // somebody typed into a shell profile, and renaming one silently stops
    // honouring it.
    overrideEnv: "CODEX_BIN",
    installHint:
      "Install it (https://github.com/openai/codex) and sign in, or set CODEX_BIN to its full path, then retry.",
  },
};

/**
 * The directories on PATH, which is the authoritative list.
 *
 * IT WAS LAST, AND THAT WAS WRONG. The reasoning was that PATH is the thing a
 * Finder-launched app cannot trust, so three known install directories were
 * searched ahead of it. But the fix for a bad PATH is to repair the PATH
 * (`host-path.ts` now does, at boot, from the login shell), and searching a
 * fixed list first means Telar can run a DIFFERENT BINARY THAN THE USER'S OWN
 * TERMINAL DOES — a stale `~/.local/bin/claude` beating the nvm/mise/bun copy
 * their shell resolves. The pane would then report a version nobody could
 * reproduce, which is the exact failure this module's header exists to prevent.
 * T3 Code has no such list at all: bare name, PATH, done.
 *
 * ABSOLUTE ONLY, and that is not pedantry: a PATH entry of "." or "bin" joins to
 * a bare or cwd-relative name (`path.join(".", "codex") === "codex"`), which is
 * precisely the bare-name spawn this module exists to stop.
 */
const pathCandidates = (bin: string): string[] =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, bin))
    .filter((candidate) => path.isAbsolute(candidate));

/**
 * The three well-known install directories, as a NET rather than a preference.
 *
 * Reached only after PATH, and they earn their place solely in the case that
 * remains after `host-path.ts`: a machine whose login shell would not answer
 * and whose `launchctl` PATH is empty too. Without them that machine finds
 * nothing at all; ahead of PATH they would override a working answer.
 */
const FALLBACK_DIRS = (bin: string): string[] => [
  path.join(os.homedir(), ".local", "bin", bin),
  `/opt/homebrew/bin/${bin}`,
  `/usr/local/bin/${bin}`,
];

/**
 * Everywhere a binary of this name might be, best first.
 *
 * TAKES A BARE NAME rather than a `CliId` because the CLIs are not the only
 * thing this app has to find. Updating a provider means running its package
 * manager — `npm`, `brew`, `bun` — and a packaged app spawning a bare `npm`
 * fails exactly the way a bare `claude` did, for exactly the same reason. One
 * search order, so a helper cannot be looked for somewhere a CLI would not be.
 */
export function candidatePathsFor(bin: string, override?: string | undefined): string[] {
  const seen = new Set<string>();
  return [override, ...pathCandidates(bin), ...FALLBACK_DIRS(bin)]
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

/**
 * A file this process could actually run.
 *
 * `existsSync` WAS NOT THE QUESTION. A directory named `claude`, or a file
 * without its executable bit — an interrupted install, a `git checkout` that
 * dropped the mode, a copy off a FAT volume — counted as found, and the failure
 * surfaced later as a spawn EACCES with nothing naming the cause. T3 Code
 * checks `X_OK`; so does this now.
 */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function cliCandidatePaths(id: CliId): string[] {
  const spec = SPECS[id];
  return candidatePathsFor(spec.bin, process.env[spec.overrideEnv]);
}

/** The first runnable candidate, or nothing. The un-judged half of `resolveCli`
 *  — used for helpers that have no version to check. */
export function findExecutable(bin: string): string | undefined {
  return candidatePathsFor(bin).find(isExecutableFile);
}

/** The brand name, without resolving anything. For the messages that have to
 *  be written before a resolution exists. */
export function cliLabel(id: CliId): string {
  return SPECS[id].label;
}

/** Keyed on (path, mtime) rather than for the process lifetime, so a CLI that
 *  upgrades ITSELF while Telar runs is noticed on the next turn instead of being
 *  reported at whatever it was at boot. */
const versionCache = new Map<string, string | null>();

/** In-flight async probes, so N concurrent readers of the settings pane spawn
 *  ONE `--version` between them rather than one each. */
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(executable: string): string {
  try {
    return `${executable}:${statSync(executable).mtimeMs}`;
  } catch {
    return executable;
  }
}

/**
 * Throw the version cache away.
 *
 * BELT AND BRACES, called after Telar itself updates a CLI. The (path, mtime)
 * key already invalidates itself for every installer seen so far — a new binary
 * has a new mtime, and a retargeted symlink stats through to the new file. But
 * "so far" is doing real work in that sentence: an installer that preserves
 * timestamps would leave this reporting the version it replaced, and the moment
 * that matters most is the one right after an update, when the pane is about to
 * be re-read to prove the update worked.
 */
export function forgetCliVersions(): void {
  versionCache.clear();
}

// `claude --version` says "2.1.222 (Claude Code)"; `codex --version` says
// "codex-cli 0.145.0".
const parseVersion = (out: string): string | null => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;

const PROBE = { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 } as const;

function detectVersion(executable: string): string | null {
  const key = cacheKey(executable);
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  let version: string | null = null;
  try {
    version = parseVersion(execFileSync(executable, ["--version"], { ...PROBE, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    version = null;
  }
  versionCache.set(key, version);
  return version;
}

/**
 * The same probe, off the event loop.
 *
 * WHY BOTH EXIST. The sync one runs at the moment a turn spawns a provider, in
 * code that is not serving anything else. The async one serves the settings
 * pane's provider probes: a synchronous spawn on the daemon's HTTP loop stalls
 * every other request — including live session streams — for as long as a wedged
 * binary takes to reach the 10s timeout.
 */
async function detectVersionAsync(executable: string): Promise<string | null> {
  const key = cacheKey(executable);
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  const running = inflight.get(key);
  if (running) return running;

  const probe = execFileP(executable, ["--version"], PROBE)
    .then(({ stdout }) => parseVersion(stdout))
    .catch(() => null)
    .then((version) => {
      versionCache.set(key, version);
      inflight.delete(key);
      return version;
    });
  inflight.set(key, probe);
  return probe;
}

/** Announced ONCE per process per BINARY, not per turn — keyed on the path
 *  rather than the id, because two logins may now pin two different `claude`s
 *  and a log line that only ever named the first would be worse than none. */
const announced = new Set<string>();

function announce(resolution: CliResolution): void {
  const key = `${resolution.id}:${resolution.path ?? "-"}`;
  if (announced.has(key)) return;
  announced.add(key);
  const where = resolution.path ?? "not found";
  const what = resolution.version ?? "version unknown";
  const against = resolution.expected ? ` (Telar expects ${resolution.expected})` : "";
  console.log(`[telar] ${resolution.label} CLI: ${resolution.status} · ${what}${against} · ${where}`);
  if (resolution.message) console.log(`[telar] ${resolution.label} CLI: ${resolution.message}`);
}

type Located =
  | {
      kind: "found";
      executable: string;
      expected?: string;
      /** OTHER runnable copies of the same binary — see `alsoFound`. Collected
       *  only when nothing was pinned, because a pinned path was chosen and
       *  listing what else exists would be noise. */
      alternatives?: string[];
    }
  | { kind: "settled"; resolution: CliResolution };

/**
 * WHAT THE USER PINNED, and how to describe it back to them.
 *
 * TWO SOURCES, MOST SPECIFIC FIRST. A login's own binary path beats the
 * machine-wide env var, for the same reason `providerProcessEnv` lets an
 * instance's declared variable beat an inherited one: the more specific
 * declaration is the one somebody made on purpose about THIS account.
 */
type Pin = { value: string; what: string; howToClear: string };

/** `~` is stored rather than an absolute home so a registry survives being
 *  copied between machines; it is expanded here, at the moment it is used. */
const expandHome = (value: string): string => (value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value);

function pinFor(spec: CliSpec, binaryPath: string | undefined): Pin | undefined {
  const own = binaryPath?.trim();
  if (own) {
    return {
      // Described with what the user TYPED and resolved with the expansion, so
      // the error names the value they can find in the field.
      value: expandHome(own),
      what: `This login's binary path is set to ${own}`,
      howToClear: "clear the binary path on this login to use the usual locations",
    };
  }
  const override = process.env[spec.overrideEnv]?.trim();
  if (override) {
    return {
      value: expandHome(override),
      what: `${spec.overrideEnv} is set to ${override}`,
      howToClear: `fix the path or unset ${spec.overrideEnv} to use the usual locations`,
    };
  }
  return undefined;
}

function locate(spec: CliSpec, binaryPath?: string): Located {
  const expected = spec.expectedVersion?.();
  const base = { id: spec.id, label: spec.label } as const;
  const missing = (message: string): Located => ({
    kind: "settled",
    resolution: { ...base, status: "missing", ...(expected ? { expected } : {}), message },
  });

  const pin = pinFor(spec, binaryPath);

  /**
   * A PIN WITH A SEPARATOR IN IT IS AN EXPLICIT PATH; a bare name is a name to
   * look up. This is T3 Code's rule (`resolveCommandPath`), and it is what makes
   * the settings field usable: "claude" means "whichever one my shell finds",
   * "/opt/beta/claude" means that file and nothing else.
   */
  if (pin && (pin.value.includes("/") || pin.value.includes("\\"))) {
    // AN EXPLICIT PIN THAT DOES NOT RESOLVE IS AN ERROR, NOT A HINT. The user
    // most likely to set one is the user least able to notice it being ignored,
    // and falling through to a different binary would report a green "ok"
    // naming a path nobody chose.
    if (!existsSync(pin.value)) {
      return missing(
        `${pin.what}, but nothing is there. ` +
          `Telar will not silently fall back to a different ${spec.label} than the one you pinned — ${pin.howToClear}.`,
      );
    }
    if (!isExecutableFile(pin.value)) {
      return missing(
        `${pin.what}, but it is not an executable file. ` +
          `Check that it is a file rather than a directory and that it has its executable bit (chmod +x), or ${pin.howToClear}.`,
      );
    }
    return { kind: "found", executable: pin.value, ...(expected ? { expected } : {}) };
  }

  // Either the default binary name, or a bare name the user pinned — both are
  // looked up the same way, which is what keeps "claude" in the settings field
  // meaning exactly what typing `claude` in a terminal means.
  //
  // EVERY MATCH, NOT THE FIRST. The extra work is a stat per PATH entry, which
  // is nothing beside the `--version` subprocess this resolution is about to
  // run — and knowing a SECOND copy exists is the difference between an
  // incompatible verdict being a mystery and being a two-install machine.
  const bin = pin?.value ?? spec.bin;
  const [executable, ...alternatives] = candidatePathsFor(bin).filter(isExecutableFile);
  if (!executable) {
    return missing(
      pin
        ? `${pin.what}, and no runnable \`${bin}\` was found on PATH. Use a full path, or ${pin.howToClear}.`
        : `No ${spec.label} installation found. Telar does not bundle one. ${spec.installHint}`,
    );
  }
  return {
    kind: "found",
    executable,
    ...(expected ? { expected } : {}),
    ...(pin || alternatives.length === 0 ? {} : { alternatives }),
  };
}

/**
 * The sentence that turns "why is this suddenly broken" into a diagnosis.
 *
 * ONLY EVER APPENDED TO A MESSAGE THAT ALREADY EXISTS, so a healthy install
 * says nothing about copies it is not using. It matters on exactly one machine
 * shape and matters a lot there: two installs of the same CLI, where the one
 * PATH resolves first is a version this build cannot speak to. Telar then
 * REFUSES EVERY TURN — correctly, since the wrapper and the CLI would otherwise
 * misbehave at the protocol level — and without this the reader has no way to
 * know a working copy is sitting right there.
 *
 * It is also what makes the search order's change of behaviour explicable.
 * Telar used to prefer three known directories over PATH; it now runs what the
 * terminal runs, and someone whose two copies disagree needs to be told that is
 * what happened rather than left to conclude the app broke.
 */
function alsoFound(spec: CliSpec, alternatives: readonly string[] | undefined): string {
  if (!alternatives?.length) return "";
  const shown = alternatives.slice(0, 3).join(", ");
  const rest = alternatives.length > 3 ? ` (and ${alternatives.length - 3} more)` : "";
  return ` Also on this machine: ${shown}${rest}. Telar uses whichever your PATH finds first; set a binary path below to pick one.`;
}

// PROBE AND VERDICT ARE SPLIT so the sync and async paths differ in exactly one
// call — the subprocess — and share every judgement. Two copies of the
// classification would be two places for the settings pane and the spawn gate to
// disagree about the same machine.
/** Followed, or nothing — a dangling link is not an error worth failing a
 *  resolution over, it is simply one less thing known about the install. */
function realPathOf(executable: string): { realPath?: string } {
  try {
    const resolved = realpathSync(executable);
    return resolved === executable ? {} : { realPath: resolved };
  } catch {
    return {};
  }
}

function classify(
  spec: CliSpec,
  executable: string,
  version: string | null,
  expected: string | undefined,
  alternatives?: readonly string[],
): CliResolution {
  const base = { id: spec.id, label: spec.label, ...realPathOf(executable) } as const;
  const others = alsoFound(spec, alternatives);

  if (!version) {
    return {
      ...base,
      status: "unknown",
      path: executable,
      ...(expected ? { expected } : {}),
      // Keeps the path, because knowing WHAT it found is the whole question.
      message: `${executable} would not report a version — a broken install, a wrapper script, or not executable by you.${others}`,
    };
  }
  if (!expected) {
    return spec.expectedVersion
      ? {
          ...base,
          status: "unverified",
          path: executable,
          version,
          // Should now be rare: it means the SDK manifest was unreadable, which
          // `expectedClaudeCliVersion` no longer trips over on its own.
          message: `Using ${spec.label} ${version} unchecked — Telar could not read the version it pairs with.`,
        }
      : { ...base, status: "ok", path: executable, version };
  }

  const verdict = spec.verdict?.(version, expected, executable);
  // A HEALTHY INSTALL SAYS NOTHING about copies it is not using. Duplicates are
  // only worth a sentence when they might explain the problem being reported.
  if (!verdict || verdict.status === "ok") return { ...base, status: "ok", path: executable, version, expected };
  return {
    ...base,
    status: verdict.status,
    path: executable,
    version,
    expected,
    ...(verdict.message ? { message: `${verdict.message}${others}` } : {}),
  };
}

/**
 * Which binary a particular login runs, when it says so.
 *
 * ONE OPTION, THREADED EVERYWHERE, because a probe and a turn that disagree
 * about which binary they mean is the bug this whole module exists to stop. A
 * pane that reported the version of one `claude` while turns ran another would
 * be worse than no version at all.
 */
export type CliResolveOptions = {
  /** This login's own binary path — an absolute path, or a bare name to look
   *  up. Absent means the driver's default name. */
  binaryPath?: string | undefined;
};

/** Where the CLI is, what version it is, and whether that is a version this
 *  build expects to be able to talk to. */
export function resolveCli(id: CliId, options: CliResolveOptions = {}): CliResolution {
  const spec = SPECS[id];
  const located = locate(spec, options.binaryPath);
  const resolution =
    located.kind === "settled"
      ? located.resolution
      : classify(spec, located.executable, detectVersion(located.executable), located.expected, located.alternatives);
  announce(resolution);
  return resolution;
}

/** The same verdict, without blocking the event loop. Shares the cache and the
 *  classification, so the two can report different answers only if the CLI
 *  itself changed between them. */
export async function resolveCliAsync(id: CliId, options: CliResolveOptions = {}): Promise<CliResolution> {
  const spec = SPECS[id];
  const located = locate(spec, options.binaryPath);
  if (located.kind === "settled") {
    announce(located.resolution);
    return located.resolution;
  }
  const version = await detectVersionAsync(located.executable);
  const resolution = classify(spec, located.executable, version, located.expected, located.alternatives);
  announce(resolution);
  return resolution;
}

/** Whether a turn may proceed. `drifted` and `unknown` pass DELIBERATELY: a hard
 *  gate on every unrecognised version would lock somebody out of their own app
 *  the day a CLI ships a release we have not blessed, and the common case — a
 *  patch ahead — demonstrably works. Only "no CLI at all" and "wrong protocol
 *  family" are refusals: the turn fails, it does not degrade. */
export function cliUsable(resolution: Pick<CliResolution, "status">): boolean {
  return resolution.status !== "missing" && resolution.status !== "incompatible";
}

/**
 * The executable to spawn, or a thrown, ACTIONABLE refusal.
 *
 * The alternative is what both providers used to do in a packaged app — spawn
 * something that is not there and let the failure surface downstream as ENOENT
 * or "app-server exited (code=null)", with nothing anywhere naming the missing
 * install. The message is the resolution's own, so the reader learns what to
 * install rather than an errno.
 */
export function requireCli(id: CliId, options: CliResolveOptions = {}): string {
  const resolution = resolveCli(id, options);
  if (!cliUsable(resolution)) {
    throw new Error(resolution.message ?? `No ${SPECS[id].label} installation found.`);
  }
  // Every usable status carries a path — `missing` is the only pathless one and
  // it was just refused.
  return resolution.path ?? SPECS[id].bin;
}
