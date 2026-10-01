import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

const mounted: (() => void)[] = [];
const realFetch = globalThis.fetch;

/** Call once at the top of a test file: registers a DOM for that file only,
 *  unmounts whatever each test mounted, and hands the DOM back at the end. */
export function installTestDom() {
  GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
    globalThis.fetch = realFetch;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}

export async function mount(element: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  let gone = false;
  const unmount = () => {
    if (gone) return;
    gone = true;
    act(() => root.unmount());
    host.remove();
  };
  mounted.push(unmount);
  return { host, unmount };
}

/** Lets pending zero-delay timers and promises land, up to 20 turns or until `until` holds. */
export async function flush(until: () => boolean = () => false) {
  for (let turn = 0; turn < 20 && !until(); turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The pointer and mouse events a real press sends, on the deepest element. */
export async function press(element: Element) {
  const target = element.querySelector("svg") ?? element;
  const init = { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0, detail: 1 };
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" } as PointerEventInit));
    target.dispatchEvent(new MouseEvent("mousedown", init));
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" } as PointerEventInit));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  });
  await flush();
}

export type Route = (body: unknown) => unknown;

/** Stubs `fetch` until the test ends: `"METHOD /path"` answers with its route's
 *  JSON, a route that throws answers 500, and a missing one 404. Returns the calls. */
export function stubFetch(routes: Record<string, Route>) {
  const calls: { route: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = `${init?.method ?? "GET"} ${new URL(String(input), "http://localhost").pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const answer = routes[route];
    if (!answer) return Response.json({ error: { message: `no route ${route}` } }, { status: 404 });
    try {
      return Response.json(answer(body));
    } catch (cause) {
      return Response.json({ error: { message: String(cause) } }, { status: 500 });
    }
  }) as typeof fetch;
  return calls;
}

export const buttonLabelled = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll("button")].find((node) => node.textContent?.trim() === label) as HTMLButtonElement | undefined;

export async function click(element: Element | undefined) {
  await act(async () => (element as HTMLElement).click());
  await flush();
}

export function stubBoxSize(width: number, height: number) {
  const keys = ["clientWidth", "clientHeight"] as const;
  let saved: (PropertyDescriptor | undefined)[] = [];
  beforeAll(() => {
    saved = keys.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
  });
  afterAll(() => typeof HTMLElement !== "undefined" && keys.forEach((key, index) => (saved[index] ? Object.defineProperty(HTMLElement.prototype, key, saved[index]) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key])));
}
