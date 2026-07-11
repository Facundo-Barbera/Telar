import { setup } from "./setup";
import { run } from "./run";
import { watchUntilReady } from "./watch";
import { teardown } from "./teardown";

// THE one command. A single long-lived process that HOSTS the in-process
// executor: setup -> run -> (watch -> teardown) | (--keep: park until Ctrl-C).
async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const ui = process.argv.includes("--ui");
  const state = await setup({ keep, ui });
  try {
    const loomId = await run(state); // executor now hosted in THIS process
    if (ui) console.log("watch:  http://127.0.0.1:" + state.webServerPort + "/looms/" + loomId);
    console.log("loomId: " + loomId);
    console.log("runDir: " + state.runDir);

    if (keep) {
      const onSignal = () => {
        teardown(state).finally(() => process.exit(0));
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      console.log("--keep: leaving run up. Ctrl-C to tear down, or:");
      console.log("  bun run scripts/e2e/greenfield-next/teardown.ts --run " + state.runDir);
      await new Promise<void>(() => {}); // park — keeps executor + server alive
    } else {
      const finalState = await watchUntilReady(state, loomId);
      console.log("final loom state: " + finalState);
      await teardown(state);
      process.exit(finalState === "ready" ? 0 : 1);
    }
  } catch (err) {
    console.error(err);
    if (!keep) await teardown(state); // always clean up on failure unless --keep
    process.exit(1);
  }
}

main();
