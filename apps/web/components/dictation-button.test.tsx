/**
 * THE MIC BUTTON, END TO END, WITH A FAKE MICROPHONE (#544).
 *
 * The real `Composer` is mounted and the real composer registry is the write
 * path, because every claim here is about that seam: interim words have to
 * arrive in the draft React owns and be REPLACED there as Deepgram revises
 * them, through the editor's own writes. A test that called the writer
 * directly would pass with the button wired to nothing — `lib/dictation/
 * interim.test.ts` is that test, and this is the one that holds the wiring.
 *
 * WHAT IS FAKED IS THE BROWSER, NOT THE FEATURE. `MediaRecorder`,
 * `getUserMedia` and `WebSocket` do not exist in happy-dom, and the token route
 * is on the other side of a fetch. Those three are stubbed; the hook, the
 * reducer, the registry and the composer are the real ones.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "@/components/composer";
import { installPageApi } from "@/lib/page-api";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  // LET REACT FINISH BEFORE THE DOM IS TAKEN AWAY. The scheduler posts its work
  // as a task and reads `window.event` when it runs; unregistering with one
  // still queued throws `window is not defined` out of a test that has already
  // passed, which is an unhandled error nobody can attribute.
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  await GlobalRegistrator.unregister();
});

/* ------------------------------------------------------------------ *
 * The browser this button needs and happy-dom does not have.
 * ------------------------------------------------------------------ */

/** The socket the hook opened, so a test can push frames down it. */
let live: FakeSocket | undefined;
/** Chunks the recorder handed to it — the proof audio actually went up. */
let sent: unknown[] = [];
/** Tracks the page is holding. All stopped after a press is the browser's
 *  recording indicator going out, which is the one thing a microphone control
 *  must not get wrong. */
class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
let tracks: FakeTrack[] = [];
let tokenCalls = 0;
/** What `GET /api/dictation` answers. The button's whole existence hangs on
 *  it, so it is a knob rather than a constant. */
let provider: "off" | "deepgram" = "deepgram";

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  readonly frames: unknown[] = [];
  constructor(
    readonly url: string,
    /** The `Sec-WebSocket-Protocol` values — where the credential actually
     *  goes, so this test can hold that claim. */
    readonly protocols?: string | string[],
  ) {}
  send(data: unknown) {
    this.frames.push(data);
    sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  /** What the network would do a tick later. */
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  say(frame: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }
}

class FakeRecorder {
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  state = "inactive";
  ondataavailable?: (event: { data: { size: number } }) => void;
  constructor(
    readonly stream: unknown,
    readonly options?: { mimeType?: string },
  ) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
  }
}

const results = (transcript: string, isFinal: boolean) => ({
  type: "Results",
  is_final: isFinal,
  channel: { alternatives: [{ transcript }] },
});

beforeEach(() => {
  live = undefined;
  sent = [];
  tracks = [];
  tokenCalls = 0;
  provider = "deepgram";
  const media = globalThis as unknown as Record<string, unknown>;
  media.MediaRecorder = FakeRecorder;
  // `new` ON A FUNCTION THAT RETURNS AN OBJECT YIELDS THAT OBJECT, which is how
  // the hook's own `new WebSocket(url)` hands the instance out here — the
  // constructor is left alone rather than assigning itself to a module global.
  const open = function (url: string, protocols?: string | string[]) {
    live = new FakeSocket(url, protocols);
    return live;
  };
  // The hook compares `readyState` against `WebSocket.OPEN` before every send,
  // so the stand-in has to carry the constant as well as the constructor —
  // without it every comparison is against `undefined` and nothing is ever
  // sent, which fails as "the tail was not flushed" three tests away.
  open.OPEN = FakeSocket.OPEN;
  media.WebSocket = open;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        tracks.push(new FakeTrack());
        return { getTracks: () => tracks };
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/api/dictation/token")) {
      tokenCalls += 1;
      return Response.json({ provider: "deepgram", token: "jwt-abc", expiresAt: Date.now() + 300_000 });
    }
    if (url.includes("/api/dictation")) return Response.json({ dictation: { provider, configured: provider !== "off" } });
    return Response.json({});
  }) as typeof fetch;
});

