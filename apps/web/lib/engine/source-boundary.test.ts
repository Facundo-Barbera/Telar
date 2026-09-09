// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHAT THIS BOUNDARY IS, AND WHAT IT STOPPED BEING.
 *
 * It used to also forbid `tailwindcss`, `ThemeProvider` and `@/components/ui/`,
 * on the reasoning that the cockpit should own its visual system outright. That went
 * one step too far: it did not stop the cockpit from depending on the frozen app, it
 * stopped the cockpit from having a design system AT ALL — so the cockpit grew a
 * hand-written approximation of Telar's palette, hand-drawn stand-ins for its
 * icons, and no dark mode, and read as a different product.
 *
 * The real boundary is narrower and still absolute: the cockpit must not IMPORT from
 * the frozen app or from the legacy runtime. Its UI primitives are LOCAL copies
 * under `components/ui/`, which is why that path is no longer banned — a copy
 * costs a fork, an import costs the independence this whole rebuild is for.
 */
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const ownedRoots = ["app", "components", "lib"].map((segment) => path.join(appRoot, segment));
const banned = [
  // `apps/web` still catches `apps/web_old` as a substring, but naming the
  // frozen tree explicitly keeps the failure message honest after the rename.
  "@telar/core",
  "@anthropic-ai/claude-agent-sdk",
  "apps/web",
  "apps/web_old",
  "@/lib/store",
  "@/lib/server/session-engine",
  "@/app/api/chat",
  "@/lib/session-log",
  "@/components/looms",
  "@/components/workspace",
  "@/components/session/session-view",
  "@/components/ai-elements",
  "@/lib/ultra",
  "instrumentation",
  "ActivityPanel",
];

function sources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:ts|tsx)$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

/**
 * The MODULE SPECIFIERS a file imports — not its raw text.
 *
 * A whole-file substring scan cannot tell an import from prose, and it produced
 * exactly the false positive you would predict: a comment in approval-card.tsx
 * explaining what the donor app does with `Edit(apps/web/components/**)` was
 * reported as importing `apps/web`. A boundary test that fires on documentation
 * teaches people to stop writing documentation, so it reads specifiers instead.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import … from "x" / export … from "x"
    /\bimport\s+["']([^"']+)["']/g, // bare side-effect import
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

describe("standalone cockpit source boundary", () => {
  test("owns its browser, adapter, and style tree without legacy runtime imports", () => {
    for (const file of ownedRoots.flatMap(sources)) {
      const specifiers = importSpecifiers(fs.readFileSync(file, "utf8"));
      for (const forbidden of banned) {
        const offender = specifiers.find((specifier) => specifier.includes(forbidden));
        expect(offender, `${path.relative(appRoot, file)} imports ${forbidden} (via "${offender}")`).toBeUndefined();
      }
    }
  });

  test("the boundary check reads imports, not prose", () => {
    // Guards the guard: if this ever reverts to a substring scan, a comment
    // mentioning a banned path starts failing the build again.
    expect(importSpecifiers('// see apps/web_old/components/ui\nimport { x } from "./y";')).toEqual(["./y"]);
    expect(importSpecifiers('import "@telar/core";')).toEqual(["@telar/core"]);
    expect(importSpecifiers('const m = await import("@/lib/store");')).toEqual(["@/lib/store"]);
  });

  test("uses root-relative routes and its own stylesheet", () => {
    const layout = fs.readFileSync(path.join(appRoot, "app", "layout.tsx"), "utf8");
    const client = fs.readFileSync(path.join(appRoot, "lib", "engine", "client.ts"), "utf8");
    expect(layout).toContain('import "./globals.css"');
    expect(layout).toContain("AppShell");
    expect(layout).not.toContain('href="/vnext');
    expect(client).toContain('"/api/health"');
    expect(client).not.toContain("/api/vnext");
    expect(client).not.toContain("http://127.0.0.1");
  });

  test("keeps the session workspace and visual shell local", () => {
    /**
     * ASSERTED ACROSS THE COMPONENT FOLDER, not against one file's contents.
     * This once named functions inside session-cockpit.tsx, which pinned a FILE
     * LAYOUT rather than the boundary it exists to protect — splitting the
     * transcript and composer into their own modules broke it while changing
     * nothing about whether the visual shell is local.
     */
    const componentRoot = path.join(appRoot, "components");
    const components = sources(componentRoot).map((file) => fs.readFileSync(file, "utf8"));
    const cockpitSources = components.join("\n");
    const cockpit = fs.readFileSync(path.join(componentRoot, "session-cockpit.tsx"), "utf8");
    const shell = fs.readFileSync(path.join(componentRoot, "app-shell.tsx"), "utf8");
    const sidebar = fs.readFileSync(path.join(componentRoot, "app-sidebar.tsx"), "utf8");

    expect(cockpit).toContain("function SessionMasthead");
    expect(cockpitSources).toContain("function ActivityGroup");
    expect(cockpitSources).toContain("export function Composer");
    // Nothing under components/ may reach into the frozen app. READ AS
    // IMPORTS, for the reason the sibling test above pins: this was a raw
    // substring scan, and it fired on the ported components' own comments —
    // which cite `apps/web_old/...` by path to say WHERE a class string or a
    // layout rule came from. That provenance is the most useful documentation
    // in a port, and a test that punishes writing it is the test that is wrong.
    for (const source of components) {
      const specifiers = importSpecifiers(source);
      expect(specifiers.find((specifier) => specifier.includes("web_old"))).toBeUndefined();
      expect(specifiers.find((specifier) => specifier.includes("@telar/core"))).toBeUndefined();
    }
    expect(cockpit).not.toContain("Retry as new run");
    expect(cockpit).not.toContain("Discard recovered run");
    expect(cockpit).toContain("RightPanel");
    expect(shell).toContain("AppSidebar");
    expect(sidebar).toContain("Search sessions");
    expect(sidebar).toContain("Settings");
  });

  test("theme, fonts and the Tailwind pipeline are all wired, or the palette is decorative", () => {
    /**
     * Each of these was MISSING while the app still compiled and rendered, which
     * is exactly why they are pinned. A palette with no Tailwind build emits no
     * utilities; a `.dark` block with nothing to set the class is dead CSS; and
     * `--font-sans: var(--font-geist-sans)` with no next/font call resolves to
     * the fallback stack forever.
     */
    const postcss = fs.readFileSync(path.join(appRoot, "postcss.config.mjs"), "utf8");
    const layout = fs.readFileSync(path.join(appRoot, "app", "layout.tsx"), "utf8");
    const styles = fs.readFileSync(path.join(appRoot, "app", "globals.css"), "utf8");

    expect(postcss).toContain("@tailwindcss/postcss");
    expect(styles).toContain('@import "tailwindcss"');
    expect(styles).toContain("@custom-variant dark");
    // The no-flash script must run in <head>, before the body paints.
    expect(layout).toContain("THEME_INIT_SCRIPT");
    expect(layout).toContain("Geist");
    expect(layout).toContain("--font-geist-sans");
  });
});
