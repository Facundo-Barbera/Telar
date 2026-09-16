# Deep Agents JS — installed-package audit

Issue #528, part B, steps 1 and 2. Everything below is read off the installed
package or measured by a probe in `src/`, on Bun 1.3.11 / macOS arm64
(Darwin 25.6.0). Nothing here is a docs claim unless it is labelled as one.
Scenarios 1–7 are **not** in this document — they wait on session A's harness.

Re-derive any number here with `bun install && bun run probe:all` in this
directory, plus `bun run src/probe-wins.ts`.

## Versions

| Package | Version |
| --- | --- |
| `deepagents` | 1.13.4 |
| `@langchain/langgraph` | 1.4.15 |
| `@langchain/core` | 1.2.11 |
| `@langchain/openai` | 1.5.13 |
| `@langchain/langgraph-checkpoint` | 1.1.5 |
| `langchain` (pulled in transitively, peer) | 1.x |
| `zod` | 4.3.6 |
| Bun | 1.3.11 |

`deepagents` declares `langsmith >=0.7.1 <0.10.0` as a peer but the tree
resolves `langsmith@0.10.4`, so **every install prints a peer-dependency
warning**. It works anyway in all four probes; it is noise, not breakage.

## 1. Exported API

`createDeepAgent(params?) => DeepAgent` — async, returns a compiled LangGraph
graph wrapped with `recursionLimit: 1e4` and `ls_integration: "deepagents"`
metadata. Roughly 60 other symbols are exported (middleware factories,
backends, sandbox types, harness-profile helpers); the ones that matter for us
are `createFilesystemMiddleware`, `createSubAgentMiddleware`,
`createSummarizationMiddleware`, `createSkillsMiddleware`, `StateBackend`,
`FilesystemBackend`, `StoreBackend`, `CompositeBackend`.

`CreateDeepAgentParams` — all camelCase:

| Option | Type | Note |
| --- | --- | --- |
| `model` | `BaseLanguageModel \| string` | defaults to the string `"anthropic:claude-sonnet-4-6"` |
| `tools` | `(ClientTool \| ServerTool)[]` | **added to**, never replaces, the built-ins |
| `systemPrompt` | `string \| SystemMessage \| SystemPromptConfig` | structured form deprecated |
| `stateSchema` | state schema | persisted by the checkpointer |
| `middleware` | `AgentMiddleware[]` | applied after the standard stack |
| `subagents` | `AnySubAgent[]` | sync, compiled and async subagents in one array |
| `responseFormat` | Zod schema etc. | structured output |
| `contextSchema` | schema | **not** persisted between invocations |
| `checkpointer` | `BaseCheckpointSaver \| boolean` | |
| `store` | `BaseStore` | long-term memory |
| `backend` | backend instance or factory | defaults to `new StateBackend(config)` |
| `interruptOn` | `Record<string, boolean \| InterruptOnConfig>` | the approval gate |
| `name`, `memory`, `skills`, `permissions`, `streamTransformers` | | |

`index.js` and `node.js` are byte-identical in this build; the `./node`
subpath buys nothing today. A separate `./browser` build exists.

`index.d.ts` re-exports through a 180 KB `agent-*.d.ts` with every symbol
aliased to a one- or two-letter name. Editor go-to-definition lands in
minified-looking type soup. Minor, but it is what reading this API is like.

## 2. Default tools it injects — 8 of them

Measured (`src/probe-defaults.ts`), with a fake model, no options:

| Tool | Purpose |
| --- | --- |
| `ls` | list a directory in the virtual filesystem |
| `read_file` | read with pagination (100-line default window) |
| `write_file` | create or replace a whole file |
| `edit_file` | exact string replacement; requires a prior read |
| `delete` | remove a file or directory |
| `glob` | glob for paths |
| `grep` | **literal** substring search, not regex; 1000-match cap |
| `task` | delegate to an ephemeral subagent |

