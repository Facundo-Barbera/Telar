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
/** What the Mac says to transcribe (#560). It rides the TOKEN answer, which is
 *  what the badge at the caret reads — so it is a knob for the same reason. */
let language = "multi";
/**
 * WHAT THE MAC SAYS TO PRIME THE RECOGNISER WITH (#581).
 *
 * A knob rather than a constant for one case in particular: `undefined` is what
 * an engine from before this field answers, and this button has to open the
 * socket anyway. Dictating without a glossary is what it did for its whole life
 * until now; refusing to dictate at all would be the regression.
 */
let keyterms: string[] | undefined = ["Telar", "Zarigüeya"];
/**
 * WHERE happy-dom SAYS THE CARET IS (#561).
 *
 * There is no layout in happy-dom, so `Range.getBoundingClientRect()` answers
 * all zeros and `caretRectIn` would correctly conclude it has nothing to place
 * a badge against. This is the layout engine's part, faked: a movable rect the
 * test slides to prove the pill follows it.
 */
let caretAt = { x: 120, y: 400 };

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
  language = "multi";
  keyterms = ["Telar", "Zarigüeya"];
  caretAt = { x: 120, y: 400 };
  // ONE LINE HIGH AND ZERO WIDE, which is what a real collapsed caret rect is.
  // Height matters: `caretRectIn` reads a zero-height rect as "no layout yet"
  // and falls through to its own fallbacks.
  Range.prototype.getBoundingClientRect = function () {
    return new DOMRect(caretAt.x, caretAt.y, 0, 18);
  };
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
      return Response.json({ provider: "deepgram", token: "jwt-abc", expiresAt: Date.now() + 300_000, language, keyterms });
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

  test("and it primes the recogniser with the glossary the Mac sent (#581)", async () => {
    // THE WHOLE OF THE BUG. The headset put up to forty of these on every
    // socket and this button put none, which is why the VR client understood
    // the app's own vocabulary and the cockpit did not.
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(new URL(live!.url).searchParams.getAll("keyterm")).toEqual(["Telar", "Zarigüeya"]);
  });

  test("a Mac that sends no glossary still opens the socket", async () => {
    // An engine from before this field. Dictating with nothing primed is what
    // every dictation did until now; a mic button that refused to open would
    // be a regression shipped by an improvement.
    keyterms = undefined;
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(live).toBeDefined();
    expect(new URL(live!.url).searchParams.has("keyterm")).toBe(false);
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

/* ------------------------------------------------------------------ *
 * THE BADGE AT THE CARET — issue #561.
 *
 * It is drawn into `document.body` through a portal rather than into
 * the composer, so every query below is against the DOCUMENT and not
 * against the host the composer was mounted in. That is as much the
 * claim as it is the mechanics: a badge inside the editable would be a
 * node `serialize()` walks and `paint()` destroys, and one inside the
 * composer would be clipped by its own `overflow-y-auto` — which is
 * exactly where the caret is when somebody starts talking.
 * ------------------------------------------------------------------ */

const pill = (): HTMLElement | null => document.querySelector('[data-slot="dictation-caret-pill"]');
const dimmed = (): HTMLElement | null => document.querySelector("[data-dictation-interim]");

/**
 * PUT A CARET IN THE BOX, which is what a person does before they press the
 * mic: they click into the message box, and then they speak.
 *
 * The other tests here never needed one — words go in at the end of the draft
 * whether or not anything is focused — but the badge is anchored to the caret
 * and is honestly absent when there is no caret to anchor to. happy-dom has no
 * click-to-caret, so the selection is made the way the editor's own
 * `placeCaret` makes one.
 */
function focusBox(host: HTMLElement): void {
  const editable = host.querySelector<HTMLElement>('[data-slot="composer-editor"]');
  if (!editable) throw new Error("no composer editor rendered");
  act(() => {
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

describe("the badge at the caret", () => {
  test("it is not there until the microphone is actually open", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    expect(pill()).toBeNull();

    const button = micIn(host);
    await press(button);
    // NOT WHILE STARTING EITHER. A press can still end in a refused permission
    // prompt, and a badge saying "listening" through that dialog would be wrong
    // for as long as somebody took to read it.
    expect(pill()).toBeNull();

    live!.open();
    expect(pill()).not.toBeNull();
  });

  test("and it goes away when dictation stops", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    const button = micIn(host);
    await press(button);
    live!.open();
    expect(pill()).not.toBeNull();

    await press(button);
    expect(pill()).toBeNull();
  });

  test("it says which language is being transcribed", async () => {
    language = "es";
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    expect(pill()?.textContent).toContain("ES");
  });

  test("`multi` says AUTO, which is what the picker calls it", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    expect(pill()?.textContent).toContain("AUTO");
    expect(pill()?.textContent).not.toContain("MULTI");
  });

  test("it follows the caret as words land", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    const before = pill()?.style.left;

    // The caret moves because words were written at it — which is the only
    // thing that moves it during a dictation, and the moment the hook is
    // already in the middle of.
    caretAt = { x: 260, y: 400 };
    live!.say(results("fix the failing", false));

    const after = pill()?.style.left;
    expect(after).not.toBe(before);
    expect(Number.parseFloat(after ?? "")).toBeGreaterThan(Number.parseFloat(before ?? ""));
  });

  test("it is not a control: no pointer events, and nothing for a screen reader", async () => {
    // It sits over the words being typed. A tap target there would eat a caret
    // placement mid-sentence, and the mic BUTTON is the thing with a name.
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    expect(pill()?.getAttribute("aria-hidden")).toBe("true");
    expect(pill()?.className).toContain("pointer-events-none");
  });

  test("it is drawn outside the composer, never inside the editable", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    const editable = host.querySelector('[data-slot="composer-editor"]');
    expect(editable).not.toBeNull();
    expect(editable?.contains(pill())).toBe(false);
    expect(host.contains(pill())).toBe(false);
  });
});

