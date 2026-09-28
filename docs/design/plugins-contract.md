# Plugins: the contract

Status: P1–P4 have shipped. Bundled plugins, the web and iOS registries, generated settings, and external (installed) plugins with declarative UI and install/uninstall all exist. What is still open is listed under "Not built yet" at the end.

A plugin is a feature that the core does not name.

- **Bundled plugins** (Data Science, LaTeX, and the gated proof plugin `hello`) are compiled into the engine, but they reach the core only through the contract below.
- **External plugins** are folders the owner installs under `<TELAR_HOME>/plugins/`. They reach the core through the same host, doors and tool wall, and differ in where their code runs (a supervised child process) and in how their UI is drawn (declarative blocks).

## Two halves

| Half | Where it lives | Crosses a wire? |
| --- | --- | --- |
| **Manifest**: `PluginMeta` | `packages/engine-client/src/protocol/plugins.ts` | Yes. It is served in `/v2/health`, stored, and decoded by web and iOS. |
| **Modules**: `PluginEngineModule` (daemon) and `PluginToolModule` (anywhere tools are registered) | `apps/engine/src/plugins/contract.ts` and `tool-module.ts` | No. They are executable code. |

The manifest is plain data. An external plugin's `plugin.json` is `ExternalPluginManifest`, which `externalMeta` maps onto `PluginMeta`. Its modules are built from that manifest (`plugins/external/module.ts`), so the host sees the same two halves either way.

## Contribution points

### 1. Tools and prompt text (P1a, done)

- `meta.toolPrefixes` lists the tool namespaces the plugin owns. Data Science owns two of them: `ds` and `notebook`. Prefixes are globally unique.
  - A bundled plugin's prefix must be in `BUNDLED_PLUGIN_TOOL_PREFIXES`, so `parseToolName` can type its tools without a plugin host (web, iOS).
  - An installed plugin's prefix is checked for collisions by the loader. It is registered at run time with `registerPluginToolPrefixes`: by the daemon, the out-of-process worker, and the cockpit when it reads the plugin list.
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

### 2. Scoped routes (P1b, done)

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

  Callers still on the aliases:
  - `packages/engine-client` methods `dataScience*`, `latex*`, `managedTectonic` and `installManagedTectonic`, and through them the web settings panes (`data-science-section`, `latex-section`, `*-machine-settings`, `packages-panel`, `job-log`) and the web `app/api/{data-science,latex,projects/[id]/…}` proxies;
  - iOS `EngineAPI.latex(...)`, which uses the session `/latex/*` alias.
- `/v2/sessions/:id/data/table` stays core: it serves CSV with Data Science off, and only Parquet borrows the kernel.
- **Kernel host (done):** Data Science's `init` builds the `KernelHost` from the store's half of the options (engine root, session dirs, state and plot recording), attaches it to the store and registers its teardown. It is still built only on a daemon that runs turns (embedded worker), as before.
- **What stays in `state.ts`, and why:**
  - The job runners `dsJobs` and `latexJobs`, together with the settings verbs that start jobs on them (environments, installs, bootstraps). Those verbs are store methods that resolve projects, checkouts and machine settings through store state. Moving a runner without its verbs would leave the store reaching into a plugin for its own jobs. They move together when the verbs leave the store (P1c or later).
  - `store.dataScience()` / `store.latex()`, the capability resolvers. They are the gate (project opt-in, worktree rule, machine ceiling) and read store state directly.

### 3. Panel surfaces, viewers, commands, journal rows and settings panes (P2a web and P2b iOS: done)

On the web, contributions are registered by plugin id and gated by the enabled ids the cockpit reads from the project (`cockpitPlugins`):

| Contribution | Where | Gate |
| --- | --- | --- |
| Panel surfaces (`data`, `latex`), their label, icon, blurb and `wide` flag | `lib/plugins/registry.ts` (data), `components/plugins/surfaces.tsx` (component) | plugin on |
| The shared "Plugins" tab (`plugin-panels`) for installed plugins' block panels | `registry.ts` `PLUGIN_PANELS_SURFACE`, `components/plugins/plugin-panels-surface.tsx` | an enabled, running installed plugin declares a panel |
| File viewers (`notebook`, `table`) | `registry.ts` `viewers`; `panelTabForPath` / `editorFileForPath` ask `viewerAvailable` | plugin on. `pdf` is **core**: it renders with LaTeX off too |
| Commands (`open-data`, `open-latex`) | `registry.ts` `commands`; the cockpit binds them | plugin on. `open-plugins` is core navigation |
| Journal rows (`notebook.cell.output`, `latex.compile.finished`, `ds.watch.violated`) | `lib/plugins/journal.ts` | **ungated**: they are history |
| Settings panes (project and machine) | `components/plugins/settings-panes.tsx` | the settings pages' existing Mac/project checks. A plugin with no pane gets the generic one |

