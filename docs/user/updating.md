# Updating

The Telar desktop app updates itself. The agent CLIs it drives (Claude Code, Codex, OpenCode) are separate programs, and Telar can update those for you too.

## How Telar updates

Telar checks for a new build at launch and every six hours after that. When it finds one, it downloads it in the background and tells you it's ready. The update control at the bottom of the rail changes to install and restart, and Settings → Updates says the same.

Nothing installs until you choose to. You can install in one of two ways:

- **Install and restart** now. Telar asks first and tells you what the restart will interrupt: sessions that are working, and terminals whose commands will be ended.
- **Install on quit** (Settings → Updates). A downloaded update installs the next time you quit Telar.

To check by hand, use the update control in the rail, Settings → Updates, or Check for Updates… in the command palette.

## Sessions across a restart

With **Continue sessions after restarting** on (Settings → Updates), sessions stopped by an update restart pick up where they left off. Each one gets a single message saying Telar restarted.

- This only happens when restarting to install an update. A crash never resumes anything.
- Terminals and running processes don't come back.
- A session you stopped or settled yourself stays as it was.

## Channels

Settings → Updates → Channel picks which builds you get:

- **Beta**: tested builds, released on purpose. This is the default and the safe choice.
- **Nightly**: every build from the main branch as soon as it lands. You get fixes first, and you should expect things to break.

## When it doesn't update

- If a download stops making progress, Telar cancels it and says so. Check again to retry.
- A build packaged on your own machine has no update feed, so it never checks. Settings → Updates says so.
- In a browser tab there's no updater. Only the desktop app updates.

## The iPhone app

The iPhone app updates through TestFlight, not through Telar.

## Updating the agent CLIs

Settings → Providers shows each login's CLI version. When a newer one is out, the login shows **Update available**:

- If Telar can tell how the CLI was installed, it shows the exact command and an **Update now** button that runs it. Every login that uses the same program is updated with it.
- If it can't tell, update the CLI the same way you installed it.
- **Newer, but not for this build** means your version is the one this Telar build was tested with. There's no button, because moving off it is a common cause of cancelled tool calls. You can still update it yourself.
