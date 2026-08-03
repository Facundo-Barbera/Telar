// Structural coverage for Phase 3's final migration seam. The app has no DOM
// test environment, so this pins every production Git write at its confirmed
// success branch and prevents the retired project-page host from returning.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

const dispatcherImport =
  'import { dispatchTelarRefresh } from "@/lib/telar-refresh"';

describe("the Phase 3 Git migration", () => {
  test("accounts for every write seam across every Git subview", () => {
    const projectComponents = new URL("components/projects/", WEB_ROOT);
    const sources = readdirSync(projectComponents)
      .filter((name) => /^git-tab.*\.tsx$/.test(name))
      .map((name) => read(`components/projects/${name}`));
    const writeMethods = sources.flatMap(
      (source) => source.match(/method: "(?:POST|PATCH|PUT|DELETE)"/g) ?? [],
    );
    const refreshCalls = sources.flatMap(
      (source) => source.match(/dispatchTelarRefresh\(/g) ?? [],
    );

    expect(writeMethods).toHaveLength(4);
    expect(refreshCalls).toHaveLength(writeMethods.length);
  });

  test("broadcasts only when local cleanup confirms at least one write", () => {
    const source = read("components/projects/git-tab.tsx");
    const cleanup = source.slice(
      source.indexOf("const cleanup"),
      source.indexOf("const reclaim"),
    );

    expect(source).toContain(
      'import { dispatchTelarRefresh, refreshIncludes } from "@/lib/telar-refresh"',
    );
    expect(cleanup).toContain("out.results.some((result) => result.ok)");
    expect(cleanup).toContain('dispatchTelarRefresh({ domains: ["git"], project: name })');
    expect(cleanup.indexOf("dispatchTelarRefresh(")).toBeGreaterThan(
      cleanup.indexOf("out.results.some((result) => result.ok)"),
    );
  });

  test("broadcasts after a remote issue is confirmed created", () => {
    const source = read("components/projects/git-tab-remote-new-issue.tsx");
    const success = source.slice(
      source.indexOf("if (!data.ok)"),
      source.indexOf("} catch (e)"),
    );

    expect(source).toContain(dispatcherImport);
    expect(success).toContain('dispatchTelarRefresh({ domains: ["git"], project: name })');
    expect(success.indexOf("dispatchTelarRefresh(")).toBeGreaterThan(
      success.indexOf("const created = data.issue.number"),
    );
    expect(success.indexOf("dispatchTelarRefresh(")).toBeLessThan(
      success.indexOf("onCreated(created)"),
    );
  });

  test("broadcasts after confirmed issue or PR comments and issue state writes", () => {
    const source = read("components/projects/git-tab-remote-detail.tsx");
    const commentSuccess = source.slice(
      source.indexOf("setExtra((xs) =>", source.indexOf("if (!data.ok)")),
      source.indexOf("return true"),
    );
    const stateSuccess = source.slice(
      source.indexOf("setIssue({ ...issue, state: data.state })"),
      source.indexOf("} catch (e)", source.indexOf("const toggleState")),
    );

    expect(source).toContain(dispatcherImport);
    expect(commentSuccess).toContain('dispatchTelarRefresh({ domains: ["git"], project })');
    expect(commentSuccess.indexOf("dispatchTelarRefresh(")).toBeLessThan(
      commentSuccess.indexOf("onWrote()"),
    );
    expect(stateSuccess).toContain('dispatchTelarRefresh({ domains: ["git"], project: name })');
    expect(stateSuccess.indexOf("dispatchTelarRefresh(")).toBeLessThan(
      stateSuccess.indexOf("onListStale()"),
    );
  });

  test("keeps Git hosted only in the right panel and canonicalizes legacy links", () => {
    const projectPage = read("app/projects/[name]/page.tsx");
    const panel = read("components/right-panel/right-panel.tsx");

    expect(panel).toContain('import("@/components/projects/git-tab")');
    expect(panel).toContain("<GitTab name={project} />");
    expect(projectPage).not.toContain(
      'import { GitTab } from "@/components/projects/git-tab"',
    );
    expect(projectPage).not.toContain('<GitTab name={entry.name} />');
    expect(projectPage).not.toContain('key: "git"');
    expect(projectPage).toContain('if (tabParam !== "git") return');
    expect(projectPage).toContain('p.delete("tab")');
  });
});