A plugin with no web contributions (for example `hello`) draws no tab, opener, command or pane. The components themselves are the plugins' own and did not change. Generic web proxies exist for all three engine scopes: `/api/sessions/:id/plugins/<id>/<verb…>`, `/api/projects/:id/plugins/<id>/<verb…>` and `/api/plugins/<id>/<verb…>`.

**Still on aliases.** Every browser-side DS/LaTeX call in `lib/engine/client.ts` (settings verbs, jobs and the session `/ds/*` and `/latex/*` verbs) still goes through its alias route. So do the matching `app/api/{data-science,latex,projects/[id]/…,sessions/[id]/{ds,latex}}` proxies. Moving a caller is a behaviour change, because the generic doors enforce the enablement gates and the aliases do not. The engine-client also needs `projectPlugin` / `machinePlugin` methods; the web currently reaches those doors through `enginePluginDoor`.

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

`meta.eventKinds` lists the journal kinds the plugin emits, inside the `plugin.event` envelope (for example `kernel.state.changed`). Their timeline rows are registered in `lib/plugins/journal.ts`. External plugins cannot emit events yet.

### 6. Requirements and installers (*not built*)

A manifest section could declare what the plugin needs on the machine, for example:

```ts
requires?: { id; label; probe: verb; install?: verb }[]
```

`probe` and `install` are machine-scoped routes, so the cockpit can render "LaTeX needs a TeX distribution: Install" generically. Today that pane is hand-written per plugin.

### Lifecycle

- `init(context)` is bounded by `PLUGIN_INIT_TIMEOUT_MS`. It registers a cleanup for each resource as it acquires it (`onDispose`).
- The hooks are `drain` → `busy` → `releaseProject`, plus `releaseSession`. **Disable means drain**: flipping the switch refuses new work and never cancels running work.
- `PluginHost.add` / `remove` register and unregister a plugin while the engine runs. They are used for installing and removing external plugins. `remove` unwinds everything the plugin acquired and does not wait for running work.

## Bundled vs external

|  | Bundled | External |
| --- | --- | --- |
| Manifest | `PluginMeta` literal in TS | `plugin.json` (`ExternalPluginManifest`), mapped to `PluginMeta` |
| Engine code | in-process `PluginEngineModule` | supervised child process; MCP tools and routes share one stdio channel |
| Tools | `PluginToolModule` on the `telar` key | declared in the manifest, walled on the `telar` key under the plugin's prefix, each call forwarded to the child |
| UI | React components in the web registry | declarative panel blocks, drawn by the cockpit |
| Trust | same as the daemon (**not a sandbox**) | owner-authored; third-party sandboxing and signing are a later, separate design |

### External plugins (P4)

- **Folder.** `<TELAR_HOME>/plugins/<id>/plugin.json`, read when the engine starts (`plugins/external/manifest.ts`). A folder may be a symlink (a linked install). The daemon and an out-of-process worker read the same folder with the same reservations. The worker re-reads it once when a claim names a plugin it has no wall for.
- **Manifest.** `ExternalPluginManifest` in engine-client is strict. Its keys:
  - `id` (must equal the folder name), `api`, `name`, `version`, `description`, `icon`;
  - `command` (argv; a `./` program is resolved in the folder; the working directory is the folder);
  - `toolPrefix` and `tools` (name, description, JSON Schema input);
  - `briefing`;
  - `settingsSchema` / `machineSettingsSchema` (JSON Schema, published as written for the P3 renderer);
  - `routes`: `session` verbs (`tool` is reserved), and `project` / `machine` `"METHOD path"` keys;
  - `panels`.

  The ids `latex`, `data-science`, `hello` and `installed` are reserved.
- **Refusal.** A folder is refused for bad JSON, a schema issue, an id that is not the folder's, a reserved or taken id, a prefix someone owns, or a missing program. It is listed as `failed` with a `plugin.json: …` reason and contributes nothing. The engine always starts.
- **Wire.** Newline-delimited JSON-RPC 2.0 on stdio:
  - MCP `initialize` + `notifications/initialized` on each start;
  - MCP `tools/call`, with `_meta.telar = { sessionId, projectId, settings }`;
  - `telar/route {scope, verb, input, query?, params?, sessionId?, projectId?, settings}` for every route.

  `settings` is the Mac's defaults with the project's own over them. It is sent with every call, so the plugin never holds a stale copy. stderr is the log: a 200-line tail in memory, appended to `<engineRoot>/plugins/<id>/log.txt`. The plugin's state directory is that same folder (`TELAR_PLUGIN_STATE`).
