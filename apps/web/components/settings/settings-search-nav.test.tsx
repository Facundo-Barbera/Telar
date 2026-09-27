// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * MOUNTED AND DRIVEN (#760). These rules were once pinned as lines of source,
 * because a static render cannot type; `lib/testing/type-into.ts` (#732) can,
 * so the keyboard is now exercised the way a person uses it: `/` must not steal
 * a slash from a text field, the highlight must be announced, Escape clears
 * before it leaves, and choosing puts the panes back.
 */
GlobalRegistrator.register({ url: "http://localhost/settings" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SETTINGS_SEARCH_INDEX } = await import("./settings-registry");
const { SettingsSearchNav } = await import("./settings-search-nav");
const { typeInto } = await import("@/lib/testing/type-into");
type Entry = Parameters<Parameters<typeof SettingsSearchNav>[0]["onChoose"]>[0];

const shell = readFileSync(new URL("./settings-shell.tsx", import.meta.url), "utf8");

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
  // Nothing is replaced until something is typed.
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

test("choosing a result navigates, centres, focuses and pulses", () => {
  // Still read from source: this is the shell's half, and the shell is not
  // mounted here. All four live in one place because the shell owns the pane
  // switch and the scroll.
  expect(shell).toContain("onSelect(entry.pageId)");
  expect(shell).toContain('block: "center"');
  expect(shell).toContain("focus({ preventScroll: true })");
  expect(shell).toContain('classList.add("settings-search-target-pulse")');
  // And asking for less motion drops both motions rather than the jump.
  expect(shell).toContain('prefers-reduced-motion: reduce');
});
