import { mock } from "bun:test";
import * as navigation from "next/navigation";
import { act } from "react";
import { flush, mount } from "@/test/dom";

export const pushes: string[] = [];
const router = { push: (to: string) => pushes.push(to), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };
// Module mocks are process-wide and last-wins, and this file is imported once per
// process, so every mount re-installs the router another file may have replaced.
const installNavigation = () =>
  mock.module("next/navigation", () => ({
    ...navigation,
    usePathname: () => "/",
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(),
    redirect: navigation.redirect,
  }));
installNavigation();

let served: RailRequest[] = [];

export type RailRequest = { path: string; search: string; ifNoneMatch?: string };
export type LiveAnswer = { status?: number; etag?: string; body?: unknown };

const HOUR = 3_600_000;

/** A live-list row as the engine sends it; `idleHours` ages it. */
export function liveRow(id: string, extra: Record<string, unknown> & { idleHours?: number } = {}) {
  const { idleHours = 0, ...rest } = extra;
  const at = Date.now() - idleHours * HOUR;
  return {
    id,
    title: `Title ${id}`,
    projectId: "p1",
    createdAt: at,
    updatedAt: at,
    state: "active",
    driver: "claude",
    workspace: { mode: "local" },
    activity: "idle",
    ...rest,
  };
}

export const project = (id: string, name: string) => ({ id, name, root: `/tmp/${id}` });

/**
 * Answers the rail's reads: `/api/hosts` with `hosts`, every host's live list
 * with `live`, and anything else 404. Returns every request, in order.
 */
export function stubRail(live: (request: RailRequest) => LiveAnswer, hosts: { id: string; name: string }[] = []) {
  const requests: RailRequest[] = [];
  served = requests;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    const request = { path: url.pathname, search: url.search, ...(ifNoneMatch ? { ifNoneMatch } : {}) };
    requests.push(request);
    if (url.pathname === "/api/hosts") return Response.json({ hosts });
    if (/^\/api(\/hosts\/[^/]+)?\/sessions\/live$/.test(url.pathname)) {
      const answer = live(request);
      const headers = answer.etag ? { etag: answer.etag } : undefined;
      if (answer.status === 304) return new Response(null, { status: 304, ...(headers ? { headers } : {}) });
      return Response.json(answer.body, { status: answer.status ?? 200, ...(headers ? { headers } : {}) });
    }
    return Response.json({ error: { message: `no route ${url.pathname}` } }, { status: 404 });
  }) as typeof fetch;
  return requests;
}

export const liveReads = (requests: RailRequest[]) => requests.filter((request) => request.path.endsWith("/sessions/live"));

// A query-suffixed specifier is its own module instance, so a file that mocks
// `app-sidebar` (app-shell.solo.test.tsx) neither replaces nor observes this one.
export const loadRail = () => import("@/features/sessions/rail/app-sidebar?rail" as string) as Promise<typeof import("@/features/sessions/rail/app-sidebar")>;

/** Mounts the whole rail and waits for its first pass (and the layout read) to land. */
export async function mountRail() {
  installNavigation();
  window.localStorage.clear();
  pushes.length = 0;
  const { AppSidebarBody } = await loadRail();
  const { SidebarProvider } = await import("@/ui/sidebar");
  const { host } = await mount(
    <SidebarProvider>
      <AppSidebarBody />
    </SidebarProvider>,
  );
  // The layout read is deferred; a test that ends before it lands leaks it past the fetch stub.
  const layoutRead = () => served.some((request) => request.path === "/api/sidebar-layout");
  await flush(layoutRead);
  await flush();
  return host;
}

/** Runs one more pass, as the poll's next tick would. */
export async function nextPass() {
  const { PROJECTS_CHANGED_EVENT } = await import("@/features/projects/projects");
  await act(async () => window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT)));
  await flush();
  await flush();
}