/* ------------------------------------------------------------------ *
 * A composer whose draft is owned the way the cockpit owns it.
 * ------------------------------------------------------------------ */

function Box({ kind }: { kind: "session" | "agent" }) {
  const [draft, setDraft] = useState("");
  return (
    <>
      <p data-testid="draft">{draft}</p>
      <Composer
        draft={draft}
        kind={kind}
        ready
        attachments={[]}
        onAttach={() => {}}
        busy={false}
        sending={false}
        backgroundTasks={0}
        onDraftChange={setDraft}
        onSubmit={() => {}}
        onStop={() => {}}
        onStopBackground={() => {}}
        onRuntimeMode={() => {}}
      />
    </>
  );
}

const roots: { root: Root; host: HTMLElement }[] = [];

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push({ root, host });
  return host;
}

/**
 * Mount and let the provider setting land.
 *
 * THE BUTTON IS NOT THERE ON THE FIRST PAINT, by design: `off` is the default
 * and the hook reports it until the engine answers, so a mic never flashes into
 * a toolbar and back out. Every test here is about a Mac where dictation is on,
 * so they all have to wait for that answer — which is a real macrotask, not a
 * countable number of microtasks.
 */
async function mounted(node: React.ReactNode): Promise<HTMLElement> {
  const host = mount(node);
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  return host;
}

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

beforeAll(() => {
  installPageApi();
});

const micIn = (host: HTMLElement): HTMLButtonElement => {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Dictate"], button[aria-label="Stop dictating"]');
  if (!button) throw new Error("no mic button rendered");
  return button;
};

const draftOf = (host: HTMLElement): string => host.querySelector('[data-testid="draft"]')?.textContent ?? "";

/**
 * Press, and let the token fetch and the permission prompt settle.
 *
 * A REAL TICK, not a handful of microtasks: `dictationToken()` awaits a
 * `Response` and then its `json()`, and counting the microtasks that takes is
 * counting an implementation detail of `fetch`. A macrotask drains all of them.
 */
async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

