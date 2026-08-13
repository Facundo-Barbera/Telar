/**
 * Which picker opens, and what its answer means.
 *
 * The interesting cases are all about the THIRD outcome. A picker has three
 * answers, not two — a path, a deliberate cancel, and "there is no picker here" —
 * and every test below is a place where collapsing cancel into failure would show
 * an error to somebody whose machine is working perfectly.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { chooseDirectory, readDirectoryChoice } from "./choose-directory";

const shell = (answer: unknown) => ({ dialog: { chooseDirectory: async () => answer } });
const server = (payload: unknown, ok = true) => (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch;

describe("readDirectoryChoice", () => {
  test("a trailing slash is trimmed, because the engine compares paths as strings", () => {
    // `/repo/` and `/repo` register as two projects on the same directory.
    expect(readDirectoryChoice({ path: "/Users/me/code/thing/" })).toEqual({ path: "/Users/me/code/thing" });
    expect(readDirectoryChoice({ path: "  /Users/me/thing  " })).toEqual({ path: "/Users/me/thing" });
  });

  test("cancelling is its own answer", () => {
    expect(readDirectoryChoice({ cancelled: true })).toEqual({ cancelled: true });
  });

  test("no picker on this platform is its own answer too", () => {
    // A Linux machine with no osascript is behaving correctly and must not be
    // reported as a failure.
    expect(readDirectoryChoice({ unavailable: "macOS only." })).toEqual({ unavailable: "macOS only." });
  });

  test("an empty path is not a path", () => {
    // Neither route has produced one, and treating it as a choice would register a
    // project on the engine's own working directory.
    expect(readDirectoryChoice({ path: "" })).toMatchObject({ unavailable: expect.any(String) });
    expect(readDirectoryChoice({ path: "   " })).toMatchObject({ unavailable: expect.any(String) });
    expect(readDirectoryChoice(null)).toMatchObject({ unavailable: expect.any(String) });
    expect(readDirectoryChoice({ path: 42 })).toMatchObject({ unavailable: expect.any(String) });
  });
});

describe("chooseDirectory", () => {
  test("prefers the desktop shell, and never asks the server when it is there", async () => {
    // Electron's dialog is parented to the window and cross-platform; the server
    // route is a macOS fallback for a plain browser.
    let asked = false;
    const fetcher = (async () => {
      asked = true;
      return { ok: true, json: async () => ({ path: "/wrong" }) };
    }) as unknown as typeof fetch;
    expect(await chooseDirectory({}, { bridge: shell({ path: "/from/shell" }), fetcher })).toEqual({ path: "/from/shell" });
    expect(asked).toBe(false);
  });

  test("falls through to the server when there is no shell", async () => {
    expect(await chooseDirectory({}, { bridge: undefined, fetcher: server({ path: "/from/server" }) })).toEqual({ path: "/from/server" });
  });

  test("a 501 from the server is READ, not discarded", () => {
    // The platform answer arrives with a non-ok status in some shapes of this
    // route, and its body is the sentence the dialog needs to show. Dropping the
    // body because the status was not 200 would replace "macOS only" with a
    // generic failure.
    return chooseDirectory({}, { bridge: undefined, fetcher: server({ unavailable: "macOS only." }, false) }).then((choice) => {
      expect(choice).toEqual({ unavailable: "macOS only." });
    });
  });

  test("a shell that throws is unavailable, not an unhandled rejection", async () => {
    const angry = { dialog: { chooseDirectory: async () => { throw new Error("no window"); } } };
    expect(await chooseDirectory({}, { bridge: angry })).toEqual({ unavailable: "no window" });
  });

  test("a server that cannot be reached is unavailable", async () => {
    const offline = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await chooseDirectory({}, { bridge: undefined, fetcher: offline })).toMatchObject({ unavailable: expect.any(String) });
  });
});
