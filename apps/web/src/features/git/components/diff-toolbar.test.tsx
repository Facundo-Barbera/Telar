// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { filePatchQuery, parseFilePatchQuery } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { DEFAULT_DIFF_VIEW, type DiffView } from "../hooks/use-diff-view";
import { patchRequestFor } from "../model";
import { DiffToolbar } from "./diff-toolbar";

const toolbar = (view: Partial<DiffView> = {}, extra: { anyOpen?: boolean; expandable?: boolean } = {}) =>
  renderToStaticMarkup(
    <DiffToolbar
      view={{ ...DEFAULT_DIFF_VIEW, ...view }}
      setView={() => {}}
      anyOpen={extra.anyOpen ?? false}
      onToggleAll={() => {}}
      expandable={extra.expandable ?? true}
    />,
  );

describe("the diff toolbar", () => {
  test("Stacked and Split are one exclusive pair, not two independent buttons", () => {
    const markup = toolbar();
    expect(markup).toContain('role="radiogroup"');
    expect((markup.match(/role="radio"/g) ?? []).length).toBe(2);
    expect(markup).toContain("stacked");
    expect(markup).toContain("split");
  });

  test("the chosen layout is the checked one, and only it", () => {
    const checked = (markup: string) => /aria-checked="true"[^>]*>([a-z]+)</.exec(markup)?.[1];
    expect(checked(toolbar({ layout: "stacked" }))).toBe("stacked");
    expect(checked(toolbar({ layout: "split" }))).toBe("split");
    expect((toolbar({ layout: "split" }).match(/aria-checked="true"/g) ?? []).length).toBe(1);
  });

  test("wrap and whitespace are pressed marks, so a screen reader hears their state", () => {
    const off = toolbar();
    expect(off).toContain('aria-label="Word wrap" aria-pressed="false"');
    expect(off).toContain('aria-label="Ignore whitespace" aria-pressed="false"');
    const on = toolbar({ wrap: true, ignoreWhitespace: true });
    expect(on).toContain('aria-label="Word wrap" aria-pressed="true"');
    expect(on).toContain('aria-label="Ignore whitespace" aria-pressed="true"');
  });

  test("one button, whose label is the move that is left", () => {
    expect(toolbar({}, { anyOpen: false })).toContain("Expand all");
    expect(toolbar({}, { anyOpen: false })).not.toContain("Collapse all");
    expect(toolbar({}, { anyOpen: true })).toContain("Collapse all");
    expect(toolbar({}, { anyOpen: true })).not.toContain("Expand all");
  });

  test("with no rows the control goes, rather than greying out", () => {
    const empty = toolbar({}, { expandable: false });
    expect(empty).not.toContain("Expand all");
    expect(empty).toContain('role="radiogroup"');
  });

  test("ignoring whitespace is asked of GIT, not of the renderer", () => {
    expect(filePatchQuery("src/a.ts", {})).toBe("path=src%2Fa.ts");
    expect(filePatchQuery("src/a.ts", { ignoreWhitespace: true })).toContain("ignoreWhitespace=1");
    expect(filePatchQuery("src/a.ts", { untracked: true, ignoreWhitespace: true })).toContain("untracked=1");
    expect(parseFilePatchQuery(new URLSearchParams(filePatchQuery("src/a.ts", { ignoreWhitespace: true })))).toMatchObject({
      ignoreWhitespace: true,
    });
  });

  test("the cockpit's adapter carries every patch option to the route", async () => {
    const urls: string[] = [];
    const api = createEngineApi((async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ file: {} });
    }) as typeof fetch);
    const options = { ignoreWhitespace: true, untracked: true, renamedFrom: "src.txt", base: "origin/main" };
    await api.sessionFilePatch("session_a", "dst.txt", options);
    await api.projectFilePatch("project_a", "dst.txt", options);
    expect(urls.map((url) => new URL(url, "http://localhost").pathname)).toEqual(["/api/sessions/session_a/diff", "/api/projects/project_a/diff"]);
    for (const url of urls) {
      const params = new URL(url, "http://localhost").searchParams;
      expect(params.get("path")).toBe("dst.txt");
      expect(parseFilePatchQuery(params)).toMatchObject(options);
    }
  });

  test("a row asks for every option its file needs, in ONE place — issue #694", () => {
    const view: DiffView = { ...DEFAULT_DIFF_VIEW, ignoreWhitespace: true };
    expect(patchRequestFor({ path: "dst.txt", status: "renamed", renamedFrom: "src.txt" }, view, { base: "origin/main" })).toEqual({
      ignoreWhitespace: true,
      renamedFrom: "src.txt",
      base: "origin/main",
    });
    expect(patchRequestFor({ path: "new.ts", status: "untracked" }, view, {})).toEqual({ untracked: true, ignoreWhitespace: true });

    expect(patchRequestFor({ path: "a.ts", status: "modified" }, DEFAULT_DIFF_VIEW, {})).toEqual({});

    expect(filePatchQuery("dst.txt", patchRequestFor({ path: "dst.txt", status: "renamed", renamedFrom: "src.txt" }, DEFAULT_DIFF_VIEW, {}))).toContain(
      "renamedFrom=src.txt",
    );
    expect(parseFilePatchQuery(new URLSearchParams(filePatchQuery("dst.txt", patchRequestFor({ path: "dst.txt", status: "renamed", renamedFrom: "src.txt" }, DEFAULT_DIFF_VIEW, {}))))).toMatchObject({
      renamedFrom: "src.txt",
    });
  });
});
