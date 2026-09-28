// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  projectId?: string;
  session?: Session;
  onSubmit?: () => void;
  onStop?: () => void;
};

function Box({ initial = "", files = [], busy = false, projectId, session, onSubmit = () => {}, onStop = () => {} }: BoxProps) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <p data-testid="draft">{draft}</p>
      <Composer
        draft={draft}
        ready
        attachments={files}
        onAttach={() => {}}
        busy={busy}
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
