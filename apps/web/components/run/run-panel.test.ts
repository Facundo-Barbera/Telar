/**
 * The panel's polling cadence, and WHICH MAC ITS REQUESTS GO TO — the two
 * decisions in it that are not a fold over something already tested next door.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { hostFetcher, LOCAL_HOST_ID, pathnameFetcher } from "@/lib/hosts/client";
import { createRunApi, runPath } from "@/lib/run/api";
import type { RunStatusAnswer, RunView } from "@/lib/run/types";
import { outputIsLive, pollInterval, runIdentity, stillOurs } from "./run-panel";

const view = (status: RunView["status"]): RunView => ({
  runId: "run_1",
  projectId: "proj_1",
  configId: "cfg_1",
  configName: "web dev",
  command: "bun run dev",
  worktreePath: "/trees/main",
  cwd: "/trees/main",
  startedAt: 1,
  status,
  readiness: { kind: "none" },
  env: [],
});

describe("pollInterval", () => {
  test("an idle project is not polled at a live cadence", () => {
    // Every open cockpit polls this. A project with nothing deployed asking
    // once a second, forever, is the cost that makes people close the panel.
    expect(pollInterval(undefined)).toBe(5000);
    expect(pollInterval({ history: [] })).toBe(5000);
  });

  test("a starting run is watched closely, a settled one is not", () => {
    expect(pollInterval({ history: [], active: view("starting") })).toBe(1000);
    expect(pollInterval({ history: [], active: view("running") })).toBe(1000);
    expect(pollInterval({ history: [], active: view("ready") })).toBe(3000);
    expect(pollInterval({ history: [], active: view("exited") })).toBe(5000);
  });

  test("a run Telar lost is not polled hard either — nothing about it will change", () => {
    expect(pollInterval({ history: [], active: view("unknown") })).toBe(5000);
  });
});

describe("outputIsLive", () => {
  test("a finished run's terminal is kept but not chased", () => {
    // The distinction the terminal's cadence rests on, and it is not the same
    // question as whether to SHOW one: a run that ended still has its last
    // screen, which is most of the value of keeping it. What changes is that
    // nothing more can arrive, so asking twice a second is cost with no answer.
    const answer: RunStatusAnswer = { history: [], active: view("exited") };
    expect(outputIsLive(answer)).toBe(false);
    expect(outputIsLive({ history: [], active: view("running") })).toBe(true);
    expect(outputIsLive({ history: [], active: view("starting") })).toBe(true);
    expect(outputIsLive({ history: [], active: view("ready") })).toBe(true);
    // A run Telar lost contact with will never say anything again through us.
    expect(outputIsLive({ history: [], active: view("unknown") })).toBe(false);
    expect(outputIsLive({ history: [] })).toBe(false);
  });
});

/**
 * TWO MACS, THE SAME SESSION ID. Session ids are minted per host, so nothing
 * stops `sess_1` existing on both — and the run surface polls in two legs
 * (status, then output for the same session) with a human free to navigate
 * between them. The bug this guards is not a crash: an unpinned fetcher reads
 * the address bar at CALL time, so the second leg would go to the host the
 * window had moved to, be answered about a stranger's deployment, and be shown
 * as the project's own.
 *
 * WHAT IS AND IS NOT COVERED HERE. There is no DOM harness in this app, so
 * these tests pin the two decisions the component delegates to functions — how
 * requests are addressed (`hostFetcher`) and whether a returning answer may be
 * published (`stillOurs`). That a MOUNTED `RunPanel` calls them in that order,
 * and that a collapsed panel stops polling on screen, is not asserted here and
 * belongs to browser acceptance.
 */
