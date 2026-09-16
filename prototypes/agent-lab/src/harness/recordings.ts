/**
 * THE FIXTURES THE RECORDED MODEL REPLAYS.
 *
 * JSON on disk rather than literals in a scenario, for one reason that matters:
 * the restart scenarios run their second half in a FRESH PROCESS, and a script
 * both processes read off the same file is a script that cannot drift between
 * them.
 *
 * ── THESE ARE AUTHORED, NOT CAPTURED, AND THE REPORT SAYS SO ────────────────
 * A captured fixture would tie every offline scenario to one model's mood on
 * one afternoon. These are written to exercise the PATH — a tool call here, a
 * retry there — and the live smokes (scenarios 2 and 7, `TELAR_LIVE_SMOKE=1`)
 * are what prove the same prompt shape works against real Go. A live run writes
 * what it actually got to `recordings/live/`, which is evidence of that run and
 * is not what the tests replay.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordedScript } from "./recorded";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = path.resolve(here, "../../recordings");
export const LIVE_DIR = path.join(RECORDINGS_DIR, "live");

export function loadScript(name: string): RecordedScript {
  const file = path.join(RECORDINGS_DIR, `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as RecordedScript;
}

/** What a live run actually got, kept beside the fixtures but never replayed by
 *  a test. Gitignored: it is a record of one afternoon's call. */
export function saveLiveCapture(name: string, payload: unknown): string {
  mkdirSync(LIVE_DIR, { recursive: true });
  const file = path.join(LIVE_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}
