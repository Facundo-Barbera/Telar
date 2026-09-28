// @ts-expect-error bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { UNKNOWN_PATH, type GitFileChange, type SessionDiff } from "@telar/engine-client";
import { installTestDom, mount, flush, click, stubFetch } from "@/lib/testing/dom";
import { fileReference, REFERENCE_MIME } from "@/lib/drag-reference";
import type { NotebookCell, NotebookRead } from "@/lib/ds";
import type { JournalItem, JournalTask } from "@/lib/engine/journal";
import type { DiffTab } from "@/lib/diff-scope";
import { messagePlainText, quoteForComposer } from "@/components/ui/message";
import { NotebookSurface } from "./session/notebook-surface";
import { TableSurface } from "./session/table-surface";
import { DiffSurface, ReviewFileRow } from "@/features/git";
import { TranscriptItem } from "@/features/transcript";
import { Composer } from "@/features/composer";
import { DesktopBrowserSurface, type DesktopBrowserBridge, type DesktopBrowserPanelState, type DesktopBrowserTab } from "./browser-live";
import { appendToDraft } from "./session-cockpit";

installTestDom();

let copied: string[] = [];
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
});

async function rightClick(target: Element) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5, button: 2 });
  await act(async () => void target.dispatchEvent(event));
  await flush();
  return event;
}
const menuRows = () => [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
const labels = () => menuRows().map((row) => row.textContent?.trim());
const row = (label: string) => menuRows().find((each) => each.textContent?.trim() === label);
const disabled = (label: string) => row(label)?.hasAttribute("data-disabled");
const choose = (label: string) => click(row(label));
const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll(selector)].find((node) => node.textContent?.trim() === text)!;

describe("every surface menu uses the shared primitive", () => {
  const sources = [".", "../features"]
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .flatMap((dir) =>
      (fs.readdirSync(dir, { recursive: true }) as string[])
        .filter((name) => name.endsWith(".tsx") && !name.includes(".test.") && name !== path.join("ui", "context-menu.tsx"))
        .map((name) => ({ name, source: fs.readFileSync(path.join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "") })),
    )
    .filter(({ source }) => source.includes("<ContextMenuItem"));

  test("imports components/ui/context-menu and defines no ContextMenu of its own", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const { name, source } of sources) {
      expect(source, name).toContain('from "@/components/ui/context-menu"');
      expect(source, name).not.toMatch(/function ContextMenu\b/);
    }
  });

  test("no menu item fetches directly — each fires a callback the surface already wires", () => {
    for (const { name, source } of sources) {
      for (const item of source.match(/<ContextMenuItem[^>]*onClick=\{[^}]*\}/g) ?? []) {
        expect(item, name).not.toMatch(/\bfetch\(|\bapi\.\w+\(/);
      }
    }
  });
});

