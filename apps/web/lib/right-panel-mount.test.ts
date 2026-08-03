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
    expect(session).toContain("<RightPanelTrigger scopeKey={rightPanelScopeKey");
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
    expect(inspector).toContain("available < 280");
    expect(inspector).toContain("if (!open) return;");
    expect(inspector).toContain("{browserTabs.length > 0 && (");
    expect(inspector).toContain("Math.min(320, available)");
    expect(inspector).not.toContain("animate-in");
    expect(session).toContain('workspaceInspectorReserved && "min-[1180px]:pr-[21rem]"');
    expect(session).not.toContain("transition-[padding-right]");
    expect(message).toContain("max-w-3xl");
    expect(message).not.toContain("max-w-7xl");
  });

  test("uses an inline dock when wide and a drawer instead of disappearing below 1180px", () => {
    const panel = read("components/right-panel/right-panel.tsx");
    expect(panel).toContain('RIGHT_PANEL_VISIBLE_CLASS = "flex"');
    expect(panel).toContain('"workspace-fullscreen" : "drawer-below-1180"');
    expect(panel).toContain("<AnimatePresence initial={false}>");
    expect(panel).toContain("<motion.aside");
    expect(panel).toContain("exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}");
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
    expect(browser).toContain("Local servers");
    expect(browser).toContain('target="_blank"');
    expect(controller).toContain('new EventSource("/api/browser/events")');
    expect(browser).toContain("state.screenshot && hasNavigatedTab");
    expect(browser).toContain("<DesktopBrowserViewport bridge={desktopBridge}");
    expect(controller).toContain("bridge.setBounds");
    expect(controller).toContain("bridge.setVisible(true)");
    expect(desktopHost).toContain("bridge.callTool(command.name, command.args)");
    expect(desktopHost).toContain("/api/browser/desktop-host");
    expect(layout).toContain("<DesktopBrowserHost />");
    expect(desktopMain).toContain("new DesktopBrowserManager(win)");
    expect(desktopMain).toContain('preload: path.join(__dirname, "preload.js")');
    expect(browserManager).toContain("new WebContentsView");
    expect(browserManager).toContain("CURSOR_MOVE_MS = 160");
    expect(browserManager).toContain("CURSOR_CLICK_LEAD_MS = 40");
    expect(browserManager).toContain("setTimeout(() => { root.style.opacity = '0'; }, 700)");
    expect(events).not.toContain("send(runtime.version)");
    expect(chat).toContain("createBrowserMcpServer");
    expect(chat).toContain('namespaceOf("browser"');
  });
});
