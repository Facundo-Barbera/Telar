// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { hostFetcher, hostFromPathname, hostPrefix, LOCAL_HOST_ID, rewriteApiPath } from "./client";

describe("hostFromPathname", () => {
  test("a remote screen names its host; everything else is local", () => {
    expect(hostFromPathname("/hosts/host_ab/projects/p/sessions/s")).toBe("host_ab");
    expect(hostFromPathname("/hosts/host%20x")).toBe("host x");
    expect(hostFromPathname("/projects/p/sessions/s")).toBe(LOCAL_HOST_ID);
    expect(hostFromPathname("/")).toBe(LOCAL_HOST_ID);
  });
});

describe("rewriteApiPath", () => {
  test("an api call from a remote screen goes through that host's proxy", () => {
    expect(rewriteApiPath("/api/projects", "host_ab")).toBe("/api/hosts/host_ab/projects");
    expect(rewriteApiPath("/api/sessions/s1/turns?x=1", "host_ab")).toBe("/api/hosts/host_ab/sessions/s1/turns?x=1");
  });

  test("local is the absence of the hop", () => {
    expect(rewriteApiPath("/api/projects", LOCAL_HOST_ID)).toBe("/api/projects");
    expect(hostPrefix(LOCAL_HOST_ID)).toBe("");
    expect(hostPrefix(undefined)).toBe("");
    expect(hostPrefix("host_ab")).toBe("/hosts/host_ab");
  });

  // The hosts routes are this cockpit's own book; a remote's book is not
  // ours, and a nested hop would loop.
  test("the hosts routes are never proxied", () => {
    expect(rewriteApiPath("/api/hosts", "host_ab")).toBe("/api/hosts");
    expect(rewriteApiPath("/api/hosts/host_ab/projects", "host_ab")).toBe("/api/hosts/host_ab/projects");
  });

  test("non-api paths are left alone", () => {
    expect(rewriteApiPath("https://example.com/api/x", "host_ab")).toBe("https://example.com/api/x");
    expect(rewriteApiPath("/_next/static/x.js", "host_ab")).toBe("/_next/static/x.js");
  });
});

describe("hostFetcher", () => {
  test("pins every string request to one host", async () => {
    const seen: string[] = [];
    const base = (async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : String(input));
      return new Response("{}");
    }) as typeof fetch;
    await hostFetcher("host_ab", base)("/api/projects");
    await hostFetcher(LOCAL_HOST_ID, base)("/api/projects");
    expect(seen).toEqual(["/api/hosts/host_ab/projects", "/api/projects"]);
  });
});

describe("a row's own Mac", () => {
  test("a fetcher for a remote row hops; a local row does not", async () => {
    // What `sessionFetch` in session-inbox-menu.tsx relies on: settle, snooze,
    // rename and delete on a paired Mac's row must land on THAT engine.
    const seen: string[] = [];
    const base = (async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : String(input));
      return new Response("{}");
    }) as typeof fetch;
    await hostFetcher("host_ab", base)("/api/sessions/s1", { method: "PATCH" });
    await hostFetcher(LOCAL_HOST_ID, base)("/api/sessions/s1", { method: "PATCH" });
    expect(seen).toEqual(["/api/hosts/host_ab/sessions/s1", "/api/sessions/s1"]);
  });
});
