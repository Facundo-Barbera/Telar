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
const SURFACES = ["session/notebook-surface.tsx", "session/table-surface.tsx"];

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
