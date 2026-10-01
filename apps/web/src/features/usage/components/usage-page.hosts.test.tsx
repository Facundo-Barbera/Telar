import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@telar/engine-client";
import { buttonLabelled, click, flush, installTestDom, mount, stubFetch } from "@/test/dom";
import { SidebarProvider } from "@/ui/sidebar";
import { UsagePage } from "./usage-page";

installTestDom();

const report = (costUsd: number, sessions: number): UsageReport => ({
  sinceMs: Date.now() - 7 * 86_400_000,
  untilMs: Date.now(),
  resolution: "day",
  timeZone: "UTC",
  buckets: [
    {
      period: new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(Date.now()),
      driver: "claude",
      model: "claude-opus",
      tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreate: 0 },
      costUsd,
      priced: true,
      turns: 1,
    },
  ],
  sources: [{ provider: "claude", status: "ok", path: "~/.claude", files: 1, sessions }],
  pricing: "fresh",
  sessions,
  readAt: Date.now(),
});

const byComputer = () => document.querySelector('section[aria-label="Usage by computer"]');
const headline = () => document.querySelector("p.text-4xl")?.textContent;

describe("usage across hosts", () => {
  test("one host shows no host switcher", async () => {
    stubFetch({ "GET /api/hosts": () => ({ hosts: [] }), "GET /api/usage": () => ({ usage: report(2, 3) }) });
    await mount(
      <SidebarProvider>
        <UsagePage />
      </SidebarProvider>,
    );
    await flush(() => headline() === "$2.00");
    expect(headline()).toBe("$2.00");
    expect(byComputer()).toBeNull();
  });

  test("totals every host that answered, and an unreachable one does not hold up the rest", async () => {
    stubFetch({
      "GET /api/hosts": () => ({
        hosts: [
          { id: "host_studio", name: "studio", baseUrl: "http://studio", addedAt: 1 },
          { id: "host_away", name: "away", baseUrl: "http://away", addedAt: 1 },
        ],
      }),
      "GET /api/usage": () => ({ usage: report(2, 3) }),
      "GET /api/hosts/host_studio/usage": () => ({ usage: report(5, 1) }),
      "GET /api/hosts/host_away/usage": () => {
        throw new Error("The cockpit cannot reach away.");
      },
    });
    await mount(
      <SidebarProvider>
        <UsagePage />
      </SidebarProvider>,
    );
    await flush(() => headline() === "$7.00" && Boolean(byComputer()?.textContent?.includes("Did not answer")));

    expect(headline()).toBe("$7.00");
    const rows = [...byComputer()!.querySelectorAll("tr")].map((row) => row.textContent);
    expect(rows).toEqual(["This computer3 sessions$2.00", "studio1 session$5.00", "awayDid not answer—", "Total2 of 3 computers$7.00"]);

    await click(buttonLabelled("studio", byComputer()!));
    expect(headline()).toBe("$5.00");
    await click(buttonLabelled("All", byComputer()!));
    expect(headline()).toBe("$7.00");
  });
});
