// Structural coverage for the route-level panel host. The repository has no
// DOM test environment, so store transitions are tested separately while this
// contract pins the production mount, hosted Git surface, and width policy.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("the production right-panel mount", () => {
  test("mounts one session-owned dock with live Activity state", () => {
    const page = read("app/projects/[name]/sessions/[id]/page.tsx");
    const session = read("components/session/session-view.tsx");
    expect(page).not.toContain('import { RightPanel } from "@/components/right-panel/right-panel"');
    expect(session).toContain('import { RightPanel, RightPanelTrigger } from "@/components/right-panel/right-panel"');
    expect(session).toContain("<RightPanelTrigger scopeKey={resolvedRightPanelScopeKey}");
    expect(session).toContain("activityCount={activityCount}");
    expect(session).toContain('surface="panel"');
    expect(session).not.toContain("rail={<SubagentRail");
  });

  test("hosts the existing Git surface rather than copying it", () => {
    const panel = read("components/right-panel/right-panel.tsx");
    expect(panel).toContain('import("@/components/projects/git-tab")');
    expect(panel).toContain("<GitTab name={project} />");
    expect(panel).not.toContain("GitHeaderStrip");
    expect(panel).not.toContain("WorktreesSection");
  });

  test("keeps the workspace inspector independent from the surface dock", () => {
    const inspector = read("components/session/workspace-inspector.tsx");
    const session = read("components/session/session-view.tsx");
    const message = read("components/ai-elements/message.tsx");
    expect(inspector).toContain('aria-label="Pinned summary"');
    expect(inspector).toContain("createPortal(");
    expect(inspector).toContain('className="fixed z-[70]');
    expect(inspector).toContain('data-presentation={sidebarMode ? "sidebar" : "floating"}');
    expect(inspector).toContain("right: 12");
    expect(inspector).toContain("window.innerHeight - top - 12");
    expect(inspector).toContain("style={sidebarMode ? { maxHeight: anchor.maxHeight } : undefined}");
    expect(inspector).toContain("available < 280");
    expect(inspector).toContain("if (!open) return;");
    expect(inspector).toContain("{browserTabs.length > 0 && (");
    expect(inspector).toContain("Math.min(320, available)");
    expect(inspector).not.toContain("animate-in");
    expect(inspector).toContain("<AnimatePresence initial={false}>");
    expect(inspector).toContain("sidebarMode && !reduceMotion ? { opacity: 0, x: 28 } : false");
    expect(inspector).toContain("sidebarMode && !reduceMotion ? { opacity: 0, x: 28 } : undefined");
    expect(inspector).toContain("duration: reduceMotion ? 0 : 0.28");

    expect(session).toContain("transition-[padding-right] duration-300");
    expect(session).toContain('workspaceInspectorReserved && "min-[1180px]:pr-[21rem]"');
    expect(message).toContain("max-w-[50rem]");
    expect(message).not.toContain("max-w-7xl");
    expect(message).toContain("group-[.is-assistant]:w-full group-[.is-user]:w-fit");
    const kinds = read("components/conversation/kinds.tsx");
    expect(kinds).toContain('"flex w-full min-w-0 flex-col gap-0.5 text-xs"');
    expect(kinds).not.toContain('open ? "w-full" : "w-fit"');

    const conversation = read("components/conversation/conversation.tsx");
    expect(conversation).toContain("const TranscriptViewport = memo(");
    expect(conversation).toContain("empty={items.length === 0 ? empty : undefined}");
    expect(session).toContain("const transcriptItems = useMemo<TranscriptItem[]>");
    expect(session).toContain("const liveWork = useMemo<WorkState | null>");
  });

  test("uses an inline dock when wide and a drawer instead of disappearing below 1180px", () => {
    const panel = read("components/right-panel/right-panel.tsx");
    expect(panel).toContain('RIGHT_PANEL_VISIBLE_CLASS = "flex"');
    expect(panel).toContain('"workspace-fullscreen" : "drawer-below-1180"');
    expect(panel).toContain("<AnimatePresence initial={false}>");
    expect(panel).toContain("<motion.aside");
    expect(panel).toContain("marginRight: inlinePanel && !fullscreen ? -preferredWidth : 0");
    expect(panel).toContain("void window.telarDesktop?.browser.setVisible(scopeKey, false)");
    expect(panel).toContain("absolute inset-y-0 right-0");
    expect(panel).toContain("min-[1180px]:relative");
    expect(panel).toContain('aria-label="Open right panel"');
    expect(panel).toContain("export function RightPanelTrigger");
    expect(panel).not.toContain("pointer-events-none absolute right-2 top-1.5");
    expect(panel).toContain("rounded-2xl border border-border bg-background");
    expect(panel).toContain('"workspace-fullscreen"');
    expect(panel).toContain('aria-label={fullscreen ? "Exit fullscreen panel" : "Open panel fullscreen"}');
    expect(panel).toContain('aria-label="Resize right panel"');
    expect(panel).toContain("RIGHT_PANEL_WIDTH_STORAGE_KEY");
    expect(panel).toContain('setProperty("--right-panel-width"');
    expect(panel).toContain("setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY");
    expect(panel).not.toContain("flex-col border-l border-border bg-muted/10");
    expect(panel).toContain("h-10 w-px rounded-full");
  });

  test("pins tab activation, closing gestures, context actions, and disabled reasons", () => {
    const tabs = read("components/right-panel/tab-strip.tsx");
    expect(tabs).toContain("onAuxClick");
    expect(tabs).toContain("group-hover/tab:opacity-70");
    expect(tabs).toContain("<ContextMenu.Root>");
    expect(tabs).toContain("Close others");
    expect(tabs).toContain("Close tabs to the right");
    expect(tabs).toContain("<TooltipContent side=\"left\">{reason}</TooltipContent>");
  });

  test("mounts one event-driven controlled browser shared with agents", () => {
    const browser = read("components/right-panel/browser-surface.tsx");
    const panel = read("components/right-panel/right-panel.tsx");
    const session = read("components/session/session-view.tsx");
    const controller = read("lib/use-controlled-browser.ts");
    const desktopHost = read("components/desktop-browser-host.tsx");
    const layout = read("app/layout.tsx");
    const events = read("app/api/browser/events/route.ts");
    const chat = read("app/api/chat/route.ts");
    const desktopMain = read("../desktop/main.js");
    const browserManager = read("../desktop/browser-manager.js");
    expect(browser).not.toContain("<iframe");
    expect(browser).toContain('aria-label="Browser address"');
    expect(controller).toContain('cachedJson<LocalServersResponse>("/api/local-servers"');
    expect(controller).toContain('activeTab.url !== "about:blank"');
    expect(controller).toContain("if (active?.url) onActiveUrl?.(active.url)");
    expect(browser).toContain("Local servers");
    expect(browser).toContain('nextUrl === "about:blank" ? "" : nextUrl');
    expect(browser).toContain('target="_blank"');
    expect(controller).not.toContain('new EventSource("/api/browser/events")');
    expect(controller).toContain("subscribeBrowserRuntimeEvents");
    expect(browser).toContain("state.screenshot && hasNavigatedTab");
    expect(browser).toContain("<DesktopBrowserViewport bridge={desktopBridge}");
    expect(controller).toContain("bridge.setBounds");
    expect(controller).toContain("await bridge.setVisible(scopeKey, true)");
    expect(controller).toContain("performance.now() + 360");
    expect(browser).toContain('className="min-h-0 flex-1 bg-background"');
    // The claim is that the tool call is SCOPED — the host routes by scopeKey
    // rather than to a single ambient browser. The exact spelling moved when
    // desktop-browser-host started validating id/scopeKey/name off the command
    // before dispatching (an unscoped legacy command is now rejected outright),
    // so this tracks the validated locals it dispatches with.
    expect(desktopHost).toContain("bridge.callTool(scopeKey, name, command.args ?? {})");
    expect(desktopHost).toContain("T3 Code-derived");
    expect(desktopHost).toContain("renderer must not create or own a parallel");
    expect(desktopHost).toContain("/api/browser/desktop-host");
    expect(desktopHost).toContain("diagnosticEventSource(");
    expect(desktopHost).toContain('"/api/browser/events"');
    expect(desktopHost).toContain("TELAR_BROWSER_MUTATION_EVENT");
    expect(desktopHost).toContain("event.reveal && event.scopeKey");
    expect(desktopHost).toContain("detail: event.scopeKey");
    // THE AGENT-REVEAL LISTENER BELONGS TO THE ADAPTER, NOT THE PANEL. It was
    // in right-panel.tsx and INV-8a failed it there by name: a window
    // subscription plus a comparison against this session's scope keys is
    // session semantics, which AD-12 keeps out of the shell. Asserted from both
    // sides — present in the owner, ABSENT from the panel — so a future move
    // back cannot pass by satisfying only half of it.
    expect(session).toContain("openRightPanelBrowser(resolvedRightPanelScopeKey)");
    expect(session).toContain("TELAR_BROWSER_MUTATION_EVENT");
    expect(session).toContain("eventScopeKey !== resolvedRightPanelScopeKey");
    expect(session).toContain("eventScopeKey !== provisionalRightPanelScopeKey");
    expect(panel).not.toContain("TELAR_BROWSER_MUTATION_EVENT");
    expect(panel).not.toContain("window.addEventListener");
    expect(session).toContain("adoptRightPanelSession(");
    expect(session).toContain("scopeKey={resolvedRightPanelScopeKey}");
    expect(layout).toContain("<DesktopBrowserHost />");
    expect(desktopMain).toContain("new DesktopBrowserManager(win)");
    expect(desktopMain).toContain('preload: path.join(__dirname, "preload.js")');
    expect(browserManager).toContain("new WebContentsView");
    expect(browserManager).toContain('setBackgroundColor("#00000000")');
    expect(browserManager).toContain("CURSOR_MOVE_MS = 160");
    expect(browserManager).toContain("CURSOR_CLICK_LEAD_MS = 40");
    expect(browserManager).toContain("root.style.opacity = '0.38'");
    expect(browserManager).toContain("}, 2200)");
    expect(browserManager).toContain("}, 6000)");
    expect(events).not.toContain("send(runtime.version)");
    expect(events).toContain("JSON.stringify(event)");
    expect(chat).toContain("createBrowserMcpServer");
    expect(chat).toContain("browserTools({ scopeKey: browserScopeKey })");
    expect(chat).toContain("createBrowserMcpServer({ scopeKey: browserScopeKey })");
    expect(chat).toContain("CODEX_BROWSER_TOOL_NAMESPACE");
  });
});