`execute` is a ninth built-in, registered only when the backend can run
commands. `StateBackend` cannot, so it is absent by default.

**`write_todos` is NOT injected.** The planning/todo tool that the deep-agents
write-ups lead with is opt-in via `TodoListMiddleware` in 1.13.4; `todos` is
`undefined` in state after a default turn. The issue lists "planning/todo" as
a win to measure — as shipped it is not a default, it is one more middleware
you could equally add to a plain LangGraph agent.

### Both tool-bearing middlewares are mandatory

```js
const REQUIRED_MIDDLEWARE_NAMES = new Set(["FilesystemMiddleware", "SubAgentMiddleware"]);
```

Excluding either throws. You can narrow the filesystem surface with an
allowlist — but `read_file` must be in it, and `task` survives even with
`subagents: []` and `generalPurposeAgent: false`.

### What that costs per turn

Measured with `js-tiktoken` `cl100k_base` over name + description + JSON
schema, against one 74-token custom tool (`src/probe-injection-cost.ts`):

| Configuration | Tools | Total | **Injected overhead** |
| --- | --- | --- | --- |
| Default `createDeepAgent` | 9 | 2,744 tok | **2,670 tok/turn** |
| Narrowed as far as the API allows | 3 | 1,073 tok | **999 tok/turn** |

Per tool: `read_file` 715, `grep` 538, `edit_file` 383, `task` 355,
`write_file` 243, `delete` 192, `glob` 132, `ls` 112.

So a Telar Agent that has no filesystem at all still pays ~1,000 tokens on
every single model call, and ~2,670 if you take the defaults. Over the
40-turn scenario 7 that is 107k tokens of tool schema the LangGraph baseline
does not spend.

## 3. The default system prompt: there isn't one

The headline surprise. `createDeepAgent` with a fake model sends **no system
message at all** — 0 chars, measured.

`BASE_AGENT_PROMPT` (1,703 chars), `TASK_SYSTEM_PROMPT` (2,165),
`EXECUTION_SYSTEM_PROMPT` (279) and `DEFAULT_SUBAGENT_PROMPT` (108) are all
still exported, but the source marks them dead:

> `@deprecated` Legacy prompt compatibility exports. These prompts are
> retained only so existing imports continue to resolve. **Deep Agents no
> longer injects authored base prose or duplicate built-in middleware guidance
> by default.** Do not use these in new code; they will be removed in the next
> major release.

What replaced them is the **harness profile**: `createDeepAgent` resolves a
profile from the model spec and takes `baseSystemPrompt` from it. The registry
ships **empty** — no profile is registered at module load — so
`resolveHarnessProfile` returns `EMPTY_HARNESS_PROFILE` for every model, ours
included, and the base prompt is empty. An app can `registerHarnessProfile()`
its own.

Two consequences worth carrying into the report:

- The "injected prompts" cost the issue asks about is **not** prose. It is
  tool schemas, measured above. The prose cost is zero.
- Deep agents' default behavioural guidance is *also* zero. Whatever made a
  deep agent behave like one in the write-ups is, on this version, something
  you supply yourself. The remaining structural difference is the tools, the
  subagent graph and the middleware — not a prompt.

The one thing that *does* add a system prompt is skills: 2,032 chars for a
single trivial skill (below).

## 4. What backs the virtual filesystem

`StateBackend` by default: files live in the graph state under `files`, as
`Record<path, FileData>`. Measured — a `write_file` to `/notes.md`:

```json
{"/notes.md":{"content":"hello","mimeType":"text/markdown",
  "created_at":"…","modified_at":"…"}}
```

…and `existsSync("/notes.md") === false`. **No real cwd, no disk, no
sandbox.** The `files` key is part of the checkpoint, so it persists and
restores with the thread exactly like `messages`.

