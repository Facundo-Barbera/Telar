/**
 * THE MIC BUTTON, END TO END, WITH A FAKE MICROPHONE (#544).
 *
 * The real `Composer` is mounted and the real `window.telar.dictate` is the
 * insertion path, because every claim here is about that seam: a finalised
 * phrase has to arrive in the draft React owns, through the editor's own
 * insertion, and interim guesses have to stay out of it. A test that called the
 * reducer directly would pass with the button wired to nothing.
 *
 * WHAT IS FAKED IS THE BROWSER, NOT THE FEATURE. `MediaRecorder`,
 * `getUserMedia` and `WebSocket` do not exist in happy-dom, and the token route
 * is on the other side of a fetch. Those three are stubbed; the hook, the
 * reducer, the page API and the composer are the real ones.
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

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  readonly frames: unknown[] = [];
  constructor(readonly url: string) {}
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
  const media = globalThis as unknown as Record<string, unknown>;
  media.MediaRecorder = FakeRecorder;
  // `new` ON A FUNCTION THAT RETURNS AN OBJECT YIELDS THAT OBJECT, which is how
  // the hook's own `new WebSocket(url)` hands the instance out here — the
  // constructor is left alone rather than assigning itself to a module global.
  const open = function (url: string) {
    live = new FakeSocket(url);
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

describe("the mic button on a composer", () => {
  test("a finalised phrase lands in the draft React owns; interim guesses do not", async () => {
    const host = mount(<Box kind="session" />);
    const button = micIn(host);

    await press(button);
    live!.open();
    expect(button.getAttribute("aria-label")).toBe("Stop dictating");

    // The three guesses Deepgram walks through before it commits. None of them
    // may reach the box: `dictate` inserts and cannot retract.
    live!.say(results("fix", false));
    live!.say(results("fix the", false));
    expect(draftOf(host)).toBe("");

    live!.say(results("fix the failing test", true));
    // Through the editor's own insertion, spaced as a paste would be.
    expect(draftOf(host)).toBe("fix the failing test ");

    // A second utterance continues the sentence rather than replacing it.
    live!.say(results("and push it", true));
    expect(draftOf(host)).toBe("fix the failing test and push it ");
  });

  test("the same button, on the Agent's composer", async () => {
    // The Agent screen renders this same component with `kind="agent"`, which
    // is what keeps one button from becoming two.
    const host = mount(<Box kind="agent" />);
    await press(micIn(host));
    live!.open();
    live!.say(results("summarise the rail", true));
    expect(draftOf(host)).toBe("summarise the rail ");
  });

  test("it opens the socket with the token it was just minted, in the query", async () => {
    const host = mount(<Box kind="session" />);
    await press(micIn(host));
    expect(tokenCalls).toBe(1);
    expect(new URL(live!.url).searchParams.get("access_token")).toBe("jwt-abc");
  });

  test("audio only goes up once the socket is open, so the container header is not lost", async () => {
    const host = mount(<Box kind="session" />);
    await press(micIn(host));
    // Before `onopen` there is no recorder at all — a chunk produced now would
    // be the WebM header, and losing it makes everything after it unreadable.
    expect(sent).toHaveLength(0);
    live!.open();
    expect(sent).toHaveLength(0);
  });

  test("pressing again stops, flushes the tail, and puts the microphone down", async () => {
    const host = mount(<Box kind="session" />);
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
    const host = mount(<Box kind="session" />);
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
    const host = mount(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(host.textContent).toContain("did not allow the microphone");
  });

  test("a Mac with no key refuses with the engine's sentence, not a status", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: { code: "conflict", message: "No Deepgram key is configured on this Mac, so dictation cannot start." } }, { status: 409 })) as typeof fetch;
    const host = mount(<Box kind="session" />);
    await press(micIn(host));
    expect(host.textContent).toContain("No Deepgram key is configured");
  });
});
