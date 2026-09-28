/**
 * `telar diagnose` — read-only questions about a store, run by hand.
 *
 * Today there is one: `stalled`, which answers #813's frequency question
 * without anybody opening the live store with `sqlite3`. See `diagnose.ts` for
 * what it reads and why it refuses to go through `EngineStore`.
 *
 * THE ROOT IS ALWAYS EXPLICIT — `--root`, or `TELAR_HOME` via
 * `engineRootFromEnv`, which itself refuses to guess. There is deliberately no
 * built-in path to the store in `~/Library/Application Support`: a diagnostic
 * that defaults to somebody's live conversations is one typo away from being
 * pointed at them by accident, and naming the directory is no effort at all
 * next to reading the answer.
 *
 * `--json` IS THE DEFAULT AND THE ONLY FORMAT. The answer is a shape to count
 * and compare across days, not prose to read once, and a second format would be
 * a second thing to keep true.
 */
import { engineRootFromEnv } from "./state";
import { DiagnoseError, scanStalled } from "./diagnose";

const USAGE = `telar diagnose stalled [--root <engine root>] [--minutes N] [--json]

Which runs in a store have been silent for longer than a threshold, as ids and
times. Read-only: the database is opened readonly and nothing is written.

  --root <path>   The engine root to read (the directory holding
                  execution.sqlite). Defaults to TELAR_HOME's engine root.
  --minutes N     How long counts as silent. Defaults to the engine's own
                  STALLED_AFTER_MS.
  --json          Emit JSON. This is the default and the only format.
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new DiagnoseError(`--${name} needs a value`);
  return value;
}

export function runDiagnose(argv: string[]): string {
  const [command] = argv;
  if (command !== "stalled") throw new DiagnoseError(`${USAGE}\nUnknown command ${command === undefined ? "(none given)" : `"${command}"`}.`);
  const root = flag(argv, "root") ?? engineRootFromEnv();
  const minutes = flag(argv, "minutes");
  if (minutes !== undefined && !(Number(minutes) > 0)) throw new DiagnoseError("--minutes must be a positive number");
  const scan = scanStalled({
    engineRoot: root,
    ...(minutes === undefined ? {} : { thresholdMs: Number(minutes) * 60_000 }),
  });
  return `${JSON.stringify(scan, null, 2)}\n`;
}

// Only when this file IS the process, so the function above stays testable
// without a subprocess — and so importing it never runs a scan.
if (import.meta.main) {
  try {
    process.stdout.write(runDiagnose(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
