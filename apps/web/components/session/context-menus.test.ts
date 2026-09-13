// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE EDITOR'S AND THE PANEL'S RIGHT-CLICK MENUS, PINNED AS SOURCE.
 *
 * The same instrument the Spool uses for the same claims
 * (`spool/idiom.test.ts`), and for the same reason: there is no DOM harness in
 * this app, and everything asserted here is structural. Four surfaces grew a
 * menu in one pass, and the ways that decays are all invisible on screen — a
 * fifth surface copying the primitive instead of importing it, an item quietly
 * growing a second write path beside the one the visible control uses, a
 * trigger creeping outwards until it wraps the draggable element and eats the
 * drag, a Reveal offered in a browser tab that can never do it.
 *
 * WHAT IS DELIBERATELY NOT HERE: whether a menu opens, and what it looks like.
 * `ContextMenuContent` portals, and a portal renders nothing on the server, so
 * that question belongs to the render test beside this file — which reaches
 * the item list the only way `renderToStaticMarkup` can.
 */
const dir = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
/** Comments stripped: every omission below is NAMED where it happened, and a
 *  scan that read prose would fire on the explanation and teach the next
 *  person to delete it. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const files = code(read("files-surface.tsx"));
const editor = code(read("editor-surface.tsx"));
const view = code(read("file-view-surface.tsx"));
const panel = code(fs.readFileSync(path.join(dir, "..", "right-panel.tsx"), "utf8"));

/** The four surfaces this pass gave a menu, by the name they are read under. */
const MENUS = { "files-surface.tsx": files, "editor-surface.tsx": editor, "file-view-surface.tsx": view, "right-panel.tsx": panel };

describe("one primitive, four surfaces", () => {
  test("every surface imports the shared context menu and none defines its own", () => {
    for (const [name, source] of Object.entries(MENUS)) {
      expect(source, `${name} imports the shared primitive`).toContain('from "@/components/ui/context-menu"');
      expect(source, `${name} does not define its own`).not.toMatch(/function ContextMenu\b/);
    }
  });

  test("the quiet idiom holds: no destructive colour on any of the new items, closes included", () => {
    // Closing a tab is ordinary, and four close verbs painted red would make
    // the strip look dangerous to tidy. The primitive keeps the variant for a
    // future caller; none of these opts in — the same line the Spool draws.
    for (const [name, source] of Object.entries(MENUS)) {
      expect(source, `${name} spends no destructive colour in a menu item`).not.toMatch(/ContextMenuItem[^>]*variant="destructive"/);
    }
  });
});

