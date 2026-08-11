// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const vnextRoots = [
  path.join(webRoot, "app", "vnext"),
  path.join(webRoot, "app", "api", "vnext"),
  path.join(webRoot, "components", "vnext"),
  path.join(webRoot, "lib", "vnext"),
];
const banned = [
  "@/lib/store",
  "@/lib/server/session-engine",
  "@/app/api/chat",
  "@/lib/session-log",
  "@/components/looms",
  "@/components/workspace",
  "@/components/session/session-view",
  "@/lib/ultra",
  "@telar/core",
  "@anthropic-ai/claude-agent-sdk",
];
const shellBanned = [
  "@/components/app-sidebar",
  "@/components/ui/sidebar",
  "@/components/dock/",
  "@/components/common/loom-notifications",
  "@/components/common/ultra-dock-signal",
  "@/components/desktop-browser-host",
  "@/lib/app-shell-data",
  "@/lib/use-accounts",
];

function sources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:ts|tsx)$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

describe("vNext source boundary", () => {
  test("the cockpit and adapters do not import legacy state, execution, or product surfaces", () => {
    for (const file of vnextRoots.flatMap(sources)) {
      const source = fs.readFileSync(file, "utf8");
      for (const forbidden of banned) expect(source, `${path.relative(webRoot, file)} imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("only the legacy route group owns the legacy product shell", () => {
    const rootLayout = fs.readFileSync(path.join(webRoot, "app", "layout.tsx"), "utf8");
    const vnextLayout = fs.readFileSync(path.join(webRoot, "app", "vnext", "layout.tsx"), "utf8");
    const legacyLayout = fs.readFileSync(path.join(webRoot, "app", "(legacy)", "layout.tsx"), "utf8");

    for (const forbidden of shellBanned) {
      expect(rootLayout, `root layout imports ${forbidden}`).not.toContain(forbidden);
      expect(vnextLayout, `vNext layout imports ${forbidden}`).not.toContain(forbidden);
    }
    expect(vnextLayout).toContain('aria-label="vNext navigation"');
    expect(vnextLayout).toContain('href="/vnext/settings"');
    expect(vnextLayout).not.toContain('href="/settings"');
    expect(rootLayout).not.toContain('import "./globals.css"');
    expect(vnextLayout).toContain('import "./vnext.css"');
    expect(legacyLayout).toContain('import "../globals.css"');
    expect(legacyLayout).toContain("<AppSidebar initialData={initialSidebarData}");
    expect(legacyLayout).toContain("<DockProvider>");
    expect(legacyLayout).toContain("<AccountsProvider initial={accountEnvelope}>");
  });

  test("vNext settings stays a read-only local runtime surface", () => {
    const settings = fs.readFileSync(path.join(webRoot, "app", "vnext", "settings", "page.tsx"), "utf8");

    expect(settings).toContain("Local runtime settings");
    expect(settings).toContain("bun run dev:vnext");
    expect(settings).toContain("does not manage accounts, credentials, or provider configuration");
    for (const forbidden of shellBanned) expect(settings, `vNext settings imports ${forbidden}`).not.toContain(forbidden);
  });

  test("all engine operations occur behind vNext adapter routes", () => {
    const client = fs.readFileSync(path.join(webRoot, "lib", "vnext", "client.ts"), "utf8");
    expect(client).toContain('"/api/vnext/health"');
    expect(client).not.toContain("http://127.0.0.1");
    expect(client).not.toContain("chats.json");
  });

  test("the supported vNext process disables legacy Next boot recovery", () => {
    const instrumentation = fs.readFileSync(path.join(webRoot, "instrumentation.ts"), "utf8");
    const launcher = fs.readFileSync(path.resolve(webRoot, "..", "..", "scripts", "vnext-dev.mjs"), "utf8");
    expect(instrumentation).toContain('process.env.TELAR_VNEXT === "1"');
    expect(launcher).toContain('TELAR_VNEXT: "1"');
  });
});
