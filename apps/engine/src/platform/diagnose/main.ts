import { engineRootFromEnv } from "../fs/engine-root";
import { DiagnoseError, scanStalled } from "./stalled";

const USAGE = `telar diagnose stalled [--root <engine root>] [--minutes N]

Which runs in a store have been silent for longer than a threshold, as ids and
times. Read-only: the database is opened readonly and nothing is written.

  --root <path>   The engine root to read (the directory holding
                  execution.sqlite). Defaults to TELAR_HOME's engine root.
  --minutes N     How long counts as silent. Defaults to the engine's own
                  STALLED_AFTER_MS.
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

if (import.meta.main) {
  try {
    process.stdout.write(runDiagnose(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
