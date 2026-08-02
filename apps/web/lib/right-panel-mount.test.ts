// Structural coverage for the route-level panel host. The repository has no
// DOM test environment, so store transitions are tested separately while this
// contract pins the production mount, hosted Git surface, and width policy.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("the production right-panel mount", () => {
  test("mounts one route-level third child with isolated scope", () => {
    const page = read("app/projects/[name]/sessions/[id]/page.tsx");
    expect(page).toContain('import { RightPanel } from "@/components/right-panel/right-panel"');
    expect(page).toContain('<RightPanel project={name} scopeKey={`${name}:${id}`} />');
  });

  test("hosts the existing Git surface rather than copying it", () => {
    const panel = read("components/right-panel/right-panel.tsx");
    expect(panel).toContain('import { GitTab } from "@/components/projects/git-tab"');
    expect(panel).toContain("<GitTab name={project} />");
    expect(panel).not.toContain("GitHeaderStrip");
    expect(panel).not.toContain("WorktreesSection");
  });

  test("hides the panel below 1440px and retains a wide-screen reopen edge", () => {
    const panel = read("components/right-panel/right-panel.tsx");
    expect(panel).toContain('RIGHT_PANEL_WIDE_ONLY_CLASS = "hidden min-[1440px]:flex"');
    expect(panel.match(/data-collapse-below="1440px"/g)).toHaveLength(2);
    expect(panel).toContain('aria-label="Open right panel"');
    expect(panel).toContain("w-10 shrink-0");
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

  test("describes iframe policy failures without claiming detection", () => {
    const browser = read("components/right-panel/browser-surface.tsx");
    expect(browser).toContain("<iframe");
    expect(browser).toContain("Some sites block framing");
    expect(browser).toContain("cannot reliably detect that refusal");
    expect(browser).toContain('target="_blank"');
  });
});
