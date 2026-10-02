import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/sessions" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FeedbackDialog } = await import("./feedback-dialog");

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const opened = mock((_url: string) => Promise.resolve());

beforeEach(() => {
  opened.mockClear();
  (window as unknown as { telarDesktop: unknown }).telarDesktop = { browser: { openExternal: opened } };
  globalThis.fetch = (async () => Response.json({ appVersion: "1.4.0", appName: "Telar", channel: "beta" })) as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<FeedbackDialog triggerClassName="" />));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
});

afterAll(() => GlobalRegistrator.unregister());

const press = (el: Element) => act(async () => void (el as HTMLElement).click());

test("the button opens the dialog and submit opens the issue URL in the system browser", async () => {
  expect(document.querySelector("textarea")).toBeNull();
  await press(document.querySelector('button[aria-label="Send feedback"]')!);

  const textarea = document.querySelector("textarea")!;
  const submit = [...document.querySelectorAll("button")].find((b) => b.textContent === "Open issue")!;
  expect(submit.disabled).toBe(true);

  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(textarea, "Dark mode flickers");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press(submit);

  expect(opened).toHaveBeenCalledTimes(1);
  const url = new URL(opened.mock.calls[0]![0]);
  expect(url.pathname).toBe("/NovarixHQ/Telar/issues/new");
  expect(url.searchParams.get("body")).toContain("Dark mode flickers");
  expect(url.searchParams.get("body")).toContain("Build: 1.4.0 · beta");
});

test("unchecking the info box sends only the text", async () => {
  await press(document.querySelector('button[aria-label="Send feedback"]')!);
  const textarea = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Just text");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press(document.querySelector('input[type="checkbox"]')!);
  await press([...document.querySelectorAll("button")].find((b) => b.textContent === "Open issue")!);

  expect(new URL(opened.mock.calls[0]![0]).searchParams.get("body")).toBe("Just text");
});
