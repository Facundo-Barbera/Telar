import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { Session } from "@telar/engine-client";
import { activeComposer } from "@/features/composer";
import { installTestDom, mount, flush, click, stubFetch } from "@/test/dom";
import { Composer } from "./composer";
import { draftAfterStash } from "../hooks/use-composer-stash";

installTestDom();

const STASH = "telar:prompt-stash:v1";
const storage = Object.getOwnPropertyDescriptor(window, "localStorage")!;

beforeEach(() => {
  localStorage.removeItem(STASH);
});

afterEach(() => {
  Object.defineProperty(window, "localStorage", storage);
});

type BoxProps = {
  initial?: string;
  files?: File[];
  busy?: boolean;
  compact?: boolean;
  fresh?: boolean;
  projectId?: string;
  session?: Session;
  onSubmit?: () => void;
  onStop?: () => void;
};

function Box({ initial = "", files = [], busy = false, compact = false, fresh = false, projectId, session, onSubmit = () => {}, onStop = () => {} }: BoxProps) {
  const [draft, setDraft] = useState(initial);
  const [attachments, setAttachments] = useState(files);
  return (
    <>
      <p data-testid="draft">{draft}</p>
      <Composer
        draft={draft}
        ready
        attachments={attachments}
        onAttach={setAttachments}
        busy={busy}
        compact={compact}
        fresh={fresh}
        driver="claude"
        sending={false}
        backgroundTasks={0}
        onDraftChange={setDraft}
        onSubmit={onSubmit}
        onStop={onStop}
        onStopBackground={() => {}}
        onRuntimeMode={() => {}}
        {...(projectId ? { projectId } : {})}
        {...(session ? { session } : {})}
      />
    </>
  );
}

async function composer(props: BoxProps = {}, routes: Parameters<typeof stubFetch>[0] = {}) {
  const calls = stubFetch(routes);
  const { host } = await mount(<Box {...props} />);
  await flush();
  const editor = host.querySelector<HTMLElement>("[data-slot=composer-editor]")!;
  return {
    host,
    editor,
    calls,
    draft: () => host.querySelector('[data-testid="draft"]')!.textContent,
    stashList: () => host.querySelector('[role="listbox"][aria-label="Prompts waiting to be sent"]'),
  };
}

function key(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const saveChord = { key: "s", metaKey: true };

async function type(editor: HTMLElement, text: string) {
  act(() => {
    editor.focus();
    editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  const entry = activeComposer();
  if (!entry) throw new Error("no active composer");
  act(() => {
    entry.replace(0, 0, text);
  });
  await flush();
}

const layout = { width: 0, item: 40, observers: new Set<() => void>() };

beforeAll(() => {
  globalThis.ResizeObserver = class {
    readonly fire: () => void;
    constructor(callback: () => void) {
      this.fire = () => callback();
    }
    observe() {
      layout.observers.add(this.fire);
    }
    unobserve() {}
    disconnect() {
      layout.observers.delete(this.fire);
    }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => layout.width });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => (layout.width ? layout.item : 0) });
});

afterEach(() => {
  layout.width = 0;
  layout.item = 40;
});

async function narrowable(props: BoxProps, width: number) {
  layout.width = width;
  const mounted = await composer(props);
  const resize = async (next: number) => {
    layout.width = next;
    act(() => {
      for (const fire of [...layout.observers]) fire();
    });
    await flush();
  };
  return { ...mounted, resize };
}

const stashed = () => JSON.parse(localStorage.getItem(STASH) ?? "[]") as { prompt: string }[];

describe("⌘S", () => {
  test("with words in the box stashes them, clears the box, and never lets the Save dialog open", async () => {
    const { editor, draft } = await composer({ initial: "later" });
    const event = key(editor, saveChord);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(draft()).toBe("");
    expect(stashed().map((entry) => entry.prompt)).toEqual(["later"]);
  });

  test("takes a file with the words and gives both back on restore", async () => {
    const pdf = new File(["%PDF notes"], "notes.pdf", { type: "application/pdf" });
    const { host, editor, draft, stashList } = await composer({ initial: "read this", files: [pdf] });
    key(editor, saveChord);
    await flush(() => stashed().length > 0);
    expect(draft()).toBe("");
    expect(host.textContent).not.toContain("notes.pdf");
    key(editor, saveChord);
    await flush();
    const row = [...stashList()!.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("read this"))!;
    await act(async () => row.querySelector("button")!.click());
    await flush(() => Boolean(host.textContent?.includes("notes.pdf")));
    expect(draft()).toBe("read this");
    expect(host.textContent).toContain("notes.pdf");
  });

  test("on an empty box opens the stash list, and is still prevented", async () => {
    const { editor, stashList } = await composer();
    const event = key(editor, saveChord);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(stashList()?.textContent).toContain("Nothing stashed");
  });

  test("during an IME composition belongs to the IME", async () => {
    const { editor, draft } = await composer({ initial: "later" });
    const event = key(editor, { ...saveChord, isComposing: true });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(draft()).toBe("later");
    expect(stashed()).toEqual([]);
  });

  test("wins over an open completion menu", async () => {
    const { host, editor, draft } = await composer();
    await type(editor, "/");
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    key(editor, saveChord);
    await flush();
    expect(draft()).toBe("");
    expect(stashed().map((entry) => entry.prompt)).toEqual(["/"]);
  });
});

