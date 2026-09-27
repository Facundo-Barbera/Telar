# Plugins: the contract

Status: P1a landed (tools and prompt text); P1b scoped routes landed. Everything marked *planned* is the target shape, not code yet.

A plugin is a feature that the core does not name. Data Science and LaTeX are **bundled plugins**: they are compiled into the engine, but they reach the core only through the contract below. A future **external plugin** will use the same manifest and contribution points, and will differ only in where its code runs.

## Two halves

| Half | Where it lives | Crosses a wire? |
| --- | --- | --- |
| **Manifest**: `PluginMeta` | `packages/engine-client/src/protocol/plugins.ts` | Yes. It is served in `/v2/health`, stored, and decoded by web and iOS. |
| **Modules**: `PluginEngineModule` (daemon) and `PluginToolModule` (anywhere tools are registered) | `apps/engine/src/plugins/contract.ts` and `tool-module.ts` | No. They are executable code. |

The manifest is plain data. On the day a plugin is loaded from a folder, its `plugin.json` will be exactly `PluginMeta`, and only the module-loading half will be new.

## Contribution points

### 1. Tools and prompt text (P1a, done)

- `meta.toolPrefixes` lists the tool namespaces the plugin owns. Data Science owns two of them: `ds` and `notebook`. Prefixes are globally unique, and the host asserts them against `BUNDLED_PLUGIN_TOOL_PREFIXES` so that `parseToolName` can type a tool without a plugin host (web, iOS).
- `PluginToolModule.tools(tool, capability)` returns the wall. It is pure over a **capability port**. `capability(call)` builds that port over the generic wire `POST /v2/sessions/:id/plugins/:plugin/:verb`, so the worker needs no per-plugin client.
- `meta.briefing` is the paragraph a session is told when the plugin is enabled for it. Each driver (Claude, Codex and OpenCode) appends `pluginBriefings(enabledIds)` after the browser and run briefings.
- `meta.readTools` is a **claim**, not a grant. The reads that take effect are `claim ∩ HOST_RATIFIED_READ_TOOLS[id] ∩ own prefixes` (see `policy.ts`). Ratifying a read is a security decision, and it is made in a reviewed diff to the host.

Registration is generic in three places, and none of them names a plugin:

| Path | Who uses it | Where |
| --- | --- | --- |
| Claude, in-process SDK server | packaged app, no socket | `driver.ts` loops over `pluginToolModules()` |
| Claude, `telar` socket | worker-hosted socket | `driver.ts` adds one `TelarWallPart` per module |
| Worker lease | Codex, OpenCode | `worker.ts` adds one `TelarWallPart` per module |

**Invariant: one key.** Every wall rides the `telar` MCP key, so a tool keeps a single qualified name (`mcp__telar__ds_kernel`) on every provider. That name is the identity of stored approvals and journal rows. A plugin must never move its tools to another key.

**Enabled set.** The claim carries `plugins: string[]`, which lists the ids this turn may use. The engine resolves it at claim time, applying the machine ceiling and the project opt-in (plus the resolved-environment gate for the two mirrored plugins). The worker builds a capability only for those ids. A missing id means no tools and no briefing. The Claude fingerprint and the OpenCode server identity both carry the sorted ids, so toggling a plugin cold-starts the provider.

### 2. Scoped routes (P1b, routes done)

There are three tables, one per scope:

| Scope | Field | Served at | Gate |
| --- | --- | --- | --- |
| session | `routes` (`verb → (input, capability)`, POST only) | `/v2/sessions/:id/plugins/<plugin>/<verb>` | `resolve(sessionId)`: Mac and project |
| project | `projectRoutes` | `/v2/projects/:id/plugins/<plugin>/<verb>` | Mac and project, unless the route sets `beforeEnable` |
| machine | `machineRoutes` | `/v2/plugins/<plugin>/<verb>` | Mac |

- Project and machine entries are keyed by method and path: `"GET environments"`, `"DELETE jobs/:id"`. A `:name` segment captures one path segment.
- Each entry is `{ status?: 200 | 202; beforeEnable?; handle({ input, query, params }, scope) }` (see `plugins/routes.ts`). The daemon matches the route, gates it, parses the body and writes the response.
- Error handling:
  - `PluginInputError` becomes a 400 `invalid_request`.
  - Any other unexpected throw becomes `plugin_error`, carrying the plugin id.
  - Refusals because a plugin is off use the session door's words: `<id> is turned off for this Mac`, `<id> is not enabled for this project`.