describe("whether there is a mic button at all", () => {
  test("no button on a Mac where dictation is off — which is every Mac by default", async () => {
    provider = "off";
    const host = await mounted(<Box kind="session" />);
    // NOT A DISABLED ONE. macOS dictation and Wispr Flow already work in this
    // box, so an uninvited mic would be Telar claiming a job the reader may
    // have given to something else.
    expect(host.querySelector('button[aria-label="Dictate"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Stop dictating"]')).toBeNull();
  });

  test("nothing is even asked for while it is off", async () => {
    provider = "off";
    await mounted(<Box kind="session" />);
    // No token minted, no microphone prompt — there is no control to press.
    expect(tokenCalls).toBe(0);
  });

  test("it appears once a provider is chosen", async () => {
    const host = await mounted(<Box kind="session" />);
    expect(host.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  });
});

describe("the mic button on a composer", () => {
  test("interim words go into the draft React owns and are replaced in place", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);

    await press(button);
    live!.open();
    expect(button.getAttribute("aria-label")).toBe("Stop dictating");

    // Each guess REPLACES the last in the box rather than joining it — the
    // whole of what changed here. Three guesses, one phrase on screen.
    live!.say(results("fix", false));
    expect(draftOf(host)).toBe("fix ");
    live!.say(results("fix the", false));
    expect(draftOf(host)).toBe("fix the ");

    live!.say(results("fix the failing test", true));
    expect(draftOf(host)).toBe("fix the failing test ");

    // A second utterance continues the sentence rather than replacing it: the
    // final settled the words and the span was forgotten.
    live!.say(results("and push", false));
    expect(draftOf(host)).toBe("fix the failing test and push ");
    live!.say(results("and push it", true));
    expect(draftOf(host)).toBe("fix the failing test and push it ");
  });

  test("nothing unconfirmed is printed beside the button any more", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();
    live!.say(results("in the box", false));

    expect(draftOf(host)).toBe("in the box ");
    // THE CAPTION IS GONE. Its wrapper holds the button and a refusal and
    // nothing else — a live transcription printed in two places on one screen
    // is the thing that was taken out.
    expect(button.parentElement!.textContent).toBe("Listening");
  });

  test("the same button, on the Agent's composer", async () => {
    // The Agent screen renders this same component with `kind="agent"`, which
    // is what keeps one button from becoming two.
    const host = await mounted(<Box kind="agent" />);
    await press(micIn(host));
    live!.open();
    live!.say(results("summarise the rail", true));
    expect(draftOf(host)).toBe("summarise the rail ");
  });

  test("a person typing mid-guess keeps their keystrokes and the dictation carries on", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    live!.open();
    live!.say(results("recording", false));
    expect(draftOf(host)).toBe("recording ");

    // Typing into the box through the editor itself, which is what makes the
    // writer's own guard fire: the draft is no longer the one it committed.
    const editable = host.querySelector<HTMLElement>('[data-slot="composer-editor"]')!;
    act(() => {
      editable.textContent = "typed over it";
      editable.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(draftOf(host)).toBe("typed over it");

    live!.say(results("recording now", false));
    // NOT ONE CHARACTER OF THEIRS IS EATEN. The stale span was dropped and the
    // new guess opened a fresh one.
    expect(draftOf(host)).toContain("typed over it");
    expect(draftOf(host)).toContain("recording now");
  });

  test("it opens the socket with the token it was just minted, as the bearer subprotocol", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(tokenCalls).toBe(1);
    // THE WHOLE OF THE BUG #555 SHIPPED: the query parameter is refused by
    // Deepgram with close 1002, and `["bearer", jwt]` is what opens.
    expect(live!.protocols).toEqual(["bearer", "jwt-abc"]);
    expect(new URL(live!.url).searchParams.get("access_token")).toBeNull();
  });

  test("audio only goes up once the socket is open, so the container header is not lost", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    // Before `onopen` there is no recorder at all — a chunk produced now would
    // be the WebM header, and losing it makes everything after it unreadable.
    expect(sent).toHaveLength(0);
    live!.open();
    expect(sent).toHaveLength(0);
  });

  test("pressing again stops, flushes the tail, and puts the microphone down", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();
    const socket = live!;

    await press(button);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    // CloseStream before the close: Deepgram holds the tail of an utterance
    // until it hears silence or this, and those are the words just spoken.
    expect(socket.frames).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.readyState).toBe(3);
    // The browser's recording dot goes out because the track is stopped, not
    // because the button changed colour.
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("leaving the screen mid-dictation releases the microphone", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    live!.open();
    for (const { root, host: node } of roots.splice(0)) {
      act(() => root.unmount());
      node.remove();
    }
    expect(tracks.every((track) => track.stopped)).toBe(true);
    void host;
  });

  test("a refused microphone is said in the person's own terms, and nothing is left running", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const denial = new Error("Permission denied");
          denial.name = "NotAllowedError";
          throw denial;
        },
      },
    });
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(host.textContent).toContain("did not allow the microphone");
  });

  test("a Mac with a provider chosen but no key refuses with the engine's sentence, not a status", async () => {
    // ONLY THE MINT REFUSES. The provider read still answers, because that is
    // the state this Mac is actually in: dictation is switched on, so there IS
    // a button, and pressing it is what finds out the key is missing.
    const settings = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (!url.includes("/api/dictation/token")) return settings(input, init);
      return Response.json({ error: { code: "conflict", message: "No Deepgram key is configured on this Mac, so dictation cannot start." } }, { status: 409 });
    }) as typeof fetch;
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(host.textContent).toContain("No Deepgram key is configured");
  });

  test("a provider this browser cannot drive is refused by name rather than opening the wrong socket", async () => {
    const settings = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (!url.includes("/api/dictation/token")) return settings(input, init);
      // A Mac that has moved on to a provider this build does not know. Its
      // socket, format and credential scheme are all different.
      return Response.json({ provider: "openai", token: "jwt-abc", expiresAt: Date.now() + 300_000 });
    }) as typeof fetch;
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(live).toBeUndefined();
    expect(host.textContent).toContain("openai");
  });
});
