// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, expect, test } from "bun:test";
import { act, createRef, useImperativeHandle, useState, type Ref } from "react";
import { bindCommands, COMMANDS, type CommandId } from "../commands";
import type { SidebarSession } from "@/features/sessions";
import { click, flush, installTestDom, mount, stubFetch } from "@/lib/testing/dom";
import { clearField, typeInto } from "@/lib/testing/type-into";
import { CommandPalette, type CommandPalettePage } from "./command-palette";
import type { NewConversationTarget } from "@/features/projects";

installTestDom();

const unbinds: (() => void)[] = [];
afterEach(() => {
  while (unbinds.length > 0) unbinds.pop()!();
  window.localStorage.clear();
});

const target: NewConversationTarget = { id: "p1", name: "Alpha" };
const session = { id: "s1", title: "Chat one", projectName: "Alpha" } as SidebarSession;

type Props = { open: boolean; page?: CommandPalettePage; query?: string };
type Control = { set: (props: Props) => void };
const control = createRef<Control>();

function Harness({ log, ref, ...initial }: Props & { log: string[]; ref: Ref<Control> }) {
  const [props, set] = useState<Props>(initial);
  useImperativeHandle(ref, () => ({ set }), []);
  return (
    <CommandPalette
      {...props}
      targets={[target]}
      sessions={[session]}
      railOpen
      onOpenChange={(open) => log.push(`open:${open}`)}
      onRun={(id) => log.push(`run:${id}`)}
      onChooseProject={(chosen) => log.push(`project:${chosen.id}`)}
      onOpenSession={(opened) => log.push(`session:${opened.id}`)}
      onRegistered={() => log.push("registered")}
    />
  );
}

async function openPalette(props: Partial<Props> = {}) {
  const log: string[] = [];
  await mount(<Harness open {...props} log={log} ref={control} />);
  await flush();
  return log;
}

async function rerender(props: Props) {
  await act(async () => control.current!.set(props));
  await flush();
}

function bind(...ids: CommandId[]) {
  unbinds.push(bindCommands(Object.fromEntries(ids.map((id) => [id, () => {}]))));
}

const field = () => document.querySelector('[role="combobox"]') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')];
const option = (label: string) => options().find((node) => node.textContent?.startsWith(label));
const highlighted = () => document.getElementById(field().getAttribute("aria-activedescendant") ?? "");

async function key(init: KeyboardEventInit) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

test("every verb the rail binds is a command in the registry", () => {
  const ids = new Set(COMMANDS.map((command) => command.id));
  for (const id of ["new-conversation", "new-conversation-in", "add-project", "search-sessions", "toggle-rail"] as const) {
    expect(ids.has(id)).toBe(true);
  }
});

test("Actions lists only what can run, never the palette itself, and moves the rail to Quick settings", async () => {
  await openPalette();
  expect(option("Settings…")).toBeDefined();
  expect(option("Add Project…")).toBeUndefined();
  await rerender({ open: false });

  bind("add-project", "search-sessions", "toggle-rail");
  await rerender({ open: true });
  const actions = [...document.querySelectorAll('[role="group"][aria-label="Actions"] [role="option"]')].map((node) => node.textContent);
  expect(actions.some((text) => text?.startsWith("Add Project…"))).toBe(true);
  expect(actions.some((text) => text?.startsWith("Command Palette"))).toBe(false);
  expect(actions.some((text) => text?.startsWith("Toggle Rail"))).toBe(false);
  const quick = document.querySelector('[role="group"][aria-label="Quick settings"]');
  expect(quick?.textContent).toContain("RailShown");
});

test("a quick row applies, shows its new state, and leaves the palette open", async () => {
  const log = await openPalette();
  const before = option("Colour scheme")!.textContent;
  await click(option("Colour scheme"));
  expect(option("Colour scheme")!.textContent).not.toBe(before);
  expect(log).toEqual([]);
});