- **Lifecycle** (`plugins/external/process.ts`). Nothing is spawned at engine start; the child starts on first use. It restarts with backoff (1s doubling to 30s, reset after a minute up) while wanted, stops when the last project turns the plugin off (`releaseProject`), and on dispose. In-flight requests are refused when it dies.
- **Tools.** The wall comes from the manifest, so it exists without the child running. A call goes through the generic session door as the reserved verb `tool`, so the host's gate (Mac, then project) applies, and only a declared name passes.
- **Approval.** An external manifest has no `readTools` key, `externalMeta` always publishes `[]`, and `HOST_RATIFIED_READ_TOOLS` names no external id. Every external tool parks an approval card.
- **Declarative UI.** A manifest's `panels` name a declared session verb that answers `{ blocks }`. The block kinds are `heading`, `text` (plain or `markdown`), `keyValue`, `table`, `log`, and `action`, a button that posts a session verb with `input` after an optional `confirm`, then redraws. Blocks are parsed one by one (`parsePluginPanelView`), so a kind the cockpit does not know is skipped. On the web, every enabled plugin's panels share one right-panel tab, "Plugins", which is offered only while one of them has a panel. The phone draws nothing for them yet. Settings come from the published JSON Schema through the P3 renderer.
- **Tool rows.** The daemon and the cockpit call `registerPluginToolPrefixes` with the installed prefixes, so `parseToolName` types an installed plugin's tools like a bundled one's.
- **Install and remove** (`plugins/external/installer.ts`, Settings ▸ Plugins):
  - `POST /v2/plugins/installed {path, mode: "copy" | "link"}` checks the manifest with the loader's rules before writing anything. It then copies the folder in (through a staging name) or links it, and registers and starts the plugin without a restart. A refusal comes back as a 400 with the reason.
  - `DELETE /v2/plugins/installed/:id` stops the plugin and then deletes a copied folder. For a linked folder it only removes the link; the owner's folder stays. A refused folder can be removed the same way.
  - `PluginStatus.installed = { linked }` marks what Settings may remove.
  - Project and Mac entries for a removed id are left in place. They name nothing and draw nothing.
- **Example.** `examples/plugins/tally` has one tool (`tally_count`), one setting (`step`) and one panel (Counts, with a Reset action). A test installs it into a real engine and drives it end to end.
- **Trust.** Owner-authored. The child gets a minimal environment (`PATH`, `HOME`, `TELAR_PLUGIN_ID`/`_DIR`/`_STATE`) with no engine token or provider keys, but it is **not a sandbox**.

## History

1. **P1a**: this doc. DS and LaTeX walls and briefings come from their manifests. Registration in `driver.ts` and `worker.ts` is generic. The fingerprint is derived from the enabled ids. Tool names are unchanged.
2. **P1b**: the scoped routes table replaces the hand-written `/v2/data-science/*` and `/v2/latex/*` routes, which remain as aliases. The kernel host moves into Data Science's `init`.
3. **P1c**: the legacy `Project.dataScience` / `Project.latex` mirror is retired.
   - The engine reads and writes only `plugins.entries[<id>]`.
   - On every open, the store folds any legacy block into the map (`migrateLegacyPluginFields`) and drops it. An existing entry always wins, settings come across whole, and a registry with no legacy keys is not rewritten.
   - `PATCH /v2/projects/:id` still accepts `dataScience` / `latex` as deprecated input aliases. They write the map and are never stored.
   - The claim's dedicated fields are gone. `plugins` carries the two plugins when they resolve for the session.
   - **Rolling back to an engine older than the map is not supported.** Such an engine would see no Data Science or LaTeX settings.
4. **P2**: the UI registry covering panels, viewers, commands and journal rows, on the web (P2a) and iOS (P2b).
5. **P3**: settings generated from the schema, with one switch per scope. Data Science and LaTeX keep only the blocks the generator cannot draw.
6. **P4**: external plugins, in three parts:
   - the folder loader, the supervised process, and MCP tools and routes;
   - declarative panel blocks, and typed tool rows for installed prefixes;
   - install/uninstall from Settings, and the example plugin.

## Not built yet

- **Sandboxing and signing** for third-party plugins. External plugins are the owner's own code, and nothing here isolates them.
- **Requirements and installers** declared in a manifest (contribution point 6).
- **Events from external plugins** (`eventKinds`) and their timeline rows.
- **iOS** draws no panels for installed plugins. It ignores the `panels` key.
- **Callers still on the DS/LaTeX aliases** (see contribution points 2 and 3).
