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
 * ASSERTED AS SOURCE TEXT, for the reason `spool/idiom.test.ts` gives: this app
 * has no DOM harness, and every claim here is structural rather than visual —
 * "there is ONE primitive", "every item fires a callback the surface already
 * wires", "no menu spells a second write path". Each is decidable by reading
 * the file, and each is a rule a future edit breaks silently.
 *
 * THE RULE THE WHOLE ROUND TURNS ON: a menu item's handler is a function the
 * same surface already gives a VISIBLE control. A right-click that reached a
 * second `fetch` would be a second way for the same verb to go wrong, and the
 * Spool's own round established that it does not happen.
 */
const dir = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
/** Source with its comments stripped — an explanation of an ABSENCE must not
 *  satisfy a scan looking for the thing it says is absent. */
const code = (name: string) => read(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** Source with its line breaks collapsed, for sentences JSX wraps arbitrarily. */
const flat = (name: string) => code(name).replace(/\s+/g, " ");

/** Every file this round puts a menu on. Grown one surface per commit, so the
 *  cross-surface rules below hold at every point in the series rather than
 *  only at the end of it. */
const SURFACES = ["transcript.tsx", "composer.tsx", "session/notebook-surface.tsx", "session/table-surface.tsx", "session/diff-surface.tsx"];

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
    expect(source).toContain('onClick={() => onInsert("above", "code")}');
    expect(source).toContain('onClick={() => onInsert("below", "code")}');
    expect(source).toContain('onClick={() => onInsert("below", "markdown")}');
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
 * which is the point the Spool's calendar case makes about a day cell and a
 * pill: they are genuinely different objects, not one list reused twice.
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
    expect(source).toContain("const rowMenu = { ...(onOpenFile ? { onOpenFile } : {}), ...(onInsertReference ? { onInsertReference } : {}) };");
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
 * THE COMPOSER'S CHROME — and, just as importantly, NOT the box you type in.
 *
 * A `<textarea>` already has a menu and it is the browser's: cut, copy, paste,
 * undo, spell-check, Look Up, Share. Replacing it with our four rows would take
 * away six useful things to add two, and take away the one menu on this screen
 * nobody had to learn.
 */
describe("the composer's chrome, and the textarea it leaves alone", () => {
  const cmp = () => code("composer.tsx");

  test("the menu is on the chips and the control strip, and the editor is untouched", () => {
    const source = cmp();
    // The chips.
    expect(source).toContain("<AttachmentChip file={file} onRemove={() => onAttach(attachments.filter((_, at) => at !== index))} />");
    expect(source).toContain("onRemoveAttachment={() => onAttach(attachments.filter((_, at) => at !== index))}");
    // The foot strip: the trigger IS the left cluster, so the addon's flex
    // layout is unchanged.
    expect(source).toContain('className="flex min-w-0 flex-wrap items-center gap-1"');
    // And nothing wraps the editor.
    expect(source).not.toMatch(/<ContextMenu[\s\S]{0,400}<ComposerEditor/);
    expect(source).not.toMatch(/<ComposerEditor[\s\S]{0,200}<\/ContextMenuTrigger>/);
  });

  test("the rule is written down where the next person would undo it", () => {
    expect(read("composer.tsx")).toContain("THE COMPOSER'S CHROME ANSWERS A RIGHT-CLICK; THE BOX YOU TYPE IN DOES NOT");
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
    expect(cmp()).toContain("<ContextMenuItem onClick={onRemoveAttachment}>Remove attachment</ContextMenuItem>");
  });
});