Alternatives ship in the box: `FilesystemBackend` (real disk under a
`rootDir`), `StoreBackend` (LangGraph store), `CompositeBackend` (route
prefixes to different backends), plus sandbox protocols. `permissions` are
glob rules over `read`/`write`, first match wins, permissive default — and
they are *not* enforced on `execute`, which throws a `ConfigurationError` if
you combine permissions with an execution-capable backend.

For a Telar Agent with no project and no cwd this is the good news: the
filesystem is a scratchpad in the checkpoint, not an assumption about the
disk. It is still 1,671 tokens/turn of tool schema for a scratchpad.

## 5. Subagents

`task` launches an ephemeral subagent. Measured: the subagent's model call
carries a **fresh 2-message context** with no trace of the parent's user turn,
and the parent transcript grows by only the tool call and its result — the
subagent's own turns are never spliced in. The parent sees one final report
string. A `general-purpose` subagent is registered automatically unless the
harness profile disables it or you supply one by that name.

Each subagent gets its own filesystem, summarisation and patch-tool-calls
middleware, and inherits the parent's `permissions` unless it declares its
own. Custom subagents do **not** inherit the parent's skills; only the
general-purpose one does.

This is a genuine capability. It also overlaps almost exactly with what Telar
already does with real sessions — and unlike a Telar session, a `task`
subagent is in-process, invisible in the rail, and has no journal a human can
read afterwards.

## 6. Summarisation and offload

`SummarizationMiddleware` is in the default stack. Thresholds are
**model-derived**, measured via `computeSummarizationDefaults`:

| Model advertises `profile.maxInputTokens`? | Trigger | Keep | Arg truncation |
| --- | --- | --- | --- |
| yes | 85% of window | last 10% | at 85%, keep 10% |
| no | 170,000 tokens | last 6 messages | after 20 messages, keep 20 |

Our Go model through `@langchain/openai` will almost certainly fall in the
second row — *inference, not measured; it needs A's model factory to confirm*.
A flat 170k trigger against a model whose real window may be smaller is a
misfire risk worth checking in scenario 7.

Overflowing tool results are offloaded to the virtual filesystem rather than
dropped: default 20,000 tokens (~80 KB) for a tool result, 50,000 (~200 KB)
for a human message, with conversation history written under
`/conversation_history`. `ls`, `glob`, `grep` and `read_file` are exempt.

**Summarisation does not destroy the checkpoint.** From the source: rather
than issuing `RemoveMessage(REMOVE_ALL_MESSAGES)`, the middleware stores a
summarisation event and reconstructs the effective message list per call.
So the full transcript — and any parked approval — survives in state. This is
the strongest single argument for B on scenario 7, and it is also
re-implementable in A in well under a hundred lines.

## 7. Skills

Measured: with `skills: ["/skills/"]` and one trivial `SKILL.md` in state, the
system prompt goes from 0 to **2,032 chars**, containing the skill's *name and
description only* — the body is not inlined. Progressive disclosure: the agent
reads the file when it decides it needs it. Skills are read from the backend,
so with `StateBackend` they need no real directory.

## 8. Bun compatibility

`deepagents` itself: **fine**. It imports, constructs, runs turns, delegates,
interrupts and resumes on Bun 1.3.11. No native modules, no Node-only APIs hit
in four probes.

**The checkpointer is not fine, and this hits both variants.**
`@langchain/langgraph-checkpoint-sqlite` binds `better-sqlite3`, which Bun
refuses to load:

```
error: 'better-sqlite3' is not yet supported in Bun.
 code: "ERR_DLOPEN_FAILED"    (oven-sh/bun#4290)
```

It throws at `SqliteSaver.fromConnString()`, before any agent exists. #528
asks for a durable saver, explicitly not `MemorySaver`, on a Bun-only
prototype — with the official package that is unsatisfiable, for **A as much
as for B**.

`src/bun-sqlite-saver.ts` is a port onto Bun's built-in `bun:sqlite`, same
two-table schema, same serde, so the files stay interchangeable. Verified:
a thread checkpoints, a tool interrupt parks, and a brand-new agent object
with a brand-new saver over the same file resumes the approval and runs the
tool. Reported to session A, offered for the shared harness.