describe("the stash list", () => {
  test("Escape closes it even when it is empty", async () => {
    const { editor, stashList } = await composer();
    key(editor, saveChord);
    await flush();
    expect(stashList()).not.toBeNull();
    const event = key(editor, { key: "Escape" });
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(stashList()).toBeNull();
  });

  test("nothing it adds is disabled, so the composer is never greyed", async () => {
    localStorage.setItem(STASH, JSON.stringify([{ id: "one", at: Date.now(), prompt: "kept for later", images: [] }]));
    const { host, editor, stashList } = await composer();
    const badge = host.querySelector<HTMLElement>('[aria-label="Stashed prompts"]');
    expect(badge).not.toBeNull();
    key(editor, saveChord);
    await flush();
    expect(stashList()?.textContent).toContain("kept for later");
    expect(host.querySelector("[disabled], [aria-disabled=true]")).toBeNull();
  });
});

describe("the box is cleared only by a write that landed", () => {
  test("a refused write says so and takes nothing from the box", async () => {
    const full = { getItem: () => null, removeItem: () => {}, setItem: () => {
      throw new Error("quota");
    } };
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => full });
    const { host, editor, draft } = await composer({ initial: "important paragraph" });
    key(editor, saveChord);
    await flush();
    expect(draft()).toBe("important paragraph");
    expect(host.textContent).toContain("There was no room to stash this. Nothing was taken from the box.");
  });

  test("what was typed during an encode is not part of what is cleared", () => {
    expect(draftAfterStash("draft and more", "draft")).toBe(" and more");
    expect(draftAfterStash("draft", "draft")).toBe("");
    expect(draftAfterStash("rewritten", "draft")).toBe("");
  });
});

describe("the skills menu", () => {
  const skills = () => ({ skills: [{ name: "deploy", description: "Ship it" }], commands: [] });

  test("a canvas with no session asks the project", async () => {
    const { editor, calls } = await composer({ projectId: "project_a" }, { "GET /api/projects/project_a/skills": skills });
    await type(editor, "$");
    await flush(() => calls.some((call) => call.route.endsWith("/skills")));
    expect(calls.map((call) => call.route)).toContain("GET /api/projects/project_a/skills");
  });

  test("a session asks itself, not the project", async () => {
    const session = { id: "session_a", driver: "claude", projectId: "project_a", workspace: { mode: "local", path: "/work" } } as Session;
    const { editor, calls } = await composer({ projectId: "project_a", session }, { "GET /api/sessions/session_a/skills": skills });
    await type(editor, "$");
    await flush(() => calls.some((call) => call.route.endsWith("/skills")));
    const routes = calls.map((call) => call.route);
    expect(routes).toContain("GET /api/sessions/session_a/skills");
    expect(routes).not.toContain("GET /api/projects/project_a/skills");
  });
});

describe("the corner button is Stop only while a running turn has nothing typed", () => {
  const corner = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Stop"], button[aria-label="Send"]')!;

  test("an empty box during a turn stops it", async () => {
    let stops = 0;
    let sends = 0;
    const { host } = await composer({ busy: true, onStop: () => stops++, onSubmit: () => sends++ });
    expect(corner(host).getAttribute("aria-label")).toBe("Stop");
    await click(corner(host));
    expect([stops, sends]).toEqual([1, 0]);
  });

  test("a draft during a turn turns it back into Send, so a steer can be clicked", async () => {
    let stops = 0;
    let sends = 0;
    const { host } = await composer({ initial: "steer left", busy: true, onStop: () => stops++, onSubmit: () => sends++ });
    expect(corner(host).getAttribute("aria-label")).toBe("Send");
    await click(corner(host));
    expect([stops, sends]).toEqual([0, 1]);
  });

  test("a picture with no words is a message", async () => {
    let sends = 0;
    const { host } = await composer({ busy: true, files: [new File(["x"], "shot.png", { type: "image/png" })], onSubmit: () => sends++ });
    expect(corner(host).getAttribute("aria-label")).toBe("Send");
    await click(corner(host));
    expect(sends).toBe(1);
  });

  test("with nothing typed and no turn running, Send sends nothing", async () => {
    let sends = 0;
    const { host } = await composer({ onSubmit: () => sends++ });
    await click(corner(host));
    expect(sends).toBe(0);
  });
});

