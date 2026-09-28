// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { filePatchQuery, parseFilePatchQuery } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { DEFAULT_DIFF_VIEW, type DiffView } from "@/lib/diff-view";
import { DiffToolbar, patchRequestFor } from "./diff-surface";

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
    // A radiogroup rather than two toggles: the pair is one stop in the tab
    // order, and "both off" is not a state a layout can be in.
    const markup = toolbar();
    expect(markup).toContain('role="radiogroup"');
    expect((markup.match(/role="radio"/g) ?? []).length).toBe(2);
    expect(markup).toContain("stacked");
    expect(markup).toContain("split");
  });

  test("the chosen layout is the checked one, and only it", () => {
    /** The checked radio's own label — `[^>]*` steps over the class attribute
     *  that Tailwind puts between the two, which is not what is being read. */
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
    // Never a pair: with something open the useful move is to close, with
    // nothing open the only move is to open. A disabled twin would spend half
    // the control's width saying nothing.
    expect(toolbar({}, { anyOpen: false })).toContain("Expand all");
    expect(toolbar({}, { anyOpen: false })).not.toContain("Collapse all");
    expect(toolbar({}, { anyOpen: true })).toContain("Collapse all");
    expect(toolbar({}, { anyOpen: true })).not.toContain("Expand all");
  });

  test("with no rows the control goes, rather than greying out", () => {
    const empty = toolbar({}, { expandable: false });
    expect(empty).not.toContain("Expand all");
    // The layout controls stay: they are a preference, and choosing one over an
    // empty review is a perfectly ordinary thing to do before the read lands.
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
    /**
     * THE SHAPE #739's BUG LIVED IN, made assertable. Three optional fields
     * spread into a request object: `untracked` from the row, `ignoreWhitespace`
     * from the toolbar, `renamedFrom` from the list's own rename pairing. The
     * failure mode is not a wrong value, it is a MISSING key — and TypeScript
     * checks nothing at a call site that spreads.
     *
     * So the construction is one exported function and this reads its output,
     * per file rather than per parameter: a renamed, untracked file with the
     * toggle on and a base chosen must carry all four at once.
     */
    const view: DiffView = { ...DEFAULT_DIFF_VIEW, ignoreWhitespace: true };
    expect(patchRequestFor({ path: "dst.txt", status: "renamed", renamedFrom: "src.txt" }, view, { base: "origin/main" })).toEqual({
      ignoreWhitespace: true,
      renamedFrom: "src.txt",
      base: "origin/main",
    });
    expect(patchRequestFor({ path: "new.ts", status: "untracked" }, view, {})).toEqual({ untracked: true, ignoreWhitespace: true });

    // ...and an ordinary row under default settings asks for nothing extra,
    // which is what makes each key above a claim rather than a constant.
    expect(patchRequestFor({ path: "a.ts", status: "modified" }, DEFAULT_DIFF_VIEW, {})).toEqual({});

    // The rename reaches the WIRE through the shared builder, not just the
    // object — the exact gap that made the last dead flag typecheck.
    expect(filePatchQuery("dst.txt", patchRequestFor({ path: "dst.txt", status: "renamed", renamedFrom: "src.txt" }, DEFAULT_DIFF_VIEW, {}))).toContain(
      "renamedFrom=src.txt",
    );
    expect(parseFilePatchQuery(new URLSearchParams(filePatchQuery("dst.txt", patchRequestFor({ path: "dst.txt", status: "renamed", renamedFrom: "src.txt" }, DEFAULT_DIFF_VIEW, {}))))).toMatchObject({
      renamedFrom: "src.txt",
    });
  });
});