- `beforeEnable` is for the reads a person uses to choose settings before turning the plugin on: DS environments, create environment and probe; LaTeX distributions. The Mac switch still refuses these.
- The old paths are now aliases into the same tables, ungated and not relabelled, so their HTTP behaviour is unchanged:
  - `/v2/projects/:id/{data-science,latex}/*`
  - `/v2/{data-science,latex}/*`
  - session `/ds/*` and `/latex/*`

  Callers still on the aliases, to move in P2:
  - `packages/engine-client` methods `dataScience*`, `latex*`, `managedTectonic` and `installManagedTectonic`, and through them the web settings panes (`data-science-section`, `latex-section`, `*-machine-settings`, `packages-panel`, `job-log`) and the web `app/api/{data-science,latex,projects/[id]/…}` proxies;
  - iOS `EngineAPI.latex(...)`, which uses the session `/latex/*` alias.
- `/v2/sessions/:id/data/table` stays core: it serves CSV with Data Science off, and only Parquet borrows the kernel.
- **Kernel host (done):** Data Science's `init` builds the `KernelHost` from the store's half of the options (engine root, session dirs, state and plot recording), attaches it to the store and registers its teardown. It is still built only on a daemon that runs turns (embedded worker), as before.
- **What stays in `state.ts`, and why:**
  - The job runners `dsJobs` and `latexJobs`, together with the settings verbs that start jobs on them (environments, installs, bootstraps). Those verbs are store methods that resolve projects, checkouts and machine settings through store state. Moving a runner without its verbs would leave the store reaching into a plugin for its own jobs. They move together when the verbs leave the store (P1c or later).
  - `store.dataScience()` / `store.latex()`, the capability resolvers. They are the gate (project opt-in, worktree rule, machine ceiling) and read store state directly.

### 3. Panel surfaces and file viewers (P2, *planned*)

These are declared in the manifest as data, so that web and iOS can register them without running engine code:

```ts
ui?: {
  panels?: { id; label; icon; scope: "session" }[];   // right-panel tabs
  viewers?: { id; extensions: string[]; label }[];    // e.g. .ipynb, .tex/.pdf
  commands?: { id; label; verb }[];                   // palette entries → a route
}
```

Bundled plugins map each id to a React component in a web registry. External plugins get a declarative renderer (P4). The iOS `PluginID` becomes an open string.

### 4. Settings schema (P3, *planned* beyond what exists)

- The manifest already has `settings` sections (`scope: project | machine`), `settingsSchema` and `machineSettingsSchema`. The host validates writes against these, and the protocol keeps the settings blob opaque.
- P3 generates the settings pane from the schema and gives each scope a single on/off switch.

### 5. Events

`meta.eventKinds` lists the journal kinds the plugin emits, inside the `plugin.event` envelope (for example `kernel.state.changed`). P2 adds a timeline renderer per kind.

### 6. Requirements and installers (P1b/P4, *planned*)

A manifest section will declare what the plugin needs on the machine, for example:

```ts
requires?: { id; label; probe: verb; install?: verb }[]
```

`probe` and `install` are machine-scoped routes, so the cockpit can render "LaTeX needs a TeX distribution: Install" generically. Today that pane is hand-written per plugin.

### Lifecycle (exists)

- `init(context)` is bounded by `PLUGIN_INIT_TIMEOUT_MS`. It registers a cleanup for each resource as it acquires it (`onDispose`).
- The hooks are `drain` → `busy` → `releaseProject`, plus `releaseSession`. **Disable means drain**: flipping the switch refuses new work and never cancels running work.

## Bundled vs external

|  | Bundled (today) | External (P4) |
| --- | --- | --- |
| Manifest | `PluginMeta` literal in TS | `plugin.json` = `PluginMeta` |
| Engine code | in-process `PluginEngineModule` | supervised child process, speaking MCP for tools and HTTP/stdio for routes |
| Tools | `PluginToolModule` on the `telar` key | the host proxies the child's MCP tools onto the `telar` key under the plugin's prefixes |
| UI | React components in the web registry | declarative UI only |
| Trust | same as the daemon (**not a sandbox**) | owner-authored at first; third-party sandboxing is a later, separate design |

## Migration order

1. **P1a**: this doc. DS and LaTeX walls and briefings come from their manifests. Registration in `driver.ts` and `worker.ts` is generic, including the missing in-process loop. The fingerprint is derived from the enabled ids. Tool names are unchanged.
2. **P1b**: the scoped routes table replaces the hand-written `/v2/data-science/*` and `/v2/latex/*` routes. The kernel host and the installers move into the plugin's `init`.
3. **P1c**: drop the legacy `Project.dataScience` / `Project.latex` mirror, with a migration. The claim's `dataScience` / `latex` fields go with it.
4. **P2**: UI registry covering panels, viewers, commands and event renderers. iOS `PluginID` becomes open.
5. **P3**: settings generated from the schema, with one switch per scope.
6. **P4**: external plugins, covering the folder loader, the supervised process, MCP tools and routes, declarative UI, and install/uninstall.
