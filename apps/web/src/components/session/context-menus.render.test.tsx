// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu } from "@/components/ui/context-menu";
import { RightPanel, type PanelTabItem } from "@/components/right-panel";
import { click, flush, installTestDom, mount, stubFetch } from "@/lib/testing/dom";
import { directoryReference, fileReference, type TelarReference } from "@/lib/drag-reference";
import type { EditorState } from "@/lib/editor-workspace";
import { nativeViewOverlayHidden } from "@/lib/native-view-overlay";
import type { WorkspaceFileMenu } from "@/lib/workspace-open";
import { EditorSurface } from "./editor-surface";
import { FileRowMenuItems, FilesSurface } from "./files-surface";
import { FileViewSurface } from "./file-view-surface";

installTestDom();

async function rightClick(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5, button: 2 }));
  });
  await flush();
}

async function escape() {
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
}

const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
const labels = () => menuItems().map((node) => node.textContent);
const item = (label: string) => menuItems().find((node) => node.textContent === label);

const LISTING = { workspacePath: "/w", repository: true, files: ["src/a.ts", "src/lib/b.ts", "README.md"], source: "git", truncated: false, readAt: 1 };

function stubTree() {
  return stubFetch({ "GET /api/sessions/s1/files": () => ({ listing: LISTING }), "GET /api/sessions/s1/diff": () => ({ diff: { files: [] } }) });
}

const copied: string[] = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });

type Desktop = { workspace: Record<string, (path: string, opener?: string) => Promise<unknown>> };
const shell = window as unknown as { telarDesktop?: Desktop };

function installShell() {
  const asked: string[] = [];
  const answer = (verb: string) => async (path: string) => (asked.push(`${verb} ${path}`), { ok: true });
  shell.telarDesktop = {
    workspace: { open: answer("open"), reveal: answer("reveal"), revealFile: answer("revealFile"), openFile: answer("openFile"), openers: async () => ({ openers: [] }) },
  };
  return asked;
}

afterEach(() => {
  delete shell.telarDesktop;
  copied.length = 0;
  window.localStorage.clear();
});

describe("a file row's item list", () => {
  const desktop: WorkspaceFileMenu = { reveal: () => {}, open: () => {}, openLabel: "Open in Zed", openIcon: "zed" };
  const browser: WorkspaceFileMenu = { openLabel: "Open in the default app" };
  const row = (files: WorkspaceFileMenu, overrides: Partial<Parameters<typeof FileRowMenuItems>[0]> = {}) =>
    renderToStaticMarkup(
      <ContextMenu open>
        <FileRowMenuItems
          path="apps/web/src/lib/utils.ts"
          directory={false}
          expanded={false}
          absolute="/Users/x/code/telar/apps/web/src/lib/utils.ts"
          files={files}
          onOpen={() => {}}
          onKeep={() => {}}
          onToggle={() => {}}
          onCollapseAll={() => {}}
          {...overrides}
        />
      </ContextMenu>,
    );
  const rows = (html: string) => (html.match(/role="menuitem"/g) ?? []).length;

  test("on the desktop it offers both shell verbs, naming the app", () => {
    const html = row(desktop);
    expect(html).toContain("Reveal in Finder");
    expect(html).toContain("Open in Zed");
    for (const label of ["Open", "Open pinned", "Copy path", "Copy relative path"]) expect(html).toContain(label);
  });

  test("in a browser tab it hides Reveal and Open-in-app rather than disabling them", () => {
    const html = row(browser);
    expect(html).not.toContain("Reveal in Finder");
    expect(html).not.toContain("Open in the default app");
    expect(html).not.toContain('data-disabled="');
    expect(rows(html)).toBe(rows(row(desktop)) - 2);
    for (const label of ["Open pinned", "Copy path", "Copy relative path"]) expect(html).toContain(label);
  });

  test("no composer item without a listener, and no absolute path without a root", () => {
    expect(row(desktop)).not.toContain("Insert into composer");
    expect(row(desktop, { onInsertReference: () => {} })).toContain("Insert into composer as a reference");
    const rootless = row(desktop, { absolute: undefined });
    expect(rootless).not.toContain(">Copy path<");
    expect(rootless).toContain("Copy relative path");
  });

  test("a directory row swaps the openers for Expand/Collapse and Collapse all", () => {
    const html = row(desktop, { directory: true });
    expect(html).toContain("Expand");
    expect(html).toContain("Collapse all");
    expect(html).not.toContain("Open pinned");
    expect(row(desktop, { directory: true, expanded: true })).toContain(">Collapse<");
  });
});