describe("the words still being revised", () => {
  test("the unconfirmed run is drawn dimmer, and settles when the phrase does", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();

    live!.say(results("fix the failing", false));
    // THE GUESS IS MARKED, and it is exactly the guess — not the space the
    // composer added in front of it when it spliced the words in.
    expect(dimmed()?.textContent).toBe("fix the failing");

    live!.say(results("fix the failing test", false));
    expect(dimmed()?.textContent).toBe("fix the failing test");

    // A FINAL LEAVES NOTHING DIM. The words are the person's now.
    live!.say(results("fix the failing test", true));
    expect(dimmed()).toBeNull();
    expect(draftOf(host)).toBe("fix the failing test ");
  });

  test("the draft is the same string with the dim on it or without it", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();

    live!.say(results("hello there", false));
    // THE COMPOSER'S ONE RULE, held: the dim is a drawing of the draft and not
    // part of it, so what would be SENT is unchanged by its being there.
    expect(draftOf(host)).toBe("hello there ");
    expect(dimmed()).not.toBeNull();
  });

  test("stopping mid-guess leaves the words and takes the dim off them", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();

    live!.say(results("half a sentence", false));
    expect(dimmed()).not.toBeNull();

    await press(button);
    // They said it; they can edit it. What must not survive is the MARKING —
    // greyed-out text in a box nobody is dictating into is the app lying.
    expect(draftOf(host)).toBe("half a sentence ");
    expect(dimmed()).toBeNull();
  });

  test("the caret is tinted while the microphone is open, and only then", async () => {
    const host = await mounted(<Box kind="session" />);
    const editable = () => host.querySelector('[data-slot="composer-editor"]');
    expect(editable()?.hasAttribute("data-dictating")).toBe(false);

    const button = micIn(host);
    await press(button);
    live!.open();
    // The quiet signal beside the loud one — and the one that survives the
    // badge being scrolled out of view.
    expect(editable()?.hasAttribute("data-dictating")).toBe(true);

    await press(button);
    expect(editable()?.hasAttribute("data-dictating")).toBe(false);
  });
});
