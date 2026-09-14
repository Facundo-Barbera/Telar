// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ADAPTIVE RIGHT-CLICK MENUS, ROUND 3 (#274, part of #94) — the conversation's
 * own surfaces: transcript rows, the composer's chrome, notebook cells, table
 * headers, diff rows and browser tabs.
 *
 * ASSERTED AS SOURCE TEXT, for the reason the app's other idiom tests give: it
 * has no DOM harness, and every claim here is structural rather than visual —
 * "there is ONE primitive", "every item fires a callback the surface already
 * wires", "no menu spells a second write path". Each is decidable by reading
 * the file, and each is a rule a future edit breaks silently.
 *
 * THE RULE THE WHOLE ROUND TURNS ON: a menu item's handler is a function the
 * same surface already gives a VISIBLE control. A right-click that reached a
 * second `fetch` would be a second way for the same verb to go wrong, and the
 * earlier rounds established that it does not happen.
 */
const dir = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
/** Source with its comments stripped — an explanation of an ABSENCE must not
 *  satisfy a scan looking for the thing it says is absent. */
const code = (name: string) => read(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** Source with its line breaks collapsed, for sentences JSX wraps arbitrarily. */
const flat = (name: string) => code(name).replace(/\s+/g, " ");
/** A file outside `components/` — the desktop shell, for the halves of a
 *  verb that live on both sides of the bridge. */
const codeOf = (relative: string) => fs.readFileSync(path.join(dir, relative), "utf8");

/** Every file this round puts a menu on. Grown one surface per commit, so the
 *  cross-surface rules below hold at every point in the series rather than
 *  only at the end of it. */
const SURFACES = ["transcript.tsx", "composer.tsx", "browser-live.tsx", "session/notebook-surface.tsx", "session/table-surface.tsx", "session/diff-surface.tsx"];

describe("one primitive, composed per surface", () => {
  test("every surface imports the SHARED context-menu module and defines none of its own", () => {
    for (const name of SURFACES) {
      const source = code(name);
      expect(source, `${name} imports the shared primitive`).toContain('from "@/components/ui/context-menu"');
      expect(source, `${name} does not define its own ContextMenu`).not.toMatch(/function ContextMenu\b/);
    }
  });

  test("the primitive is still base-ui's dedicated ContextMenu module, not a Menu wearing its name", () => {
    const primitive = read("ui/context-menu.tsx");
    expect(primitive).toContain('import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"');
  });

  test("no menu item anywhere in this round opens a second write path", () => {
    // Every onClick is a bare callback the surface already wires to a button,
    // a keyboard chord or a prop. A `fetch(` inside a menu item would be the
    // same verb with a second set of bugs.
    for (const name of SURFACES) {
      const items = code(name).match(/<ContextMenuItem[^>]*onClick=\{[^}]*\}/g) ?? [];
      for (const item of items) {
        expect(item, `${name}: ${item} avoids a second write path`).not.toMatch(/\bfetch\(|\bapi\.\w+\(/);
      }
    }
  });
});

/**
 * THE NOTEBOOK CELL. Nine of its twelve verbs are the cell's own buttons under
 * another name; three are new — Move up, Move down and Clear outputs — and
 * those are new in the ENGINE, as members of `ds/notebook/edit`, precisely
 * because a client faking them loses the cell's id and the record of what ran.
 */
describe("the notebook cell's menu", () => {
  const nb = () => code("session/notebook-surface.tsx");

  test("it carries the cell's own verbs, each firing the prop the visible control fires", () => {
    const source = nb();
    expect(source).toContain("<ContextMenuItem disabled={running} onClick={onRun}>");
    expect(source).toContain("<ContextMenuItem disabled={running} onClick={onRunAll}>");
    expect(source).toContain('onClick={() => onInsert("above")}');
    expect(source).toContain('onClick={() => onInsert("below")}');
    expect(source).toContain('onClick={() => onType(code ? "markdown" : "code")}');
    expect(source).toContain("<ContextMenuItem variant=\"destructive\" onClick={onDelete}>");
    expect(source).toContain("onClick={() => void navigator.clipboard.writeText(source)}");
    expect(source).toContain("onClick={onCollapse}");
    expect(source).toContain("onClick={onClearOutputs}");
  });

  test("the three NEW verbs reach the engine's own union members, never a faked delete-then-insert", () => {
    const source = nb();
    expect(source).toContain('void structural({ kind: "move", cellId: cell.id, to })');
    expect(source).toContain('void structural({ kind: "clearOutputs", cellId: cell.id })');
    // The whole reason the engine owns these: a move spelled as delete +
    // insert mints a new id and drops the outputs.
    expect(source).not.toMatch(/kind: "delete"[\s\S]{0,200}kind: "insert"/);
  });

  test("Move is DISABLED at the ends rather than clamped, because the engine refuses an out-of-range target", () => {
    const source = nb();
    expect(source).toContain("<ContextMenuItem disabled={cell.index === 0} onClick={() => onMove(cell.index - 1)}>");
    expect(source).toContain("<ContextMenuItem disabled={cell.index >= count - 1} onClick={() => onMove(cell.index + 1)}>");
  });

  test("Insert above is `after: index - 1`, which is the same -1 the top strip already sends", () => {
    expect(nb()).toContain('after: where === "above" ? cell.index - 1 : cell.id');
  });

  test("insert offers a PLACE, not a type — the hover strip between cells already offers both, in place", () => {
    const source = nb();
    expect(source).toContain("Insert cell above");
    expect(source).toContain("Insert cell below");
    // No markdown/code split in the menu, so the list cannot grow a lopsided
    // "markdown below" with no "markdown above" beside it.
    expect(source).not.toContain("Insert markdown");
    expect(source).not.toContain("Insert code");
    // The strip is still the thing that does both types.
    expect(source).toContain('onClick={() => onInsert("markdown")}');
  });

  test("Copy source copies the DRAFT when there is one — what is on screen, not what is on disk", () => {
    const source = nb();
    // `source` is `draft ?? cell.source`, threaded into the menu as a prop.
    expect(source).toContain("source={source}");
    expect(source).toContain("const source = draft ?? cell.source;");
  });

  test("the outputs verbs are offered only where there are outputs to act on", () => {
    // A Clear outputs on a markdown cell is refused by the engine in words;
    // offering it at all would be a menu lying about what the cell has.
    expect(nb()).toContain("{code && outputs > 0 && (");
  });

  test("the trigger wraps the cell's own content, so right-click never races the editor's selection", () => {
    const source = nb();
    expect(source).toContain("<ContextMenuTrigger>{children}</ContextMenuTrigger>");
    // The menu is a wrapper AROUND the cell, so the OverlayEditor inside keeps
    // its own native behaviour except for the one gesture taken.
    expect(source).toContain("function CellMenu({");
  });

  test("Delete is the only destructive item here, and the surface says why in prose", () => {
    const destructive = code("session/notebook-surface.tsx").match(/<ContextMenuItem variant="destructive"/g) ?? [];
    expect(destructive).toHaveLength(1);
    expect(flat("session/notebook-surface.tsx")).not.toContain("variant=\"destructive\" onClick={onClearOutputs}");
  });
});

/**
 * THE TABLE. Two DIFFERENT menus on one surface — a header's and a cell's —
 * and the earlier rounds' point about a container and the thing inside it:
 * they are genuinely different objects, not one list reused twice.
 */
describe("the table's column header and its cells", () => {
  const tbl = () => code("session/table-surface.tsx");

  test("the header's three sort choices are a RADIO group, because the state is one-of-three", () => {
    const source = tbl();
    expect(source).toContain("<ContextMenuRadioGroup");
    expect(source).toContain('<ContextMenuRadioItem value="asc" closeOnClick>');
    expect(source).toContain('<ContextMenuRadioItem value="desc" closeOnClick>');
    expect(source).toContain('<ContextMenuRadioItem value="none" closeOnClick>');
    expect(flat("session/table-surface.tsx")).toContain("Sort ascending");
    expect(flat("session/table-surface.tsx")).toContain("Sort descending");
    expect(flat("session/table-surface.tsx")).toContain("Clear sort");
  });

  test("picking a direction calls the SAME setSort the header's own click cycles through", () => {
    const source = tbl();
    // One sort write path: the menu is handed `setSort` itself.
    expect(source).toContain("onSort={setSort}");
    expect(source).toContain('onValueChange={(next: string) => onSort(next === "none" ? undefined : { column, desc: next === "desc" })}');
    // And the header's own onClick is untouched — still the cycle it was.
    expect(source).toContain("onClick={() => setSort(sorted && !sort.desc ? { column, desc: true } : sorted ? undefined : { column, desc: false })}");
  });

  test("the header's current direction is what the group shows — the menu cannot tick two", () => {
    expect(tbl()).toContain('sort={sorted ? (sort.desc ? "desc" : "asc") : "none"}');
  });

  test("the cell's menu is ONE item the header's does not carry, and the header's four are not on the cell", () => {
    const source = tbl();
    expect(source).toContain("<ContextMenuItem onClick={() => void navigator.clipboard.writeText(value)}>Copy value</ContextMenuItem>");
    expect(source).toContain("<ContextMenuItem onClick={() => void navigator.clipboard.writeText(column)}>Copy column name</ContextMenuItem>");
    // The cell menu's whole body: no sort, no column name.
    const cellMenu = source.slice(source.indexOf("function CellMenu("), source.indexOf("export function TableSurface"));
    expect(cellMenu).not.toContain("Sort ascending");
    expect(cellMenu).not.toContain("Copy column name");
  });

  test("Copy value copies the WHOLE string, not the clipped text on screen", () => {
    // The cell is `max-w-96 truncate`, so what is visible is routinely not what
    // is there — which is most of why the verb exists.
    expect(tbl()).toContain('<CellMenu value={cell === null ? "null" : String(cell)}>');
  });

  test("both triggers render INLINE, so the cell's own truncation still ends in an ellipsis", () => {
    // A block child inside `truncate` clips with no ellipsis at all.
    expect(tbl().match(/<ContextMenuTrigger render=\{<span \/>\}>/g)).toHaveLength(2);
  });
});

/**
 * THE DIFF ROW. Its menu is mostly the row's own gestures said out loud — the
 * disclosure it already toggles, the reference its own drag already carries —
 * plus one route it did not have, into the Editor.
 *
 * AND ITS OMISSIONS ARE THE POINT. Stage, unstage and revert are a REFUSED
 * design (`apps/engine/src/git.ts`, and this surface's own header at length),
 * and a context menu is exactly where they creep back in as "just three more
 * rows". These cases pin the absence.
 */
describe("the diff surface's file row", () => {
  const dif = () => code("session/diff-surface.tsx");

  test("Open in Editor goes through the panel's ONE route, derived from onOpenTab like LatexSurface's", () => {
    expect(dif()).toContain("<ContextMenuItem onClick={() => onOpenFile(file.path)}>Open in Editor</ContextMenuItem>");
    const panel = code("right-panel.tsx");
    // The same expression LatexSurface is handed, on the same line shape.
    expect(panel).toContain("onOpenFile={(path) => onOpenTab(panelTabForPath(path, dataScience === true))}");
    expect((panel.match(/onOpenFile=\{\(path\) => onOpenTab\(panelTabForPath\(path, dataScience === true\)\)\}/g) ?? []).length).toBe(2);
  });

  test("Insert as reference inserts the SAME string the row's own drag carries", () => {
    const source = dif();
    expect(source).toContain("onClick={() => onInsertReference(fileReference(file.path).text)}");
    // `fileReference` is the one the drag uses, in this same file.
    expect(source).toContain("startReferenceDrag(event.dataTransfer, fileReference(file.path))");
  });

  test("Expand / Collapse patch toggles the SAME `open` the row's disclosure button toggles", () => {
    const source = dif();
    expect(source).toContain('<ContextMenuItem onClick={() => setOpen((current) => !current)}>{open ? "Collapse patch" : "Expand patch"}</ContextMenuItem>');
    expect(source).toContain("onClick={() => setOpen((current) => !current)}\n          title=");
  });

  test("stage, unstage and revert are absent — a refused design, and a menu is where it would creep back", () => {
    const source = dif();
    for (const verb of ["Stage", "Unstage", "Revert", "Discard", "Checkout"]) {
      expect(source, `the diff row's menu does not offer ${verb}`).not.toMatch(new RegExp(`<ContextMenuItem[^>]*>\\s*${verb}`));
    }
    // Named rather than silently dropped, in the prose beside the trigger.
    expect(read("session/diff-surface.tsx")).toContain("STAGE, UNSTAGE AND REVERT ARE NOT HERE");
  });

  test("both row lists get the SAME menu, so the two halves of the review cannot drift", () => {
    const source = dif();
    expect((source.match(/\{\.\.\.rowMenu\}/g) ?? []).length).toBe(2);
    expect(source).toContain(
      "const rowMenu = { ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenInNewPanelTab ? { onOpenInNewPanelTab } : {}), ...(onInsertReference ? { onInsertReference } : {}) };",
    );
  });

  test("Open in a new panel tab opens a SECOND DIFF filtered to the row, through the chooser's own verb (#335)", () => {
    // The row hands up a path and nothing else; the panel is what decides that
    // a new panel tab from this surface is another Diff rather than an Editor,
    // and it does it with `onOpenNewTab` — the same call the "+" chooser makes.
    expect(dif()).toContain("<ContextMenuItem onClick={() => onOpenInNewPanelTab(file.path)}>Open in a new panel tab</ContextMenuItem>");
    const panel = code("right-panel.tsx");
    expect(panel).toContain('onOpenInNewPanelTab: (path: string) => onOpenNewTab("diff", { filter: path })');
  });

  test("the header's filter field writes to the TAB's params, not to state of its own", () => {
    // A filter held locally would be invisible to the strip's label and lost on
    // every remount — see this surface's header and #335.
    const source = dif();
    expect(source).toContain("onChange={(event) => onFilterChange(event.target.value)}");
    expect(source).not.toMatch(/useState[^\n]*filter/i);
    // Clearing the field clears the param rather than storing a blank.
    expect(source).toContain('onClick={() => onFilterChange("")}');
    expect(code("right-panel.tsx")).toContain("onFilterChange: (filter: string) => onTabParams(filter.trim() ? { filter } : {})");
  });

  test("the composer thread is the cockpit's, and it inserts TEXT rather than resolving anything", () => {
    const cockpit = code("session-cockpit.tsx");
    expect(cockpit).toContain("const insertIntoComposer = useCallback((text: string) => {");
    expect(cockpit).toContain("onInsertReference={insertIntoComposer}");
    // Spacing is drag-reference's own, so a menu insert and a drop read alike.
    expect(cockpit).toContain("insertReference(current, text, current.length).draft");
    // A multi-line insert (a quoted message) is its own paragraph.
    expect(cockpit).toContain('text.includes("\\n") ? `${current.replace(/\\s+$/, "")}\\n\\n${text}`');
  });
});

/**
 * THE TRANSCRIPT. Two menus: one on a MESSAGE (what was said) and one on a
 * TOOL ROW (what was done). Neither offers a verb, because a transcript is a
 * record — a menu that could re-run a command or undo an edit would be
 * offering to change what happened.
 */
describe("the transcript's message and tool rows", () => {
  const tr = () => code("transcript.tsx");
  const msg = () => code("ui/message.tsx");

  test("the message menu is ONE definition in ui/message.tsx, composed by the transcript and the cockpit", () => {
    expect(msg()).toContain("export function MessageMenu({");
    expect(tr()).toContain("<MessageMenu");
    expect(code("session-cockpit.tsx")).toContain("<MessageMenu text={turn.prompt} markdown={false}");
    // No second spelling of it anywhere.
    for (const name of ["transcript.tsx", "session-cockpit.tsx"]) {
      expect(code(name), `${name} imports MessageMenu rather than defining one`).not.toContain("function MessageMenu(");
    }
  });

  test("Copy text and Copy as Markdown are two DIFFERENT strings, and the second is hidden where it would be the same one", () => {
    const source = msg();
    expect(source).toContain("onClick={() => void navigator.clipboard.writeText(markdown ? messagePlainText(body) : body)}>Copy text");
    expect(source).toContain("{markdown && <ContextMenuItem onClick={() => void navigator.clipboard.writeText(body)}>Copy as Markdown");
    // A person's message is a plain draft, so it gets one copy item, not two.
    expect(tr()).toContain("<MessageMenu text={itemText(item)} markdown={false}");
    expect(code("session-cockpit.tsx")).toContain("markdown={false}");
  });

  test("the plain-text pass keeps a fenced block's contents verbatim", () => {
    // A code block is the part of an answer people most want on the clipboard;
    // unwrapping emphasis inside one would corrupt it.
    expect(msg()).toContain("if (fenced) return line;");
    expect(msg()).toContain("fenced = !fenced;");
  });

  test("Quote into composer prefixes every line, and lands through the cockpit's own insert", () => {
    expect(msg()).toContain("export function quoteForComposer(text: string): string {");
    expect(msg()).toContain('.map((line) => `> ${line}`)');
    expect(msg()).toContain("<ContextMenuItem onClick={() => onQuote(quoteForComposer(body))}>Quote into composer</ContextMenuItem>");
    expect(tr()).toContain("{...(onInsert ? { onQuote: onInsert } : {})}");
    expect(code("session-cockpit.tsx")).toContain("onInsert={insertIntoComposer}");
  });

  test("a message still being streamed carries NO menu — half a sentence is not what the reader asked for", () => {
    expect(tr()).toContain("if (running(item)) return <MessageResponse streaming>{text}</MessageResponse>;");
  });

  test("the tool row's menu is about what the ROW is about — a command's command, a file's path", () => {
    const source = tr();
    expect(source).toContain("onClick={() => void navigator.clipboard.writeText(command)}>Copy command");
    expect(source).toContain('{change?.unifiedDiff ? "Copy patch" : "Copy output"}');
    expect(source).toContain("{path && onOpenFile && <ContextMenuItem onClick={() => onOpenFile(path)}>Open file in the Editor</ContextMenuItem>}");
    expect(source).toContain("onClick={() => void navigator.clipboard.writeText(path)}>Copy path");
    expect(source).toContain("onClick={() => onInsert(fileReference(path).text)}>Insert as reference");
    // The path comes from the row's own detail, for the two kinds that have one.
    expect(source).toContain('if (item.detail.type === "file_change") return item.detail.change.path;');
    expect(source).toContain('if (item.detail.type === "file_read") return item.detail.read.path;');
  });

  test("a row with nothing to offer gets no menu rather than an empty popup", () => {
    expect(tr()).toContain("const hasMenu = Boolean(command || body || path);");
    expect(tr()).toContain("if (!hasMenu) return row;");
  });

  test("RETRY FROM HERE is absent, and the file says why rather than leaving it to be re-proposed", () => {
    const source = tr();
    expect(source).not.toMatch(/<ContextMenuItem[^>]*>\s*Retry/);
    expect(source).not.toMatch(/<ContextMenuItem[^>]*>\s*Re-?run/);
    expect(read("transcript.tsx")).toContain('"Retry from here" is the item this list is missing on');
  });

  test("Open in the Agents panel rides the row that ALREADY offers it, firing the same onOpen", () => {
    const source = tr();
    expect(source).toContain("<ContextMenuItem onClick={() => onOpen(taskId)}>Open in the Agents panel</ContextMenuItem>");
    // The same `onOpen` and the same guard the visible `Open ▸` button uses.
    expect(source).toContain("{onOpen && taskId && (");
    // And no other surface in this round carries it.
    for (const name of SURFACES.filter((each) => each !== "transcript.tsx")) {
      expect(code(name), `${name} does not also carry the agent row's own verb`).not.toContain("Open in the Agents panel");
    }
  });

  test("Open file in the Editor goes through the cockpit's ONE door, showPanelTab with a file-shaped id", () => {
    expect(code("session-cockpit.tsx")).toContain("onOpenFile={(path) => showPanelTab(`file:${path}`)}");
  });

  test("every row in a turn gets the SAME gestures, so a live turn and a settled one cannot disagree", () => {
    const cockpit = code("session-cockpit.tsx");
    expect(cockpit).toContain("const rowGestures = {");
    // Nothing renders a transcript row with a hand-built subset any more.
    const body = cockpit.slice(cockpit.indexOf("function SessionTurnBody("), cockpit.indexOf("const [draftDriver"));
    expect(body).not.toContain("{...(onOpenAgent ? { onOpenAgent } : {})}");
    expect((body.match(/\{\.\.\.rowGestures\}/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

/**
 * THE COMPOSER'S CHROME — the WHOLE card (#320), and the one gesture inside it
 * that still belongs to the box you type in.
 *
 * It wrapped only the left control cluster, so a right-press on the box, on the
 * chrome beside the `+`, or on the send side answered with nothing: a menu on
 * about a fifth of the object it belongs to. The trigger is now the card, and
 * the box keeps the press that is genuinely the editor's — one over TEXT THAT
 * IS SELECTED, where cut, copy and Look Up live. With nothing selected there is
 * no editing verb to protect and the card's own menu answers.
 */
describe("the composer's chrome, and the selection it leaves alone", () => {
  const cmp = () => code("composer.tsx");

  test("the trigger is the whole card — it wraps the InputGroup itself", () => {
    // Nothing between the menu and the card: a wrapper in between would be a
    // second box to keep in sync with the card's own bounds.
    expect(flat("composer.tsx")).toContain('<ComposerChromeMenu draft={draft} attachments={attachments} stashing={stashing} onClear={() => onDraftChange("")} onStash={() => void doStash()} > <InputGroup');
  });

  test("and it is a REAL box — `contents` paints nothing and is never an event target", () => {
    // The lesson from #286, which is the exact bug this fix would otherwise
    // reintroduce: a trigger with no box has no hit area.
    const trigger = cmp().slice(cmp().indexOf("<ContextMenuTrigger"), cmp().indexOf("<ContextMenuContent"));
    expect(trigger).not.toContain("contents");
  });

  test("the chips keep their own menus, and the left cluster keeps its box without being one", () => {
    const source = cmp();
    expect(source).toContain("<AttachmentChip file={file} onRemove={() => onAttach(attachments.filter((_, at) => at !== index))} />");
    expect(source).toContain("onRemoveAttachment={() => onAttach(attachments.filter((_, at) => at !== index))}");
    // Still a box for its `min-w-0`, no longer a trigger.
    expect(source).toContain('<div className="flex min-w-0 flex-wrap items-center gap-1">');
  });

  test("a selection in the box keeps the editor's own menu, and BOTH stops are what keep it", () => {
    const source = cmp();
    expect(source).toContain("if (!selection || selection.isCollapsed || !anchor || !event.currentTarget.contains(anchor)) return;");
    // The React stop keeps the card's trigger shut. The native IMMEDIATE stop
    // is the one that matters for the browser's own menu: Base UI's trigger
    // also listens on the DOCUMENT and `preventDefault`s every `contextmenu`
    // inside itself, which a React-only stop never reaches.
    expect(source).toContain("event.stopPropagation();");
    expect(source).toContain("event.nativeEvent.stopImmediatePropagation();");
  });

  test("the rule is written down where the next person would undo it", () => {
    const source = read("composer.tsx");
    expect(source).toContain("THE COMPOSER'S CHROME ANSWERS A RIGHT-CLICK; THE BOX YOU TYPE IN DOES NOT");
    expect(source).toContain("THE TRIGGER IS THE WHOLE CARD, AND IT IS A REAL BOX");
  });

  test("Clear draft and Stash draft fire what the box and the ⌘S chord already fire", () => {
    const source = cmp();
    expect(source).toContain('onClear={() => onDraftChange("")}');
    expect(source).toContain("onStash={() => void doStash()}");
    // `doStash` is the SAME callback ⌘S calls — one stash path, not two.
    expect(source).toContain("if (draft.trim() || attachments.some((file) => file.type.startsWith(\"image/\"))) void doStash();");
  });

  test("stashable is ONE rule, so the key and the menu cannot disagree about what can be stashed", () => {
    expect(cmp()).toContain('const stashable = Boolean(draft.trim() || attachments.some((file) => file.type.startsWith("image/")));');
  });

  test("rows that would do nothing are DISABLED, not hidden — the menu keeps its shape as you type", () => {
    const source = cmp();
    expect(source).toContain("<ContextMenuItem disabled={!draft} onClick={onClear}>");
    expect(source).toContain("<ContextMenuItem disabled={stashing || !stashable} onClick={onStash}>");
  });

  test("Remove attachment appears only on a chip, which is the only place it means anything", () => {
    expect(cmp()).toContain("{onRemoveAttachment && (");
    expect(flat("composer.tsx")).toContain("<ContextMenuItem onClick={onRemoveAttachment}> <XIcon /> Remove attachment </ContextMenuItem>");
  });

  test("every row wears the glyph of the control it fires — the sidebar's menus and this one are one system", () => {
    // #286 gave the sidebar's menus icons; a menu beside them with none reads
    // as somebody else's. Each glyph is the one on the visible control: the
    // chip's own ×, and the stash badge's layers.
    const flattened = flat("composer.tsx");
    expect(flattened).toContain("<EraserIcon /> Clear draft");
    expect(flattened).toContain("<LayersIcon /> Stash draft");
    expect(flattened).toContain("<XIcon /> Remove attachment");
  });
});

/**
 * THE BROWSER TAB. It reads like every browser's strip because it IS that
 * object — and two of its six items need the shell, because a renderer can
 * neither mint a native tab nor reach the operating system.
 */
describe("the integrated browser's tab strip", () => {
  const br = () => code("browser-live.tsx");

  test("every item names THIS tab by index, so a right-click never drags your view to it", () => {
    const source = br();
    expect(source).toContain('onClick={() => void onAct({ action: "reload", index: tab.index })}>Reload');
    expect(source).toContain('onClick={() => void onAct({ action: "duplicate", index: tab.index })}>Duplicate');
    expect(source).toContain('onClick={() => void onAct({ action: "close", index: tab.index })}>Close');
    // The shell's reload learned an index for exactly this.
    expect(codeOf("../../desktop/browser-manager.js")).toContain(
      "const tab = await this.wakeTab(action.index === undefined ? this.activeTab(scope) : this.tabAt(scope, action.index));",
    );
  });

  test("Close others walks DOWN, because closing a tab renumbers the ones above it", () => {
    expect(br()).toContain("for (const other of [...tabs].sort((a, b) => b.index - a.index)) {");
    expect(br()).toContain('if (other.id !== tab.id) await onAct({ action: "close", index: other.index });');
    expect(br()).toContain("disabled={tabs.length < 2}");
  });

  test("Open in system browser hides on a shell that has no such door, and greys on a page it could not take", () => {
    const source = br();
    expect(source).toContain("{onOpenExternal && (");
    expect(source).toContain("<ContextMenuItem disabled={!web} onClick={() => void onOpenExternal(tab.url)}>");
    expect(source).toContain("const web = /^https?:\\/\\//i.test(tab.url);");
    // The renderer never decides what may leave: the main process re-checks.
    expect(source).not.toContain("shell.openExternal");
  });

  test("the DRAG stays outside the trigger, so a right-click cannot be confused with one", () => {
    const source = br();
    // The board card's rule: draggable on the wrapper, the trigger is the tab.
    const strip = source.slice(source.indexOf('aria-label="Browser tabs"'), source.indexOf("address row"));
    expect(strip.indexOf("draggable")).toBeLessThan(strip.indexOf("<TabMenu"));
    expect(source).toContain("<ContextMenuTrigger {...(className ? { className } : {})}>{children}</ContextMenuTrigger>");
  });

  test("Copy URL copies the tab's url and nothing reaches for the page", () => {
    expect(br()).toContain("onClick={() => void navigator.clipboard.writeText(tab.url)}>Copy URL");
  });
});
