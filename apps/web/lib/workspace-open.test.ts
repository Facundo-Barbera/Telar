/**
 * WHAT "OPEN WITH" REFUSES, AND WHY IT SAYS SO.
 *
 * The remote case is the one worth pinning: two machines with the same
 * checkout layout would each have a folder at that path, so attempting the
 * open would silently reveal the WRONG one. Every branch here is a sentence a
 * reader can act on rather than a disabled control with no explanation.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { workspaceFilePath, workspaceOpenBlocker } from "./workspace-open";

const local = { path: "/Users/x/code/telar", hostId: "local", hasBridge: true };

describe("workspaceOpenBlocker", () => {
  test("a local session on the desktop shell can open", () => {
    expect(workspaceOpenBlocker(local)).toBeUndefined();
    // An absent hostId is the local host too — the cockpit omits it there.
    expect(workspaceOpenBlocker({ ...local, hostId: undefined })).toBeUndefined();
  });

  test("a remote session is refused by NAME, never attempted locally", () => {
    const blocked = workspaceOpenBlocker({ ...local, hostId: "host_mac_lan", hostLabel: "mac.lan" });
    expect(blocked).toContain("mac.lan");
    expect(blocked).toContain("cannot be opened from here");
  });

  test("a remote host with no label still refuses truthfully", () => {
    expect(workspaceOpenBlocker({ ...local, hostId: "host_2" })).toContain("another machine");
  });

  test("a browser tab says the app is what is missing — not the folder", () => {
    expect(workspaceOpenBlocker({ ...local, hasBridge: false })).toContain("desktop app");
  });

  test("a session with no workspace yet says that instead", () => {
    expect(workspaceOpenBlocker({ ...local, path: undefined })).toContain("no workspace folder");
  });

  test("the remote refusal outranks a missing path — the truer reason wins", () => {
    // Whether a remote machine has that folder is not knowable from here, so
    // "it is over there" is the honest answer, not "it does not exist".
    expect(workspaceOpenBlocker({ path: undefined, hostId: "host_2", hasBridge: true })).toContain("another machine");
  });
});

/**
 * THE SHELL REFUSES A RELATIVE PATH, so the join happens here or the verb
 * fails at the moment it is pressed. Nothing is returned when either half is
 * missing, which is what makes the two items that need an absolute path
 * disappear from a menu rather than promise something they cannot do.
 */
describe("workspaceFilePath", () => {
  test("joins a checkout-relative path onto the checkout", () => {
    expect(workspaceFilePath("/Users/x/code/telar", "apps/web/lib/utils.ts")).toBe("/Users/x/code/telar/apps/web/lib/utils.ts");
  });

  test("one separator, whichever side brought one", () => {
    expect(workspaceFilePath("/Users/x/code/telar/", "README.md")).toBe("/Users/x/code/telar/README.md");
    expect(workspaceFilePath("/Users/x/code/telar", "/README.md")).toBe("/Users/x/code/telar/README.md");
    expect(workspaceFilePath("/", "README.md")).toBe("/README.md");
  });

  test("nothing when there is no root to join against — a listing that has not landed", () => {
    expect(workspaceFilePath(undefined, "README.md")).toBeUndefined();
    expect(workspaceFilePath("", "README.md")).toBeUndefined();
  });

  test("nothing for an empty relative path, rather than the checkout itself", () => {
    // A menu asking to reveal "" must not quietly reveal the whole checkout.
    expect(workspaceFilePath("/Users/x/code/telar", "")).toBeUndefined();
  });
});
