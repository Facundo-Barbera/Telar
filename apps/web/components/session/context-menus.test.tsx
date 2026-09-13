/**
 * THE RAIL'S RIGHT-CLICK MENUS — issue #273, and the Spool's idiom (see
 * `components/spool/idiom.test.ts`) applied to the sessions list.
 *
 * THREE SURFACES, ONE PRIMITIVE, AND EXACTLY ONE OF THEM SHARES ITS LIST. The
 * session row's menu and the row's `⋯` render `lib/session-action-menu.ts` —
 * that file's own test pins what the list SAYS, and the scan below pins that
 * both surfaces read it rather than spelling items of their own. The project
 * header and the rail's empty space compose their own items, because they act
 * on a project and on the list rather than on a session, and a menu that
 * offered "Delete session" over a project header would be one list stretched
 * across two nouns.
 *
 * WHY SOURCE TEXT FOR THE ITEMS. Both menus are base-ui popups: their content
 * is portaled and mounts only once opened, so a server render carries the
 * TRIGGER and none of the rows. What a render can still prove is the one
 * structural rule this issue turns on — the project header's trigger wraps the
 * label and not the drag handle — so that is what the render test at the bottom
 * asserts, and the item lists are pinned as text above it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectGroupSection } from "./project-group";
import type { ProjectGroup } from "@/lib/session-groups";

const dir = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const sidebar = () => fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
/** Comments stripped, for the reason `idiom.test.ts` gives: every absence here
 *  is documented where it happened, and a scan that read prose would fire on
 *  the explanation and teach the next person to delete it. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("one primitive, imported and never re-declared", () => {
  test("every new surface reaches for components/ui/context-menu.tsx", () => {
    const files = [read("session-action-menu.tsx"), read("project-group.tsx"), sidebar()];
    for (const source of files) {
      expect(source).toContain('from "@/components/ui/context-menu"');
      expect(code(source)).not.toMatch(/function ContextMenu\b/);
    }
  });

  test("the primitive is base-ui's dedicated ContextMenu module, not Menu wearing a name", () => {
    const primitive = fs.readFileSync(path.join(dir, "..", "ui", "context-menu.tsx"), "utf8");
    expect(primitive).toContain('import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"');
  });
});

describe("the session row: the ⋯ and the right-click are one list", () => {
  const source = code(read("session-inbox-menu.tsx"));

  test("both surfaces call the SAME hook, and that hook is the file's only caller of the definition", () => {
    // This is the invariant `lib/session-action-menu.ts` exists for, asserted
    // where it could actually be broken: a second `buildSessionActionMenuItems`
    // call in this file would be a second list, and it would drift.
    expect(source.match(/buildSessionActionMenuItems\(/g)).toHaveLength(1);
    expect(source).toContain("function useSessionRowMenu(");
    const kebab = source.slice(source.indexOf("export function SessionInboxMenu"));
    const contextMenu = source.slice(source.indexOf("export function SessionRowContextMenu"), source.indexOf("export function SessionInboxMenu"));
    expect(kebab).toContain("useSessionRowMenu(props)");
    expect(contextMenu).toContain("useSessionRowMenu(props)");
  });

  test("neither spells an item of its own — both hand `items` to the shared renderer", () => {
    expect(source).toContain("<SessionActionMenuItems items={items} parts={dropdownSessionMenuParts} />");
    expect(source).toContain("<SessionActionContextMenu items={items}>{children}</SessionActionContextMenu>");
    // No literal menu row anywhere in this file: the labels live in the
    // definition, which is what makes them checkable in one place.
    expect(source).not.toContain("<DropdownMenuItem");
    expect(source).not.toContain("<ContextMenuItem");
  });

  test("the row wires both from ONE props object, so the two cannot disagree about the row's state", () => {
    const row = code(read("session-row.tsx"));
    expect(row).toContain("const menuProps: SessionRowMenuProps = {");
    expect(row).toContain("<SessionInboxMenu {...menuProps} />");
    expect(row).toContain("<SessionRowContextMenu {...menuProps}>{row}</SessionRowContextMenu>");
  });
});

describe("the project header composes its own list", () => {
  const source = code(read("project-group.tsx"));

  test("the seven verbs, in the order the issue names them", () => {
    expect(source).toContain("New conversation here");
    expect(source).toContain("Project settings");
    expect(source).toContain("Reveal in Finder");
    expect(source).toContain('{open ? "Collapse" : "Expand"}');
    expect(source).toContain("Collapse others");
    expect(source).toContain("Move up");
    expect(source).toContain("Move down");
    // The order on screen is the order in the file — `ContextMenuItem` is a
    // flat list, so the source position IS the row position.
    const at = (needle: string) => source.indexOf(needle);
    expect(at("New conversation here")).toBeLessThan(at("Project settings"));
    expect(at("Project settings")).toBeLessThan(at("Reveal in Finder"));
    expect(at("Reveal in Finder")).toBeLessThan(at('{open ? "Collapse" : "Expand"}'));
    expect(at('{open ? "Collapse" : "Expand"}')).toBeLessThan(at("Collapse others"));
    expect(at("Collapse others")).toBeLessThan(at("Move up"));
    expect(at("Move up")).toBeLessThan(at("Move down"));
  });

  test("every row fires a callback the header was already given — no fetch, no router, no second write path", () => {
    const menu = source.slice(source.indexOf("<ContextMenuContent"), source.indexOf("</ContextMenuContent>"));
    expect(menu).not.toMatch(/fetch\(|router\.|api\./);
    for (const handler of ["onNewConversation", "onProjectSettings", "onToggle", "onCollapseOthers", "onMoveUp", "onMoveDown"]) {
      expect(menu, `${handler} is called by the menu`).toContain(handler);
    }
    // The fold row is literally the chevron's own `onToggle`, and the reorder
    // rows are the drag's own write — see `moveProjectGroupStep`.
    expect(menu).toContain("<ContextMenuItem onClick={onToggle}>");
  });

  test("Reveal and Open reuse the existing directory bridge, and are ABSENT without it", () => {
    // No new capability: the same `workspace.reveal`/`workspace.open` the
    // cockpit's Open button calls, gated by the same blocker.
    expect(source).toContain('from "@/lib/workspace-open"');
    expect(source).toContain("workspaceOpenBlocker({");
    expect(source).toContain("bridge.reveal(root)");
    expect(source).toContain("bridge.open(root, entry.openerId)");
    // Hidden rather than disabled, together.
    expect(source).toContain("{folder.available && (");
    // The remembered opener, not a second preference store.
    expect(source).toContain('from "@/lib/workspace-opener-preference"');
    // Keyed by the MAC whose folder is being opened — `place`, not the group,
    // since a group can now span two of them (#283).
    expect(source).toContain("writePreferredOpener(place.hostId, entry.id)");
  });

  test("only this surface carries the header's own verbs — the session menu never grows them", () => {
    // The Spool's distinguishing-item rule: a verb that identifies a surface
    // must not appear in another's list.
    const definition = fs.readFileSync(path.join(dir, "..", "..", "lib", "session-action-menu.ts"), "utf8");
    for (const verb of ["Collapse others", "Move up", "Move down", "Reveal in Finder"]) {
      expect(code(definition), `the session definition does not carry "${verb}"`).not.toContain(verb);
    }
    // And the header never grows the session's destructive one.
    expect(source).not.toContain("Delete session");
  });
});

describe("the rail's empty space composes a third list", () => {
  const source = code(sidebar());
  const menu = source.slice(source.lastIndexOf("<ContextMenuTrigger"), source.lastIndexOf("</ContextMenu>"));

  test("four rows: start something, register something, and the fold-all pair", () => {
    expect(menu).toContain("New conversation");
    expect(menu).toContain("New project");
    expect(menu).toContain("Collapse all projects");
    expect(menu).toContain("Expand all");
  });

  test("each one is the control it duplicates, not a second implementation of it", () => {
    // The New button's own `startSession` and its own project guess.
    expect(menu).toContain("onClick={() => startSession()}");
    expect(menu).toContain("disabled={!composerTarget}");
    // The `+`'s own dialog, opened by lifting its `open` — so `chooseDirectory`
    // is still called from exactly one place in the app.
    expect(menu).toContain("onClick={() => setRegisteringProject(true)}");
    expect(source).toContain("open={registeringProject}");
    expect(source).not.toContain("chooseDirectory");
    // The fold verbs act on the groups AS DRAWN, which is the rule
    // `foldedAfter` states and `session-groups.test.ts` pins.
    expect(menu).toContain("onClick={() => collapseAll(drawnGroupKeys)}");
    expect(menu).toContain("onClick={() => expandAll(drawnGroupKeys)}");
    expect(menu).toContain("disabled={drawnGroupKeys.length === 0}");
  });

  test("it wraps the scroll area and relies on the inner triggers to claim their own rows", () => {
    // Base UI's trigger stops the `contextmenu` it handles, so a row's menu
    // wins over this one.
    expect(menu).toContain('<SidebarGroupContent id="sidebar-session-results"');
  });

  test("the trigger FILLS the group — a `contents` box would miss the empty space entirely", () => {
    // The rows reach only as far as the last group; the space below them is
    // this group's own box. A `display: contents` trigger paints nothing, is
    // never an event target, and so covered exactly the strip that already had
    // menus of its own and none of the strip that had none.
    expect(source).toContain('<ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>');
    expect(source).not.toContain('<ContextMenuTrigger render={<div className="contents" />}>');
  });
});

/**
 * The one structural claim a server render CAN make, and the one this issue
 * turns on. The header button is `draggable` — it is the drag handle — so the
 * trigger has to live INSIDE it, around the label, rather than being the button
 * or wrapping it. Base UI's trigger renders an element of its own; one carrying
 * `draggable` would put a right-press and a grab on the same node.
 */
