import { startEngine } from "./daemon";
import { hydrateHostPath } from "./host-path";
import { providerSkillRoots } from "./provider-skills";
import { ENGINE_EXIT_LOCK_HELD, EngineStateError, engineRootFromEnv, statePaths } from "./state";

/**
 * BEFORE ANYTHING RESOLVES A BINARY, and therefore the first statement here.
 *
 * A Finder-launched app gets a four-entry PATH, so every version-managed
 * install — nvm, fnm, mise, asdf, volta, bun, pnpm — is invisible to it. This
 * asks the login shell once and repairs `process.env.PATH` in place, which is
 * what lets `cli-resolution.ts` trust PATH instead of enumerating install
 * directories it can never finish enumerating.
 *
 * ON THE ENTRY POINTS RATHER THAN IN `startEngine`: spawning an interactive
 * shell is a thing a PROCESS does once, not a thing a library call should do —
 * and every engine test constructs a daemon, none of which should be paying for
 * a shell or inheriting whatever this machine's profile exports.
 */
hydrateHostPath();

/**
 * ONE PROCESS IS A WORKING ENGINE.
 *
 * The daemon runs an embedded worker by default, so `bun run start` accepts a
 * turn AND executes it. Before this, a lone daemon 503'd every submission with
 * `worker_unavailable` until a separate `bun run worker` registered — which
 * made "the engine runs on its own" false in the most literal way.
 *
 * TELAR_EMBEDDED_WORKER=0 turns it off, for the deployment where the
 * worker is deliberately its own process (provider crashes stay out of the
 * control plane, and `worker-main.ts` still exists for exactly that).
 */
const embeddedWorker = process.env.TELAR_EMBEDDED_WORKER?.trim() !== "0";
// The usage scan cache is warmed a few seconds after start-up, so the first
// Usage page after an update finds the transcripts already read (usage.ts).
// Here and not in `startEngine`, like the PATH repair above: a process
// decision, not one every test's daemon should be making.
// The `telar` skill is installed into each provider's own skills directory on
// start (and removed when the toggle is off). Passed from here rather than
// defaulted inside `startEngine` for the reason the two decisions above are:
// writing into `~/.claude/skills` is a thing a process does, not a thing every
// test's daemon should do to the developer's home directory.
/**
 * A LIVE LOCK IS AN ORDINARY CONDITION AND EXITS SAYING SO — issue #894.
 *
 * Without this, a second Telar meeting a daemon that is already up died on an
 * unhandled rejection: exit code 1, a stack trace on a stdout a packaged app
 * sends nowhere, and a shell that read the 1 as "the engine died" and quit with
 * nothing on screen. The condition is not a failure — the store has an owner
 * and it is alive — so it gets a code of its own and one readable line.
 *
 * THE LINE NAMES THE LOCK AND ITS OWNER, because those are the two things a
 * person needs to act: the pid is already in the error's message (see
 * `acquireDaemonLock`) and the path is what `rm` would take if that pid turns
 * out to be gone. Every OTHER startup failure keeps exiting 1 — the shell's
 * blanket quit is right for an engine that really died.
 */
let daemon: Awaited<ReturnType<typeof startEngine>>;
try {
  daemon = await startEngine({ embeddedWorker, warmUsageCacheAfterMs: 5_000, skillRoots: providerSkillRoots(),
    executionStorage: process.env.TELAR_EXECUTION_STORE === "json" ? "json" : "sqlite" });
} catch (error) {
  if (!(error instanceof EngineStateError) || error.code !== "conflict") throw error;
  process.stderr.write(`Telar engine: ${error.message} — ${statePaths(engineRootFromEnv()).lock}\n`);
  process.exit(ENGINE_EXIT_LOCK_HELD);
}
process.stdout.write(
  `Telar engine listening on ${daemon.discovery.host}:${daemon.discovery.port}` +
    `${daemon.worker ? ` with embedded worker ${daemon.worker.workerId}` : " (no embedded worker)"}\n`,
);

const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
