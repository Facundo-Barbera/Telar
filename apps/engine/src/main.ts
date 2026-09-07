import { startEngine } from "./daemon";
import { hydrateHostPath } from "./host-path";

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
const daemon = await startEngine({ embeddedWorker, warmUsageCacheAfterMs: 5_000 });
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
