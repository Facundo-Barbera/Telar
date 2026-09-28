// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rememberedDirectoryKey } from "../directory-keys";
import { EngineApiError } from "@/platform/engine";
import type { DirectoryListing } from "@telar/engine-client";
import { buttonLabelled, click, flush, installTestDom, mount } from "@/test/dom";
import { DirectoryBrowser } from "./directory-browser";
import type { DirectoryLister } from "../hooks/use-directory-listing";

installTestDom();

afterEach(() => {
  window.localStorage.clear();
  delete (window as { telarDesktop?: unknown }).telarDesktop;
});

const never = () => new Promise<never>(() => {});

type Props = Partial<Parameters<typeof DirectoryBrowser>[0]>;

const render = (props: Props = {}) =>
  renderToStaticMarkup(<DirectoryBrowser actionLabel="Add" onSubmit={() => {}} onBack={() => {}} list={never} {...props} />);

function listing(path: string, patch: Partial<DirectoryListing> = {}): DirectoryListing {
  return {
    path,
    name: path.split("/").pop() ?? "",
    parent: "/Users/me",
    home: "/Users/me",
    roots: [],
    dirs: [
      { name: "alpha", path: `${path}/alpha`, git: true, hidden: false },
      { name: "beta", path: `${path}/beta`, git: false, hidden: false },
    ],
    truncated: false,
    ...patch,
  };
}

/** A lister that records every request and answers from `answer`. */
function lister(answer: (input: Parameters<DirectoryLister>[0]) => DirectoryListing | Error = (input) => listing(input.path ?? "/Users/me/code")) {
  const calls: Parameters<DirectoryLister>[0][] = [];
  const list: DirectoryLister = async (input) => {
    calls.push(input);
    const result = answer(input);
    if (result instanceof Error) throw result;
    return result;
  };
  return { list, calls };
}