describe("the notebook cell's menu", () => {
  const cell = (index: number, patch: Partial<NotebookCell> = {}): NotebookCell => ({ id: `c${index}`, index, type: "code", source: `x = ${index}`, ...patch });
  const notebook: NotebookRead = {
    path: "a.ipynb",
    sha256: "sha",
    cellCount: 3,
    cells: [cell(0, { outputs: [{ kind: "text", stream: "stdout", text: "0" }] }), cell(1, { type: "markdown", source: "# Title" }), cell(2)],
  };
  const base = "POST /api/sessions/s1/ds/notebook";

  async function open(index: number) {
    const calls = stubFetch({ [`${base}/read`]: () => notebook, [`${base}/edit`]: () => notebook, [`${base}/run`]: () => ({ results: [], notebook }) });
    const { host } = await mount(<NotebookSurface path="a.ipynb" sessionId="s1" />);
    await flush(() => host.querySelectorAll(".group\\/cell").length === 3);
    const target = host.querySelectorAll(".group\\/cell")[index]!;
    await rightClick(target);
    return { calls, host, target };
  }
  const edits = (calls: { route: string; body: unknown }[]) => calls.filter((call) => call.route === `${base}/edit`).map((call) => (call.body as { edit: unknown }).edit);

  test("a code cell with outputs offers its own verbs, and Move up is disabled at the top", async () => {
    await open(0);
    expect(labels()).toEqual([
      "Run cell", "Run all", "Insert cell above", "Insert cell below", "Move up", "Move down",
      "Change to Markdown", "Delete cell", "Copy source", "Collapse outputs", "Clear outputs",
    ]);
    expect(disabled("Move up")).toBe(true);
    expect(disabled("Move down")).toBe(false);
  });

  test("a markdown cell cannot run, offers the other type, and has no outputs verbs", async () => {
    await open(1);
    expect(labels()).toEqual(["Run all", "Insert cell above", "Insert cell below", "Move up", "Move down", "Change to Code", "Delete cell", "Copy source"]);
  });

  test("the last cell cannot move down, and a code cell with no outputs has nothing to clear", async () => {
    await open(2);
    expect(disabled("Move down")).toBe(true);
    expect(labels()).not.toContain("Clear outputs");
  });

  test("Move and Clear outputs send the engine's own edits, never a delete-then-insert", async () => {
    const { calls, target } = await open(0);
    await choose("Move down");
    await flush(() => edits(calls).length === 1);
    await rightClick(target);
    await choose("Clear outputs");
    await flush(() => edits(calls).length === 2);
    expect(edits(calls)).toEqual([{ kind: "move", cellId: "c0", to: 1 }, { kind: "clearOutputs", cellId: "c0" }]);
  });

  test("Insert above on the first cell sends after -1, the same as the strip above it", async () => {
    const { calls, target, host } = await open(0);
    await choose("Insert cell above");
    await flush(() => edits(calls).length === 1);
    await rightClick(target);
    await choose("Insert cell below");
    await flush(() => edits(calls).length === 2);
    await click(byText(host, "button", "+ markdown"));
    await flush(() => edits(calls).length === 3);
    expect(edits(calls)).toEqual([
      { kind: "insert", after: -1, source: "", cellType: "code" },
      { kind: "insert", after: "c0", source: "", cellType: "code" },
      { kind: "insert", after: -1, source: "", cellType: "markdown" },
    ]);
  });

  test("Change type, Delete and Run fire what the cell's buttons fire", async () => {
    const { calls, target } = await open(0);
    await choose("Change to Markdown");
    await rightClick(target);
    await choose("Delete cell");
    await rightClick(target);
    await choose("Run cell");
    await flush(() => calls.some((call) => call.route === `${base}/run`));
    expect(edits(calls)).toEqual([{ kind: "set", cellId: "c0", cellType: "markdown" }, { kind: "delete", cellId: "c0" }]);
    expect(calls.find((call) => call.route === `${base}/run`)?.body).toMatchObject({ path: "a.ipynb", cellId: "c0" });
  });

  test("Copy source copies the unsaved draft, not what is on disk", async () => {
    const { host, target } = await open(0);
    const box = host.querySelector('textarea[aria-label="Cell 0 source"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "x = 42");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await rightClick(target);
    await choose("Copy source");
    expect(copied).toEqual(["x = 42"]);
  });
});

describe("the table's column header and its cells", () => {
  const long = "a".repeat(400);
  const answer = { path: "t.csv", columns: ["name", "note"], dtypes: ["str", "str"], total: 1, offset: 0, rows: [[long, null]] };

  async function table() {
    const queries: URLSearchParams[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      queries.push(new URL(String(input), "http://localhost").searchParams);
      return Response.json(answer);
    }) as typeof fetch;
    const { host } = await mount(<TableSurface path="t.csv" sessionId="s1" />);
    await flush(() => Boolean(host.querySelector("tbody td:nth-child(2)")));
    const reads = () => queries.map((query) => ({ sort: query.get("sort") ?? undefined, desc: query.get("desc") === "1" }));
    return { host, reads, header: () => host.querySelector("th:nth-child(2) > span")! };
  }

  test("the header offers the three sort choices as one radio group, plus Copy column name", async () => {
    const { header } = await table();
    await rightClick(header());
    expect(labels()).toEqual(["Sort ascending", "Sort descending", "Clear sort", "Copy column name"]);
    expect(row("Clear sort")?.getAttribute("aria-checked")).toBe("true");
    await choose("Copy column name");
    expect(copied).toEqual(["name"]);
  });

  test("picking a direction re-reads sorted, the group shows it, and Clear sort drops it", async () => {
    const { header, reads } = await table();
    await rightClick(header());
    await choose("Sort descending");
    await flush(() => reads().some((read) => read.desc === true));
    expect(reads().at(-1)).toMatchObject({ sort: "name", desc: true });
    await rightClick(header());
    expect(row("Sort descending")?.getAttribute("aria-checked")).toBe("true");
    expect(row("Sort ascending")?.getAttribute("aria-checked")).toBe("false");
    await choose("Clear sort");
    await flush(() => reads().at(-1)?.sort === undefined);
    expect(reads().at(-1)?.sort).toBeUndefined();
  });

  test("the header's own click still cycles the sort", async () => {
    const { host, reads } = await table();
    await click(host.querySelector("th:nth-child(2)")!);
    await flush(() => reads().some((read) => read.sort === "name"));
    expect(reads().at(-1)).toMatchObject({ sort: "name", desc: false });
  });

  test("a cell offers only Copy value, and copies the whole string rather than the clipped one", async () => {
    const { host } = await table();
    await rightClick(host.querySelector("tbody td:nth-child(2) > span")!);
    expect(labels()).toEqual(["Copy value"]);
    await choose("Copy value");
    await rightClick(host.querySelector("tbody td:nth-child(3) > span")!);
    await choose("Copy value");
    expect(copied).toEqual([long, "null"]);
  });
});

