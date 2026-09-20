// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  // #670 split `not_github` out of `no_repository`. This pane's answer is the
  // same for both — `gh` is working either way — and that sameness is worth
  // pinning, because the split exists for the surfaces that OFFER something.
  expect(readGhState({ unavailable: "not_github" })).toEqual({ status: "ready" });
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

test("the row is drawn before the probe answers", () => {
  // A network read can take seconds, and the row is true whatever it says.
  const html = renderToStaticMarkup(<SourceControlPage />);
  expect(html).toContain("GitHub");
  // The caption is the group's; the row carries no standing sentence under it.
  expect(html).toContain("Read through a CLI you signed in to yourself");
  expect(html).not.toContain("Sessions get the same access you have in a terminal");
});

test("no row exists only to say a thing does not exist", () => {
  // GitLab's whole content was its own absence (#357). Telar still has no GitLab
  // reader; a row saying so every time the pane opens was not how to say it.
  const html = renderToStaticMarkup(<SourceControlPage />);
  expect(html).not.toContain("GitLab");
  expect(html).not.toContain("Not supported");
});

test("the sentence survives where it is an instruction rather than a description", () => {
  // "gh is not installed" with no command is a diagnosis nobody can act on, so
  // the FIX copy keeps its slot in exactly the states that have one.
  const source = readFileSync(new URL("./source-control-page.tsx", import.meta.url), "utf8");
  expect(source).toContain("brew install gh");
  expect(source).toContain("gh auth login");
});

test("search finds the pane by the CLI, not only by its name", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  // "gh" alone is two letters and matches inside a dozen unrelated words
  // ("Show-through"), which is the index's business rather than this pane's.
  expect(first("gh cli")?.pageId).toBe("source-control");
  expect(first("github")?.pageId).toBe("source-control");
  expect(first("source control")?.pageId).toBe("source-control");
});