describe("the file tree", () => {
  async function mountTree(extra: { onInsertReference?: (reference: TelarReference) => void } = {}) {
    const calls = stubTree();
    const opened: string[] = [];
    const { host } = await mount(<FilesSurface sessionId="s1" onOpenFile={(path, intent) => opened.push(`${intent} ${path}`)} {...extra} />);
    await flush(() => Boolean(host.querySelector('[role="treeitem"]')));
    const row = (name: string) => [...host.querySelectorAll('[role="treeitem"]')].find((node) => node.textContent === name);
    return { host, calls, opened, row };
  }

  test("a file row's Open and Open pinned are the click's preview and the double click's pin", async () => {
    const { opened, row } = await mountTree();
    await rightClick(row("README.md")!);
    expect(labels()).toEqual(["Open", "Open pinned", "Copy path", "Copy relative path"]);
    await click(item("Open"));
    await rightClick(row("README.md")!);
    await click(item("Open pinned"));
    expect(opened).toEqual(["preview README.md", "pin README.md"]);
  });

  test("a directory row expands it, and Collapse all shuts everything again", async () => {
    const { row } = await mountTree();
    await rightClick(row("src")!);
    expect(labels().slice(0, 2)).toEqual(["Expand", "Collapse all"]);
    await click(item("Expand"));
    expect(row("a.ts")).toBeDefined();
    await rightClick(row("src")!);
    expect(item("Collapse")).toBeDefined();
    await click(item("Collapse all"));
    expect(row("a.ts")).toBeUndefined();
  });

  test("both paths copy, the absolute one resolved against the checkout", async () => {
    const { row } = await mountTree();
    await rightClick(row("README.md")!);
    await click(item("Copy path"));
    await rightClick(row("README.md")!);
    await click(item("Copy relative path"));
    expect(copied).toEqual(["/w/README.md", "README.md"]);
  });

  test("the composer item inserts the same reference the drag carries, a directory keeping its slash", async () => {
    const inserted: TelarReference[] = [];
    const { row } = await mountTree({ onInsertReference: (reference) => inserted.push(reference) });
    await rightClick(row("src")!);
    await click(item("Insert into composer as a reference"));
    await rightClick(row("README.md")!);
    await click(item("Insert into composer as a reference"));
    expect(inserted).toEqual([directoryReference("src"), fileReference("README.md")]);
  });

  test("the space around the rows offers Refresh, which re-reads the checkout", async () => {
    const { host, calls } = await mountTree();
    await rightClick(host.querySelector("p:last-of-type")!);
    expect(labels()).toEqual(["Refresh", "Collapse all"]);
    await click(item("Refresh"));
    expect(calls.filter((call) => call.route === "GET /api/sessions/s1/files")).toHaveLength(2);
  });

  test("the search field keeps the browser's own menu", async () => {
    const { host } = await mountTree();
    await rightClick(host.querySelector('input[type="search"]')!);
    expect(labels()).toEqual([]);
  });
});