describe("the project header menu, rendered", () => {
  const group = (over: Partial<ProjectGroup> = {}): ProjectGroup => ({
    key: "p1",
    projectId: "p1",
    name: "Telar",
    sessions: [],
    ...over,
  });

  const render = (over: Partial<ProjectGroup> = {}) =>
    renderToStaticMarkup(
      <ProjectGroupSection
        group={group(over)}
        open={false}
        onToggle={() => {}}
        onNavigate={() => {}}
        renderedAt={0}
        bandFor={() => "active"}
        autoSettleAfterHours={null}
        onRefresh={() => {}}
        dragging={false}
        insert={null}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        rowDrag={() => ({
          dragging: false,
          insert: null,
          onDragStart: () => {},
          onDragEnd: () => {},
          onDragOver: () => {},
          onDragLeave: () => {},
          onDrop: () => {},
        })}
        root="/Users/someone/code/telar"
        onNewConversation={() => {}}
        onProjectSettings={() => {}}
        onCollapseOthers={() => {}}
      />,
    );

  test("the trigger is inside the draggable button, and is not itself draggable", () => {
    const html = render();
    const handle = html.indexOf("draggable");
    const trigger = html.indexOf('data-slot="context-menu-trigger"');
    expect(handle).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(handle);
    // The trigger element carries no drag attributes of its own.
    const tag = html.slice(trigger - 200, trigger + 200);
    expect(tag.slice(tag.indexOf('data-slot="context-menu-trigger"'))).not.toContain("draggable");
    // And it closes before the button does, i.e. it wraps the label rather
    // than the row.
    expect(html.indexOf("</button>")).toBeGreaterThan(trigger);
  });

  test("the trigger PAINTS the row — a `contents` box would have no hit area of its own", () => {
    // The bug a screenshot caught: `display: contents` generates no box and is
    // never an event target, so a right-press in the header's padding or in a
    // gap between the chevron and the name had the <button> as its target and
    // opened the RAIL's menu instead. The trigger carries the row's layout and
    // its padding, so the header has exactly one hit area.
    const html = render();
    const tag = html.slice(html.lastIndexOf("<span", html.indexOf('data-slot="context-menu-trigger"')));
    const open = tag.slice(0, tag.indexOf(">"));
    expect(open).not.toContain("contents");
    for (const rule of ["flex", "items-center", "px-1", "py-1.5"]) {
      expect(open, `the trigger carries ${rule}`).toContain(rule);
    }
    // The padding moved OFF the button rather than being duplicated onto both.
    const button = html.slice(html.indexOf("<button"), html.indexOf(">", html.indexOf("<button")));
    expect(button).not.toContain("px-1");
  });

  test("the label is inside the trigger; the New-conversation link stays outside it", () => {
    const html = render();
    const trigger = html.indexOf('data-slot="context-menu-trigger"');
    const closeButton = html.indexOf("</button>");
    expect(html.indexOf("Telar")).toBeGreaterThan(trigger);
    expect(html.indexOf("Telar")).toBeLessThan(closeButton);
    // The `+` is a sibling of the handle, past the trigger's reach — a
    // right-click there is the browser's business, not this menu's.
    expect(html.indexOf("New conversation in Telar")).toBeGreaterThan(closeButton);
  });

  test("a paired Mac's header still renders — its host is named, and its folder rows simply are not there", () => {
    // `workspaceOpener()` is absent on the server, so the two folder rows are
    // out on every server render; this is the shape that must not throw.
    const html = render({ hostId: "host_x", hostName: "mini" });
    expect(html).toContain("mini");
    expect(html).toContain('data-slot="context-menu-trigger"');
  });
});
