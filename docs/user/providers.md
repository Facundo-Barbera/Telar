# Providers

A provider is the agent that does the work in a session: Claude Code, Codex or OpenCode. Telar runs the CLI you installed, with the account you signed in to it. Telar never signs in for you and never reads your credentials. Tokens stay where the CLI put them.

## Logins

Settings → Providers lists your logins. Each provider starts with one default login: the CLI's own sign-in. Each row shows its status (Ready, Needs attention, Unavailable or Off) and its CLI version.

To use a second account with the same provider, choose Add a login and point Telar at a config folder you have already signed in with. The dialog shows the sign-in command to run in your terminal for that folder. For Claude Code and Codex, every login is its own account. OpenCode keeps its logins in its own shared config, so a second OpenCode login doesn't isolate its credentials.

The default login can be switched off but not removed.

## Choosing one

Pick the provider and model in the composer's model picker. The provider is fixed when a session starts. Within a session you can change model and effort from turn to turn. The models listed are the ones the CLI reports. If it can't be reached, the list is empty and shows the provider's own error instead of guesses.

## Versions and updates

Each Telar build is tested against particular CLI versions:

- **Claude Code** and **OpenCode** are checked. A small version difference is marked as drifted: usually fine, and the first thing to suspect if tool calls cancel themselves. A bigger one is refused, with a message saying which version to install.
- **Codex** isn't version-checked.

When a newer CLI is out, the login shows Update available, and Telar can run the update for you when it knows how the CLI was installed. See [Updating](updating.md).

## Differences you'll notice

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Send into a running turn | Yes | Yes | No, the message waits for the turn to end |
| `/compact` | Yes | No | No |
| Ultracode, Ultrathink, fast mode, context window | Yes | No | No |
| Service tier | No | Yes | No |
| Continue after a usage-limit reset | Yes | No | No |
| Resume a conversation started outside Telar | Yes | No | No |

## Bringing in a Claude Code conversation

Type `/resume` in a new composer to pick up a Claude Code conversation you started in your own terminal. Each row shows its opening words, when you were last in it, its folder and its size. Telar copies the conversation into a new session. Your original in Claude Code's history stays exactly as it was.

## Usage

The Usage page counts what Claude Code and Codex ran on this Mac, including work outside Telar. See [Usage and limits](usage.md).
