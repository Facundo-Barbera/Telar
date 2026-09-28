// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { buttonLabelled, click, flush, installTestDom, mount, press } from "@/lib/testing/dom";
import { liveRow, loadRail, mountRail, project, pushes, stubRail } from "@/lib/testing/rail";
import { SidebarProjectFilter } from "./sidebar-project-filter";
import { SidebarSearchField } from "@/components/sidebar-search-field";
import { writeDraft } from "@/features/composer/index";
import { projectFilterKey } from "@/features/projects";
import { canvasHref } from "../session-list";

installTestDom();
const { composerTargetOf, pickerTargetsFor } = await loadRail();

const byLabel = (label: string, root: ParentNode = document) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const filterTrigger = () => document.querySelector<HTMLElement>('[aria-label="Filter by project"], [aria-label^="Filtering by"]');
const checkbox = (name: string) => [...document.querySelectorAll('[role="checkbox"]')].find((node) => node.textContent?.includes(name)) as HTMLElement | undefined;

async function openFilter() {
  await press(filterTrigger()!);
  await flush(() => Boolean(document.querySelector('[role="checkbox"]')));
}

describe("the rail's header is one row", () => {
  test("search, then Add project and New conversation — no Reveal in Finder, no All-projects row", async () => {
    stubRail(() => ({ body: { projects: [project("p1", "One")], sessions: [liveRow("a")] } }));
    const host = await mountRail();
    expect(byLabel("Search sessions", host)).not.toBeNull();
    expect(byLabel("Add project", host)).not.toBeNull();
    expect(byLabel("New conversation", host)).not.toBeNull();
    expect(byLabel("Reveal in Finder", host)).toBeNull();
    expect(host.textContent).not.toContain("All projects");
  });

  test("with one project, New conversation opens that project's canvas", async () => {
    stubRail(() => ({ body: { projects: [project("p1", "One")], sessions: [liveRow("a")] } }));
    const host = await mountRail();
    await click(byLabel("New conversation", host)!);
    expect(pushes).toEqual([canvasHref("p1")]);
  });

  test("a sole project on a paired Mac opens its canvas on that Mac", async () => {
    stubRail(
      (request) => (request.path.startsWith("/api/hosts/mini/")
        ? { body: { projects: [project("p9", "Far")], sessions: [], daemonId: "mini-engine" } }
        : { body: { projects: [], sessions: [], daemonId: "local-engine" } }),
      [{ id: "mini", name: "Mini" }],
    );
    const host = await mountRail();
    await click(byLabel("New conversation", host)!);
    expect(pushes).toEqual([canvasHref("p9", "mini")]);
  });
});

describe("the projects New conversation can target", () => {
  test("this Mac's projects come first, then each paired Mac's, carrying their host", () => {
    const local = [{ id: "p1", environmentId: "local" as const, name: "One", root: "/tmp/p1", createdAt: 1, updatedAt: 1 }];
    const remote = [{ id: "p9", name: "Far", hostId: "mini", hostName: "Mini" }];
    expect(pickerTargetsFor(local, remote)).toEqual([
      { id: "p1", name: "One", root: "/tmp/p1" },
      { id: "p9", name: "Far", hostId: "mini", hostName: "Mini" },
    ]);
  });

  test("a chosen project opens on the Mac it lives on", () => {
    expect(composerTargetOf({ id: "p9", hostId: "mini" })).toEqual({ projectId: "p9", hostId: "mini" });
    expect(composerTargetOf({ id: "p1" })).toEqual({ projectId: "p1" });
  });
});

describe("the command palette", () => {
  const two = { projects: [project("p1", "One"), project("p2", "Two")], sessions: [liveRow("a")] };
  const dialog = () => document.querySelector('[role="dialog"]');
  const chordK = async () => {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true })));
    await flush();
  };

  test("with two projects, New conversation asks which one rather than guessing", async () => {
    stubRail(() => ({ body: two }));
    const host = await mountRail();
    await click(byLabel("New conversation", host)!);
    await flush(() => Boolean(dialog()));
    expect(pushes).toEqual([]);
    expect(dialog()!.textContent).toContain("One");
    expect(dialog()!.textContent).toContain("Two");
  });

  test("the search chord opens the palette, and pressed again closes it", async () => {
    stubRail(() => ({ body: two }));
    await mountRail();
    await chordK();
    await flush(() => Boolean(dialog()));
    expect(dialog()).not.toBeNull();
    await chordK();
    await flush(() => !dialog());
    expect(dialog()).toBeNull();
  });
});

