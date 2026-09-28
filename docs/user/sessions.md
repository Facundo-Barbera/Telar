# Sessions

A session is one conversation with one agent, on one project. It keeps its own transcript and checkout, and it survives a restart. The rail on the left lists your sessions.

## Starting one

Press ⌘N, or start a new conversation from the rail, and write your first message. Before you send it, choose where the session will work:

- **Own worktree**: Telar creates a git worktree with its own branch for this session. Several sessions can edit the same repository without colliding. You can pick the branch to start from and name the new branch. Otherwise Telar names it.
- **Project checkout**: the session works directly in the project folder, which it shares with every other session there and with your editor.

Use a worktree for anything that writes code. You can't change this choice later, because the worktree is created along with the session. The `/worktree` and `/local` commands in the composer make the same choice.

A project that isn't a git repository always uses its checkout. Set the default for new sessions in Settings → General → New sessions → Workspace, or for a single project in Settings → Projects → New conversations.

## Worktrees

- A new worktree can be prepared automatically. Telar can run a setup command, copy dependencies from the main checkout, and give the worktree its own ports. Configure this in Settings → Projects → New worktrees. Until setup finishes, the row says "Preparing".
- When a worktree is removed, Telar keeps its branch. The commits stay yours.
- Worktrees take disk space. Settings → Storage → Worktrees can remove the ones that have been inactive for a while or have no changes, and lists every worktree so you can free them. Telar never removes a worktree that has uncommitted changes, unpushed commits, or something still running. A session whose worktree was removed gets a new one when you send it another message.

## Settling and snoozing

Settling moves a session off your list without deleting anything. Settled sessions sit under Settled at the bottom of the rail. A new message brings a session back, and so does Un-settle. Settling closes the session's terminals, including shells you opened. You can't settle a session while it's working or waiting on you.

Telar also settles quiet sessions on its own. Pinned sessions and sessions with an open question stay. Change or turn off this timer in Settings → General → Settling.

Snoozing hides a session until a set time: in 1 hour, in 3 hours, this evening, tomorrow at 9:00, or next Monday. Snoozed sessions wait under Snoozed, soonest first. A snoozed session comes back early if it needs you, fails, or finishes a turn. Wake now brings it back right away.

Deleting a session removes its transcript and its worktree for good. Telar asks you to confirm.

## The rail

- **Pinned** sessions stay at the top and are never settled automatically. Pin from the session's menu or press ⌘P.
- **Group by**: Project groups sessions under their projects. None shows a single list with the newest first. In that list, sessions started by another session appear under that session.
- **Search** matches session titles and project names, across every band, settled and snoozed included. The project filter at the start of the search field narrows the rail to the projects you pick.
- **Drafts** are messages you started in a new session but never sent. They sit at the top of the rail.
- **Status**: "Waiting on you" means a question or an approval needs your answer. It's the only highlighted state. Other states include Working, Queued, Background (work still running after the turn ended), Waiting on session and Scheduled.

Shortcuts: ⌘1–⌘9 jump to the rows in your list (snoozed and settled rows are skipped), ⌘K opens the command palette, and ⌘B hides the rail.

## Titles

Telar replaces the placeholder title with a short generated one, and can also rename the branch it created to match. It never changes a title you set yourself. Rename a session by double-clicking it. Settings → General → Generated text picks the provider and model that write titles.
