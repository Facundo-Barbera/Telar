# Telar docs

## Using Telar

See [user/](user/): one guide per feature.

## Working on Telar

Start with [AGENTS.md](../AGENTS.md), then:

- [operations/development.md](operations/development.md): running the stack, tests, checks, local desktop and iOS builds
- [operations/debugging.md](operations/debugging.md): logs, engine health, diagnose, common failures
- [operations/ci.md](operations/ci.md): what `verify.yml` checks, engine shards, reruns, the other workflows
- [operations/release-desktop.md](operations/release-desktop.md): nightly and beta builds, R2, channels, the bundle-id hand-off
- [operations/release-ios.md](operations/release-ios.md): TestFlight nightlies, signing, bundle ids
- [operations/workers.md](operations/workers.md): deploying the push relay and the updates proxy
- [internals/architecture.md](internals/architecture.md): processes, domains and the target layout
- [internals/engine.md](internals/engine.md): storage, turns, HTTP and agent-tool traps
- [internals/plugins.md](internals/plugins.md): the plugin contract
- [internals/security.md](internals/security.md): the invariants that every change must keep

The migration in progress is tracked in [migration/](migration/).
