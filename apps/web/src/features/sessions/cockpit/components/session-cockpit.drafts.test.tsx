import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_INBOX_POLICY, type EngineRequest, type Session, type Turn } from "@telar/engine-client";
import { flush, installTestDom, mount } from "@/test/dom";

installTestDom();
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

const realNavigation = await import("next/navigation");
const installNavigation = () =>
  mock.module("next/navigation", () => ({
    ...realNavigation,
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
    usePathname: () => window.location.pathname,
    useSearchParams: () => new URLSearchParams(),
    redirect: () => {},
  }));
installNavigation();

const { SessionCockpit } = await import("./session-cockpit");
const { SidebarProvider } = await import("@/ui/sidebar");
const { clearTranscriptCache } = await import("../transcript-cache");
const { readDraft, writeDraft } = await import("@/features/composer");
const { runCommand } = await import("@/features/commands");

const STARTED = 1_700_000_000_000;

const record = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    title: id,
    projectId: "project_1",
    environmentId: "env_1",
    state: "active",
    createdAt: STARTED,
    updatedAt: STARTED,
    providerInstanceId: "instance_1",
    driver: "claude",
    workspace: { mode: "local", path: "/tmp/project_1" },
    envMode: "local",
    runtimeMode: "standard",
    interactionMode: "interactive",
    detached: false,
    activity: "idle",
    ...over,
  }) as unknown as Session;

type Call = { method: string; url: string; body: unknown; pathname: string };
let calls: Call[] = [];

type Opening = { session?: Partial<Session>; turns?: Turn[]; tasks?: unknown[]; requests?: EngineRequest[] };

function wire({ opening = {}, create }: { opening?: Opening; create?: (id: string) => Promise<void> } = {}) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, pathname: window.location.pathname });
    const id = /sessions\/([^/?]+)/.exec(url)?.[1] ?? "";
    if (method === "POST" && url.endsWith("/api/projects/project_1/sessions")) {
      await create?.(body.id);
      return Response.json({ session: record(body.id) });
    }
    if (method === "PATCH" && /\/api\/sessions\/[^/]+$/.test(url)) return Response.json({ session: record(id, body) });
    if (url.includes("/bootstrap")) {
      return Response.json({
        session: record(id, opening.session),
        turns: opening.turns ?? [],
        items: [],
        tasks: opening.tasks ?? [],
        requests: opening.requests ?? [],
        cursor: 1,
        events: [],
        subscriptions: [],
      });
    }
    if (url.includes("/turns")) return Response.json({ runId: "run_next", state: "queued" });
    if (url.includes("/events")) return Response.json({ events: [], cursor: 1, more: false });
    if (url.includes("/browser")) return Response.json({ browser: { tabs: [], canStart: false } });
    if (url.includes("/api/projects")) return Response.json({ projects: [{ id: "project_1", name: "exoplanets", root: "/tmp" }] });
    if (url.includes("/api/session-defaults")) return Response.json({ sessionDefaults: { envMode: "local" } });
    if (url.includes("/api/models")) return Response.json({ catalogue: { models: [] } });
    if (url.includes("/api/inbox")) return Response.json({ inbox: DEFAULT_INBOX_POLICY });
    return Response.json({});
  }) as typeof fetch;
}

beforeEach(() => {
  clearTranscriptCache();
  calls = [];
});

const settle = () => flush();

const cockpit = (sessionId?: string) => (
  <SidebarProvider>
    <SessionCockpit projectId="project_1" projectName="exoplanets" {...(sessionId ? { sessionId } : {})} />
  </SidebarProvider>
);

async function open(sessionId?: string) {
  window.history.replaceState(null, "", `/projects/project_1/sessions/${sessionId ?? "new"}`);
  installNavigation();
  const mounted = await mount(cockpit(sessionId));
  await settle();
  return mounted;
}

const editor = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="composer-editor"]')!;

