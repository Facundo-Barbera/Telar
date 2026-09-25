# Engine performance — root causes (2026-09-24)

Symptoms reported: the UI hangs (responses wait to load, conversations wait to
hydrate, leaving Settings sometimes shows nothing until a reload), and a Claude
Code turn in Telar shows output far later than the same CLI in a terminal.

Everything below was measured on synthetic fixtures under `$TMPDIR` or read from
Claude Code's own transcripts of the 24 Sep benchmark. The live store was not
read. The fixes land as three PRs, in this order:

1. git off the event loop (this PR)
2. session history by cursor/tail
3. live streaming progress + deferred MCP tool schemas

## Ranked root causes

### 1. Synchronous git on the engine's only thread, on a slow disk

The engine is one Bun process serving every session, SSE and the cockpit.
Projects moved to an external spinning HDD, where a cold `git status` in an
older worktree takes 6.3 / 12.1 / 8.0 s (warm: 0.03 s; 142 worktrees, 167 MB
pack). Several hot paths still ran git through `createGitRunner`
(`spawnSync`):

- session creation (`isGitWorkTree`, base `rev-parse`, `rev-parse HEAD`)
- the first message to a worktree draft, and an agent's send to one
- commit
- the title-driven branch rename
- clone

Each one froze every session and the UI for the length of the git call. On
main, the diff, file-patch and overview routes already used the async runner
and a 2 s per-worktree read cache.

**Measured** (fake `git` that sleeps 2 s inside the child; 10 ms drift sampler;
`$TMPDIR/perf-git/bench.ts`):

| call | event-loop lag, sync runner (max / p99) | after (max / p99) |
|---|---|---|
| createSession (local) | 2292 / 2292 ms | 2 / 2 ms |
| sessionDiff, old sync twin | 16218 / 16218 ms | 5 / 2 ms |
| gitOverview, old sync twin | 16271 / 16271 ms | 5 / 2 ms |

The diff/overview rows measure the removed sync twins. The routes on main
already avoided them.

**Fix (PR 1).** These paths now prefetch their `rev-parse` answers on the
pooled async runner and then run the unchanged sync command, because a sqlite
command cannot span an await. Commit, rename and clone are async. The read
cache is now invalidated by the engine's own writes: commit, cut, removal, push,
rename and turn end.

The regression test blocks git under test control and asserts that timers,
immediates and another session's turn still land while create, first send,
diff and overview are pending. The test's sync runner throws, so a future
`rev-parse` added to `createSession` without a prefetch fails the test.

**Still sync, and why:**

- `volumes.ts` `diskutil`: runs only on explicit register, clone and settings
  actions, capped at 5 s.
- `host-path.ts`: runs once at process start.
- The fallback in `createSession`/`submitTurn`: used by in-process callers
  that the prefetch does not cover.

### 2. More context on every request: 142 tools, none deferred

From the `prompt_snapshot` of the first request in each benchmark transcript
(same CLI 2.1.281, same user prompt):

| | Telar | Terminal |
|---|---|---|
| tools | 142 (321,631 B) | 33 (199,688 B) |
| `mcp__mac__*` (computer use) | 56 tools, 135,951 B | — |
| `mcp__telar__*` | 37 tools, 36,935 B | — |
| `mcp__telar-browser__*` | 19 tools, 15,880 B | — |
| system prompt | 6,392 B (2,678 B orientation) | 3,953 B |
| `defer_loading` tools | 0 | 0 |
| context, first call | 98,897 tok | 60,773 tok |

Claude Code only turns tool search on by itself when MCP tools exceed about 10%
of the window, which is 100k tokens on 1M. It does not turn it on at all behind
a custom base URL, so it never happened here.

Computer use is attached to every session once permission is granted
(`withComputerUse`, `computer-use.ts`; claim time in `state.ts`), whether or
not the task needs the desktop.

**Fix (PR 3).** Set `ENABLE_TOOL_SEARCH=true` for the Claude child. An explicit
value in the engine's environment or in the session env patch still wins.

Needs a live check: rerun the benchmark and record the first-call context.
Also confirm the proxy passes deferred tools through.

### 3. Nothing on screen while the model thinks

For 6 m 50 s, the journal of Telar's first request held only `turn.started`.
Three causes, all of them before the journal (the engine, journal and SSE path
loses nothing):

- **No thinking text is sent.** Telar sets no `thinking.display`, so the API
  omits the thinking text. The CLI sends an empty thinking block, then
  `thinking_delta` frames carrying only `estimated_tokens`, a signature, and
  `system/thinking_tokens` progress messages.
- **The driver holds the reasoning `item.started`** until `content_block_stop`,
  because the first flush is only armed by a delta that has text. Nothing
  handles `system/thinking_tokens`. Tool rows open only from the `assistant`
  message, which the CLI sends once a block is complete. Eighteen Writes that
  finish close together therefore land as one burst.
- **The cockpit hides a reasoning row with empty text** (`ReasoningRow`, and
  the transcript row filter).

**Fix (PR 3).**

- Flush `item.started` when a block opens.
- Surface the estimated token count as `item.updated` on the reasoning item.
- Open tool rows at `content_block_start`.
- Render "Thinking · ~N tokens" while running, and "Thought · N tokens" once
  done.

### 4. About 5× more thinking on the first call: only partly explained

Ruled out:

- **Effort.** Live `claude` children carry `--effort medium`, and Opus 5.5 has
  no effort remap.
- **Other thinking settings.** No `MAX_THINKING_TOKENS` and no thinking config
  is sent.
- **The orientation text.** It asks for no extra planning.
- **The prompt.** Identical in both runs.

The two runs differ in:

- **Permission mode.** Telar runs `default` with a `canUseTool` gate; the
  terminal ran bypass, with an `auto_mode` attachment.
- **Tool surface.** 142 tools against 33.

Telar planned the whole app in one 44k-token block. The terminal thought for 9k
and then worked incrementally. With one run each, this is not attributable yet.

Per token the model is equally fast: about 116 tok/s in Telar, about 102 in the
terminal.

**Live measurement needed:** at least 3 runs per side with the permission mode
matched, plus one Telar run with computer use off (`TELAR_COMPUTER_USE=0`).

### 5. The whole journal on every load

`GET /v2/sessions/:id` returns the entire journal: 34.9 MB in 270–580 ms for
the orchestrator session, 8.6 MB in 76–205 ms for a ~400-turn one. The store is
sqlite; the synthetic fixture is 16 projects, 650 sessions, 304 MB, in
`/tmp/perf-c`.

**Fix (PR 2):** `?tail=N` / `?before=cursor`, the cockpit paints the tail and
pages back, and old clients keep receiving the full journal.

### Cost note, not speed: 1 h cache TTL

Every Telar cache write uses the 1 h TTL, against 5 m in the terminal. The CLI
chooses this when launched through the SDK, not the engine. It costs 2× base
input per write instead of 1.25×, but it helped the first call: 81,872 tokens
were already cached.
