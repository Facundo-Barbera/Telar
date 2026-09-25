// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveWorkspace, type ProjectWorkspaceOverrides, type ProjectWorkspaceView, type WorkspaceConfig } from "@telar/engine-client";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { searchSettings } from "@/lib/settings-search";
import {
  formatArtifacts,
  MachineWorkspaceRows,
  parseArtifacts,
  parseEnv,
  parsePorts,
  ProjectWorkspaceRows,
} from "./workspace-config-section";

/**
 * The rows take the engine's view as a prop, so every state a field can be in
 * — inherited from the repo, inherited from this Mac, off, custom — renders
 * here without a network. `effective`/`sources` come from `resolveWorkspace`,
 * the same function the engine answers with.
 */
function view(
  overrides: ProjectWorkspaceOverrides,
  machine: WorkspaceConfig = {},
  proposal: ProjectWorkspaceView["proposal"] = { path: "/code/app/.telar/workspace.json" },
): ProjectWorkspaceView {
  return { projectId: "project_a", overrides, machine, proposal, ...resolveWorkspace(machine, proposal.config, overrides) };
}

test("Inherit shows the inherited value and where it comes from", () => {
  const html = renderToStaticMarkup(
    <ProjectWorkspaceRows
      view={view(
        {},
        { ports: { names: ["PORT"] }, env: { A: "1" } },
        { path: "/code/app/.telar/workspace.json", config: { setup: { command: "install command", blocking: true }, env: { B: "2" } } },
      )}
    />,
  );
  expect(html).toContain("New worktrees");
  // Setup comes from the repo file, ports from this Mac, env from both.
  expect(html).toContain("From the repo&#x27;s .telar/workspace.json");
  expect(html).toContain("install command");
  expect(html).toContain("Holds the first turn until it finishes.");
  expect(html).toContain("From this Mac&#x27;s defaults");
  expect(html).toContain("PORT");
  expect(html).toContain("From this Mac and the repo&#x27;s .telar/workspace.json");
  expect(html).toContain("A=1\nB=2");
  // Nothing anywhere for the rest.
  expect(html).toContain("Nothing to inherit.");
  // Read-only: no editor while inheriting.
  expect(html).not.toContain('aria-label="Setup command"');
  // Reserved fields are never drawn.
  expect(html).not.toContain("xecution");
  expect(html).not.toContain("viction");
});

test("Off shows neither an inherited value nor an editor", () => {
  const html = renderToStaticMarkup(
    <ProjectWorkspaceRows view={view({ setup: null }, {}, { path: "p", config: { setup: { command: "install command" } } })} />,
  );
  expect(html).not.toContain("install command");
  expect(html).not.toContain('aria-label="Setup command"');
});

test("Custom opens the editor on the project's own value", () => {
  const html = renderToStaticMarkup(
    <ProjectWorkspaceRows
      view={view({
        setup: { command: "own command", timeoutMs: 90_000 },
        env: { KEY: "value" },
        artifacts: [{ path: "out", regen: "build command" }],
      })}
    />,
  );
  expect(html).toContain('aria-label="Setup command"');
  expect(html).toContain('value="own command"');
  expect(html).toContain('value="90"');
  expect(html).toContain("KEY=value");
  expect(html).toContain("out =&gt; build command");
  // The merge rule is behind the ⓘ, not in the hint.
  expect(html).toContain("Merges by key: this Mac &lt; the repo&#x27;s .telar/workspace.json &lt; this project.");
});

test("an unreadable repo file is one row that says why", () => {
  const html = renderToStaticMarkup(<ProjectWorkspaceRows view={view({}, {}, { path: "p", error: "Unexpected token" })} />);
  expect(html).toContain("Repo file");
  expect(html).toContain("Could not read .telar/workspace.json, so nothing is inherited from it: Unexpected token");
});

test("a write's error reads on the row that made it", () => {
  const html = renderToStaticMarkup(
    <ProjectWorkspaceRows
      view={view({ ports: { names: ["PORT"] } })}
      writer={{ save: () => {}, reject: () => {}, error: { field: "ports", message: "ports.names.0: not a valid environment variable name" } }}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("not a valid environment variable name");
});

test("this Mac's defaults start empty, with no Inherit or Off, and only suggest", () => {
  const html = renderToStaticMarkup(<MachineWorkspaceRows machine={{}} />);
  expect(html).toContain("Worktree defaults");
  expect(html).not.toContain("Inherit");
  // Offered, never pre-filled: the textarea is empty and the path is a button.
  expect(html).toContain("Add node_modules");
  expect(html).not.toContain(">node_modules<");
});

test("the text forms parse what they format", () => {
  expect(parseEnv("A=1\n\n B = two=2 ")).toEqual({ ok: true, value: { A: "1", B: "two=2" } });
  expect(parseEnv("nope")).toEqual({ ok: false, message: "Line 1: expected KEY=value." });
  expect(parsePorts("PORT, WEB_PORT API_PORT", { names: ["X"], base: 4000 })).toEqual({
    ok: true,
    value: { names: ["PORT", "WEB_PORT", "API_PORT"], base: 4000 },
  });
  expect(parsePorts("  ")).toEqual({ ok: true, value: undefined });
  const artifacts = [{ path: "out\\win" }, { path: "gen/*", regen: "regen command" }];
  expect(parseArtifacts(formatArtifacts(artifacts))).toEqual({ ok: true, value: artifacts });
  expect(parseArtifacts("=> x").ok).toBe(false);
});

test("search finds the rows on both panes", () => {
  const hits = searchSettings(SETTINGS_SEARCH_INDEX, "seed dependencies");
  expect(hits.map((hit) => hit.pageId).sort()).toEqual(["projects", "storage"]);
});
