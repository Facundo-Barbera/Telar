// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { GlobeIcon } from "lucide-react";
import { SECTION_ALIASES, SECTION_IDS, SECTIONS } from "./settings-sections";
import { resolveSection } from "./use-section-from-url";

const route = (raw: string | null) => resolveSection(raw, SECTION_IDS, SECTION_ALIASES);
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

test("retired ids land on the pane that took over their rows", () => {
  expect(route("application")).toBe("about");
  expect(route("settled")).toBe("general");
  expect(route("sessions")).toBe("general");
  expect(route("inbox")).toBe("general");
  expect(route("textgen")).toBe("general");
  expect(route("permissions")).toBe("tools");
  // Baked into app/api/mcp/oauth/callback/route.ts.
  expect(route("mcp")).toBe("tools");
});

test("no alias shadows a real pane id", () => {
  for (const alias of Object.keys(SECTION_ALIASES)) expect(SECTION_IDS).not.toContain(alias);
});

test("plugins share one destination, and removed panes are not routed", () => {
  for (const gone of ["latex", "data-science", "schedules", "store"]) {
    expect(SECTION_IDS).not.toContain(gone);
    expect(route(gone)).toBeNull();
  }
  expect(route(null)).toBeNull();
});
