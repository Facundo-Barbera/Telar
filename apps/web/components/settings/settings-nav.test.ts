// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { GlobeIcon } from "lucide-react";
import { SECTION_IDS, SECTIONS } from "./settings-sections";
import { resolveSection } from "./use-section-from-url";

const route = (raw: string | null) => resolveSection(raw, SECTION_IDS);
const section = (id: string) => SECTIONS.find((entry) => entry.id === id);

test("the nav is five groups, in order, each holding its panes", () => {
  expect(SECTIONS.map(({ group, id }) => `${group}:${id}`)).toEqual([
    "Cockpit:general",
    "Cockpit:appearance",
    "Cockpit:keybindings",
    "Cockpit:integrations",
    "Cockpit:dictation",
    "Agents:providers",
    "Agents:tools",
    "Agents:plugins",
    "Projects:projects",
    "This Mac:remote",
    "This Mac:storage",
    "About:about",
    "About:updates",
    "About:source-control",
  ]);
});

test("panes are labelled for what they hold", () => {
  expect(section("about")?.label).toBe("This build");
  expect(section("updates")?.label).toBe("Updates");
  expect(section("storage")?.label).toBe("Storage");
  expect(section("integrations")?.label).toBe("Browser");
  expect(section("integrations")?.icon).toBe(GlobeIcon);
});

test("every current pane id routes to itself", () => {
  for (const id of SECTION_IDS) expect(route(id)).toBe(id);
});


test("plugins share one destination, and removed panes are not routed", () => {
  for (const gone of ["latex", "data-science", "schedules", "store"]) {
    expect(SECTION_IDS).not.toContain(gone);
    expect(route(gone)).toBeNull();
  }
  expect(route(null)).toBeNull();
});