Two porting gotchas, recorded for whoever owns it: `bun:sqlite` throws on
`undefined` bindings (the official saver passes `undefined` for
`parent_checkpoint_id`), and `.get()` returns `null`, not `undefined`.

## 9. Package footprint

Two scratch installs, `du -sh node_modules`:

| Variant | node_modules | Packages | Cold install | Warm |
| --- | --- | --- | --- | --- |
| langgraph + core + openai | 91 MB | 24 | 1.38 s | 1.51 s |
| the same, plus `deepagents` | 100 MB | 45 | 1.67 s | 1.09 s |
| **delta** | **+9 MB** | **+21** | +0.29 s | — |

Cold timings use an isolated `BUN_INSTALL_CACHE_DIR`, so they include the
download; the shared cache was left alone. `deepagents` itself is 2.7 MB.

The 21 extra packages are `deepagents`, the `langchain` umbrella package, and
a `fast-glob`/`micromatch` tree (`braces`, `picomatch`, `fastq`, `@nodelib`,
`reusify`, `run-parallel`, `merge2`, …) plus `yaml`. Pulling in the whole
`langchain` umbrella for what a LangGraph app otherwise avoids is the more
interesting cost; 9 MB is not.

## 10. Official JS docs vs the installed package

The issue is right that the docs mix Python. Every mismatch below was checked
against 1.13.4 by running it.

| # | Docs say | Installed 1.13.4 | Impact |
| --- | --- | --- | --- |
| 1 | `interrupt_on`, `excluded_tools`, `register_harness_profile`, `from deepagents import` on the JS overview page | `interruptOn`, `excludedTools`, `registerHarnessProfile` | snake_case copied from Python; fails to compile |
| 2 | Default tools are `ls, read_file, write_file, edit_file, glob, grep` + `execute`/`eval` | `delete` is a built-in and is **not** documented; there is no `eval` tool in `FILESYSTEM_TOOL_NAMES` | an undocumented destructive tool ships on by default |
| 3 | The harness supplies "core agent instructions" | no system prompt is sent; `BASE_AGENT_PROMPT` is deprecated and uninjected | the docs describe the pre-1.13 behaviour |
| 4 | Skills example passes `FileData` as `{content: string[], created_at, modified_at}` | that is the **v1** shape; v2 requires `mimeType` and a string body. Copying the docs example throws at invoke | and the error names the *file path* as a missing state field, which sends you the wrong way entirely |
| 5 | LangGraph JS interrupts page: `new Command({resume: {action: "approve", …}})`, any JSON value | the HITL middleware wants `new Command({resume: {decisions: [{type: "approve"}]}})` and throws `Invalid HITLResponse: decisions must be a non-empty array` otherwise | cost me a probe run; the deep-agents HITL page is correct, the LangGraph one is not |
| 6 | LangGraph JS persistence page names `MemorySaver`, `SqliteSaver`, `PostgresSaver`, `AsyncPostgresSaver` | `AsyncPostgresSaver` is a Python-only class | Python leakage on a JS page |
| 7 | Same page gives no npm package for `SqliteSaver` and no native-dependency note | it is `@langchain/langgraph-checkpoint-sqlite` and it cannot run on Bun at all | the single most expensive gap; see §8 |
| 8 | The interrupts page says only "use a durable checkpointer in production" | no durable JS saver works on Bun out of the box | — |

One thing the docs get right: they scope `write_todos` to `TodoListMiddleware`
rather than presenting it as a default, which matches §2. The write-ups
*about* deep agents are what oversell it, not the reference.

## Still to do

Steps 3 and 4 — `src/variants/deepagents.ts` on A's harness, scenarios 1–7,
the A-vs-B evidence and win/loss tables in `REPORT.md`, and the
recommendation — are blocked on session A publishing the shared harness. A is
still working; nothing of its branch has landed on `main` yet.
