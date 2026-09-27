# Plugins: the contract

Status: P1a landed (tools and prompt text). Everything marked *planned* is the target shape, not code yet.

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

### 2. Scoped routes (P1b, *planned*)

Today `routes` is a flat `verb → (input, capability)` table served at session scope, with legacy aliases `/ds/*` and `/latex/*`. P1b turns it into a table keyed by scope:

```ts
routes?: {
  session?: Record<string, Route>;   // capability = resolve(sessionId); gate = project opt-in
  project?: Record<string, Route>;   // e.g. environment lists, main-file pickers
  machine?: Record<string, Route>;   // e.g. /v2/latex/managed, toolchain probes
}
```

The daemon serves these at `/v2/{sessions/:id|projects/:id|machine}/plugins/:plugin/:verb`. The daemon parses the body and writes the response. A thrown error becomes `plugin_error` carrying the plugin id. The hand-written `/v2/data-science/*` and `/v2/latex/*` arms become aliases and are then removed. The kernel host and the installers move into the plugin's `init`.

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
