# Plugins: the contract

Status: P1a (tools and prompt text), P1b (scoped routes, kernel host in `init`) and P1c (legacy mirror retired) landed. Everything marked *planned* is the target shape, not code yet.

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

### 3. Panel surfaces, viewers, commands, journal rows and settings panes (P2a web: done; P2b iOS: planned)

On the web, contributions are registered by plugin id and gated by the enabled ids the cockpit reads from the project (`cockpitPlugins`):

| Contribution | Where | Gate |
| --- | --- | --- |
| Panel surfaces (`data`, `latex`), their label, icon, blurb and `wide` flag | `lib/plugins/registry.ts` (data), `components/plugins/surfaces.tsx` (component) | plugin on |
| File viewers (`notebook`, `table`) | `registry.ts` `viewers`; `panelTabForPath` / `editorFileForPath` ask `viewerAvailable` | plugin on. `pdf` is **core**: it renders with LaTeX off too |
| Commands (`open-data`, `open-latex`) | `registry.ts` `commands`; the cockpit binds them | plugin on. `open-plugins` is core navigation |
| Journal rows (`notebook.cell.output`, `latex.compile.finished`, `ds.watch.violated`) | `lib/plugins/journal.ts` | **ungated**: they are history |
| Settings panes (project and machine) | `components/plugins/settings-panes.tsx` | the settings pages' existing Mac/project checks. A plugin with no pane gets the generic one |

A plugin with no web contributions (for example `hello`) draws no tab, opener, command or pane. The components themselves are the plugins' own and did not change. Generic web proxies exist for all three engine scopes: `/api/sessions/:id/plugins/<id>/<verb…>`, `/api/projects/:id/plugins/<id>/<verb…>` and `/api/plugins/<id>/<verb…>`.

**Still on aliases (P2 follow-up).** Every browser-side DS/LaTeX call in `lib/engine/client.ts` (settings verbs, jobs and the session `/ds/*` and `/latex/*` verbs) still goes through its alias route. So do the matching `app/api/{data-science,latex,projects/[id]/…,sessions/[id]/{ds,latex}}` proxies. Moving a caller is a behaviour change, because the generic doors enforce the enablement gates and the aliases do not. The engine-client also needs `projectPlugin` / `machinePlugin` methods; the web currently reaches those doors through `enginePluginDoor`.

**P2b (iOS, done).**
- `PluginID` is an open string type, and `Project.enabledPlugins` reads every enabled id from the map (or from the legacy blocks, for an older engine).
- `PanelTab` is a raw-string type, so saved tabs such as `"data"` still decode.
- `PluginUI` (`Stores/PluginUI.swift`) declares each bundled plugin's tabs and viewers. `PluginSurfaceView` binds each tab to its existing surface.
- An unknown id adds nothing.
- The phone still calls the Mac's `/api/sessions/:id/{ds,latex}/*` aliases rather than the generic plugin route. The Mac it is paired with may predate that web route (added in P2a), and the aliases keep a new phone working against it.

### 4. Settings schema (P3: done)

- The host publishes each plugin's `settingsSchema` / `machineSettingsSchema` on `PluginStatus` as JSON Schema. It is generated with zod's `toJSONSchema` from the same schema that validates writes.
- `.meta()` on a field supplies the row's copy and three renderer hints:
  - `title`, the label;
  - `description`, the one-sentence hint;
  - `info`, the fact behind the ⓘ;
  - `widget: "path"`, a field that names a place on disk;
  - `inherits: "<machine key>"`, the Mac default a project falls back to.
- The web renders these fields generically (`lib/plugins/settings-form.ts`, `components/plugins/generated-settings.tsx`):
  - a boolean becomes a toggle, a string enum a select, a string text or a path, and a number a number;
  - a project field with a Mac default offers "Inherit (<Mac value>)";
  - nested objects and arrays are left to bespoke blocks.
- This is the default for any plugin without a bespoke pane. Project fields appear under the enable switch once the plugin is on (Projects pane). Mac fields appear on the Plugins pane while the plugin is allowed.
- Generated rows join Settings search at runtime (`pluginSettingsSearchEntries`), anchored where they render.
- The enable switches do not move: one on Plugins for the Mac, one on Projects for each project.
- **Data Science and LaTeX use the generator.**
  - Every field their schemas can express is generated:
    - LaTeX's Mac "Compiling" group: *Default engine* (with `labels`), *Install missing packages automatically*.
    - Data Science's Mac *Default Python*, as a path field.
  - Everything else stays bespoke, registered as blocks in `components/plugins/settings-panes.tsx`:
    - `machineGroups`: whole groups before the generated group. Used by LaTeX's distribution cards and managed install.
    - `machineRows`: rows inside the generated group. Used by Data Science's default packages list.
    - `project`: a whole project editor. Both plugins keep theirs, because every project field they have is a choice probed from the Mac: environments and packages, distributions and main-file candidates.
  - The Mac section labels ("Compiling", "Data science defaults") head the generated groups, so the moved rows keep their search anchors.

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
3. **P1c (done)**: the legacy `Project.dataScience` / `Project.latex` mirror is retired.
   - The engine reads and writes only `plugins.entries[<id>]`.
   - On every open, the store folds any legacy block into the map (`migrateLegacyPluginFields`) and drops it. An existing entry always wins, settings come across whole, and a registry with no legacy keys is not rewritten.
   - `PATCH /v2/projects/:id` still accepts `dataScience` / `latex` as deprecated input aliases for one release. They write the map and are never stored.
   - The claim's dedicated fields are gone. `plugins` carries the two plugins when they resolve for the session.
   - **Rolling back to an engine older than the map is no longer supported.** Such an engine would see no Data Science or LaTeX settings.
4. **P2**: UI registry covering panels, viewers, commands and event renderers. P2a (web) and P2b (iOS) are done.
5. **P3 (done)**: settings generated from the schema, with one switch per scope. Data Science and LaTeX keep only the blocks the generator cannot draw.
6. **P4**: external plugins, covering the folder loader, the supervised process, MCP tools and routes, declarative UI, and install/uninstall.