describe("the compact composer, while reading back", () => {
  const expand = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Open the full composer"]');

  test("focusing and clicking the box keeps it compact", async () => {
    const { host, editor } = await composer({ compact: true });
    await click(editor);
    await type(editor, "hello");
    expect(expand(host)).not.toBeNull();
    expect(editor.style.maxHeight).toBe("calc(5lh + 1.25rem)");
  });

  test("typing and Enter sends from the compact box, steering a running turn too", async () => {
    let sends = 0;
    const { host, editor } = await composer({ compact: true, busy: true, onSubmit: () => sends++ });
    await type(editor, "steer left");
    key(editor, { key: "Enter" });
    await flush();
    expect(sends).toBe(1);
    expect(expand(host)).not.toBeNull();
  });

  test("its height is capped, then it scrolls", async () => {
    const { editor } = await composer({ compact: true, initial: "one\ntwo\nthree\nfour\nfive\nsix\nseven" });
    expect(editor.style.maxHeight).toBe("calc(5lh + 1.25rem)");
  });

  test("the expand button opens the full composer", async () => {
    const { host, editor } = await composer({ compact: true });
    await click(expand(host)!);
    expect(expand(host)).toBeNull();
    expect(editor.style.maxHeight).toBe("");
  });
});

describe("a composer too narrow for its controls", () => {
  const session = { id: "session_a", driver: "claude", projectId: "project_a", workspace: { mode: "local", path: "/work" } } as Session;
  const shot = () => new File(["x"], "shot.png", { type: "image/png" });
  const model = (root: ParentNode) => root.querySelector('[aria-label^="Model:"]');
  const tray = (host: HTMLElement) => host.querySelector("[data-slot=composer-foot]")!;
  const oneLine = (host: HTMLElement) => model(tray(host)) !== null;

  const expand = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Open the full composer"]');
  const collapsed = "calc(5lh + 1.25rem)";

  test("narrow shows the collapsed composer it takes while reading back", async () => {
    const { host, editor } = await narrowable({ session }, 100);
    expect(expand(host)).not.toBeNull();
    expect(editor.style.maxHeight).toBe(collapsed);
    expect(oneLine(host)).toBe(true);
    expect(host.querySelector('button[aria-label="Send"]')).not.toBeNull();
  });

  test("focusing and typing while narrow keeps it collapsed, and Enter sends", async () => {
    let sends = 0;
    const { host, editor } = await narrowable({ session, onSubmit: () => sends++ }, 100);
    await click(editor);
    await type(editor, "quick note");
    key(editor, { key: "Enter" });
    await flush();
    expect(sends).toBe(1);
    expect(expand(host)).not.toBeNull();
    expect(oneLine(host)).toBe(true);
  });

  test("expanded while narrow, the full box keeps the model in the tray", async () => {
    const { host, editor } = await narrowable({ session, initial: "longer thought" }, 100);
    await click(expand(host)!);
    expect(expand(host)).toBeNull();
    expect(editor.style.maxHeight).toBe("");
    expect(oneLine(host)).toBe(true);
    expect(editor.textContent).toBe("longer thought");
  });

  test("wide keeps the full composer, with the model in the card", async () => {
    const { host } = await narrowable({ session }, 2000);
    expect(oneLine(host)).toBe(false);
    expect(model(host)).not.toBeNull();
  });

  test("the words, the attachments and the focus survive switching both ways", async () => {
    const { host, editor, resize } = await narrowable({ session, initial: "half a thought", files: [shot()] }, 2000);
    act(() => editor.focus());
    await resize(100);
    expect(oneLine(host)).toBe(true);
    expect(host.querySelector("[data-slot=composer-editor]")).toBe(editor);
    expect(editor.textContent).toBe("half a thought");
    expect(host.textContent).toContain("shot.png");
    expect(document.activeElement).toBe(editor);
    await resize(2000);
    expect(oneLine(host)).toBe(false);
    expect(editor.textContent).toBe("half a thought");
    expect(host.textContent).toContain("shot.png");
    expect(document.activeElement).toBe(editor);
  });

  test("it turns mini below a 784px column and comes back only at 800, so the edge never flickers", async () => {
    const { host, resize } = await narrowable({ session }, 2000);
    expect(oneLine(host)).toBe(false);
    await resize(783);
    const flips: boolean[] = [];
    for (const width of [790, 784, 799, 786, 783]) {
      await resize(width);
      flips.push(oneLine(host));
    }
    expect(flips.every(Boolean)).toBe(true);
    await resize(800);
    expect(oneLine(host)).toBe(false);
    await resize(790);
    expect(oneLine(host)).toBe(false);
  });

  test("controls that would wrap in a wider column still turn it mini", async () => {
    layout.item = 400;
    const { host } = await narrowable({ session }, 1000);
    expect(expand(host)).not.toBeNull();
  });

  test("a new conversation's canvas is mini too", async () => {
    const { host } = await narrowable({ fresh: true }, 500);
    expect(expand(host)).not.toBeNull();
  });

  test("a composer opened full while reading back turns mini once the column narrows", async () => {
    const { host, resize } = await narrowable({ session, compact: true }, 2000);
    await click(expand(host)!);
    expect(expand(host)).toBeNull();
    await resize(600);
    expect(expand(host)).not.toBeNull();
  });
});
