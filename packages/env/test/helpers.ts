import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Isolated TELAR_HOME per test file. */
export function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "telar-env-home-"));
  process.env.TELAR_HOME = home;
  return home;
}

/** A real git repo whose verbs write marker files, so tests need no Docker. */
export function fakeProject(opts?: { cost?: string; withReset?: boolean; tiers?: Record<string, string> }): string {
  const dir = mkdtempSync(join(tmpdir(), "telar-env-proj-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: dir,
  });
  const cost = opts?.cost ?? "heavy";
  // Markers are per-slot so idempotence and cross-slot isolation are observable.
  const lines = [
    "version: 1",
    "env:",
    `  cost: ${cost}`,
    '  up: touch "up-$TELAR_SLOT"; echo "$TELAR_PORT_BASE" > "port-$TELAR_SLOT"',
    '  ready: test -f "up-$TELAR_SLOT"',
    ...(opts?.withReset ? ['  reset: touch "reset-$TELAR_SLOT"'] : []),
    '  down: rm -f "up-$TELAR_SLOT"',
    ...(opts?.tiers
      ? ["  tiers:", ...Object.entries(opts.tiers).map(([name, cmd]) => `    ${name}: ${cmd}`)]
      : []),
  ];
  writeFileSync(join(dir, "telar.yaml"), `${lines.join("\n")}\n`);
  return dir;
}

export function sidecarFor(home: string, projectId: string, yaml: string): void {
  const dir = join(home, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env.yaml"), yaml);
}
