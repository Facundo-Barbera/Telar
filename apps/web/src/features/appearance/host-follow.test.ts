import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Composition, Look } from "@telar/engine-client";
import { decideFollow, parseFollowMode, readFollowNotice, wearPublication, writeFollowNotice } from "./host-follow";
import { DEFAULT_COMPOSITION, writeComposition } from "./composition";
import { lookTintMessage } from "./looks";

const published = { updatedAt: 1_700_000_000_000, appearance: { version: 2 } };

describe("parseFollowMode", () => {
  test("a fresh window follows; only an explicit detach does not", () => {
    expect(parseFollowMode(null)).toBe("follow");
    expect(parseFollowMode("follow")).toBe("follow");
    expect(parseFollowMode("garbage")).toBe("follow");
    expect(parseFollowMode("detached")).toBe("detached");
  });
});

describe("decideFollow", () => {
  test("a remote window that has not seen this publication wears it", () => {
    expect(decideFollow({ mode: "follow", isHost: false, applied: null, answer: published })).toBe("apply");
    expect(decideFollow({ mode: "follow", isHost: false, applied: 1, answer: published })).toBe("apply");
  });

  test("the same publication is not worn twice", () => {
    expect(decideFollow({ mode: "follow", isHost: false, applied: published.updatedAt, answer: published })).toBe("skip");
  });

  test("the host window never follows, whatever the store says", () => {
    expect(decideFollow({ mode: "follow", isHost: true, applied: null, answer: published })).toBe("skip");
  });

  test("a detached window keeps its own taste", () => {
    expect(decideFollow({ mode: "detached", isHost: false, applied: null, answer: published })).toBe("skip");
  });

  test("nothing published, or nothing readable, is nothing to wear", () => {
    expect(decideFollow({ mode: "follow", isHost: false, applied: null, answer: { updatedAt: null, appearance: null } })).toBe("skip");
    expect(decideFollow({ mode: "follow", isHost: false, applied: null, answer: { updatedAt: 5, appearance: null } })).toBe("skip");
  });
});

describe("wearing what the host published", () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost/" });
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
  beforeEach(() => {
    window.localStorage.clear();
    writeComposition(DEFAULT_COMPOSITION, {});
  });

  const composition = (card: string): Composition => ({
    light: { base: "#ffffff", layers: [], overrides: { card } },
    dark: { base: "#252525", layers: [], overrides: {} },
  });

  const look = (card: string): Look => ({
    version: 2,
    id: "published",
    label: "The host's",
    composition: composition(card),
    images: {},
    accent: "indigo",
    fontSans: "geist",
    fontMono: "geist",
    fontSansCustom: "",
    fontMonoCustom: "",
    fontSize: 14,
    fontMonoSize: 12,
    translucencyLevel: 60,
    depth: "flat",
  });

  test("a card no ink lightness can rescue leaves a sentence behind", () => {
    // Mid-green sits on the state ink's own lightness, so the repair cannot move it.
    wearPublication(look("oklch(0.50 0.10 162)"), () => {});
    expect(readFollowNotice()).toBe(lookTintMessage(["success", "warning", "destructive"]));
  });

  test("and the next wear that costs nothing CLEARS it", () => {
    wearPublication(look("oklch(0.50 0.10 162)"), () => {});
    expect(readFollowNotice()).toBeDefined();
    wearPublication(look("#111111"), () => {});
    expect(readFollowNotice(), "a notice must never outlive the Look it is about").toBeUndefined();
  });

  test("the store survives a window that refuses to remember", () => {
    writeFollowNotice("something");
    expect(readFollowNotice()).toBe("something");
    writeFollowNotice(undefined);
    expect(readFollowNotice()).toBeUndefined();
  });
});
