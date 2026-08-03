// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { normalizeBrowserUrl } from "./browser-surface";
import { parseBrowserTabs } from "@/lib/server/browser-runtime";

describe("browser address normalization", () => {
  test("makes local and ordinary hostnames directly usable", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeBrowserUrl("example.com/path")).toBe("http://example.com/path");
  });

  test("preserves supported absolute addresses and rejects unsafe schemes", () => {
    expect(normalizeBrowserUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("file:///tmp/private")).toBeNull();
  });

  test("treats an empty value as invalid and keeps the internal blank page", () => {
    expect(normalizeBrowserUrl("   ")).toBeNull();
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
  });
});

describe("controlled browser tabs", () => {
  test("parses Playwright MCP's current tab marker and markdown links", () => {
    expect(parseBrowserTabs([
      "- 0: [Docs](https://example.com/docs)",
      "- 1: (current) [Telar](http://localhost:3000/)",
    ].join("\n"))).toEqual([
      { index: 0, title: "Docs", url: "https://example.com/docs", active: false },
      { index: 1, title: "Telar", url: "http://localhost:3000/", active: true },
    ]);
  });

  test("does not manufacture tabs from status prose", () => {
    expect(parseBrowserTabs("No open tabs. Navigate to a URL to create one.")).toEqual([]);
  });
});
