import { startEngine } from "./daemon";

/**
 * ONE PROCESS IS A WORKING ENGINE.
 *
 * The daemon runs an embedded worker by default, so `bun run start` accepts a
 * turn AND executes it. Before this, a lone daemon 503'd every submission with
 * `worker_unavailable` until a separate `bun run worker` registered — which
 * made "the engine runs on its own" false in the most literal way.
 *
 * TELAR_VNEXT_EMBEDDED_WORKER=0 turns it off, for the deployment where the
 * worker is deliberately its own process (provider crashes stay out of the
 * control plane, and `worker-main.ts` still exists for exactly that).
 */
const embeddedWorker = process.env.TELAR_VNEXT_EMBEDDED_WORKER?.trim() !== "0";
const daemon = await startEngine({ embeddedWorker });
process.stdout.write(
  `Telar vNext engine listening on ${daemon.discovery.host}:${daemon.discovery.port}` +
    `${daemon.worker ? ` with embedded worker ${daemon.worker.workerId}` : " (no embedded worker)"}\n`,
);

const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
