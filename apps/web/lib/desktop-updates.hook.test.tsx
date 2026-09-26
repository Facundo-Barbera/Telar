/**
 * THE UPDATER'S STATE MACHINE, DRIVEN — `useDesktopUpdate()` against a scripted
 * bridge, with no shell anywhere near it.
 *
 * `desktop-updates.test.ts` pins the pure folds beside this one (which sentence,
 * which control, which toast); what needs a React to run is everything the two
 * surfaces used to each own a copy of: the pull that recovers a download a
 * remount missed, the race between that pull and a push, and — the whole of
 * issue #389 — what a press of Apply does, what a SECOND press does, and what
 * happens when the shell takes the press and then does not restart.
 *
 * The ten-second deadline is a parameter for exactly this reason: the test
 * passes twenty milliseconds and asserts the same behaviour a person would wait
 * ten seconds to see.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useDesktopUpdate, type DesktopUpdate, type UpdatePrefsInfo, type UpdateStatus, type UpdatesBridge } from "./desktop-updates";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

// ── the scripted shell ────────────────────────────────────────────────────
type Script = {
  /** What `status()` answers — the state a remount has to recover. */
  current: UpdateStatus | null;
  /** Hold that pull open until released, to drive the push/pull race. */
  deferStatus: boolean;
  prefs: Partial<UpdatePrefsInfo>;
  checkAnswer: { status: string } | undefined;
  rejectCheck: string | null;
  rejectInstall: string | null;
  rejectPrefs: boolean;
};

let script: Script;
let calls: string[];
let listeners: Set<(status: UpdateStatus) => void>;
let releasePull: (() => void) | null;

const bridge: UpdatesBridge = {
  check: async () => {
    calls.push("check");
    if (script.rejectCheck) throw new Error(script.rejectCheck);
    return script.checkAnswer;
  },
  install: async () => {
    calls.push("install");
    if (script.rejectInstall) throw new Error(script.rejectInstall);
    return { status: "restarting" };
  },
  onStatus: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  status: async () => {
    calls.push("status");
    if (script.deferStatus) await new Promise<void>((resolve) => (releasePull = resolve));
    return script.current;
  },
  getPrefs: async () => {
    calls.push("getPrefs");
    if (script.rejectPrefs) throw new Error("prefs store unreadable (scripted)");
    return { channel: "beta", installOnQuit: false, channels: ["beta"], configured: true, logPath: "/dev/null", ...script.prefs } as UpdatePrefsInfo;
  },
  setPrefs: async () => ({ channel: "beta", installOnQuit: false }),
};

const seatBridge = () => {
  (globalThis as { window?: { telarDesktop?: unknown } }).window!.telarDesktop = { updates: bridge };
};

beforeEach(() => {
  // What the restart question asks the engine — nothing is running here.
  globalThis.fetch = (async () => Response.json({ sessions: [], projects: [] })) as unknown as typeof fetch;
  script = { current: null, deferStatus: false, prefs: {}, checkAnswer: undefined, rejectCheck: null, rejectInstall: null, rejectPrefs: false };
  calls = [];
  listeners = new Set();
  releasePull = null;
  seatBridge();
});

/** A push from the shell, as `broadcastUpdateStatus` makes one. */
const push = async (status: UpdateStatus) => {
  await act(async () => {
    for (const listener of listeners) listener(status);
  });
};

