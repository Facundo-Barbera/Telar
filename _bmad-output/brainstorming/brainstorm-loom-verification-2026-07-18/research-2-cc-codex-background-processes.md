# Research 2 — Background Processes in Claude Code & Codex CLI

> Scout report, 2026-07-18. Feeds the loom-verification brainstorm. Sources: official docs, anthropics/claude-code + openai/codex repos, GitHub issues verified live via `gh issue view`. UNVERIFIED items marked.

## Claude Code

### In-session background commands
- `Bash` with `run_in_background: true`; auto-backgrounding when a foreground command hits its timeout (moved to background instead of killed; disable-all via `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`).
- Output is incremental/cursored: `BashOutput(bash_id, filter?)` returns only new output since last check; newer builds generalize to Task system (`TaskOutput` deprecated in favor of `Read` on the task's output file; `TaskStop` by id). A `Monitor` tool watches output without manual polling.
- Human surface: `/tasks` list + interactive kill; Ctrl+B backgrounds a running foreground command.
- Dev-server idiom: start in background → poll output for "listening" line → curl the port.

### Whole-session background agents (the second level)
- `/background` (`/bg`), `claude --bg "prompt"`, `/fork` — detached sessions hosted by a **per-user supervisor daemon** (`claude daemon status`), state at `~/.claude/jobs/<id>/state.json` + `~/.claude/daemon/roster.json`. Survive terminal close and CLI auto-update; `claude agents` TUI: attach/logs/stop/kill/respawn/rm.
- Headless (`claude -p`): background Bash killed ~5s after final result; background subagents waited on (10 min cap default).

### SDK surface (directly relevant to telar as embedder)
- Typed events: `task_started`, `tool_progress`, `task_notification` (status + output_file); `query.stopTask(taskId)`; `AgentDefinition.background?: boolean`; stall watchdog env var for background subagents.

## Codex CLI
- **Unified exec**: `exec_command` (allocates a PTY, blocks up to `yield_time_ms` 250ms–30s, returns `session_id` if still running) + `write_stdin` (feed input / poll output). `ProcessStore` with LRU eviction at 64 processes; 1 MiB output buffer.
- Control surface is coarse: `/ps` lists (read-only, ~3-line previews); `/stop` kills ALL background terminals — **no per-process kill** (#8656); no live full-output streaming while running (#14928); indefinitely-streaming commands never auto-detach (#5948).
- **Sandbox coupling**: workspace-write mode has **network off by default**; `[sandbox_workspace_write] network_access = true` required for a server to bind/be reachable — and it's **silently ignored on macOS Seatbelt** (#10390, open). `allow_local_binding` separately gates loopback. A Codex-started server's reachability is untrustworthy without an explicit probe.
- Codex Cloud environments (different product): container image + setup script (internet on) + maintenance script + env vars + secrets (setup-phase only); agent-phase internet off by default; no preview-URL/port-forward found.

## Verified pain points (both ecosystems)
- **Orphaned process trees**: children reparented to PID 1 on session exit, running indefinitely (CC #43944 — explicitly: no way to tag Claude-spawned PIDs; CC #16198, #50865; Codex #15379, #16256, #12491 — 1300+ zombies/37GB).
- **Timeout kills the wrapper, not the children** (Codex #4337 — `bash -lc` killed, children keep pipes open and hang the session).
- **Stale/duplicated status**: shells reported "running" after completion (CC #13091, #14049); shell-slot counter leaks on crash (CC #38927).
- **Duplicate dev servers on port conflict** because the agent loses track of what it already started (CC #9780).
- Persistent system-reminders about finished background shells burning tokens (CC #12302 et al).

## Design synthesis for telar

1. CC already has telar's two-level split: in-session background commands (id, incremental output, stop-by-id) vs whole-session background agents (supervisor daemon). Codex only has the low-level PTY tier, coarser.
2. Convergent failure mode across both: **no ownership tagging of spawned process trees** → orphans, duplicates, unkillable children. A telar primitive must track full process-tree PIDs and own cleanup itself.
3. Under Codex, "the port is reachable" is untrustworthy without an explicit health probe (sandbox networking, broken opt-out on macOS).
4. Model telar's primitive on CC's **typed SDK event surface** (start/progress/notification events + stop-by-id), not Codex's raw PTY polling — regardless of which agent is driving.