async function mountBrowser(props: Props = {}) {
  const { host } = await mount(<DirectoryBrowser actionLabel="Add" onSubmit={() => {}} onBack={() => {}} list={never} {...props} />);
  await flush(() => !host.textContent?.includes("Reading that folder…"));
  return host;
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

const field = (host: Element) => host.querySelector('[aria-label="Folder path"]') as HTMLInputElement;
const status = (host: Element) => host.querySelector('[role="status"]')?.textContent;

test("the first paint is a field, a captioned list and a legend — never a blank panel", () => {
  const html = render();
  expect(html).toContain('aria-label="Folder path"');
  expect(html).toContain("Directories");
  expect(html).toContain("Reading that folder…");
  expect(html).toContain("Navigate");
  expect(html).toContain("Up");
});

test("the button says what pressing it DOES, and names the key that does it", () => {
  expect(render({ actionLabel: "Add" })).toContain("Add");
  expect(render({ actionLabel: "Clone here" })).toContain("Clone here");
  expect(render()).toContain("⌘↵");
});

test("the highlight is announced, and the arrows move it", async () => {
  const host = await mountBrowser({ list: lister().list });
  const options = [...host.querySelectorAll('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual(["alpha", "beta"]);
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  expect(field(host).getAttribute("aria-activedescendant")).toBe("directory-browser-entry-0");

  await key(field(host), { key: "ArrowDown" });
  expect(field(host).getAttribute("aria-activedescendant")).toBe("directory-browser-entry-1");
  expect(host.querySelector("#directory-browser-entry-1")?.getAttribute("aria-selected")).toBe("true");
});

test("the dotfolder toggle offers the OTHER state and asks for dotfolders", async () => {
  expect(render()).toContain("Show dotfolders (⌘.)");
  const { list, calls } = lister();
  const host = await mountBrowser({ list });
  await click(host.querySelector('[aria-label="Show dotfolders"]')!);
  await flush(() => calls.length > 1);
  expect(calls.at(-1)).toMatchObject({ hidden: true });
  const toggle = host.querySelector('[aria-label="Hide dotfolders"]');
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
});

test("the caller's sentence is shown, and its own refusal wins over it", async () => {
  const notice = "That repository already exists there.";
  expect(render({ notice })).toContain(notice);
  const host = await mountBrowser({ notice, list: lister(() => new EngineApiError("conflict", "That folder is outside what may be browsed.")).list });
  expect(status(host)).toBe("That folder is outside what may be browsed.");
});

test("a pasted path opens at its nearest folder, says so, and browsing on clears it", async () => {
  const { list, calls } = lister((input) => listing(input.path === "~/gone/file" ? "/Users/me/gone" : input.path!, input.nearest ? { missing: "~/gone/file" } : {}));
  const host = await mountBrowser({ startAt: "~/gone/file", list });
  expect(calls[0]).toEqual({ path: "~/gone/file", nearest: true });
  expect(status(host)).toBe("Nothing to open at ~/gone/file, so this is the nearest folder that exists.");

  await click(host.querySelector("#directory-browser-entry-0")!);
  await flush(() => calls.length > 1);
  expect(calls[1]).toEqual({ path: "/Users/me/gone/alpha" });
  expect(status(host)).toBeUndefined();
});

test("a pasted path the listing refuses falls back to home and says why", async () => {
  const { list, calls } = lister((input) => (input.path ? new EngineApiError("not_found", "No such folder.") : listing("/Users/me")));
  const host = await mountBrowser({ startAt: "~/nowhere", list });
  await flush(() => calls.length > 1);
  expect(calls[1]).toEqual({});
  expect(status(host)).toBe("No such folder. Showing home instead.");
});

test("a listing whose repository marks ran out of time says so", async () => {
  const host = await mountBrowser({ list: lister((input) => listing(input.path ?? "/Users/me", { gitPartial: true })).list });
  expect(host.textContent).toContain("not every repository is marked");
});

test("the busy state is the button's, not a spinner over the whole panel", () => {
  const html = render({ busy: true });
  expect(html).toContain("animate-spin");
  expect(html).toContain("disabled");
});

test("the last directory is remembered per host", async () => {
  window.localStorage.setItem(rememberedDirectoryKey("studio"), "/Users/me/work");
  const { list, calls } = lister();
  await mountBrowser({ hostId: "studio", list });
  expect(calls[0]).toEqual({ path: "/Users/me/work" });
  expect(window.localStorage.getItem(rememberedDirectoryKey("studio"))).toBe("/Users/me/work");
  expect(window.localStorage.getItem(rememberedDirectoryKey(undefined))).toBeNull();
});

test("a remembered folder that has gone opens home once, with nothing to say", async () => {
  window.localStorage.setItem(rememberedDirectoryKey(undefined), "/Users/me/deleted");
  const { list, calls } = lister((input) => (input.path ? new EngineApiError("not_found", "No such folder.") : listing("/Users/me")));
  const host = await mountBrowser({ list });
  await flush(() => calls.length > 1);
  expect(calls).toEqual([{ path: "/Users/me/deleted" }, {}]);
  expect(status(host)).toBeUndefined();
  expect(window.localStorage.getItem(rememberedDirectoryKey(undefined))).toBe("/Users/me");
});

test("a storage that throws is not a reason to fail to draw", async () => {
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("denied");
  };
  try {
    const { list, calls } = lister();
    const host = await mountBrowser({ list });
    expect(calls[0]).toEqual({});
    expect(host.querySelectorAll('[role="option"]').length).toBe(2);
  } finally {
    Storage.prototype.getItem = getItem;
  }
});

test("Open in Finder reveals the listed folder, desktop-only, and never for another Mac", async () => {
  const revealed: string[] = [];
  (window as { telarDesktop?: unknown }).telarDesktop = { workspace: { reveal: async (path: string) => void revealed.push(path) } };
  const local = await mountBrowser({ list: lister().list });
  await click(buttonLabelled("Open in Finder", local));
  expect(revealed).toEqual(["/Users/me/code"]);

  const remote = await mountBrowser({ hostId: "studio", list: lister().list });
  expect(buttonLabelled("Open in Finder", remote)).toBeUndefined();

  delete (window as { telarDesktop?: unknown }).telarDesktop;
  const tab = await mountBrowser({ list: lister().list });
  expect(buttonLabelled("Open in Finder", tab)).toBeUndefined();
});

test("the native picker is offered only when the engine is unreachable", async () => {
  const offer = "Choose a folder with the system picker instead";
  let fellBack = 0;
  const onFallback = () => void (fellBack += 1);
  const refused = await mountBrowser({ onFallback, list: lister(() => new EngineApiError("conflict", "No.")).list });
  expect(buttonLabelled(offer, refused)).toBeUndefined();

  const down = await mountBrowser({ onFallback, list: lister(() => new EngineApiError("engine_unavailable", "The engine is not running.")).list });
  await click(buttonLabelled(offer, down));
  expect(fellBack).toBe(1);
});

test("⌘Enter takes the folder being shown, even from a row's button", async () => {
  const submitted: string[] = [];
  const host = await mountBrowser({ onSubmit: (path) => void submitted.push(path), list: lister().list });
  await key(host.querySelector("#directory-browser-entry-1")!, { key: "Enter", metaKey: true });
  expect(submitted).toEqual(["/Users/me/code"]);
});
