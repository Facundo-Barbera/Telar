// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { SourceControlPage, readGhState } from "./source-control-page";

/**
 * The pane's whole job is to turn one per-project answer into a fact about the
 * MACHINE, and to say what to type when that fact is bad news. Both halves are
 * tested without a network: the reading is pure, and the first paint is the
 * state a reader sees before the probe lands.
 */

test("no GitHub remote means gh works, not that anything is wrong", () => {
  // The trap: `no_repository` is `gh` running perfectly and reporting that this
  // checkout has no GitHub remote. Reading it as a failure would tell somebody
  // to reinstall a CLI that is already fine.
  expect(readGhState({ unavailable: "no_repository" })).toEqual({ status: "ready" });
  expect(readGhState({ repository: "Facundo-Barbera/Telar" })).toEqual({ status: "ready", repository: "Facundo-Barbera/Telar" });
});

test("the two machine-level failures are carried through as themselves", () => {
  expect(readGhState({ unavailable: "not_installed" })).toEqual({ status: "unavailable", reason: "not_installed" });
  expect(readGhState({ unavailable: "not_authenticated" })).toEqual({ status: "unavailable", reason: "not_authenticated" });
  // gh's own words survive, because the pane cannot diagnose what gh could not.
  expect(readGhState({ unavailable: "failed", message: "dial tcp: i/o timeout" })).toEqual({
    status: "unavailable",
    reason: "failed",
    message: "dial tcp: i/o timeout",
  });
});

test("the rows are drawn before the probe answers", () => {
  // A network read can take seconds, and everything here except the status word
  // is true whatever it says.
  const html = renderToStaticMarkup(<SourceControlPage />);
  expect(html).toContain("GitHub");
  expect(html).toContain("GitLab");
  expect(html).toContain("read through the gh CLI");
});

test("GitLab is listed and says no, rather than being left out", () => {
  const html = renderToStaticMarkup(<SourceControlPage />);
  expect(html).toContain("Not supported");
  // Inert, not absent: somebody whose repositories are on GitLab learns it here
  // instead of by opening a forge panel that stays empty.
  expect(html).toContain("inert=");
  // And it says what still works, because most of the app is git rather than GitHub.
  expect(html).toContain("sessions, worktrees, branches and diffs are git, not GitHub");
});

test("search finds the pane by the CLI, not only by its name", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  // "gh" alone is two letters and matches inside a dozen unrelated words
  // ("Show-through"), which is the index's business rather than this pane's.
  expect(first("gh cli")?.pageId).toBe("source-control");
  expect(first("github")?.pageId).toBe("source-control");
  expect(first("source control")?.pageId).toBe("source-control");
  expect(first("gitlab")?.title).toBe("GitLab");
});
