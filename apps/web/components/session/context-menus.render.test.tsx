/**
 * THE TREE ROW'S MENU, RENDERED — and the one thing that must not appear in a
 * browser tab.
 *
 * WHY THIS IS A SECOND FILE, and why it renders the item list rather than the
 * row. `ContextMenuContent` portals, and `react-dom/server` renders nothing
 * inside a portal, so a `renderToStaticMarkup` of `FileTreeRow` returns the
 * chip and none of its menu — proving nothing about the list. Rendering the
 * items under a bare `ContextMenu` root reaches the real list (the same
 * component the surface hands to its `ContextMenuContent`) with no portal in
 * the way, which is the only way to SEE these rows without a DOM harness this
 * app does not have. Everything structural is next door in context-menus.test.ts.
 *
 * The claim under test is a promise, not a layout: a plain browser has no way
 * to show you a folder in Finder, so the row is ABSENT rather than greyed. A
 * disabled row is that promise restated on every right-click and broken every
 * time.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu } from "@/components/ui/context-menu";
import { FileRowMenuItems } from "./files-surface";
import type { WorkspaceFileMenu } from "@/lib/workspace-open";

/** A shell that can act on a file, as `useWorkspaceFileMenu` reports one. */
const desktop: WorkspaceFileMenu = { reveal: () => {}, open: () => {}, openLabel: "Open in Zed", openIcon: "zed" };
/** A browser tab: no bridge, so neither verb exists. */
const browser: WorkspaceFileMenu = { openLabel: "Open in the default app" };

const row = (files: WorkspaceFileMenu, overrides: Partial<Parameters<typeof FileRowMenuItems>[0]> = {}) =>
  renderToStaticMarkup(
    <ContextMenu open>
      <FileRowMenuItems
        path="apps/web/lib/utils.ts"
        directory={false}
        expanded={false}
        absolute="/Users/x/code/telar/apps/web/lib/utils.ts"
        files={files}
        onOpen={() => {}}
        onKeep={() => {}}
        onToggle={() => {}}
        onCollapseAll={() => {}}
        {...overrides}
      />
    </ContextMenu>,
  );

describe("a file row's menu on the desktop", () => {
  test("offers both shell verbs, and names the app rather than saying 'Open'", () => {
    const html = row(desktop);
    expect(html).toContain("Reveal in Finder");
    expect(html).toContain("Open in Zed");
  });

  test("offers both paths and the two ways in", () => {
    const html = row(desktop);
    expect(html).toContain("Open");
    expect(html).toContain("Open pinned");
    expect(html).toContain("Copy path");
    expect(html).toContain("Copy relative path");
  });
});

describe("the same row in a plain browser tab", () => {
  test("HIDES Reveal and Open-in-app — it does not grey them out", () => {
    const html = row(browser);
    expect(html).not.toContain("Reveal in Finder");
    expect(html).not.toContain("Open in the default app");
    // Not merely rendered-and-disabled, which is the shape this rules out:
    // no item carries the attribute, and there are two fewer rows than the
    // desktop draws. (`data-disabled:` appears in every item's Tailwind class
    // list, so the ATTRIBUTE is what has to be looked for.)
    expect(html).not.toContain('data-disabled="');
    const rows = (source: string) => (source.match(/role="menuitem"/g) ?? []).length;
    expect(rows(html)).toBe(rows(row(desktop)) - 2);
  });

  test("keeps every item the browser CAN do", () => {
    const html = row(browser);
    expect(html).toContain("Open pinned");
    expect(html).toContain("Copy path");
    expect(html).toContain("Copy relative path");
  });
});

describe("the rest of what the list hides rather than fakes", () => {
  test("no composer item until something is listening for one", () => {
    expect(row(desktop)).not.toContain("Insert into composer");
    expect(row(desktop, { onInsertReference: () => {} })).toContain("Insert into composer as a reference");
  });

  test("no absolute Copy path before a checkout root is known", () => {
    const html = row(desktop, { absolute: undefined });
    expect(html).not.toContain(">Copy path<");
    // The relative one needs no root, and stays.
    expect(html).toContain("Copy relative path");
  });

  test("a directory row swaps the two openers for the two collapse verbs", () => {
    const html = row(desktop, { directory: true });
    expect(html).toContain("Expand");
    expect(html).toContain("Collapse all");
    expect(html).not.toContain("Open pinned");
    // And an open one says Collapse instead of Expand.
    expect(row(desktop, { directory: true, expanded: true })).toContain(">Collapse<");
  });
});
