// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { click, flush, installTestDom, mount, press } from "@/lib/testing/dom";
import { liveRow, mountRail, project, pushes, stubRail } from "@/lib/testing/rail";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { canvasHref } from "@/lib/session-list";
import type { ProjectGroup } from "@/lib/session-groups";
import { readPreferredOpener } from "@/lib/workspace-opener-preference";
import { ProjectGroupSection } from "./project-group";

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
const disabled = (label: string) => item(label)?.hasAttribute("data-disabled");

const shell = window as unknown as { telarDesktop?: unknown };

function installShell() {
  const asked: string[] = [];
  shell.telarDesktop = {
    workspace: {
      openers: async () => ({ openers: [{ id: "zed", label: "Zed", path: "/Applications/Zed.app" }] }),
      open: async (path: string, opener?: string) => (asked.push(`open ${path} ${opener}`), { ok: true }),
      reveal: async (path: string) => (asked.push(`reveal ${path}`), { ok: true }),
    },
  };
  return asked;
}

afterEach(() => {
  delete shell.telarDesktop;
  window.localStorage.clear();
});

const HEADER_VERBS = ["Collapse others", "Move up", "Move down", "Reveal in Finder"];

async function railWith(projects: ReturnType<typeof project>[], sessions: ReturnType<typeof liveRow>[]) {
  stubRail(() => ({ body: { projects, sessions } }));
  const host = await mountRail();
  const header = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button[id^="project-group-"]')].find((node) => node.textContent?.includes(name))!;
  const trigger = (name: string) => header(name).querySelector('[data-slot="context-menu-trigger"]')!;
  const expanded = () => [...host.querySelectorAll('button[id^="project-group-"]')].map((node) => node.getAttribute("aria-expanded"));
  const order = () => [...host.querySelectorAll('button[id^="project-group-"]')].map((node) => (node.textContent?.includes("One") ? "One" : "Two"));
  return { host, header, trigger, expanded, order };
}

function recordLayoutWrites() {
  const writes: unknown[] = [];
  const rail = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input), "http://localhost").pathname === "/api/sidebar-layout" && init?.method && init.method !== "GET") {
      writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
    }
    return rail(input, init);
  }) as typeof fetch;
  return writes;
}

const TWO = [project("p1", "One"), project("p2", "Two")];
const TWO_ROWS = [liveRow("a"), liveRow("b", { projectId: "p2" })];

describe("the session row: the ⋯ and the right-click are one list", () => {
  test("both show the same items, and none of the project header's verbs", async () => {
    const { host } = await railWith(TWO, TWO_ROWS);
    const row = [...host.querySelectorAll("a")].find((node) => node.textContent?.includes("Title a"))!;
    await rightClick(row);
    const fromRow = labels();
    expect(fromRow).toContain("Delete session");
    await escape();
    await press(row.closest("li")?.querySelector('[aria-label="Session actions"]') ?? host.querySelector('[aria-label="Session actions"]')!);
    expect(labels()).toEqual(fromRow);
    for (const verb of HEADER_VERBS) expect(fromRow).not.toContain(verb);
  });
});

describe("the project header's menu", () => {
  test("seven verbs in order, Move up disabled on the first group, and no session verbs", async () => {
    const { trigger } = await railWith(TWO, TWO_ROWS);
    await rightClick(trigger("One"));
    expect(labels()).toEqual(["New conversation here", "Project settings", "Collapse", "Collapse others", "Move up", "Move down"]);
    expect(disabled("Move up")).toBe(true);
    expect(disabled("Move down")).toBe(false);
    expect(labels()).not.toContain("Delete session");
  });

  test("New conversation here and Project settings go where the header's own controls go", async () => {
    const { trigger } = await railWith(TWO, TWO_ROWS);
    await rightClick(trigger("One"));
    await click(item("New conversation here"));
    await rightClick(trigger("Two"));
    await click(item("Project settings"));
    expect(pushes).toEqual([canvasHref("p1"), projectSettingsHref("p2")]);
  });

  test("Collapse others folds every other group and keeps this one open", async () => {
    const { trigger, expanded } = await railWith(TWO, TWO_ROWS);
    expect(expanded()).toEqual(["true", "true"]);
    await rightClick(trigger("One"));
    await click(item("Collapse others"));
    expect(expanded()).toEqual(["true", "false"]);
  });

  test("Move down writes the order the drag would", async () => {
    const { trigger } = await railWith(TWO, TWO_ROWS);
    const writes = recordLayoutWrites();
    await rightClick(trigger("One"));
    await click(item("Move down"));
    expect(writes).toEqual([{ method: "PATCH", body: { projectOrder: ["p2", "p1"] } }]);
  });
});