async function type(host: HTMLElement, text: string) {
  const box = editor(host);
  act(() => {
    box.textContent = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function send(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await act(async () => button.click());
}

describe("the first message of a new conversation", () => {
  test("mints the session's id, moves the address to it before the create, and sends that id", async () => {
    wire();
    const { host } = await open();
    await type(host, "hello there");
    await send(host);
    await settle();
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/projects/project_1/sessions"));
    expect(created).toBeDefined();
    const id = (created!.body as { id: string }).id;
    expect(id).toMatch(/^session_[0-9a-f]{32}$/);
    expect(created!.pathname).toBe(`/projects/project_1/sessions/${id}`);
    const turn = calls.find((call) => call.method === "POST" && call.url.includes(`/sessions/${id}/turns`));
    expect((turn!.body as { input: string }).input).toBe("hello there");
  });

  test("clears the canvas's stored draft, so the next new conversation opens empty", async () => {
    writeDraft(undefined, "project_1", "sent once");
    wire();
    const { host } = await open();
    expect(editor(host).textContent).toBe("sent once");
    await send(host);
    await settle();
    expect(calls.some((call) => call.url.includes("/turns"))).toBe(true);
    expect(readDraft(undefined, "project_1")).toBe("");
  });

  test("a follow-up typed while the session is being created stays in the box", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    wire({ create: () => held });
    const { host } = await open();
    await type(host, "first");
    await send(host);
    await settle();
    await type(host, "a follow-up");
    await act(async () => release());
    await settle();
    await send(host);
    await settle();
    const sent = calls.filter((call) => call.method === "POST" && call.url.includes("/turns")).map((call) => (call.body as { input: string }).input);
    expect(sent).toEqual(["first", "a follow-up"]);
  });
});

describe("switching conversations", () => {
  test("saves the outgoing draft under its own conversation and loads the incoming one's", async () => {
    writeDraft("session_drafts_a", "project_1", "");
    writeDraft("session_drafts_b", "project_1", "b's own draft");
    wire();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = async (id: string) => {
      window.history.replaceState(null, "", `/projects/project_1/sessions/${id}`);
      installNavigation();
      await act(async () => root.render(cockpit(id)));
      await settle();
    };
    try {
      await show("session_drafts_a");
      await type(host, "half a thought");
      await show("session_drafts_b");
      expect(editor(host).textContent).toBe("b's own draft");
      expect(readDraft("session_drafts_a", "project_1")).toBe("half a thought");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe("⌘P over the conversation you are reading", () => {
  const pinPatches = (id: string) =>
    calls.filter((call) => call.method === "PATCH" && call.url.endsWith(`/api/sessions/${id}`)).map((call) => call.body);

  test("pins an unpinned conversation", async () => {
    wire();
    await open("session_drafts_pin");
    await act(async () => void runCommand("pin-session"));
    await settle();
    expect(pinPatches("session_drafts_pin")).toEqual([{ settledOverride: "active" }]);
  });

  test("unpins a pinned one by clearing the override", async () => {
    wire({ opening: { session: { settledOverride: "active" } as Partial<Session> } });
    await open("session_drafts_unpin");
    await act(async () => void runCommand("pin-session"));
    await settle();
    expect(pinPatches("session_drafts_unpin")).toEqual([{ settledOverride: null }]);
  });
});

describe("a request opened under a sub-agent's background claim", () => {
  test("is drawn on the turn that spawned the agent, with its decision buttons", async () => {
    const id = "session_drafts_claim";
    const turns = [
      { runId: "run_ask", sessionId: id, sequence: 1, input: "research this", state: "completed", acceptedAt: 1, updatedAt: 1 },
      {
        runId: "run_claim",
        sessionId: id,
        sequence: 2,
        input: "",
        origin: "provider",
        providerReason: { kind: "background_task", taskId: "task_toolu_agent" },
        state: "running",
        acceptedAt: 2,
        updatedAt: 2,
      },
    ] as unknown as Turn[];
    const request = {
      id: "req_claim",
      runId: "run_claim",
      sessionId: id,
      state: "open",
      openedAt: STARTED,
      detail: { kind: "command_execution", command: { command: "ls -la", cwd: "/tmp/project_1" } },
    } as unknown as EngineRequest;
    const tasks = [{ id: "task_toolu_agent", sessionId: id, runId: "run_ask", kind: "agent", backgrounded: true, state: "running", title: "research", startedAt: 1, updatedAt: 1, items: [] }];
    wire({ opening: { turns, tasks, requests: [request] } });
    const { host } = await open(id);
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels).toContain("Allow once");
  });
});
