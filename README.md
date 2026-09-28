# Telar

Telar is a control surface for the coding agents already installed on your machine. It doesn't replace or bundle them. A local engine owns your projects, their sessions and a durable journal of every turn. The cockpit is where you drive them: in the desktop app, in a browser, or on your iPhone.

*Telar* is Spanish for **loom**. The icon is warp and weft: separate threads becoming one fabric.

## What it drives

Your own installs and your own subscriptions. Set up at least one:

| Provider | Get it | Sign in |
| --- | --- | --- |
| Claude Code | [claude.com/product/claude-code](https://claude.com/product/claude-code) | `claude auth login` |
| Codex | [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli) | `codex login` |
| OpenCode | [opencode.ai](https://opencode.ai) | `opencode auth login` |

Settings → Providers shows the exact binary and version that will answer you.

## What it adds

- **Sessions with their own checkout.** A session works in the project's tree or in its own git worktree, so several agents can work on one repo without colliding.
- **A durable journal.** Every turn, tool call and result survives a restart.
- **A permission gate.** Risky actions wait for you, on the Mac or on your phone.
- **Agents that coordinate.** A session can start other sessions, hand them work and collect their results.
- **An integrated browser and terminals**, so an agent can check its own work.
- **Plugins**: Data Science notebooks, LaTeX, and plugins you write yourself.
- **A notebook per project**, and prompts you can reuse.
- **iPhone app** with notifications and a Live Activity.

## Install

Desktop builds are published as nightlies. To build and install one locally from source instead, see [docs/operations/development.md](docs/operations/development.md).

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev            # engine + cockpit in a browser, isolated TELAR_HOME
bun run dev:desktop    # the same inside the development desktop shell
```

Before you change code, read [AGENTS.md](AGENTS.md): where code lives, the rules, and how to verify. The architecture is in [docs/internals/architecture.md](docs/internals/architecture.md).

## Docs

- [Using Telar](docs/user/)
- [Developing and releasing](docs/operations/)
- [How it works](docs/internals/)

## Prior art

Telar owes its shape to [T3 Code](https://github.com/pingdotgg/t3code), which solved the same problem in the open and solved parts of it better. Conductor, the Codex desktop app and Cursor are the other reference points.

## License

Proprietary. © 2026 Facundo Barbera. All rights reserved. See [`LICENSE`](LICENSE).
