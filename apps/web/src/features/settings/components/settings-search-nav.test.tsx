// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({ url: "http://localhost/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SETTINGS_SEARCH_INDEX } = await import("../index");
const { SettingsSearchNav } = await import("./settings-search-nav");
const { SettingsShell, revealSettingsRow } = await import("./settings-shell");
const { SECTIONS } = await import("../settings-sections");
const { typeInto } = await import("@/lib/testing/type-into");
type Entry = Parameters<Parameters<typeof SettingsSearchNav>[0]["onChoose"]>[0];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let chosen: Entry[];

beforeEach(async () => {
  chosen = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <SettingsSearchNav index={SETTINGS_SEARCH_INDEX} onChoose={(entry) => chosen.push(entry)}>
        <nav>the panes</nav>
      </SettingsSearchNav>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

afterAll(() => GlobalRegistrator.unregister());

const field = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...host.querySelectorAll('[role="option"]')];

async function press(target: EventTarget, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

test("at rest it is a combobox showing the key that focuses it", () => {
  const html = renderToStaticMarkup(
    <SettingsSearchNav index={SETTINGS_SEARCH_INDEX} onChoose={() => undefined}>
      <nav>the panes</nav>
    </SettingsSearchNav>,
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(">/</kbd>");
  expect(html).toContain("the panes");
});

test("the slash key focuses the field, except where a slash is a slash", async () => {
  const other = document.createElement("input");
  document.body.appendChild(other);
  other.focus();
  await press(other, "/");
  expect(document.activeElement).toBe(other);

  await press(document.body, "/");
  expect(document.activeElement).toBe(field());
});

test("the highlight is announced, not just drawn", async () => {
  await typeInto(field(), "s");
  expect(field().getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  expect(options().length).toBeGreaterThan(1);
  expect(field().getAttribute("aria-activedescendant")).toBe(options()[0].id);
  expect(options()[0].getAttribute("aria-selected")).toBe("true");

  await press(field(), "ArrowDown");
  expect(field().getAttribute("aria-activedescendant")).toBe(options()[1].id);
  expect(options()[1].getAttribute("aria-selected")).toBe("true");
  expect(options()[0].getAttribute("aria-selected")).toBe("false");
});

test("Escape clears before it leaves", async () => {
  field().focus();
  await typeInto(field(), "s");
  await press(field(), "Escape");
  expect(field().value).toBe("");
  expect(host.textContent).toContain("the panes");
  expect(document.activeElement).toBe(field());

  await press(field(), "Escape");
  expect(document.activeElement).not.toBe(field());
});

test("the empty state is one line", async () => {
  await typeInto(field(), "zzqqxxnothing");
  expect(options()).toHaveLength(0);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("No settings found.");
});

test("Enter chooses the highlighted result and puts the panes back", async () => {
  await typeInto(field(), "s");
  await press(field(), "ArrowDown");
  const highlighted = field().getAttribute("aria-activedescendant");
  await press(field(), "Enter");
  expect(chosen).toHaveLength(1);
  expect(highlighted).toEndWith(`-${chosen[0].id}`);
  expect(field().value).toBe("");
  expect(host.textContent).toContain("the panes");
});

test("choosing a result in the shell selects the pane it lives on", async () => {
  const selected: string[] = [];
  await act(async () => {
    root.render(
      <SettingsShell title="Settings" sections={SECTIONS} active="general" onSelect={(id) => selected.push(id)} search={SETTINGS_SEARCH_INDEX}>
        <p>pane</p>
      </SettingsShell>,
    );
  });
  await typeInto(field(), "tailscale");
  await press(field(), "Enter");
  expect(selected).toEqual(["remote"]);
});

function stubRow(reducedMotion: boolean) {
  window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes("reduce") })) as unknown as typeof window.matchMedia;
  const row = document.createElement("div");
  row.id = "settings-row-target";
  row.tabIndex = -1;
  const scrolls: unknown[] = [];
  row.scrollIntoView = (options?: unknown) => void scrolls.push(options);
  document.body.appendChild(row);
  return { row, scrolls };
}

test("revealing a row centres, focuses and pulses it", () => {
  const { row, scrolls } = stubRow(false);
  expect(revealSettingsRow(row.id)).toBe(true);
  expect(scrolls).toEqual([{ block: "center", behavior: "smooth" }]);
  expect(document.activeElement).toBe(row);
  expect(row.classList.contains("settings-search-target-pulse")).toBe(true);
  row.dispatchEvent(new Event("animationend"));
  expect(row.classList.contains("settings-search-target-pulse")).toBe(false);
});

test("with reduced motion the row is still centred and focused, without motion", () => {
  const { row, scrolls } = stubRow(true);
  revealSettingsRow(row.id);
  expect(scrolls).toEqual([{ block: "center", behavior: "auto" }]);
  expect(document.activeElement).toBe(row);
  expect(row.classList.contains("settings-search-target-pulse")).toBe(false);
});

test("a row that is not rendered is not revealed", () => {
  expect(revealSettingsRow("settings-row-missing")).toBe(false);
});