describe("the diff surface's file row", () => {
  const file: GitFileChange = { path: "src/a.ts", status: "modified" };
  const view = { layout: "stacked", wrap: false, ignoreWhitespace: false, tree: false } as const;

  async function fileRow(patch: Partial<Parameters<typeof ReviewFileRow>[0]> = {}) {
    const { host } = await mount(
      <ReviewFileRow readPatch={async () => ({ file: { patch: "", binary: false } })} file={file} reported view={view} open={false} onToggle={() => {}} {...patch} />,
    );
    await rightClick(host.querySelector("button")!);
    return host;
  }

  test("with every route wired it offers them all, and never stage, unstage or revert", async () => {
    await fileRow({ onOpenFile: () => {}, onOpenInNewPanelTab: () => {}, onInsertReference: () => {} });
    expect(labels()).toEqual(["Open in Editor", "Open in a new panel tab", "Copy path", "Insert as reference", "Expand patch"]);
  });

  test("with no routes it offers what the row can do alone", async () => {
    await fileRow({ open: true });
    expect(labels()).toEqual(["Copy path", "Collapse patch"]);
  });

  test("each item fires its route with the row's path", async () => {
    const seen: string[] = [];
    const host = await fileRow({
      onOpenFile: (at) => seen.push(`editor ${at}`),
      onOpenInNewPanelTab: (at) => seen.push(`tab ${at}`),
      onInsertReference: (text) => seen.push(`insert ${text}`),
      onToggle: () => seen.push("toggle"),
    });
    const trigger = host.querySelector("button")!;
    for (const label of ["Open in Editor", "Open in a new panel tab", "Insert as reference", "Expand patch", "Copy path"]) {
      await rightClick(trigger);
      await choose(label);
    }
    expect(seen).toEqual(["editor src/a.ts", "tab src/a.ts", "insert `src/a.ts`", "toggle"]);
    expect(copied).toEqual(["src/a.ts"]);
  });

  test("Insert as reference inserts the same text the row's own drag carries", async () => {
    let inserted = "";
    const host = await fileRow({ onInsertReference: (text) => (inserted = text) });
    await choose("Insert as reference");
    const data = new Map<string, string>();
    const drag = new Event("dragstart", { bubbles: true });
    Object.defineProperty(drag, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" } });
    await act(async () => void host.querySelector("[draggable]")!.dispatchEvent(drag));
    expect(inserted).toBe(fileReference(file.path).text);
    expect(data.get("text/plain")).toBe(inserted);
    expect(JSON.parse(data.get(REFERENCE_MIME)!).text).toBe(inserted);
  });
});

describe("the diff surface around its rows", () => {
  const diff: SessionDiff = {
    repository: true,
    workspacePath: "/w",
    files: [{ path: "a.ts", status: "modified" }, { path: "b.ts", status: "added" }],
    commits: [],
    linesAdded: 0,
    linesRemoved: 0,
    truncated: false,
  };

  async function surface(tab: DiffTab, onTabChange: (tab: DiffTab) => void = () => {}) {
    stubFetch({ "GET /api/sessions/s1/diff": () => ({ diff }) });
    const opened: string[] = [];
    const { host } = await mount(
      <DiffSurface sessionId="s1" reported={new Map([["b.ts", 1]])} suggestion="Work" tab={tab} onTabChange={onTabChange} onOpenFile={(at) => opened.push(at)} />,
    );
    await flush(() => host.querySelectorAll("[data-diff-path]").length === 2);
    return { host, opened };
  }

  test("the unreported row and the reported row carry the same menu", async () => {
    const { host, opened } = await surface({ kind: "branch" });
    for (const at of ["a.ts", "b.ts"]) {
      await rightClick(host.querySelector(`[data-diff-path="${at}"] button`)!);
      expect(labels()).toEqual(["Open in Editor", "Copy path", "Expand patch"]);
      await choose("Open in Editor");
    }
    expect(opened).toEqual(["a.ts", "b.ts"]);
  });

  test("the filter field rewrites the whole tab, and its clear button blanks the filter", async () => {
    const written: DiffTab[] = [];
    const { host } = await surface({ kind: "branch", base: "main", filter: "a" }, (tab) => written.push(tab));
    const field = host.querySelector('input[aria-label="Filter this review by path"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "src/");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(host.querySelector('button[aria-label="Clear the filter"]')!);
    expect(written).toEqual([{ kind: "branch", base: "main", filter: "src/" }, { kind: "branch", base: "main", filter: "" }]);
  });
});

describe("inserting into the composer's draft", () => {
  test("an empty draft becomes the insert, and a reference joins the sentence with one space", () => {
    expect(appendToDraft("  ", "`a.ts`")).toBe("`a.ts`");
    expect(appendToDraft("fix", "`a.ts`")).toBe("fix `a.ts` ");
    expect(appendToDraft("fix ", "`a.ts`")).toBe("fix `a.ts` ");
  });

  test("a multi-line insert is a paragraph of its own", () => {
    expect(appendToDraft("see this  \n", "> one\n> two")).toBe("see this\n\n> one\n> two");
  });
});

describe("the transcript's message and tool rows", () => {
  const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;
  const said = (type: "assistant_message" | "user_message", text: string, status: JournalItem["status"] = "completed") =>
    ({ ...base, id: "m", status, completedAt: 2, detail: { type, text } }) as unknown as JournalItem;
  const answer = "Use **this**:\n\n```\nconst *x* = 1;\n```";

  async function transcriptRow(item: JournalItem, gestures: Partial<Parameters<typeof TranscriptItem>[0]> = {}) {
    const { host } = await mount(<TranscriptItem item={item} {...gestures} />);
    const event = await rightClick(host.firstElementChild!);
    return { host, event };
  }

  test("an answer offers plain text, its Markdown, and a quote into the composer", async () => {
    const quoted: string[] = [];
    await transcriptRow(said("assistant_message", answer), { onInsert: (text) => quoted.push(text) });
    expect(labels()).toEqual(["Copy text", "Copy as Markdown", "Quote into composer"]);
    await choose("Copy text");
    await transcriptRow(said("assistant_message", answer));
    await choose("Copy as Markdown");
    expect(copied).toEqual([messagePlainText(answer), answer]);
    expect(copied[0]).toContain("const *x* = 1;");
    expect(copied[0]).toContain("Use this:");
  });

  test("Quote into composer hands the cockpit every line prefixed", async () => {
    const quoted: string[] = [];
    await transcriptRow(said("assistant_message", "one\n\ntwo"), { onInsert: (text) => quoted.push(text) });
    await choose("Quote into composer");
    expect(quoted).toEqual(["> one\n> \n> two"]);
    expect(quoteForComposer("  one\ntwo  ")).toBe("> one\n> two");
  });

  test("a person's message is plain, so it gets one copy item rather than two", async () => {
    await transcriptRow(said("user_message", "fix *it*"));
    expect(labels()).toEqual(["Copy text"]);
    await choose("Copy text");
    expect(copied).toEqual(["fix *it*"]);
  });

  test("an answer still streaming carries no menu", async () => {
    const { event } = await transcriptRow(said("assistant_message", "half a sen", "inProgress"));
    expect(menuRows()).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  test("a command row copies its command and output, and never offers to re-run", async () => {
    const item = { ...base, id: "c", status: "completed", completedAt: 2, detail: { type: "command_execution", command: { command: "ls -la", outputPreview: "a\nb" } } } as unknown as JournalItem;
    await transcriptRow(item);
    expect(labels()).toEqual(["Copy command", "Copy output"]);
    await choose("Copy command");
    expect(copied).toEqual(["ls -la"]);
  });

  test("a file row offers the file: open it, copy it, reference it", async () => {
    const seen: string[] = [];
    const item = { ...base, id: "f", status: "completed", completedAt: 2, title: "Edit", detail: { type: "file_change", change: { path: "src/a.ts", kind: "edit", unifiedDiff: "@@\n-a\n+b" } } } as unknown as JournalItem;
    const gestures = { onOpenFile: (at: string) => seen.push(`editor ${at}`), onOpenFileInNewTab: (at: string) => seen.push(`tab ${at}`), onInsert: (text: string) => seen.push(`insert ${text}`) };
    const { host } = await transcriptRow(item, gestures);
    expect(labels()).toEqual(["Copy patch", "Open file in the Editor", "Open in a new panel tab", "Copy path", "Insert as reference"]);
    for (const label of ["Open file in the Editor", "Open in a new panel tab", "Insert as reference", "Copy path", "Copy patch"]) {
      if (!row(label)) await rightClick(host.firstElementChild!);
      await choose(label);
    }
    expect(seen).toEqual(["editor src/a.ts", "tab src/a.ts", "insert `src/a.ts`"]);
    expect(copied).toEqual(["src/a.ts", "@@\n-a\n+b"]);
  });

  test("a row with nothing to offer — a file not yet named — gets no menu", async () => {
    const item = { ...base, id: "u", status: "inProgress", title: "Edit", detail: { type: "file_change", change: { path: UNKNOWN_PATH, kind: "edit" } } } as unknown as JournalItem;
    const { event } = await transcriptRow(item);
    expect(menuRows()).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  test("an agent row offers Open in the Agents panel only where its Open button exists", async () => {
    const spawn = { ...base, id: "t", status: "completed", completedAt: 2, detail: { type: "task", taskId: "task_1" } } as unknown as JournalItem;
    const task = { id: "task_1", state: "completed", title: "Survey", role: "explorer", resultText: "Found it." } as unknown as JournalTask;
    const opened: string[] = [];
    await transcriptRow(spawn, { tasks: [task], onOpenAgent: (id) => opened.push(id) });
    expect(labels()).toEqual(["Copy text", "Copy as Markdown", "Open in the Agents panel"]);
    await choose("Open in the Agents panel");
    expect(opened).toEqual(["task_1"]);
    await transcriptRow(spawn, { tasks: [task] });
    expect(labels()).not.toContain("Open in the Agents panel");
  });
});

describe("the composer's chrome, and the selection it leaves alone", () => {
  function Box({ initial = "", files = [], onAttach }: { initial?: string; files?: File[]; onAttach?: (files: File[]) => void }) {
    const [draft, setDraft] = useState(initial);
    return (
      <>
        <p data-testid="draft">{draft}</p>
        <Composer
          draft={draft}
          kind="session"
          ready
          attachments={files}
          onAttach={(next) => onAttach?.([...next])}
          busy={false}
          sending={false}
          backgroundTasks={0}
          onDraftChange={setDraft}
          onSubmit={() => {}}
          onStop={() => {}}
          onStopBackground={() => {}}
          onRuntimeMode={() => {}}
        />
      </>
    );
  }

  async function composer(props: Parameters<typeof Box>[0] = {}) {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    const { host } = await mount(<Box {...props} />);
    await flush();
    const editor = host.querySelector('[contenteditable="true"]')!;
    return { host, editor, draft: () => host.querySelector('[data-testid="draft"]')!.textContent };
  }

  test("an empty box keeps both rows, disabled rather than hidden", async () => {
    const { editor } = await composer();
    await rightClick(editor);
    expect(labels()).toEqual(["Clear draft", "Stash draft"]);
    expect(disabled("Clear draft")).toBe(true);
    expect(disabled("Stash draft")).toBe(true);
  });

  test("the whole card answers, and Clear draft empties the box", async () => {
    const { host, draft } = await composer({ initial: "hello" });
    await rightClick(host.querySelector("[data-slot=input-group] button:last-of-type")!);
    expect(disabled("Clear draft")).toBe(false);
    expect(disabled("Stash draft")).toBe(false);
    await choose("Clear draft");
    expect(draft()).toBe("");
  });

  test("Stash draft takes the text off the box, as ⌘S does", async () => {
    const { editor, draft } = await composer({ initial: "later" });
    await rightClick(editor);
    await choose("Stash draft");
    expect(draft()).toBe("");
  });

  test("a picture alone is stashable, the same rule ⌘S uses", async () => {
    const { editor } = await composer({ files: [new File(["x"], "shot.png", { type: "image/png" })] });
    await rightClick(editor);
    expect(disabled("Clear draft")).toBe(true);
    expect(disabled("Stash draft")).toBe(false);
  });

  test("a chip adds Remove attachment, and removing takes only that file", async () => {
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
    let attached: File[] = files;
    const { host } = await composer({ files, onAttach: (next) => (attached = next) });
    await rightClick(byText(host, "span", "b.txt"));
    expect(labels()).toEqual(["Remove attachment", "Clear draft", "Stash draft"]);
    await choose("Remove attachment");
    expect(attached.map((file) => file.name)).toEqual(["a.txt"]);
  });

  test("a right-click on selected text in the box leaves the browser's own menu alone", async () => {
    const { editor } = await composer({ initial: "select me" });
    const range = document.createRange();
    range.selectNodeContents(editor);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const event = await rightClick(editor.querySelector("*") ?? editor);
    window.getSelection()!.removeAllRanges();
    expect(menuRows()).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the integrated browser's tab strip", () => {
  const tab = (index: number, patch: Partial<DesktopBrowserTab> = {}): DesktopBrowserTab => ({
    index,
    id: `tab_${index}`,
    title: `Page ${index}`,
    url: `https://example.com/${index}`,
    active: index === 0,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    colorScheme: "system",
    preview: false,
    viewport: { width: 1280, height: 800, preset: "default", mode: "fit" },
    ...patch,
  });

  async function strip(tabs: DesktopBrowserTab[], extra: Partial<DesktopBrowserBridge> = {}) {
    const state: DesktopBrowserPanelState = { scopeKey: "s", tabs, presentation: { width: 1280, height: 800, scale: 0.5, rect: { x: 0, y: 0, width: 640, height: 400 } } };
    const actions: Record<string, unknown>[] = [];
    const bridge: DesktopBrowserBridge = {
      getState: async () => state,
      action: async (_scope, action) => {
        actions.push(action);
        return state;
      },
      setBounds: async () => {},
      setVisible: async () => {},
      onState: () => () => {},
      ...extra,
    };
    const { host } = await mount(<DesktopBrowserSurface bridge={bridge} scopeKey="s" projectId="p" />);
    await flush(() => host.querySelectorAll('[role="tab"]').length === tabs.length);
    const menuOf = (index: number) => rightClick(host.querySelectorAll('[role="tab"]')[index]!);
    return { actions, menuOf };
  }

  test("every item names the right-clicked tab by index, and none selects it", async () => {
    const { actions, menuOf } = await strip([tab(0), tab(1)]);
    for (const label of ["Reload", "Duplicate", "Close"]) {
      await menuOf(1);
      await choose(label);
    }
    await menuOf(1);
    await choose("Copy URL");
    expect(actions).toEqual([{ action: "reload", index: 1 }, { action: "duplicate", index: 1 }, { action: "close", index: 1 }]);
    expect(copied).toEqual(["https://example.com/1"]);
  });

  test("Close others walks down, because closing renumbers the tabs above", async () => {
    const { actions, menuOf } = await strip([tab(0), tab(1), tab(2)]);
    await menuOf(1);
    await choose("Close others");
    await flush(() => actions.length === 2);
    expect(actions).toEqual([{ action: "close", index: 2 }, { action: "close", index: 0 }]);
  });

  test("Close others is disabled on a lone tab", async () => {
    const { menuOf } = await strip([tab(0)]);
    await menuOf(0);
    expect(disabled("Close others")).toBe(true);
  });

  test("Open in system browser is absent without the shell's door, and greyed on a non-web page", async () => {
    const plain = await strip([tab(0)]);
    await plain.menuOf(0);
    expect(labels()).not.toContain("Open in system browser");

    const sent: string[] = [];
    const openExternal = async (url: string) => (sent.push(url), { ok: true });
    const shell = await strip([tab(0), tab(1, { url: "about:blank" })], { openExternal });
    await shell.menuOf(0);
    await choose("Open in system browser");
    expect(sent).toEqual(["https://example.com/0"]);
    await shell.menuOf(1);
    expect(disabled("Open in system browser")).toBe(true);
  });
});
