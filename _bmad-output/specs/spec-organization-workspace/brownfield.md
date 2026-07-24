# Brownfield — Organization Workspace

Companion to `SPEC.md`. What already exists in telar, what blocks a project-less master session, and what the harnesses do and don't support. Claims below were re-verified against the working tree at spec time; line numbers drift, the shapes don't.

## The one hard coupling

Project coupling lives in **the chat route, not the engine**.

- `packages/core` `engine.ts` `agent()` takes `cwd` as an **optional** param falling back to `process.cwd()`, with **zero manifest dependency**. Nothing in the engine requires a project.
- `apps/web/app/api/chat/route.ts` is where the gate is:
  - `manifest = getProject(project).manifest` — wrapped in a try/catch that returns a **plain 400** for an unknown or missing project, deliberately before any SSE stream opens.
  - `const workspace = manifest.root` — and `workspace` then feeds **cwd, guardrails, and settingSources** for both providers.

Everything else about project-less chat is nearly free:

- `Chat.project` is **already optional** in core's store.
- Permissions are **string-keyed** — a synthetic `'__master__'` key works without a schema change.
- Session logs are keyed by `sessionId` only.
- The loom and ultra MCP servers dereference project **lazily, inside mutating tools** — so they can be mounted in a project-less session without exploding.

**Remaining blockers, in full:** the upfront project gate, a synthetic cwd, default guardrails, and `settingSources: []`.

## The Codex MCP gap (pre-existing, now in scope)

Codex sessions **never receive project MCP servers today**.

- `resolveProjectMcpServers(project)` is wired in exactly one place — the **Claude branch** of the chat route, spread into the SDK's `mcpServers` alongside `loom` and `ultra`, with `strictMcpConfig: true` (Telar deliberately owns the MCP surface; `settingSources` of `project`/`local` would leak the repo's `.mcp.json` and the user's local Claude MCP config as duplicate unauthenticated servers).
- `runCodexTurn` has **no MCP plumbing at all** — its call site passes `prompt, cwd, env, model, reasoningEffort, sandbox, resume, signal, approvalPolicy, onApproval` and nothing else. The Codex driver only *renders* inbound `mcpToolCall` events; it has no injection path.

Because SPEC.md commits the master to a full harness session, this gap is **required work for a Codex-backed master**, not incidental cleanup. A Claude-backed master is unblocked today.

## Harness findings

### Claude Code

- `cwd` is **incidental, not hard-required** — an empty non-git directory works fine empirically. There is no dedicated no-cwd mode (the process cwd is always used), but the SDK's `cwd` is optional with a `process.cwd()` default.
- `settingSources: []` zeroes ambient config discovery.
- MCP injection is fully programmatic (`mcpServers` + `strictMcpConfig`) — already the pattern Telar uses.
- The trust dialog is **skipped** in non-interactive/SDK mode.
- Session history and auto-memory are keyed **per-directory** (`~/.claude/projects/<encoded-path>`).

### Codex

- Also no no-cwd mode. `-C`/`--cd` sets the working root and **the directory must exist**.
- An empty non-git dir works once `--skip-git-repo-check` (SDK: `skipGitRepoCheck`) is set.
- The sandbox's workspace-write boundary is working-root + `--add-dir`, **purely path-based**.
- Per-invocation MCP injection is verified two ways with **zero global config**:
  1. `-c mcp_servers.<name>.<field>` dotted overrides (SDK: config object → repeated `--config` flags), or
  2. `CODEX_HOME` pointed at a synthetic dir.
  `--ignore-user-config` gives config-file-free runs.

### Conclusion

Neither harness has a true working-directory-less mode, but neither needs a *meaningful* one — both run fine in an empty directory (Claude Code natively, Codex with the skip flag). Both key state **per-directory** (CC history + auto-memory; Codex trust + sandbox writable roots), which is the argument for **one stable synthetic home** over throwaway scratch dirs: a stable home accrues one continuous history/memory bucket, scratch dirs fragment it.

## Master session shape (decided)

Per SPEC.md, the master is a full harness session configured as:

| Setting | Value | Why |
| --- | --- | --- |
| project gate | **skipped** | The route's `getProject` 400 must not apply to the master |
| `cwd` | `TELAR_HOME/workspace/home` | A dedicated empty subdir — the store (`lanes.yaml`, `packets/`) sits above it, outside the master's path-based write boundary. Per-directory state keying makes this accrue continuous history |
| `settingSources` | `[]` | Zero ambient config discovery |
| guardrails | defaults | No project manifest to source them from |
| MCP | injected directly | Claude: `mcpServers` + `strictMcpConfig`. Codex: `-c mcp_servers.*` overrides (closes the gap above) |
| Codex extras | `skipGitRepoCheck` | The workspace home is an empty non-git dir |

**Never use `/Users/facundo` as cwd** — trust never persists there.

## The workspace MCP server (new, in v1 scope)

Cross-surface item access ships as an **in-process MCP server**, following the existing `lib/loom-mcp.ts` / `lib/ultra-mcp.ts` pattern (no separate transport), exposing list / create / modify over the store.

It is not optional convenience. The brainstorm planned "harness file tools for v1," but that does not work for CAP-12:

- Codex's sandbox workspace-write boundary is **purely path-based** — working root + `--add-dir`. A project session's root is its own repo, so `TELAR_HOME/workspace` is outside it.
- Claude sessions are likewise cwd-anchored, and Telar sets `settingSources` deliberately to keep ambient config out.
- Granting every project session an `--add-dir` onto the workspace store would widen each session's write boundary across all projects' items — the opposite of the isolation the rest of the system maintains.

Mounting it alongside `loom` and `ultra` in the chat route's `mcpServers` also means it inherits `strictMcpConfig: true` and the existing `PreToolUse` guardrail path.

## Existing artifacts

- UI mockups: `apps/web/lib/demo-gallery/workspace/**` — `fixtures.ts`, `shared.tsx`, `home.tsx`, `queue.tsx`, `packet.tsx`, `session.tsx`; registered as four gallery entries and viewable at `/demo-gallery`. Design source-of-truth prototypes, **not production code** — see `ui-contract.md` for what is contractual.
- The `Conversation` component extraction plan (adopted companion) — master chat is named there as one of the new surfaces to be born on the shared shell rather than hand-rebuilt, and `ApprovalCard` is named as the protocol rendering for `weave_batch` and lane splits.
- Production chat still runs `session-view.tsx`; the extraction is a pure-render carve-out at the render seam, to be proven in the demo gallery first.
