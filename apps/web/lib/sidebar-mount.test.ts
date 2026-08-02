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
  });

  test("keeps the keyboard-accessible trigger outside the offcanvas sidebar", () => {
    const sidebar = read("components/app-sidebar.tsx");
    const layout = read("app/layout.tsx");

    expect(sidebar).not.toContain("<SidebarTrigger");
    expect(layout).toContain('aria-label="Toggle main sidebar"');
    expect(layout).toContain("z-[60]");
    expect(layout.indexOf("<SidebarTrigger")).toBeLessThan(layout.indexOf("<AppSidebar"));
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
    expect(sidebar).toContain("isLoomNeedsYou(loom.state)");
    expect(sidebar).not.toContain("ProjectRow");
    expect(sessionPage).not.toContain("SessionsRail");
  });

  test("opens the shared new-session workspace without a duplicate project prompt", () => {
    const sidebar = read("components/app-sidebar.tsx");

    expect(sidebar).toContain('aria-label="New session"');
    expect(sidebar).toContain('render={<Link href="/" />}');
    expect(sidebar).not.toContain("Choose the project this session belongs to.");
  });

  test("server-seeds the persistent shell and shares one account registry", () => {
    const layout = read("app/layout.tsx");
    const sidebar = read("components/app-sidebar.tsx");
    const accounts = read("lib/use-accounts.ts");

    expect(layout).toContain("const initialSidebarData: AppSidebarInitialData");
    expect(layout).toContain("<AppSidebar initialData={initialSidebarData}");
    expect(layout).toContain("<AccountsProvider initial={accountEnvelope}>");
    expect(sidebar).toContain("if (!initialData) queueMicrotask");
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
});