describe("a panel is about one Mac", () => {
  const saved = globalThis.window;

  afterEach(() => {
    if (saved === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = saved;
  });

  const at = (pathname: string) => {
    (globalThis as { window?: unknown }).window = { location: { pathname } };
  };

  /** Records where each request actually went. */
  function socket() {
    const sent: string[] = [];
    const fetcher = (async (input: string) => {
      sent.push(input);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { sent, fetcher };
  }

  test("the same session id on two hosts is not the same panel", () => {
    expect(runIdentity("host_a", "sess_1")).not.toBe(runIdentity("host_b", "sess_1"));
    // And the joiner cannot be spelled by the ids themselves, so no pair of
    // ids can impersonate another pair.
    expect(runIdentity("host", "a:sess_1")).not.toBe(runIdentity("host:a", "sess_1"));
    expect(runIdentity(undefined, "sess_1")).toBe(runIdentity(LOCAL_HOST_ID, "sess_1"));
  });

  test("a pinned api keeps talking to its own host after the window has navigated away", async () => {
    const { sent, fetcher } = socket();
    at("/hosts/host_a/projects/p/sessions/sess_1");
    const api = createRunApi(hostFetcher("host_a", fetcher));

    await api.status("sess_1");
    // The human moves to the other Mac while the panel is still resolving.
    at("/hosts/host_b/projects/p/sessions/sess_1");
    await api.output("sess_1", { after: 3 });
    await api.stop("sess_1");

    expect(sent).toEqual([
      "/api/hosts/host_a/sessions/sess_1/run/status",
      "/api/hosts/host_a/sessions/sess_1/run/output?after=3",
      "/api/hosts/host_a/sessions/sess_1/run/stop",
    ]);
  });

  test("the terminal's own three calls are host-scoped too, which is why they exist", () => {
    // THE WHOLE REASON THE EMULATOR IS FED OVER HTTP. `terminalBridge()` is
    // undefined for a session whose Mac is not this one — deliberately, because
    // a terminal that lies about which computer it is on is worse than no
    // terminal — so a bridge-fed Run tab would show a PAIRED session an empty
    // screen for a run happening on the machine it is about. These go the same
    // way every other run call does.
    expect(runPath("sess_1", "/bytes", { after: 7 })).toBe("/api/sessions/sess_1/run/bytes?after=7");
    expect(runPath("sess_1", "/write")).toBe("/api/sessions/sess_1/run/write");
    expect(runPath("sess_1", "/resize")).toBe("/api/sessions/sess_1/run/resize");
  });

  test("a pinned api keeps the terminal on its own Mac across a navigation", async () => {
    const { sent, fetcher } = socket();
    at("/hosts/host_a/projects/p/sessions/sess_1");
    const api = createRunApi(hostFetcher("host_a", fetcher));

    await api.bytes("sess_1", { after: 2 });
    // Typing while the window has moved: the keystroke must not be delivered to
    // the other Mac's deployment, which has its own session ids and could well
    // have one spelled `sess_1`.
    at("/hosts/host_b/projects/p/sessions/sess_1");
    await api.write("sess_1", { runId: "run_1", data: "y\r" });
    await api.resize("sess_1", { runId: "run_1", cols: 120, rows: 30 });

    expect(sent).toEqual([
      "/api/hosts/host_a/sessions/sess_1/run/bytes?after=2",
      "/api/hosts/host_a/sessions/sess_1/run/write",
      "/api/hosts/host_a/sessions/sess_1/run/resize",
    ]);
  });

  test("a late answer is published only for the subject that asked, and only while watching", () => {
    const a = runIdentity("host_a", "sess_1");
    const b = runIdentity("host_b", "sess_1");

    // The ordinary case: still the same subject, still on screen.
    expect(stillOurs(a, a, true)).toBe(true);
    // A status or output leg that resolves after the panel moved to the other
    // Mac — the answer describes a deployment the reader is no longer looking
    // at, so it is dropped rather than rendered as theirs.
    expect(stillOurs(a, b, true)).toBe(false);
    // Off screen: the poll was stopped, so whatever was in flight when it
    // stopped is discarded rather than applied when the panel reopens.
    expect(stillOurs(a, a, false)).toBe(false);
  });

  test("the unpinned default is exactly the hazard: leg two follows the address bar", async () => {
    // Not a wish for different behaviour from `pathnameFetcher` — it is right
    // for a screen whose subject IS the current address. It is why the run
    // panel must not use it, and this is that difference, in one place.
    const seen: string[] = [];
    const base = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: string) => {
      seen.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      at("/hosts/host_a/projects/p/sessions/sess_1");
      const api = createRunApi(pathnameFetcher);
      await api.status("sess_1");
      at("/hosts/host_b/projects/p/sessions/sess_1");
      await api.output("sess_1", { after: 3 });
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = base;
    }
    expect(seen[0]).toContain("/api/hosts/host_a/");
    expect(seen[1]).toContain("/api/hosts/host_b/");
  });
});
