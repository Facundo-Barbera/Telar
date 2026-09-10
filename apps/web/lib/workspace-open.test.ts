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
import { workspaceOpenBlocker } from "./workspace-open";

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
