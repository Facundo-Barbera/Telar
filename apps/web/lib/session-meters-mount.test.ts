// Structural coverage for the composer meters. The app has no DOM test
// environment, so live interaction is verified in-browser and this contract
// prevents the clipped, non-dismissible in-tree overlay from returning.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../components/session/session-meters.tsx", import.meta.url),
  "utf8",
);
const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");

describe("session meter popovers", () => {
  test("portals the context card above the transformed composer", () => {
    expect(source.match(/<Popover>/g)?.length).toBe(1);
    expect(source.match(/<PopoverContent/g)?.length).toBe(1);
    expect(source).toContain('align="end"');
    expect(source).toContain('side="top"');
    expect(source).not.toContain("useAnchoredOverlay");
  });

  test("uses the popover trigger state instead of hover pinning", () => {
    expect(source.match(/<PopoverTrigger/g)?.length).toBe(1);
    expect(source).not.toContain("usePinnableHover");
    expect(source).not.toContain("hovered || pinned");
    expect(source).toContain('title="View context window"');
  });

  test("keeps exact harness snapshots persisted behind a unified readout", () => {
    expect(route).toContain("q.getContextUsage()");
    expect(route).toContain("fromClaudeContextUsage(await q.getContextUsage())");
    expect(route).not.toContain("contextUsagePromise");
    // lastMainUsage moved onto the projector's ClaudeTurnState (the estimate
    // fallback's capture is tested there); the route still prefers the exact
    // snapshot and falls back to the estimate — that preference is the pin.
    expect(route).toContain("contextUsage?.totalTokens ?? contextOf(turnState.lastMainUsage)");
    expect(route).toContain("contextUsage,");
    expect(store).toContain("contextUsage?: ContextUsageSnapshot");
    expect(store).toContain("chat.contextUsage = opts.contextUsage");
    expect(route).toContain("fromCodexContextUsage({");
    expect(route).toContain("totalTokens: nev.usage.total_tokens");
    expect(source).toContain("Total processed");
    expect(source).toContain("automatically compacts its context when needed");
    expect(source).not.toContain("Exact attribution");
    expect(source).not.toContain("DetailGroup");
  });
});