describe("the Editor's tab strip", () => {
  const FILES: EditorState["files"] = [
    { path: "src/a.ts", view: "code", pinned: true },
    { path: "src/lib/b.ts", view: "code", pinned: false },
    { path: "README.md", view: "code", pinned: true },
  ];

  async function mountEditor() {
    stubTree();
    const state: { current?: EditorState } = {};
    function Harness() {
      const [editor, setEditor] = useState<EditorState>({ files: FILES, explorerOpen: false });
      state.current = editor;
      return <EditorSurface state={editor} onState={setEditor} sessionId="s1" />;
    }
    const { host } = await mount(<Harness />);
    const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((node) => node.textContent === name)!;
    const paths = () => state.current!.files.map((file) => file.path);
    return { host, state, tab, paths };
  }

  test("four close verbs and Reveal in file tree; Pin only on the preview; no relative path or app", async () => {
    const { tab } = await mountEditor();
    await rightClick(tab("b.ts"));
    expect(labels()).toEqual(["Close", "Close others", "Close to the right", "Close all", "Pin", "Reveal in file tree"]);
    await escape();
    await rightClick(tab("a.ts"));
    expect(labels()).not.toContain("Pin");
  });

  test("Close others, Close to the right and Close all sweep the strip", async () => {
    const { tab, paths } = await mountEditor();
    await rightClick(tab("b.ts"));
    await click(item("Close to the right"));
    expect(paths()).toEqual(["src/a.ts", "src/lib/b.ts"]);
    await rightClick(tab("b.ts"));
    await click(item("Close others"));
    expect(paths()).toEqual(["src/lib/b.ts"]);
    await rightClick(tab("b.ts"));
    await click(item("Close all"));
    expect(paths()).toEqual([]);
  });

  test("Pin keeps the preview", async () => {
    const { tab, state } = await mountEditor();
    await rightClick(tab("b.ts"));
    await click(item("Pin"));
    expect(state.current!.files.every((file) => file.pinned)).toBe(true);
  });

  test("Reveal in file tree opens the tree with the file's directories expanded, and the root unlocks Copy path", async () => {
    const { host, tab, state } = await mountEditor();
    await rightClick(tab("b.ts"));
    expect(labels()).not.toContain("Copy path");
    await click(item("Reveal in file tree"));
    await flush(() => Boolean(host.querySelector('[role="treeitem"]')));
    await flush();
    expect(state.current!.explorerOpen).toBe(true);
    expect([...host.querySelectorAll('[role="treeitem"]')].map((node) => node.textContent)).toContain("b.ts");
    await rightClick(tab("b.ts"));
    await click(item("Copy path"));
    expect(copied).toEqual(["/w/src/lib/b.ts"]);
  });

  test("on the desktop a tab reveals its file in Finder", async () => {
    const asked = installShell();
    const { host, tab } = await mountEditor();
    await rightClick(tab("a.ts"));
    await click(item("Reveal in file tree"));
    await flush(() => Boolean(host.querySelector('[role="treeitem"]')));
    await rightClick(tab("a.ts"));
    expect(labels()).not.toContain("Copy relative path");
    await click(item("Reveal in Finder"));
    expect(asked).toEqual(["revealFile /w/src/a.ts"]);
  });
});

