#!/usr/bin/env node
/**
 * THE ASSERTION THE TEST SUITE CANNOT MAKE — issue #632.
 *
 *   bun run --cwd apps/engine durability:pragmas
 *
 * `apps/engine/test/durability.test.ts` asserts that the execution store's
 * connection reports `checkpoint_fullfsync=1`. Under `bun:sqlite` — Apple's
 * system libsqlite3, compiled with `DEFAULT_CKPTFULLFSYNC` — that is ALREADY
 * TRUE before the constructor sets anything, so the assertion passes on a build
 * where the line was deleted. The packaged app runs the engine under
 * Electron-as-Node on `node:sqlite`, whose bundled amalgamation defaults it to
 * 0. **The suite is vacuous in exactly the direction that matters**, and this
 * script is what closes that gap: it bundles the store the way the app is
 * bundled, runs it under plain `node`, and asserts the three values.
 *
 * ══ WHY IT BUNDLES RATHER THAN IMPORTING THE SOURCE ══
 *
 * Node can strip types and run the `.ts` directly, and that would prove the
 * `node:sqlite` half. What it would not prove is that the pragmas survive the
 * bundler — `apps/desktop/build-app.sh` runs `bun build --target=node` over the
 * engine, and a probe that skipped that step would be testing a file the app
 * does not contain. So this performs the same `bun build` over a one-file entry
 * and runs its output, which is the packaged path minus the .app.
 *
 * IT DOES NOT BUILD THE APP. Bundling `execution-store.ts` alone is under a
 * second; building the desktop app is minutes and a signing identity.
 *
 * ══ WHAT IT IS NOT ══
 *
 * It is not a durability proof. Nothing here can power-cycle a drive, and
 * `fcntl(2)` records that some drives ignore the flush request outright. The
 * claim is exactly: the pragmas that make sqlite ask for a device barrier are
 * the ones in effect, in the runtime that ships.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(here, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "telar-durability-bundle-"));
const bundle = path.join(out, "probe.mjs");

/** What the store must report on the runtime the app ships. `synchronous=1` is
 *  NORMAL and `fullfsync=0` is the resting state — a build that left the
 *  barrier's pragma raised would pay `F_FULLFSYNC` on every ordinary commit. */
const EXPECTED = { synchronous: 1, checkpointFullfsync: 1, fullfsync: 0 };

let failed = false;
try {
  // The same flags `apps/desktop/build-app.sh` uses for the engine, minus the
  // entry point. `NODE_OPTIONS=` for the reason that script gives: an inherited
  // one is meant for node and bun's bundler is not node.
  execFileSync(
    "bun",
    ["build", "scripts/durability-probe.ts", "--target=node", "--format=esm", "--external", "@anthropic-ai/claude-agent-sdk", "--outfile", bundle],
    { cwd: engine, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, NODE_OPTIONS: "" } },
  );
  const printed = execFileSync(process.execPath, [bundle], { encoding: "utf8" }).trim();
  const actual = JSON.parse(printed.split("\n").at(-1));
  console.log(`bundled execution store under ${actual.runtime}`);
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = actual[name];
    const ok = got === want;
    if (!ok) failed = true;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name} = ${got}${ok ? "" : ` (expected ${want})`}`);
  }
  if (actual.runtime.startsWith("bun")) {
    // Refuse to report success from the runtime whose default makes the answer
    // meaningless. This script exists BECAUSE bun answers 1 for free.
    console.error("!! this ran under bun, where checkpoint_fullfsync is 1 by default — the result proves nothing about the .app");
    failed = true;
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
