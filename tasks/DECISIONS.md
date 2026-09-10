# Decisions

## 2026-09-08 — GitHub as task tracker

- GitHub Issues is the authoritative backlog/status/discussion record. Local task files are pointers and supporting artifacts only.
- Keep one issue per task; DEV-003 is included in Live Dev #184. Reuse existing GitHub issues instead of duplicating them.
- Status labels provide Backlog, Ready, In progress, Review, Done. A GitHub Project board is pending Projects authorization; do not claim it exists yet.
- Only user-selected work starts. Migration does not dispatch backlog or review tasks.

## 2026-09-08 — local development and orchestration

- User directs priorities and tells the orchestrator what to address next.
- Use Telar agents for implementation. Next-phase work uses the local checkout on `dev/local-dogfood`; serialize writers and branch changes.
- Preserve existing branches, worktrees, unfinished edits, and app data.
- The installed nightly Telar app and its data are off-limits for development changes. It updates only through the nightly channel.
- Mac Dev is a separate app: `com.telar.desktop.dev`, with its own `~/Library/Application Support/Telar Dev` home and updater disabled. Do not share mutable state with nightly.
- iPhone Dev is `com.telar.mobile.dev`; TestFlight nightly is `com.telar.mobile`. Updates target Dev explicitly. Pairing Dev phone with Dev Mac is separate from nightly.
- A Dev rebuild is not proof of successful interactive launch. Record build, install, process health, visual verification, and user acceptance separately.
- No new publication is queued for the local phase. Prior authorization delivered the six-PR nightly batch; record any future delivery instruction explicitly.
- DEV-005 is the selected active task, including the helper correction DEV-003. Its foundation build is awaiting review and isolated acceptance; do not start backlog tasks automatically.
- Loom/Ultra/Warp roadmap and the floating desktop companion are retired at the user's request. Their nine GitHub issues were closed as not planned; do not carry them into the new plugin scope or repeatedly suggest them.
