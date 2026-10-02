import { describe, expect, test } from "bun:test";
import { buildFeedbackUrl, describeSystem } from "./feedback";

const info = { version: "1.4.0", channel: "beta", system: "Mac OS X 15.1", connection: "local" as const };
const bodyOf = (url: string) => new URL(url).searchParams.get("body") ?? "";

describe("buildFeedbackUrl", () => {
  test("targets a new issue with the text and no label", () => {
    const url = new URL(buildFeedbackUrl("The rail jumps\nwhen I scroll"));
    expect(url.origin + url.pathname).toBe("https://github.com/NovarixHQ/Telar/issues/new");
    expect(url.searchParams.get("title")).toBe("The rail jumps");
    expect(url.searchParams.get("body")).toBe("The rail jumps\nwhen I scroll");
    expect(url.searchParams.has("labels")).toBe(false);
  });

  test("adds build, system and connection only when info is given", () => {
    const body = bodyOf(buildFeedbackUrl("hi", info));
    expect(body).toContain("Build: 1.4.0 · beta");
    expect(body).toContain("System: Mac OS X 15.1");
    expect(body).toContain("Host: this Mac");
    expect(bodyOf(buildFeedbackUrl("hi"))).toBe("hi");
  });

  test("a remote connection names no host", () => {
    expect(bodyOf(buildFeedbackUrl("hi", { ...info, connection: "remote" }))).toContain("Host: a remote host");
  });

  test("a long text is truncated, noted, and keeps the info", () => {
    const url = buildFeedbackUrl("word ".repeat(5000), info);
    expect(url.length).toBeLessThanOrEqual(7500);
    expect(bodyOf(url)).toContain("[truncated]");
    expect(bodyOf(url)).toContain("System: Mac OS X 15.1");
  });
});

describe("describeSystem", () => {
  test("reads the OS version from a user agent", () => {
    expect(describeSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit")).toBe("Mac OS X 10.15.7");
    expect(describeSystem("nothing")).toBe("unknown");
  });
});