test("the Accent page is a page of this dialog, and Backspace on an empty field walks back", async () => {
  const log = await openPalette();
  await click(option("Accent colour"));
  expect(field().getAttribute("aria-label")).toBe("Search accents");
  expect(options().map((node) => node.textContent)).toContain("Indigo");
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);

  await typeInto(field(), "s");
  await key({ key: "Backspace" });
  expect(field().getAttribute("aria-label")).toBe("Search accents");

  await clearField(field());
  await key({ key: "Backspace" });
  expect(field().getAttribute("aria-label")).toBe("Search commands, projects and conversations");
  expect(log).toEqual([]);
});

test("the chord sits at the row's right", async () => {
  await openPalette();
  expect(option("New Conversation")!.textContent).toMatch(/^New Conversation.+N$/);
});

test("the arrows wrap over every section, and Enter takes the highlighted row", async () => {
  const log = await openPalette();
  expect(highlighted()?.textContent).toStartWith("New Conversation");
  await key({ key: "ArrowUp" });
  expect(highlighted()?.textContent).toStartWith("Chat one");
  await key({ key: "ArrowDown" });
  expect(highlighted()?.textContent).toStartWith("New Conversation");
  await key({ key: "ArrowUp" });
  await key({ key: "ArrowUp" });
  expect(highlighted()?.textContent).toStartWith("AAlpha");
  await key({ key: "Enter" });
  expect(log).toEqual(["open:false", "project:p1"]);
});

test("⌘1 means nothing here, and an IME's Enter commits a candidate rather than taking a row", async () => {
  const log = await openPalette();
  await key({ key: "1", metaKey: true });
  await key({ key: "Enter", isComposing: true });
  await key({ key: "Enter", keyCode: 229 });
  expect(log).toEqual([]);
  expect(highlighted()?.textContent).toStartWith("New Conversation");
});

test("the highlight is announced, each section is a named group, and the field has focus", async () => {
  await openPalette();
  expect(document.querySelector('[role="listbox"]')?.id).toBe(field().getAttribute("aria-controls"));
  expect(field().getAttribute("aria-activedescendant")).toBe("command-palette-0");
  const groups = [...document.querySelectorAll('[role="group"]')].map((node) => node.getAttribute("aria-label"));
  expect(groups).toEqual(["Actions", "Quick settings", "Projects", "Recent conversations"]);
  expect(document.activeElement).toBe(field());
});

test("a row that walks opens the project palette's own page without closing, and Backspace comes back", async () => {
  bind("new-conversation-in");
  const log = await openPalette();
  await click(option("New Conversation In…"));
  expect(field().getAttribute("aria-label")).toBe("Search projects");
  expect(log).toEqual([]);
  await key({ key: "Backspace" });
  expect(field().getAttribute("aria-label")).toBe("Search commands, projects and conversations");
});

test("any other command closes the dialog first, then runs", async () => {
  const log = await openPalette();
  await click(option("Settings…"));
  expect(log).toEqual(["open:false", "run:settings"]);
});

test("a fresh palette every time, seeded with what the rail's field held", async () => {
  await openPalette();
  await typeInto(field(), "zzz");
  await key({ key: "ArrowDown" });
  await rerender({ open: false });
  await rerender({ open: true, query: "Chat" });
  expect(field().value).toBe("Chat");
  expect(options().map((node) => node.textContent)).toEqual(["Chat oneAlpha"]);
  expect(field().getAttribute("aria-activedescendant")).toBe("command-palette-0");
});

test("a page asked for while the palette is already up is still a page asked for", async () => {
  await openPalette();
  await rerender({ open: true, page: "projects" });
  expect(field().getAttribute("aria-label")).toBe("Search projects");
});

test("the legend names the keys", async () => {
  await openPalette();
  const text = document.body.textContent ?? "";
  for (const hint of ["↑↓ Navigate", "Enter Select", "Esc Close"]) expect(text).toContain(hint);
});

test("it searches what the rail hands it and reads nothing of its own", async () => {
  const calls = stubFetch({});
  await openPalette();
  await typeInto(field(), "Alpha");
  expect(options().map((node) => node.textContent)).toContain("AAlphaLocal");
  expect(calls).toEqual([]);
});