describe("the file tree's three lists", () => {
  test("a file row offers Open and Open pinned; a directory row offers Expand/Collapse and Collapse all", () => {
    expect(files).toContain("<ContextMenuItem onClick={onOpen}>Open</ContextMenuItem>");
    expect(files).toContain("<ContextMenuItem onClick={onKeep}>Open pinned</ContextMenuItem>");
    expect(files).toContain('<ContextMenuItem onClick={onToggle}>{expanded ? "Collapse" : "Expand"}</ContextMenuItem>');
    expect(files).toContain("<ContextMenuItem onClick={onCollapseAll}>Collapse all</ContextMenuItem>");
  });

  test("the two row verbs are the SAME callbacks the click and the double click fire — no second open", () => {
    // `onOpen` is the single click's preview and `onKeep` the double click's
    // pin, both handed down by the surface from one `onOpenFile`.
    expect(files).toContain('onOpen={() => onOpenFile(row.node.path, "preview")}');
    expect(files).toContain('onKeep={() => onOpenFile(row.node.path, "pin")}');
    expect(files.match(/onOpenFile\(/g)).toHaveLength(3); // preview, pin, and the keyboard's Enter
  });

  test("the header and the empty space offer Refresh and Collapse all — the subheader button's own callback", () => {
    expect(files).toContain("<ContextMenuItem onClick={refresh}>Refresh</ContextMenuItem>");
    expect(files).toContain("<ContextMenuItem onClick={collapseAll}>Collapse all</ContextMenuItem>");
    // One definition of "refresh", fired by the glyph and by the menu alike.
    expect(files).toContain("onClick={refresh}\n");
    expect(files.match(/void load\(\)\.finally/g)).toHaveLength(1);
  });

  test("both paths are copyable, and the absolute one only where a checkout root is known", () => {
    expect(files).toContain("<ContextMenuItem onClick={() => void navigator.clipboard?.writeText(absolute)}>Copy path</ContextMenuItem>");
    expect(files).toContain("<ContextMenuItem onClick={() => void navigator.clipboard?.writeText(path)}>Copy relative path</ContextMenuItem>");
    expect(files).toMatch(/\{absolute && <ContextMenuItem/);
  });

  test("the composer item carries the SAME payload the row's drag does, and is absent without a callback", () => {
    expect(files).toContain("onClick={() => onInsertReference(directory ? directoryReference(path) : fileReference(path))}");
    expect(files).toContain("{onInsertReference && (");
    // The drag builds the identical pair one element up.
    expect(files).toContain("directory ? directoryReference(row.node.path) : fileReference(row.node.path)");
  });
});

describe("the strip's four close verbs, and the one close path", () => {
  test("Close, Close others, Close to the right, Close all — each through the SAME close the × button fires", () => {
    expect(editor).toContain("<ContextMenuItem onClick={() => close(entry.path)}>Close</ContextMenuItem>");
    expect(editor).toContain("<ContextMenuItem onClick={() => closeMany(otherEditorPaths(state, entry.path))}>Close others</ContextMenuItem>");
    expect(editor).toContain("<ContextMenuItem onClick={() => closeMany(editorPathsAfter(state, entry.path))}>Close to the right</ContextMenuItem>");
    expect(editor).toContain("<ContextMenuItem onClick={() => closeMany(editorPaths(state))}>Close all</ContextMenuItem>");
    expect(editor).toContain("const closeMany = useCallback((paths: readonly string[]) => paths.forEach((path) => close(path)), [close]);");
  });

  test("a sweep cannot skip the refused-save confirm, because there is only one place that closes a file", () => {
    // `forget` is the only caller of `closeEditorFile`, and `close` is the only
    // caller of `forget` that a menu can reach. A reducer per verb would be a
    // second route past the confirm — which is why lib/editor-workspace.ts only
    // NAMES the paths a sweep is about.
    expect(editor.match(/closeEditorFile\(/g)).toHaveLength(1);
    expect(editor).not.toMatch(/closeOtherEditorFiles|closeAllEditorFiles|closeEditorFilesToTheRight/);
  });

  test("Pin is the double click's own reducer, and only offered where it would do something", () => {
    expect(editor).toContain("{!entry.pinned && (");
    expect(editor).toContain("<ContextMenuItem onClick={() => onState((current) => pinEditorFile(current, entry.path))}>Pin</ContextMenuItem>");
  });

  test("Reveal in file tree opens the tree and asks it, through state each side already owns", () => {
    expect(editor).toContain("<ContextMenuItem onClick={() => revealInTree(entry.path)}>Reveal in file tree</ContextMenuItem>");
    expect(editor).toContain("onState((current) => setExplorerOpen(current, true));");
    expect(editor).toContain("setReveal((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));");
    // And the tree answers it by expanding the ancestors and scrolling — no
    // imperative handle, no second source of truth for what is open.
    expect(files).toContain("setOpened((current) => new Set([...current, ...ancestorsOf([revealPath])]));");
    expect(files).toContain('rowsRef.current.get(path)?.scrollIntoView({ block: "nearest" });');
  });

  test("the strip offers Copy path and Reveal in Finder, and neither Copy relative path nor Open in <app>", () => {
    // A tab is a way back to a file, not a place to work on its path: the two
    // it carries are the two a strip is asked for. The full list lives one pane
    // over, on the file itself.
    const menu = editor.slice(editor.indexOf("<ContextMenuContent>"), editor.indexOf("</ContextMenuContent>"));
    expect(menu).toContain("Copy path");
    expect(menu).toContain("Reveal in Finder");
    expect(menu).not.toContain("Copy relative path");
    expect(menu).not.toContain("files.open");
  });
});

describe("the file body and its address row are one surface with one list", () => {
  test("the list is written once and hung on both places it belongs", () => {
    expect(view).toContain("function FileMenuItems({");
    expect(view.match(/<ContextMenuContent>\{menu\}<\/ContextMenuContent>/g)).toHaveLength(2);
    expect(view.match(/function FileMenuItems\(/g)).toHaveLength(1);
  });

  test("it carries both paths, both shell verbs, the re-read, and the reference", () => {
    expect(view).toContain("<ContextMenuItem onClick={() => void navigator.clipboard?.writeText(absolute)}>Copy path</ContextMenuItem>");
    expect(view).toContain("<ContextMenuItem onClick={() => void navigator.clipboard?.writeText(path)}>Copy relative path</ContextMenuItem>");
    expect(view).toContain('<ContextMenuItem onClick={() => files.reveal!(path, "file")}>Reveal in Finder</ContextMenuItem>');
    expect(view).toContain("<ContextMenuItem onClick={onReread}>Re-read from disk</ContextMenuItem>");
    expect(view).toContain("<ContextMenuItem onClick={() => onInsertReference(fileReference(path))}>Insert into composer as a reference</ContextMenuItem>");
  });

  test("the two view controls take the shapes a menu has for them, writing through the SAME calls the header does", () => {
    expect(view).toContain("<ContextMenuCheckboxItem checked={wrap.on} onCheckedChange={onWrap}>");
    expect(view).toContain('<ContextMenuRadioGroup value={source ? "source" : "rendered"} onValueChange={(value) => onSource(value === "source")}>');
    expect(view).toContain('<ContextMenuRadioItem value="rendered">Rendered</ContextMenuRadioItem>');
    expect(view).toContain('<ContextMenuRadioItem value="source">Source</ContextMenuRadioItem>');
    // One writer for the wrap preference, one setter for the markdown view.
    expect(view).toContain("onWrap={(on) => writeWrapLines(on)}");
    expect(view).toContain("onSource={setSource}");
    expect(view.match(/writeWrapLines\(/g)).toHaveLength(2); // the toolbar toggle and the menu
  });

  test("the re-read is one callback, fired by the glyph and the item alike", () => {
    expect(view).toContain("const reread = useCallback(() => {");
    expect(view).toContain("onClick={reread}");
    expect(view).toContain("onReread={reread}");
  });

  test("THE TEXTAREA KEEPS THE BROWSER'S OWN EDIT MENU", () => {
    // The one hard rule of this pass: a menu must not be taken from a text box
    // to be given to the surface around it.
    const textarea = view.slice(view.indexOf("<textarea"), view.indexOf("</div>", view.indexOf("<textarea")));
    expect(textarea).toContain("onContextMenu={(event) => event.stopPropagation()}");
    expect(textarea).not.toContain("ContextMenuTrigger");
    // And the same courtesy for the tree's search field.
    expect(files).toContain("onContextMenu={(event) => event.stopPropagation()}");
  });
});

describe("the right panel's tab strip", () => {
  test("Close, Close others, Close all and the fullscreen toggle — all on callbacks the strip already has", () => {
    expect(panel).toContain("<ContextMenuItem onClick={() => onCloseTab(id)}>Close</ContextMenuItem>");
    // Addressed by INSTANCE id, not by kind: with two Editors open, sweeping
    // by kind would close the one you asked to keep (#322).
    expect(panel).toContain("tabs.filter((other) => other.id !== id).forEach((other) => onCloseTab(other.id))");
    expect(panel).toContain("<ContextMenuItem onClick={() => tabs.forEach((other) => onCloseTab(other.id))}>Close all</ContextMenuItem>");
    expect(panel).toContain("<ContextMenuItem onClick={() => setFullscreen((current) => !current)}>");
    expect(panel).toContain('{fullscreen ? "Exit fullscreen" : "Fill the window"}');
  });

  test("no menu item anywhere reaches past its surface's own callbacks to fetch, PATCH or POST", () => {
    for (const [name, source] of Object.entries(MENUS)) {
      const items = source.match(/<ContextMenuItem[^>]*onClick=\{[^}]*\}/g) ?? [];
      expect(items.length, `${name} carries menu items`).toBeGreaterThan(0);
      for (const item of items) {
        expect(item, `${name}'s ${item} avoids a second write path`).not.toMatch(/fetch\(|POST|PATCH|api\./);
      }
    }
  });
});

describe("every trigger paints a box, and none of them is the drag handle", () => {
  test("no trigger anywhere in this pass is `display: contents`", () => {
    // THE BUG THIS PINS SHIPPED ONCE ALREADY, one round over: a `contents`
    // element generates no box and is therefore never an event target — only
    // its children are — so a right-press in a chip's own padding, or in the
    // empty space under the last row, sailed past the menu it was aimed at and
    // opened whatever sat behind. `project-group.tsx` and `app-sidebar.tsx`
    // both took the fix; these four surfaces were written the same way and
    // carry it too. Every trigger below is either the surface's own layout box
    // or a wrapper that contains one.
    for (const [name, source] of Object.entries(MENUS)) {
      expect(source, `${name} has no contents trigger`).not.toMatch(/<ContextMenuTrigger[^>]*"contents"/);
    }
  });

  test("each one is a real box, and the chips took their layout off the wrapper rather than adding to it", () => {
    // The tree: one box over all three bands, so the header and the space under
    // the last row are inside it and the rows' own triggers claim themselves.
    expect(files).toContain('<ContextMenuTrigger render={<div className="flex h-full min-h-0 flex-col" />}>');
    // The two tab chips: the wrapper kept the size and the colour, the trigger
    // took the flex row and the padding, so the chip is one hit area.
    for (const [name, source] of [
      ["editor-surface.tsx", editor],
      ["right-panel.tsx", panel],
    ] as const) {
      expect(source, `${name}'s chip trigger carries the row`).toContain(
        '<ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center px-1.5" />}>',
      );
      // …and the padding MOVED rather than being duplicated onto both.
      expect(source, `${name}'s chip wrapper gave up its padding`).not.toMatch(/group\/(file|tab) relative flex h-7[^"]*px-1\.5/);
    }
    // The file surface: one box around the shared address row, one filling the
    // rest of the column.
    expect(view).toContain('<ContextMenuTrigger render={<div className="shrink-0" />}>');
    expect(view).toContain('<ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>');
  });

  test("no trigger carries a draggable of its own, on any surface", () => {
    for (const [name, source] of Object.entries(MENUS)) {
      expect(source, `${name}'s trigger is not the drag handle`).not.toMatch(/<ContextMenuTrigger[^>]*\bdraggable\b/);
    }
  });

  test("the tree row still drags from the element ABOVE its trigger", () => {
    // board.tsx's card states the rule: hoisting the trigger onto the draggable
    // element would put a right-press and a grab on the same node.
    const drag = files.indexOf("draggable");
    expect(drag).toBeGreaterThan(-1);
    expect(drag).toBeLessThan(files.indexOf("<ContextMenu>"));
  });

  test("the address row's drag is inside the trigger now, because the row itself moved into editor-chrome.tsx", () => {
    // `EditorAddressRow` is shared by four surfaces and carries the `draggable`;
    // only this one hangs a menu, so the trigger wraps the COMPONENT. Same
    // guarantee seen from the other side: the trigger is still not the handle.
    expect(view).not.toMatch(/\bdraggable\b/);
    expect(view).toContain("<EditorAddressRow");
    expect(view.indexOf('<ContextMenuTrigger render={<div className="shrink-0" />}>')).toBeLessThan(view.indexOf("<EditorAddressRow"));
  });

  test("the panel's tab menu is CONTROLLED, so the native browser view goes down with it", () => {
    // lib/native-view-overlay.ts: the desktop shell composites a WebContentsView
    // above this DOM, and an uncontrolled menu has no state to hand the hook —
    // it would open behind the page. lib/native-view-overlay.test.ts scans for
    // this; it is restated here so the reason travels with the menu.
    expect(panel).toContain("<ContextMenu open={menuTab === id} onOpenChange={(next: boolean) => setMenuTab(next ? id : undefined)}>");
    expect(panel).toContain("useNativeViewOverlay(menuTab !== undefined);");
  });
});
