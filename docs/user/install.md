# Install

Telar is a Mac app for Apple Silicon. It doesn't bring its own agent: it drives the coding agents you already have on the Mac (Claude Code, Codex and OpenCode). Install at least one of them and sign in to it before you start.

## First run

1. Install Telar and open it.
2. Install a provider's CLI and sign in with it the usual way, in your own terminal. See [Providers](providers.md).
3. Add a project and start a session.

Telar keeps its data in its own folder on the Mac. On first launch it creates that folder, and after that it only opens the one it created. If the folder is on a drive that isn't plugged in, or has moved, Telar waits and says so. It never creates a fresh, empty one on its own. Plug the drive back in and Telar carries on. Starting a new store instead has to be confirmed on purpose.

## Adding a project

A project is a folder Telar works in, usually a git repository. Add one from the rail or the command palette (⌘K → Add project):

- **Local folder**: browse to a folder already on the Mac.
- **Git URL** or **GitHub repository**: Telar clones it into a folder you pick. A GitHub repository can be written as `owner/repo`.

Other forges show up in the list but aren't set up yet. Clone those yourself and add them as a local folder.

A project that isn't a git repository still works, but its sessions can't have worktrees of their own. See [Sessions](sessions.md).

## Checking your providers

Settings → Providers lists every login Telar found, with its CLI version and whether it's ready. A provider that isn't installed appears under "Not on this machine" with a hint on how to install it. After installing or signing in, choose Re-check.

Telar looks for each CLI where your own terminal would find it: on your `PATH` first, then in the usual install folders. If a CLI lives somewhere unusual, set `CLAUDE_CODE_EXECUTABLE`, `CODEX_BIN` or `OPENCODE_BIN` to its full path.

## Next steps

- [Sessions](sessions.md): local checkouts and worktrees.
- [Composer](composer.md): models, effort and access.
- [iPhone](iphone.md) and [Remote access](remote-access.md): reaching the Mac from elsewhere.
- [Updating](updating.md): Telar updates itself.
