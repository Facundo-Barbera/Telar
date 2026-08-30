# @telar/env

The environment lease scheduler — the first agent-facing piece of the
[August 2026 direction](../../docs/vision-2026-08.md). Standalone and
Telar-optional: agents use it today from ordinary t3 code / Claude Code
sessions, long before any Telar UI exists.

Implements [Environment Contract v1](../../docs/env-contract-v1.md): five
verbs (`up` / `ready` / `reset` / `down` / `verify`), a cost class
(`none` / `light` / `heavy`), sidecar config, and a machine-global lease pool
sized to review bandwidth, not agent count.

## Contract discovery

1. Sidecar (wins): `$TELAR_HOME/projects/<id>/env.yaml` — never committed to a shared repo.
2. Repo fallback: a `telar.yaml` with an `env:` block, for solo projects.

Project id = slug + hash of the normalized `origin` remote (fallback: primary
checkout path). State lives in `$TELAR_HOME/env/state.json` under a lock;
stale leases (dead holder or expired TTL) are reclaimed lazily on every call.

## CLI

```bash
bun run --cwd packages/env src/cli.ts <cmd>   # or: telar-env <cmd>

telar-env lease             # acquire (or queue) — prints lease with TELAR_* values
telar-env release <id>      # kept warm when nobody queues; --down forces teardown
telar-env renew <id>
telar-env status            # machine-wide pool state
telar-env context           # full project briefing for an agent session
telar-env tier <name>       # run a verification tier (unit: unleased; others auto-lease)
telar-env init [--write]    # scaffold a sidecar contract (agents: see ONBOARDING.md)
telar-env conform           # contract-v1 conformance sequence on a scratch slot
telar-env worktree-list
telar-env worktree-create <branch> [path]
```

## MCP server

```jsonc
// .mcp.json / t3 code MCP config
{
  "mcpServers": {
    "telar-env": {
      "command": "bun",
      "args": ["/Users/facundo/Projects/personal/Telar/packages/env/src/mcp.ts"]
    }
  }
}
```

Tools: `env_lease`, `env_release`, `env_renew`, `env_status`,
`project_context`, `env_tier`, `env_init`, `env_conform`, `worktree_list`,
`worktree_create`.
Every tool accepts an optional `cwd` so one server instance serves any project.

The moat rule holds here: there is no `accept` tool, and there never will be.

## Pool policy

`$TELAR_HOME/config.yaml` (all optional):

```yaml
env:
  pool: { heavy: 1, light: 4 }
  leaseTtlMinutes: 45
  portRangeBase: 40000
  portRangeSize: 20
```

- `heavy` pool is machine-global (containers, real RAM) — a queue, not a fan-out.
- `light` cap is per project.
- `none` never leases: `env_lease` grants immediately with no environment.
- A worktree that already holds a lease and leases again gets the *same* lease
  renewed (the repair exception: verify → repair never re-queues).