/** Mount the hook and hand back its latest value, live. */
function mount(options?: { restartTimeoutMs?: number }) {
  let latest: DesktopUpdate | null = null;
  function Probe() {
    latest = useDesktopUpdate(options);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // Not StrictMode: its double-invoked effects would subscribe twice and the
  // point here is what the bridge is ASKED, in order.
  act(() => root.render(<Probe />));
  return {
    /** The hook's current value — read fresh, never captured. */
    get update() {
      return latest!;
    },
    press: async () => {
      await act(async () => latest!.act());
    },
    /** Apply is asked first now: the press opens the question, and this is
     *  the "Restart and update" answer to it. */
    confirm: async () => {
      await act(async () => latest!.restart.confirm());
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Let every already-resolved promise the mount kicked off settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("what a surface knows when it mounts", () => {
  test("it recovers a download that finished while it was gone", async () => {
    // `update-downloaded` is never re-emitted, so a remounted surface that only
    // listened would lose the one state that matters most.
    script.current = { status: "downloaded", version: "0.3.1" };
    const probe = mount();
    await settle();
    expect(probe.update.action).toBe("apply");
    expect(probe.update.label).toBe("Install v0.3.1 and restart");
    expect(calls).toContain("status");
    probe.unmount();
  });

  test("a push beats a slow pull, whatever order they resolve in", async () => {
    // The pull asks what we MISSED; a push that lands while it is in flight is
    // newer by construction. Without the guard a stale "downloading 40%" would
    // rewind a "downloaded" that had already arrived.
    script.deferStatus = true;
    script.current = { status: "downloading", version: "0.3.1", percent: 40 };
    const probe = mount();
    await settle();
    await push({ status: "downloaded", version: "0.3.1" });
    await act(async () => {
      releasePull?.();
    });
    await settle();
    expect(probe.update.status.status).toBe("downloaded");
    expect(probe.update.action).toBe("apply");
    probe.unmount();
  });

  test("a build with no feed retires the control rather than lying to it", async () => {
    script.prefs = { configured: false };
    const probe = mount();
    await settle();
    expect(probe.update.path).toBe("none");
    probe.unmount();
  });

  test("a Dev build's local-checkout updater is not this control", async () => {
    script.prefs = { configured: false, localUpdater: true };
    const probe = mount();
    await settle();
    expect(probe.update.path).toBe("local");
    probe.unmount();
  });

  test("prefs that will not read leave a retryable control, not a hidden one", async () => {
    script.rejectPrefs = true;
    const probe = mount();
    await settle();
    expect(probe.update.path).toBe("unknown");
    expect(probe.update.label).toContain("Click to retry");
    // The press retries the read rather than checking a feed it cannot describe.
    script.rejectPrefs = false;
    await probe.press();
    await settle();
    expect(probe.update.path).toBe("feed");
    expect(calls.filter((call) => call === "getPrefs")).toHaveLength(2);
    expect(calls).not.toContain("check");
    probe.unmount();
  });

  test("with no shell there is nothing to draw", async () => {
    delete (globalThis as { window?: { telarDesktop?: unknown } }).window!.telarDesktop;
    const probe = mount();
    await settle();
    expect(probe.update.supported).toBe(false);
    expect(calls).toEqual([]);
    probe.unmount();
  });
});

describe("the press that applies an update", () => {
  const ready: UpdateStatus = { status: "downloaded", version: "0.3.1" };

  test("the press asks first: nothing is installed until the answer, and Cancel installs nothing", async () => {
    const probe = mount();
    await settle();
    await push(ready);
    await probe.press();
    expect(probe.update.restart.open).toBe(true);
    expect(calls).not.toContain("install");
    await act(async () => probe.update.restart.cancel());
    expect(probe.update.restart.open).toBe(false);
    expect(probe.update.action).toBe("apply");
    expect(calls).not.toContain("install");
    probe.unmount();
  });

  test("it says 'restarting' before the shell has even answered", async () => {
    // THE DEFECT #389 OPENS WITH: the shell takes seconds to stage, and until
    // now nothing on screen moved in those seconds.
    const probe = mount();
    await settle();
    await push(ready);
    await probe.press();
    await probe.confirm();
    expect(probe.update.action).toBe("restarting");
    expect(probe.update.busy).toBe(true);
    expect(probe.update.label).toBe("Restarting to install v0.3.1…");
    expect(calls.filter((call) => call === "install")).toHaveLength(1);
    probe.unmount();
  });

  test("pressing again while it restarts asks the shell for nothing", async () => {
    const probe = mount();
    await settle();
    await push(ready);
    await probe.press();
    await probe.confirm();
    await probe.press();
    await probe.press();
    expect(calls.filter((call) => call === "install")).toHaveLength(1);
    // A press while restarting opens no second question either.
    expect(probe.update.restart.open).toBe(false);
    probe.unmount();
  });

  test("a restart that never happens returns the press, with a sentence", async () => {
    // The retry the issue asks for, in place of the native warning a second
    // press used to produce. The update is still downloaded and still
    // installable — so the control goes back to Apply rather than to Check.
    const probe = mount({ restartTimeoutMs: 20 });
    await settle();
    await push(ready);
    await probe.press();
    await probe.confirm();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(probe.update.action).toBe("apply");
    expect(probe.update.failure).toContain("has not restarted");
    expect(probe.update.label).toBe(probe.update.failure);
    // And it is a real retry: asked again, and the shell is asked again.
    await probe.press();
    await probe.confirm();
    expect(calls.filter((call) => call === "install")).toHaveLength(2);
    probe.unmount();
  });

  test("a rejected install explains itself and leaves the update installable", async () => {
    script.rejectInstall = "squirrel refused (scripted)";
    const probe = mount();
    await settle();
    await push(ready);
    await probe.press();
    await probe.confirm();
    await settle();
    expect(probe.update.failure).toContain("squirrel refused");
    expect(probe.update.action).toBe("apply");
    expect(probe.update.busy).toBe(false);
    probe.unmount();
  });

  test("the shell's own 'restarting' broadcast reaches a surface that never pressed", async () => {
    // Both surfaces are live at once; the one that was not pressed learns from
    // the shell rather than guessing.
    const probe = mount();
    await settle();
    await push({ status: "restarting", version: "0.3.1" });
    expect(probe.update.action).toBe("restarting");
    expect(probe.update.busy).toBe(true);
    probe.unmount();
  });
});

describe("the press that checks", () => {
  test("the spinner appears on the press, not on the shell's reply", async () => {
    const probe = mount();
    await settle();
    await probe.press();
    expect(probe.update.status.status).toBe("checking");
    expect(probe.update.busy).toBe(true);
    expect(calls).toContain("check");
    probe.unmount();
  });

  test("a build with no feed clears its own spinner", async () => {
    // "unsupported" comes back from the handler rather than over onStatus, so
    // nothing else would ever end this state.
    script.checkAnswer = { status: "unsupported" };
    const probe = mount();
    await settle();
    await probe.press();
    await settle();
    expect(probe.update.status.status).toBe("unsupported");
    expect(probe.update.busy).toBe(false);
    expect(probe.update.label).toContain("packaged locally");
    probe.unmount();
  });

  test("a rejected check says why and can be pressed again", async () => {
    script.rejectCheck = "feed unreachable (scripted)";
    const probe = mount();
    await settle();
    await probe.press();
    await settle();
    expect(probe.update.failure).toContain("feed unreachable");
    expect(probe.update.busy).toBe(false);
    expect(probe.update.action).toBe("check");
    probe.unmount();
  });

  test("an arriving download is not a thing to press", async () => {
    const probe = mount();
    await settle();
    await push({ status: "downloading", version: "0.3.1", percent: 40 });
    await probe.press();
    expect(calls).not.toContain("check");
    expect(probe.update.action).toBe("download");
    expect(probe.update.busy).toBe(true);
    probe.unmount();
  });

  test("a shell that says 'unsupported' out of band retires the control", async () => {
    const probe = mount();
    await settle();
    expect(probe.update.path).toBe("feed");
    await push({ status: "unsupported" });
    expect(probe.update.path).toBe("none");
    probe.unmount();
  });
});
