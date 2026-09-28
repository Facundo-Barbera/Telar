# Tally — an example Telar plugin

A minimal installed plugin with one tool, one setting and one panel.

| Part | What it is |
| --- | --- |
| Tool | `tally_count { label }` adds to a named counter for the project and returns the new value. It asks for approval like every installed plugin's tool. |
| Setting | `step`: how much each count adds. Set it in the project's settings. |
| Panel | **Counts**, in the right panel's **Plugins** tab: the counters as a table, the step, a log of recent counts, and a **Reset** button. |

## Try it

1. Go to **Settings ▸ Plugins**, choose **Add plugin from folder**, and pick this folder. **Link…** keeps using the folder in place, so edits apply the next time the plugin starts.
2. Turn **Tally** on for a project, in that project's settings.
3. In a conversation in that project, ask the agent to "tally apples twice", then approve the tool calls.
4. Open the right panel's **Plugins** tab to see the counts.

The plugin runs with `bun`. To use Node instead, change `command` to `["node", "server.mjs"]`.

## Files

- `plugin.json` is the manifest. Its fields are validated by `ExternalPluginManifest` in `packages/engine-client/src/plugins/schema.ts`.
- `server.mjs` handles newline-delimited JSON-RPC on stdio: `initialize`, `tools/call` and `telar/route`. Its counts are kept in `$TELAR_PLUGIN_STATE/counts.json`, and whatever it writes to stderr is its log.
