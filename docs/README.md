# Telar docs

## Using Telar

One guide per feature:

- [Install](user/install.md)
- [Providers](user/providers.md): Claude Code, Codex, OpenCode
- [Sessions](user/sessions.md)
- [Composer](user/composer.md)
- [Permissions and requests](user/permissions.md)
- [The panel](user/panel.md)
- [Terminal](user/terminal.md)
- [Integrated browser](user/browser.md)
- [Agents working together](user/agents-together.md)
- [Plugins](user/plugins.md)
- [Notes and prompts](user/notes-and-prompts.md)
- [Schedules](user/schedules.md)
- [iPhone](user/iphone.md)
- [Remote access](user/remote-access.md)
- [Appearance](user/appearance.md)
- [Keyboard shortcuts](user/keyboard-shortcuts.md)
- [Usage and limits](user/usage.md)
- [Updating](user/updating.md)

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