describe("the file view's menu", () => {
  const read = (path: string, text: string) => ({ file: { path, text, bytes: text.length, sha256: "sha", binary: false, truncated: false } });

  async function mountFile(path: string, text: string, extra: { onInsertReference?: (reference: TelarReference) => void } = {}) {
    const calls = stubFetch({ "GET /api/sessions/s1/files": () => read(path, text) });
    const { host } = await mount(<FileViewSurface path={path} sessionId="s1" workspacePath="/w" {...extra} />);
    await flush(() => Boolean(host.querySelector("textarea") || host.textContent?.includes(text.trim().slice(2))));
    return { host, calls };
  }

  test("the address row and the body carry one list, with both paths", async () => {
    const { host } = await mountFile("src/a.ts", "const a = 1;\n");
    await rightClick(host.querySelector('[aria-label="Re-read this file"]')!);
    const row = labels();
    expect(row).toEqual(["Copy path", "Copy relative path", "Re-read from disk"]);
    await escape();
    await rightClick(host.querySelector("textarea")!.parentElement!);
    expect(labels()).toEqual(row);
  });

  test("the textarea keeps the browser's own edit menu", async () => {
    const { host } = await mountFile("src/a.ts", "const a = 1;\n");
    await rightClick(host.querySelector("textarea")!);
    expect(labels()).toEqual([]);
  });

  test("Re-read from disk reads the file again", async () => {
    const { host, calls } = await mountFile("src/a.ts", "const a = 1;\n");
    await rightClick(host.querySelector('[aria-label="Re-read this file"]')!);
    await click(item("Re-read from disk"));
    await flush();
    expect(calls.filter((call) => call.route === "GET /api/sessions/s1/files")).toHaveLength(2);
  });

  test("markdown's Rendered/Source radio switches the view, and Wrap lines drives the header's switch", async () => {
    const { host } = await mountFile("notes.md", "# hello\n");
    await rightClick(host.querySelector('[aria-label="Re-read this file"]')!);
    expect(item("Rendered")?.getAttribute("aria-checked")).toBe("true");
    expect(item("Wrap lines")).toBeUndefined();
    await click(item("Source"));
    expect(host.querySelector("textarea")).not.toBeNull();
    const wrap = () => host.querySelector('[role="switch"][aria-label="Wrap lines"]')!.getAttribute("aria-checked");
    const before = wrap();
    await click(item("Wrap lines"));
    await flush();
    expect(wrap()).toBe(before === "true" ? "false" : "true");
  });

  test("the composer item inserts the file's own reference", async () => {
    const inserted: TelarReference[] = [];
    const { host } = await mountFile("src/a.ts", "const a = 1;\n", { onInsertReference: (reference) => inserted.push(reference) });
    await rightClick(host.querySelector('[aria-label="Re-read this file"]')!);
    await click(item("Insert into composer as a reference"));
    expect(inserted).toEqual([fileReference("src/a.ts")]);
  });
});

describe("the right panel's tab strip", () => {
  const tab = (id: string, kind: string): PanelTabItem => ({ id, kind, params: {} }) as PanelTabItem;
  const TABS = [tab("t1", "agents"), tab("t2", "processes"), tab("t3", "diff")];

  async function mountPanel(tabs: PanelTabItem[] = TABS, extra: Partial<React.ComponentProps<typeof RightPanel>> = {}) {
    const closed: string[] = [];
    const { host } = await mount(
      <RightPanel sessionId="s1" projectId="p1" tabs={tabs} tab={tabs[0]!.id} onTabChange={() => {}} onOpenTab={() => {}} onCloseTab={(id) => closed.push(id)} onClose={() => {}} {...extra} />,
    );
    const chip = (index: number) => host.querySelectorAll('[role="tab"]')[index]!;
    return { host, closed, chip };
  }

  test("Close, Close others and Close all go through the strip's own close, by instance", async () => {
    stubFetch({});
    const { closed, chip } = await mountPanel();
    await rightClick(chip(1));
    expect(labels()).toEqual(["Close", "Close others", "Close all", "Fill the window"]);
    await click(item("Close"));
    await rightClick(chip(1));
    await click(item("Close others"));
    await rightClick(chip(1));
    await click(item("Close all"));
    expect(closed).toEqual(["t2", "t1", "t3", "t1", "t2", "t3"]);
  });

  test("Fill the window toggles fullscreen, and the menu takes the native view down while open", async () => {
    stubFetch({});
    const { host, chip } = await mountPanel();
    await rightClick(chip(0));
    expect(nativeViewOverlayHidden()).toBe(true);
    await click(item("Fill the window"));
    expect(nativeViewOverlayHidden()).toBe(false);
    expect(host.querySelector("[data-panel-fullscreen]")).not.toBeNull();
    await rightClick(chip(0));
    expect(item("Exit fullscreen")).toBeDefined();
  });

  test("the Editor tab's tree inserts a file into the message as text", async () => {
    stubTree();
    const inserted: string[] = [];
    const editors = { e1: { files: [], explorerOpen: true } };
    const { host } = await mountPanel([tab("e1", "editor")], { editors, onEditorChange: () => {}, onInsertReference: (text) => inserted.push(text) });
    await flush(() => Boolean(host.querySelector('[role="treeitem"]')));
    await rightClick([...host.querySelectorAll('[role="treeitem"]')].find((node) => node.textContent === "README.md")!);
    await click(item("Insert into composer as a reference"));
    expect(inserted).toEqual([fileReference("README.md").text]);
  });
});
