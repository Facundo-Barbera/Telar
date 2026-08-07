// Structural coverage for the live mount. This repository deliberately has no
// DOM test environment, so the pointer arithmetic lives in sidebar-width.test
// and this contract prevents that tested primitive from becoming dead again.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("the production sidebar mount", () => {
  test("mounts the offcanvas resize rail with the shared app preferences", () => {
    const sidebar = read("components/app-sidebar.tsx");
    const layout = read("app/layout.tsx");

    expect(sidebar).toContain('collapsible="offcanvas"');
    expect(sidebar).toContain("resizable={APP_SIDEBAR_RESIZABLE}");
    expect(sidebar).toContain("<SidebarRail />");
    expect(sidebar).toContain("minWidth: SIDEBAR_RESIZE_MIN_WIDTH");
    expect(sidebar).toContain("APP_SIDEBAR_MAIN_MIN_WIDTH");
    expect(layout).toContain("<SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY}>");
    expect(sidebar).toContain("storageKey: APP_SIDEBAR_STORAGE_KEY");
    expect(read("components/ui/sidebar.tsx")).toContain('title={canResize ? "Drag to resize sidebar"');
    expect(read("components/ui/sidebar.tsx")).toContain("focus-visible:after:bg-ring");
  });

  test("keeps sidebar controls in layout instead of floating over route content", () => {
    const sidebar = read("components/app-sidebar.tsx");
    const trigger = read("components/main-sidebar-trigger.tsx");
    const pageHeader = read("components/common/page-header.tsx");
    const sessionView = read("components/session/session-view.tsx");
    const settingsShell = read("components/settings/settings-shell.tsx");
    const layout = read("app/layout.tsx");

    expect(sidebar).toContain('aria-label="Hide main sidebar"');
    expect(sidebar).not.toContain('data-slot="sidebar-reveal-rail"');
    expect(trigger).toContain('aria-label="Show main sidebar"');
    expect(trigger).toContain("if (!visible) return fallback");
    expect(pageHeader).toContain("<MainSidebarTrigger />");
    expect(sessionView).toContain('className="-mx-[7px]"');
    expect(sessionView).toContain("fallback={<FolderGit2Icon");
    expect(settingsShell).toContain("<MainSidebarTrigger />");
    expect(layout).not.toContain("<SidebarTrigger");
    expect(layout).not.toContain("fixed left-2 top-2");
  });

  test("flushes a queued pointer width before persisting on release", () => {
    const primitive = read("components/ui/sidebar.tsx");
    const endDrag = primitive.slice(
      primitive.indexOf("const endDrag"),
      primitive.indexOf("// A rail unmounted mid-drag"),
    );

    expect(endDrag.indexOf("applyPendingWidth(drag)")).toBeGreaterThan(-1);
    expect(endDrag.indexOf("setSidebarWidth")).toBeGreaterThan(
      endDrag.indexOf("applyPendingWidth(drag)"),
    );
  });

  test("does not mount the desktop rail in the mobile sheet", () => {
    expect(read("components/ui/sidebar.tsx")).toContain("if (isMobile) return null");
  });

  test("mounts one session sidebar and retires both legacy navigation trees", () => {
    const sidebar = read("components/app-sidebar.tsx");
    const sessionPage = read("app/projects/[name]/sessions/[id]/page.tsx");

    expect(sidebar).toContain("deriveSessionList");
    expect(sidebar).toContain('cachedJson<{ chats?: ChatMeta[] }>("/api/chats?archived=include"');
    expect(sidebar).toContain("isLoomRunning(loom.state)");
    // The sidebar is a chat inbox. Looms carry no read/settle/snooze state and
    // a non-ready one has no terminal action a person can take, so an
    // attention group for them here could only accumulate — that signal
    // belongs to /looms and the dashboard, which can act on it. isLoomRunning
    // stays: it feeds the activity indicator, not a list.
    expect(sidebar).not.toContain("isLoomNeedsYou");
    expect(sidebar).not.toContain("<SidebarGroupLabel>Needs you");
    expect(sidebar).not.toContain("ProjectRow");
    expect(sessionPage).not.toContain("SessionsRail");
    // The row moved out of app-sidebar.tsx into its own component; the claim
    // being pinned is unchanged — session links must never speculatively fetch
    // a force-dynamic transcript route.
    expect(read("components/session/session-row.tsx")).toContain("prefetch={false}");
  });

  test("clears a focused run without starting an RSC navigation loop", () => {
    const view = read("components/session/session-view.tsx");
    const focusCleanup = view.slice(
      view.indexOf("if (!focusRunId) return"),
      view.indexOf("const ultraRunList"),
    );

    expect(focusCleanup).toContain('window.history.replaceState(null, "", pathname)');
    expect(focusCleanup).not.toContain("\n    router.replace(");
    // DEPS GREW BY ONE (issue #13): arrival used to reveal the run by putting it
    // in `transcriptItems`, so selecting it was the whole job. Now that the pane
    // lives in the right-panel dock rather than the transcript, arrival must ALSO
    // open the dock — `openRightPanelActivity(resolvedRightPanelScopeKey)` — so
    // the scope key the effect closes over has to be a real dependency, not an
    // accidental stale closure.
    expect(focusCleanup).toContain("}, [focusRunId, pathname, resolvedRightPanelScopeKey]);");
  });

  test("keeps stale inspector callbacks from crashing Fast Refresh", () => {
    const inspector = read("components/session/workspace-inspector.tsx");

    expect(inspector).toContain('typeof onReservedChange === "function"');
    expect(inspector).toContain("notifyReservedChange(sidebarMode)");
    expect(inspector).toContain("notifyReservedChange(false)");
  });

  test("opens the shared new-session workspace without a duplicate project prompt", () => {
    const sidebar = read("components/app-sidebar.tsx");

    expect(sidebar).toContain('aria-label="New session"');
    expect(sidebar).toContain('render={<Link href="/" />}');
    expect(sidebar).not.toContain("Choose the project this session belongs to.");
  });

  test("does not mark Projects active inside a session workspace", () => {
    const sidebar = read("components/app-sidebar.tsx");

    expect(sidebar).toContain("const inSessionWorkspace =");
    expect(sidebar).toContain('href === "/projects" && inSessionWorkspace');
  });

  test("server-seeds the persistent shell and shares one account registry", () => {
    const layout = read("app/layout.tsx");
    const sidebar = read("components/app-sidebar.tsx");
    const accounts = read("lib/use-accounts.ts");

    expect(layout).toContain("const initialSidebarData: AppSidebarInitialData");
    expect(layout).toContain("renderedAt: Date.now()");
    expect(layout).toContain("<AppSidebar initialData={initialSidebarData}");
    expect(layout).toContain("<AccountsProvider initial={accountEnvelope}>");
    expect(sidebar).toContain("if (!initialData) queueMicrotask");
    // The seeded clock must reach the row's time formatting rather than each
    // row reading Date.now() — that is what keeps SSR and the first client
    // render agreeing. The row now lives in its own file; the claim does not.
    expect(read("components/session/session-row.tsx")).toContain(
      "fmtAgo(session.updatedAt, renderedAt)",
    );
    expect(read("components/session/session-row.tsx")).not.toContain("Date.now()");
    expect(accounts).toContain("const AccountsContext = createContext");
    expect(accounts).toContain('refreshIncludes(event, "accounts")');
  });

  test("broadcasts sidebar refresh when a session save completes", () => {
    const view = read("components/session/session-view.tsx");
    const saved = view.slice(view.indexOf('case "saved"'), view.indexOf('case "error"'));
    expect(saved).toContain("dispatchTelarRefresh({");
    expect(saved).toContain('domains: ["chats", "usage"]');
    expect(saved).not.toContain('new Event("telar:refresh")');
  });

  test("a completed session never double-renders through the feed subscriber", () => {
    // The once-per-session reconnectedRef guard is GONE by design: the feed
    // subscriber deliberately re-arms so a server-drained queued turn streams
    // into the open mount (feel contract rule 7). The double-render defense
    // moved: a fresh mount replays with NO cursor, and the events route's
    // first-tick gate finishes an idle session silently — while a local POST
    // owns rendering, arming refuses outright. Pin all three.
    const view = read("components/session/session-view.tsx");
    expect(view).not.toContain("reconnectedRef");
    const subscriber = view.slice(
      view.indexOf("// THE SESSION-FEED SUBSCRIBER"),
      view.indexOf("const send = useCallback"),
    );
    expect(subscriber).toContain("if (abortRef.current) return;");
    expect(subscriber).toContain("if (reconnectAbortRef.current) return;");
    expect(subscriber).toContain("feedCursorRef.current = null; // fresh mount");
  });
});
