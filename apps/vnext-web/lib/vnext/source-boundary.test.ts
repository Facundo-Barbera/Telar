// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const ownedRoots = ["app", "components", "lib"].map((segment) => path.join(appRoot, segment));
const banned = [
  // `apps/web` still catches `apps/web_old` as a substring, but naming the
  // frozen tree explicitly keeps the failure message honest after the rename.
  "@telar/core", "@anthropic-ai/claude-agent-sdk", "apps/web", "apps/web_old", "@/lib/store", "@/lib/server/session-engine",
  "@/app/api/chat", "@/lib/session-log", "@/components/looms", "@/components/workspace", "@/components/session/session-view",
  "@/components/ui/", "@/components/ai-elements", "@/lib/ultra", "ThemeProvider", "instrumentation", "tailwindcss", "ActivityPanel",
];

function sources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:ts|tsx)$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

describe("standalone vNext source boundary", () => {
  test("owns its browser, adapter, and style tree without legacy runtime imports", () => {
    for (const file of ownedRoots.flatMap(sources)) {
      const source = fs.readFileSync(file, "utf8");
      for (const forbidden of banned) expect(source, `${path.relative(appRoot, file)} imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("uses root-relative routes and a vNext-owned stylesheet", () => {
    const layout = fs.readFileSync(path.join(appRoot, "app", "layout.tsx"), "utf8");
    const settings = fs.readFileSync(path.join(appRoot, "app", "settings", "page.tsx"), "utf8");
    const client = fs.readFileSync(path.join(appRoot, "lib", "vnext", "client.ts"), "utf8");
    expect(layout).toContain('import "./globals.css"');
    expect(layout).toContain("VNextAppShell");
    expect(layout).not.toContain('href="/vnext');
    expect(settings).toContain("vnext-settings-page");
    expect(client).toContain('"/api/health"');
    expect(client).not.toContain("/api/vnext");
    expect(client).not.toContain("http://127.0.0.1");
  });

  test("keeps the session workspace and visual shell local", () => {
    const cockpit = fs.readFileSync(path.join(appRoot, "components", "session-cockpit.tsx"), "utf8");
    const shell = fs.readFileSync(path.join(appRoot, "components", "vnext-app-shell.tsx"), "utf8");
    const sidebar = fs.readFileSync(path.join(appRoot, "components", "vnext-sidebar.tsx"), "utf8");
    const panel = fs.readFileSync(path.join(appRoot, "components", "right-panel.tsx"), "utf8");
    const styles = fs.readFileSync(path.join(appRoot, "app", "globals.css"), "utf8");
    expect(cockpit).toContain("function SessionMasthead");
    expect(cockpit).toContain("function SessionTranscript");
    expect(cockpit).toContain("function SessionComposer");
    expect(cockpit).toContain("Retry as new run");
    expect(cockpit).toContain("Discard recovered run");
    expect(cockpit).toContain('aria-live="polite"');
    expect(cockpit).toContain("VNextRightPanel");
    expect(shell).toContain("VNextSidebar");
    expect(sidebar).toContain("Search sessions");
    expect(sidebar).toContain("Settings");
    expect(panel).toContain("no browser, Git, loom, account, or agent controls");
    expect(styles).toContain(".vnext-session-workspace");
    expect(styles).toContain(".vnext-sidebar");
    expect(styles).toContain(".vnext-right-panel");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("prefers-reduced-motion");
    expect(styles).not.toContain("tailwind");
  });
});
