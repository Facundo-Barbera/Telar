#!/usr/bin/env bun
import { runConformance } from "./conformance.ts";
import { createWorktree, listWorktrees, projectContext } from "./context.ts";
import { init } from "./init.ts";
import { acquire, downStale, reclaimStale, release, renew } from "./lease.ts";
import { snapshotState } from "./state.ts";
import { runTier } from "./tiers.ts";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const cwd = process.cwd();

switch (cmd) {
  case "lease": {
    const result = await acquire({ cwd });
    print(result);
    process.exit(result.granted ? 0 : 2);
  }
  case "release": {
    const id = rest.find((a) => !a.startsWith("--")) ?? fail("usage: telar-env release <lease-id> [--down]");
    print(await release(id, { down: rest.includes("--down") }));
    break;
  }
  case "renew": {
    const id = rest[0] ?? fail("usage: telar-env renew <lease-id>");
    print(renew(id));
    break;
  }
  case "status": {
    await downStale(reclaimStale());
    print(snapshotState());
    break;
  }
  case "context": {
    print(projectContext(cwd));
    break;
  }
  case "tier": {
    const tier = rest.find((a) => !a.startsWith("--")) ?? fail("usage: telar-env tier <name> [--keep-lease]");
    const result = await runTier({ cwd, tier, keepLease: rest.includes("--keep-lease") });
    print(result);
    process.exit(result.ok ? 0 : 1);
  }
  case "init": {
    print(init(cwd, { write: rest.includes("--write") }));
    break;
  }
  case "conform": {
    const report = await runConformance(cwd);
    print(report);
    process.exit(report.ok ? 0 : 1);
  }
  case "worktree-list": {
    print(listWorktrees(cwd));
    break;
  }
  case "worktree-create": {
    const branch = rest[0] ?? fail("usage: telar-env worktree-create <branch> [path]");
    print(createWorktree(cwd, branch, rest[1]));
    break;
  }
  default:
    fail(
      [
        "telar-env — environment lease scheduler (contract v1)",
        "",
        "  lease                       acquire an environment for this worktree (or queue)",
        "  release <lease-id> [--down] release; kept warm when nobody queues, --down forces teardown",
        "  renew <lease-id>            extend a lease's TTL",
        "  status                      pool state: slots, ports, leases, queue",
        "  context                     full project briefing (contract, worktrees, leases)",
        "  tier <name> [--keep-lease]  run a verification tier (unit: unleased; others: auto-lease)",
  "  init [--write]              scaffold a sidecar contract (see ONBOARDING.md)",
  "  conform                     run the contract conformance sequence on a scratch slot",
        "  worktree-list               worktrees with their slots",
        "  worktree-create <branch>    new worktree, slot assigned on first lease",
      ].join("\n"),
    );
}
