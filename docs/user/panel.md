# The panel

The panel is the pane to the right of the conversation. It shows what the session is doing to your project: its changes, its files, its terminals, its browser and the agents working under it. Each session keeps its own set of panel tabs.

Press ⌘\ to show or hide it. ⌥⌘→ and ⌥⌘← move between its tabs, and ⌥⌘F lets it fill the window. A new session's panel starts empty and offers the surfaces you can open. You can drag tabs to reorder them.

## What it can show

- **Diff**: what this session changed.
- **Editor**: the project's files, with the tree beside them.
- **Terminal**: your shells and the project's running commands. See [Terminal](terminal.md).
- **Browser**: Telar's integrated browser. See [Integrated browser](browser.md).
- **Agents**: sub-agents, and the sessions working for this one.
- **Processes**: work the agent left running in the background.
- **Issues** and **Pull requests**: the project's open ones on GitHub.
- **Data** and **LaTeX**: only in projects that turned on those plugins. See [Plugins](plugins.md).

You can open a second Diff, Editor, Terminal or Browser tab when you want two side by side.

## Diff

The diff shows everything that changed since the session started: uncommitted edits and commits the agent already made. It reads the files on disk, so it also lists changes nobody mentioned, like a rewritten lockfile. Files the conversation said it wrote are marked, so the unexplained ones stand out.

From here you can commit, push the session's branch and open a pull request. Pushing and opening a pull request each ask you to confirm first. Opening a pull request needs the GitHub CLI. Nothing here discards changes or force-pushes. Use the terminal for that.

To review part of a large change, give a Diff tab a folder or file filter.

## Editor

Click a file in the tree to open it. A single click opens it as a preview that the next click replaces. Double-click the tab to keep it open. Notebooks open as cells, CSV files as a table and PDFs as documents. ⇧⌘P jumps to a file by name.

Edits save on their own shortly after you stop typing, and ⌘S saves right away. If the agent changed the file while you were editing, Telar doesn't overwrite it. It tells you, and keeps your text unsaved until you reload.

The editor highlights code, but it's not an IDE: there's no code completion or project-wide search.

## Agents and Processes

Agents lists the sub-agents the provider started during a turn, and the other sessions this conversation has handed work to. See [Agents working together](agents-together.md).

Processes lists what the agent left running in the background, such as a watch loop or a long build, with its log. Codex reports every child as an agent, so its sessions never show anything here.

## Things the agent opens

An agent can put a file in front of you, such as a report, a guide it wrote or a plot it rendered. It opens in the panel with a viewer that suits it. Browser tabs and terminals an agent opens are added to the panel's tabs, but they never open the panel or switch the tab you're looking at.

## Artifacts in the conversation

An agent can also draw something straight into the conversation: a chart, a diagram, a UI mockup or a comparison. It appears as a card with a title. Diagrams and drawings can be dragged to pan and zoomed with ⌘ and the scroll wheel, a pinch, or the + and − buttons; double-click fits them again. A diagram too wide for the card stays readable and is cut off, so drag it or use **Open in panel**, which shows it in a panel tab with more room. When the agent revises it, the newest version is drawn and the earlier cards fold to their titles.

Html artifacts run in a sealed frame with no network, so an agent's chart can't load anything from the internet or see the rest of Telar. Ask for one by describing what you want to see.

## What's not obvious

- Panel tabs belong to the session. Switching conversations switches the whole panel.
- Changes committed during the session stay in the Diff, because it compares against where the session started, not against your last commit.
- The panel shortcuts only work where there is a panel, for example inside a conversation. See [Keyboard shortcuts](keyboard-shortcuts.md).
