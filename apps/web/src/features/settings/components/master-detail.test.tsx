import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

GlobalRegistrator.register({ url: "http://localhost/settings?section=plugins" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MasterDetail } = await import("./master-detail");

const ITEMS = ["alpha", "beta", "gamma"].map((id) => ({
  id,
  label: id.toUpperCase(),
  description: `${id} blurb`,
  control: <input type="checkbox" aria-label={`${id} switch`} />,
  detail: <p>{`${id} editor`}</p>,
}));

const realSetTimeout = window.setTimeout;

beforeEach(() => {
  window.history.replaceState(null, "", "/settings?section=plugins");
  window.setTimeout = ((fn: () => void) => {
    queueMicrotask(fn);
    return 0;
  }) as unknown as typeof window.setTimeout;
});

afterEach(() => {
  window.setTimeout = realSetTimeout;
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return {
    host,
    option: (id: string) => host.querySelector<HTMLElement>(`[data-master-item="${id}"]`)!,
    shown: () => [...host.querySelectorAll<HTMLElement>("[data-detail-for]")].filter((detail) => !detail.hidden).map((detail) => detail.textContent),
    done: () => act(() => root.unmount()),
  };
}

test("the list shows every item with its control, and the first item's editor beside it", async () => {
  const view = await mount(<MasterDetail title="Plugins" param="plugin" items={ITEMS} footer={<p>Add one</p>} />);
  expect([...view.host.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["ALPHAalpha blurb", "BETAbeta blurb", "GAMMAgamma blurb"]);
  expect(view.host.querySelector('[aria-label="beta switch"]')).not.toBeNull();
  expect(view.option("alpha").getAttribute("aria-selected")).toBe("true");
  expect(view.shown()).toEqual(["alpha editor"]);
  expect(view.host.textContent).toContain("Add one");
  view.done();
});

test("choosing an item shows its editor and writes it to the URL", async () => {
  const view = await mount(<MasterDetail title="Plugins" param="plugin" items={ITEMS} />);
  await act(async () => view.option("gamma").click());
  expect(view.shown()).toEqual(["gamma editor"]);
  expect(new URLSearchParams(window.location.search).get("plugin")).toBe("gamma");
  expect(new URLSearchParams(window.location.search).get("section")).toBe("plugins");
  view.done();
});

test("a deep link opens on the item it names", async () => {
  window.history.replaceState(null, "", "/settings?section=plugins&plugin=beta");
  const view = await mount(<MasterDetail title="Plugins" param="plugin" items={ITEMS} />);
  expect(view.shown()).toEqual(["beta editor"]);
  view.done();
});

test("up and down move the selection and the focus, and stop at the ends", async () => {
  const view = await mount(<MasterDetail title="Plugins" param="plugin" items={ITEMS} />);
  const key = (name: string) =>
    act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
  view.option("alpha").focus();
  await key("ArrowDown");
  await key("ArrowDown");
  expect(view.shown()).toEqual(["gamma editor"]);
  expect(document.activeElement).toBe(view.option("gamma"));
  await key("ArrowDown");
  expect(view.shown()).toEqual(["gamma editor"]);
  await key("ArrowUp");
  expect(view.shown()).toEqual(["beta editor"]);
  view.done();
});

test("an item without an editor is listed but cannot be chosen", async () => {
  const items = [{ id: "far", label: "Far", unavailable: "Registered on mini.", control: <input type="checkbox" aria-label="far switch" /> }];
  const view = await mount(<MasterDetail title="Plugins" param="plugin" items={items} />);
  expect(view.host.textContent).toContain("Registered on mini.");
  expect(view.option("far").hasAttribute("disabled")).toBe(true);
  expect(view.host.querySelector('[aria-label="far switch"]')!.closest("[inert]")).not.toBeNull();
  expect(view.shown()).toEqual([]);
  view.done();
});

test("a bounded split scrolls its detail inside a capped height instead of growing the page", () => {
  const markup = renderToStaticMarkup(<MasterDetail title="Logins" param="provider" items={ITEMS} bounded />);
  const paneClass = (html: string) => /class="([^"]+)"/.exec(/<div[^>]*data-detail-pane[^>]*>/.exec(html)?.[0] ?? "")?.[1] ?? "";
  const pane = paneClass(markup);
  expect(pane).toContain("overflow-y-auto");
  expect(pane).toMatch(/max-h-\[max\(20rem,70dvh\)\]/);
  expect(markup).toContain("@min-[44rem]/master:h-[min(44rem,calc(100dvh-11rem))]");
  const open = paneClass(renderToStaticMarkup(<MasterDetail title="Plugins" param="plugin" items={ITEMS} />));
  expect(open).not.toContain("overflow-y-auto");
});

test("the split answers to its own named container, so a narrow settings pane stacks it", () => {
  const markup = renderToStaticMarkup(<MasterDetail title="Plugins" param="plugin" items={ITEMS} />);
  expect(markup).toContain("@container/master");
  expect(markup).toContain("@min-[44rem]/master:grid-cols-");
  expect(markup).not.toMatch(/\b(sm|md|lg):grid-cols-/);
});