describe("the project header, mounted alone", () => {
  const group = (over: Partial<ProjectGroup> = {}): ProjectGroup => ({ key: "p1", projectId: "p1", name: "Telar", sessions: [], ...over });
  const mountHeader = (over: Partial<ProjectGroup> = {}, onToggle = () => {}) =>
    mount(
      <ProjectGroupSection
        group={group(over)}
        open={false}
        onToggle={onToggle}
        onNavigate={() => {}}
        renderedAt={0}
        bandFor={() => "active"}
        onRowChanged={() => {}}
        dragging={false}
        insert={null}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        rowDrag={() => ({ dragging: false, insert: null, onDragStart: () => {}, onDragEnd: () => {}, onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} })}
        root="/Users/someone/code/telar"
        onNewConversation={() => {}}
        onProjectSettings={() => {}}
        onCollapseOthers={() => {}}
      />,
    );

  test("the trigger sits inside the drag handle without being draggable itself", async () => {
    const { host } = await mountHeader();
    const trigger = host.querySelector('[data-slot="context-menu-trigger"]')!;
    expect(trigger.closest("button")?.getAttribute("draggable")).toBe("true");
    expect(trigger.hasAttribute("draggable")).toBe(false);
    expect(trigger.textContent).toContain("Telar");
  });

  test("a pick in the menu does not also fold the header it was opened from", async () => {
    let toggles = 0;
    const { host } = await mountHeader({}, () => toggles++);
    const trigger = host.querySelector('[data-slot="context-menu-trigger"]')!;
    await rightClick(trigger);
    await click(item("Project settings"));
    expect(toggles).toBe(0);
    await rightClick(trigger);
    await click(item("Expand"));
    expect(toggles).toBe(1);
    await click(trigger.closest("button")!);
    expect(toggles).toBe(2);
  });

  test("the + beside the header is outside the menu's reach", async () => {
    const { host } = await mountHeader();
    await rightClick(host.querySelector('[aria-label="New conversation in Telar"]')!);
    expect(labels()).toEqual([]);
  });

  test("Reveal and Open are absent in a browser tab and reach the desktop bridge when it is there", async () => {
    const plain = await mountHeader();
    await rightClick(plain.host.querySelector('[data-slot="context-menu-trigger"]')!);
    expect(labels()).not.toContain("Reveal in Finder");
    await escape();
    plain.unmount();

    const asked = installShell();
    const { host } = await mountHeader();
    const trigger = host.querySelector('[data-slot="context-menu-trigger"]')!;
    await rightClick(trigger);
    await flush(() => Boolean(item("Open in Zed")));
    await click(item("Reveal in Finder"));
    await rightClick(trigger);
    await flush(() => Boolean(item("Open in Zed")));
    await click(item("Open in Zed"));
    expect(asked).toEqual(["reveal /Users/someone/code/telar", "open /Users/someone/code/telar zed"]);
    expect(readPreferredOpener(undefined)).toBe("zed");
  });

  test("a paired Mac's header names its host and offers no folder rows", async () => {
    installShell();
    const { host } = await mountHeader({ hostId: "host_x", hostName: "mini" });
    expect(host.textContent).toContain("mini");
    await rightClick(host.querySelector('[data-slot="context-menu-trigger"]')!);
    expect(labels()).toContain("Collapse others");
    expect(labels()).not.toContain("Reveal in Finder");
  });
});

describe("the rail's empty space", () => {
  const empty = (host: HTMLElement) => host.querySelector("#sidebar-session-results")!;

  test("offers New conversation, Add project and the fold-all pair", async () => {
    const { host } = await railWith(TWO, TWO_ROWS);
    await rightClick(empty(host));
    expect(labels()).toEqual(["New conversation", "Add project", "Collapse all projects", "Expand all"]);
  });

  test("New conversation opens the sole project's canvas, like the header button", async () => {
    const { host } = await railWith([project("p1", "One")], [liveRow("a")]);
    await rightClick(empty(host));
    await click(item("New conversation"));
    expect(pushes).toEqual([canvasHref("p1")]);
  });

  test("Add project opens the palette's sources page", async () => {
    const { host } = await railWith(TWO, TWO_ROWS);
    await rightClick(empty(host));
    await click(item("Add project"));
    await flush(() => Boolean(document.querySelector('[role="dialog"]')));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Add a project");
  });

  test("Collapse all projects and Expand all fold the groups on screen", async () => {
    const { host, expanded } = await railWith(TWO, TWO_ROWS);
    await rightClick(empty(host));
    await click(item("Collapse all projects"));
    expect(expanded()).toEqual(["false", "false"]);
    await rightClick(empty(host));
    await click(item("Expand all"));
    expect(expanded()).toEqual(["true", "true"]);
  });
});