describe("the project filter, as a set", () => {
  const two = { projects: [project("p1", "One"), project("p2", "Two")], sessions: [liveRow("one-row"), liveRow("one-pinned", { settledOverride: "active" }), liveRow("two-row", { projectId: "p2" })] };

  test("absent on a cockpit with one project", async () => {
    stubRail(() => ({ body: { projects: [project("p1", "One")], sessions: [liveRow("a")] } }));
    await mountRail();
    expect(filterTrigger()).toBeNull();
  });

  test("checking a project narrows the list, pinned rows included, and the trigger counts it", async () => {
    stubRail(() => ({ body: two }));
    const host = await mountRail();
    await openFilter();
    await click(checkbox("Two"));
    const list = host.querySelector("#sidebar-session-results")!.textContent!;
    expect(list).toContain("Title two-row");
    expect(list).not.toContain("Title one-row");
    expect(list).not.toContain("Title one-pinned");
    expect(filterTrigger()!.getAttribute("aria-label")).toBe("Filtering by 1 project — change");
  });

  test("a draft is a row, so the filter reaches it too", async () => {
    stubRail(() => ({ body: two }));
    const host = await mountRail();
    await act(async () => writeDraft(undefined, "p1", "half a thought"));
    expect(host.textContent).toContain("half a thought");
    await openFilter();
    await click(checkbox("Two"));
    expect(host.textContent).not.toContain("half a thought");
  });

  test("a rail emptied by the filter says so, rather than No sessions yet", async () => {
    stubRail(() => ({ body: { ...two, sessions: [liveRow("one-row")] } }));
    const host = await mountRail();
    await openFilter();
    await click(checkbox("Two"));
    expect(host.textContent).toContain("No sessions in the selected projects");
    expect(host.textContent).not.toContain("No sessions yet");
  });
});

describe("SidebarProjectFilter", () => {
  const targets = [
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
  ];

  test("one checkbox per project, ticked by the selection, and pressing one toggles its key", async () => {
    const toggled: string[] = [];
    await mount(<SidebarProjectFilter targets={targets} selected={new Set([projectFilterKey("p2")])} onToggle={(key) => toggled.push(key)} onClear={() => {}} />);
    await openFilter();
    expect(checkbox("One")!.getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Two")!.getAttribute("aria-checked")).toBe("true");
    await click(checkbox("One"));
    expect(toggled).toEqual([projectFilterKey("p1")]);
  });

  test("nothing checked is every project: no All row, and Clear only once something is checked", async () => {
    const { unmount } = await mount(<SidebarProjectFilter targets={targets} selected={new Set()} onToggle={() => {}} onClear={() => {}} />);
    await openFilter();
    expect(document.body.textContent).not.toContain("All projects");
    expect(buttonLabelled("Clear")).toBeUndefined();
    unmount();
    let cleared = 0;
    await mount(<SidebarProjectFilter targets={targets} selected={new Set([projectFilterKey("p1")])} onToggle={() => {}} onClear={() => (cleared += 1)} />);
    await openFilter();
    await click(buttonLabelled("Clear"));
    expect(cleared).toBe(1);
  });

  test("captions each Mac only when there is more than one", async () => {
    const { unmount } = await mount(<SidebarProjectFilter targets={targets} selected={new Set()} onToggle={() => {}} onClear={() => {}} />);
    await openFilter();
    expect(document.body.textContent).not.toContain("Local");
    unmount();
    const paired = [...targets, { id: "p1", name: "Far", hostId: "mini", hostName: "Mini" }];
    await mount(<SidebarProjectFilter targets={paired} selected={new Set()} onToggle={() => {}} onClear={() => {}} />);
    await openFilter();
    const group = document.querySelector('[role="group"][aria-label="Filter by project"]')!;
    expect(group.textContent).toContain("Local");
    expect(group.textContent).toContain("Mini");
  });
});

describe("SidebarSearchField", () => {
  test("draws the search glyph when no slot is given", async () => {
    const { host } = await mount(<SidebarSearchField aria-label="Search" />);
    expect(host.querySelector("svg")).not.toBeNull();
  });

  test("a leading slot replaces the glyph rather than sitting beside it", async () => {
    const { host } = await mount(<SidebarSearchField aria-label="Search" start={<span data-slot="lead">lead</span>} />);
    expect(host.querySelector('[data-slot="lead"]')).not.toBeNull();
    expect(host.querySelector("svg")).toBeNull();
  });
});
