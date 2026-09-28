# Plugins

- **Bundled plugins** (Data Science, LaTeX) run inside the engine.
- **External plugins** live in `<TELAR_HOME>/plugins/<id>/`: a `plugin.json` manifest plus a program that the engine supervises as a child process. It speaks JSON-RPC over stdio: MCP `initialize`/`tools/call`, plus `telar/route`.
- Both kinds use the same contract (`PluginEngineModule`, `PluginToolModule`). The engine never special-cases a plugin by name.

## What a plugin can contribute

| Contribution | Where it shows |
| --- | --- |
| Agent tools and briefing text | `telarWall`, under the plugin's prefix |
| Routes, scoped to a session, project or machine | `/v2/sessions/:id/plugins/<id>/<verb>`, `/v2/projects/:id/plugins/…`, `/v2/plugins/…` |
| Settings schemas (JSON Schema, from zod) | generated settings rows in Settings ▸ Plugins and ▸ Projects |
| Panel surfaces and file viewers | the web plugin registry; external plugins declare panels built from blocks |

## Gating

- A plugin runs only when the Mac allows it **and** the project enabled it. An unset machine entry counts as allowed.
- Routes refuse when the plugin is off. The exception is routes marked `beforeEnable`, which the settings panes need before the plugin is turned on.
- A bad manifest is refused and listed as failed with its reason. The engine still starts.
- External plugins' tools are never treated as read-only; they always go through approvals.

## Not built yet

Plugins that replace whole regions of the UI (the sidebar, the transcript), style plugins, and third-party sandboxing and signing.
