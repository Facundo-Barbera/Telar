"use client";

/**
 * PUSH-TO-TALK, FROM THE BUTTON'S SIDE (#544).
 *
 * ── THE WHOLE SHAPE IN ONE PARAGRAPH ────────────────────────────────────────
 * Press the button: ask this Mac's engine for a token that dies in five
 * minutes, ask the browser for the microphone, open a socket straight to
 * Deepgram with that token, and push 250 ms chunks of audio up it. Words come
 * back and go INTO the composer as they are heard, rewritten in place until
 * Deepgram settles them. Press it again and everything unwinds.
 *
 * ── THE WORDS GO IN THE BOX, NOT IN A CAPTION ───────────────────────────────
 * The first cut parked unconfirmed guesses beside the button and only inserted
 * a phrase once it was final, because `window.telar.dictate` inserts and cannot
 * retract. That reads as lag. The retraction now lives on the composer registry
 * as `replace`, where the only callers are this app's own components, and the
 * page API keeps its three calls exactly as external clients have them — see
 * `lib/composer-registry.ts` and `lib/dictation/interim.ts`, which owns every
 * rule about the span and about somebody typing into the middle of it.
 *
 * ── TOGGLE, NOT HOLD ────────────────────────────────────────────────────────
 * The owner asked for toggle. It is also the only one that works on all three
 * surfaces: hold-to-talk on a phone means holding a finger on the screen while
 * the keyboard is up, and on the desktop it means a pointer that cannot leave
 * the button — a chord nobody can use while reading the thing they are
 * dictating about. The cost is that a forgotten recording keeps running, which
 * is what the state has to be LOUD about: see `DictationState.phase`, and the
 * button that draws it.
 *
 * ── NOTHING IS HELD BETWEEN PRESSES ─────────────────────────────────────────
 * A new token per press, not a cached one: it expires in minutes, and a cache
 * would be a credential kept alive for the length of a session to save one
 * round trip. The microphone stream is stopped on every path out, which is what
 * puts the browser's recording indicator away — a page that keeps a live track
 * after the button says idle is a page nobody trusts twice.
 *
 * ── WHICH MICROPHONE IS THIS BROWSER'S ANSWER, NOT THE MAC'S (#643) ─────────
 * Read from `devices.ts` at the press, not carried on the token with the
 * language and the glossary. Those are facts about the Mac and are the same for
 * every surface reading it; a microphone is plugged into ONE machine and its
 * `deviceId` is minted per browser profile, so the engine is the wrong place to
 * keep it and a phone could not use the answer anyway. It rides as `ideal`,
 * which is what makes an unplugged headset degrade to the default rather than
 * fail the press.
 *
 * ── AND THE STREAM IS TAPPABLE, SO THE SETTINGS PANE HAS ONE MICROPHONE ─────
 * `onStream` hands the live track to whoever asked to read it — the level meter
 * in Settings › Dictation — and hands over `undefined` on every path out. It is a
 * tap and not a transfer: this hook remains the only thing that stops those
 * tracks.
 *
 * ── REFS, NOT STATE, FOR THE MACHINERY ──────────────────────────────────────
 * The socket, the recorder, the tracks and the interim writer are not rendered
 * and must not re-render anything when they change; what state carries is the
 * two things the button DRAWS — the phase and the last refusal.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createEngineApi } from "@/lib/engine/client";
import { CHUNK_MS, listenProtocols, listenUrl, recordingType } from "./deepgram";
import { audioConstraints, readMicrophone } from "./devices";
import { createDictationWriter, type DictationBox } from "./interim";
import { microphoneRefusal, microphoneUnavailable } from "./refusal";
import { parseFrame, readFrame } from "./transcript";

export type DictationPhase =
  /** Nothing is running and the microphone is released. */
  | "idle"
  /** A token is being minted and the microphone asked for. */
  | "starting"
  /** The socket is open and audio is going up. */
  | "listening";

export type DictationState = {
  phase: DictationPhase;
  /**
   * Why it stopped, or would not start. A sentence: the button's only move is
   * to show it to a person.
   *
   * AND WHICH REFUSAL IT IS (#707). The sentence alone is not an identity: two
   * presses that fail the same way are two pieces of news, and a notice that
   * hides itself after a few seconds — which is what the toolbar now draws —
   * would stay hidden for the second one if it keyed on the words. `seq`
   * counts refusals, so an identical sentence twice is twice.
   */
  error?: { text: string; seq: number };
  /** Toggle. Starting while listening stops, which is what pressing the one
   *  button twice has to mean. */
  toggle: () => void;
  /** Whether this browser can dictate at all — no `MediaRecorder`, no
   *  `getUserMedia` (an insecure origin, or a locked-down embed), no button. */
  supported: boolean;
  /**
   * WHERE TO DRAW THE INDICATOR, AND WHAT TO PUT IN IT (#561).
   *
   * `undefined` whenever there is nothing to draw — not listening, or the caret
   * is not in a box this dictation can see. The rect is in VIEWPORT
   * coordinates, so the pill is positioned without knowing anything about the
   * composer's own scroll or layout.
   *
   * RE-READ AFTER EVERY FRAME rather than watched: words landing is the only
   * thing that moves the caret during a dictation, and that is a moment this
   * hook is already in the middle of. A `ResizeObserver` or a rAF loop would be
   * a subscription for an event we are the cause of.
   */
  caret?: { rect: DOMRect; language: string };
};

/** A frame Deepgram reads as "that is the end of the audio, flush what you
 *  have" — sent before the close so the last words are not lost with the
 *  socket. Documented as `{ "type": "CloseStream" }`. */
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" });

/** Module-level so the subscription identity is stable across renders — a fresh
 *  closure here would make `useSyncExternalStore` resubscribe on every one. */
const neverChanges = () => () => {};

/** No `MediaRecorder` (an old browser), or no `getUserMedia` (an insecure
 *  origin, or an embed with no microphone permission) — either way there is
 *  nothing to offer, and a control that is permanently disabled is an
 *  advertisement for something the reader cannot have.
 *
 *  EXPORTED FOR THE SETTINGS PANE (#643), which asks the same question and then
 *  says WHY rather than drawing nothing — see `refusal.ts`. One fact, one
 *  expression: a second copy is how the button and the pane come to disagree
 *  about whether this browser can dictate. */
export const canRecord = (): boolean => typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

/**
 * WHY THIS PAGE CANNOT RECORD, AS A SENTENCE, OR NOTHING (#639).
 *
 * `canRecord` is the fact and this is the words for it. It lives here, beside
 * the fact, because there are now two readers — the Settings pane (#643) and
 * the composer's own mic button — and a second copy is how a button that draws
 * nothing and a pane that explains why come to disagree about this browser.
 *
 * `useSyncExternalStore` RATHER THAN A READ DURING RENDER: this is a question
 * about `window`, and both callers are server-rendered first. Reading it inline
 * would answer one thing on the server and another in the browser — a hydration
 * mismatch on every screen with a composer. `undefined` is the server answer,
 * which is also the optimistic one: nothing is said until the browser has been
 * asked, rather than flashing a refusal at somebody whose page is fine.
 *
 * THE CARVE-OUT THIS RELIES ON IS MARKED "AT RISK". W3C Secure Contexts treats
 * `127.0.0.0/8` and `::1/128` as Potentially Trustworthy with no certificate —
 * which is the whole reason dictation works on this Mac and why a tunnel is the
 * cheap fix. The spec flags it as at risk. Unlikely to move, since much of the
 * web's tooling stands on it, but it is not a permanent guarantee, and the
 * sentence below and `docs/dictation-secure-context.md` both rest on it.
 */
export function useMicrophoneUnavailable(): string | undefined {
  return useSyncExternalStore(
    neverChanges,
    () => microphoneUnavailable({ secure: window.isSecureContext, canRecord: canRecord() }),
    () => undefined,
  );
}

export function useDictation(input: {
  /** THE BOX BEING SPOKEN INTO, resolved per dictation rather than held: the
   *  composer a person is looking at is whichever one is mounted and most
   *  recently focused, and that is a question with a different answer at the
   *  moment of the press than at the moment the hook was created.
   *
   *  `undefined` means there is none on screen, which is a refusal rather than
   *  a silent no-op. Injected so a test can drive the whole loop against a box
   *  that is a string. */
  box?: () => DictationBox | undefined;
  /**
   * THE LIVE TRACK, HANDED OUT SO IT CAN BE TAPPED — never so it can be owned
   * (#643).
   *
   * Called with the stream the moment it is open, and with `undefined` on every
   * path out. It exists for the level meter in Settings › Dictation, which has
   * to read the SAME audio going up to the provider rather than open a second
   * microphone: two streams could disagree, and two recording lights is one
   * more than anybody asked for.
   *
   * THE CALLEE MUST NOT STOP THE TRACKS. This hook releases the microphone on
   * every path out — that release is what puts the browser's recording dot away
   * — and a tap that stopped them would be a second owner of one device.
   */
  onStream?: (stream: MediaStream | undefined) => void;
}): DictationState {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [error, setError] = useState<{ text: string; seq: number }>();
  /** HOW MANY REFUSALS THERE HAVE BEEN, which is what makes two identical
   *  sentences two pieces of news — see `DictationState.error`. A ref because
   *  it is never drawn on its own; it only ever rides an error that is. */
  const refusals = useRef(0);
  /** EVERY REFUSAL GOES THROUGH HERE, so none of them can forget the counter. */
  const refuse = useCallback((text: string) => {
    refusals.current += 1;
    setError({ text, seq: refusals.current });
  }, []);
  /**
   * ASK THE ENGINE WHY, AND SAY THAT INSTEAD (#711).
   *
   * THIS TAB CANNOT LEARN IT AND NEVER WILL. A `WebSocket` error event carries
   * no reason by design; the engine holds the key and can ask Deepgram, so it
   * does — once, on a route every surface shares. `400 Bad Request — Keyterm
   * limit exceeded` is the sentence that reached the owner as "the connection
   * failed" and sent him to replace a key that was fine.
   *
   * AFTER THE HONEST SENTENCE, NOT INSTEAD OF IT. The refusal is shown the
   * instant the socket fails, because a caption that waited on a round trip
   * would be silence at exactly the moment somebody is wondering whether their
   * press registered. The better sentence replaces it when it arrives.
   *
   * THROUGH `refuse`, so the replacement counts as a refusal of its own — which
   * is what restarts the notice's dismissal timer. Arriving two seconds in and
   * keeping the first sentence's timer would give a longer, more important
   * sentence four seconds to be read.
   *
   * AND ONLY IF NOTHING HAS HAPPENED SINCE. `after` is the refusal count at the
   * moment of the failure: a person who pressed again while this was in flight
   * has a newer sentence on screen, and overwriting it with the diagnosis of an
   * older press would be the app answering a question nobody is still asking.
   *
   * EVERY FAILURE HERE IS SILENT. This is a better sentence for a refusal that
   * already has one; a toast about the diagnosis failing would be Telar
   * reporting on its own plumbing.
   */
  const diagnose = useCallback(
    async (after: number) => {
      try {
        const said = await createEngineApi().dictationDiagnosis();
        if (refusals.current !== after || !said.reason) return;
        refuse(said.reason);
      } catch {
        // An engine too old for the route, a Mac that is off, a failed fetch.
        // The honest sentence is already on screen and stays.
      }
    },
    [refuse],
  );
  /** WHERE THE PILL GOES (#561), re-measured whenever words land. State rather
   *  than a ref because it is drawn; `undefined` is "nothing to draw". */
  const [caret, setCaret] = useState<{ rect: DOMRect; language: string }>();
  /**
   * WHETHER THIS BROWSER CAN RECORD AT ALL.
   *
   * `useSyncExternalStore` RATHER THAN A READ DURING RENDER, and the third
   * argument is the whole reason: this is a question about `window`, and the
   * composer is server-rendered first. Reading it inline would answer `false`
   * on the server and `true` in the browser — a hydration mismatch, with React
   * finding a button in the client tree where the server sent none, on every
   * screen that has a composer.
   *
   * AND RATHER THAN AN EFFECT THAT SETS STATE, which is the cascading render
   * this app's lint forbids. `getServerSnapshot` is the hook's own answer to
   * exactly this shape.
   *
   * IT NEVER CHANGES after the first client render, so `subscribe` is a no-op:
   * a browser does not grow a `MediaRecorder` mid-session.
   */
  const supported = useSyncExternalStore(neverChanges, canRecord, () => false);

  const socket = useRef<WebSocket>(null);
  const recorder = useRef<MediaRecorder>(null);
  const stream = useRef<MediaStream>(null);
  /** How to find the box, held in a ref so `toggle` is stable across renders —
   *  the button passes a fresh closure every time it re-renders, and a `toggle`
   *  that changed identity with it would re-arm every effect that holds one. */
  const box = useRef(input.box);
  // IN AN EFFECT, NOT IN THE BODY. Writing a ref during render is what this
  // app's lint forbids, and the rule is right here: the composer re-renders on
  // every keystroke, so this runs constantly, and the value is only ever read
  // from a socket callback — which is after the commit either way.
  useEffect(() => {
    box.current = input.box;
  }, [input.box]);
  /** The tap, held for `box`'s reason: the pane passes a fresh closure on every
   *  render and it is only ever called from a path that is already past the
   *  commit. */
  const onStream = useRef(input.onStream);
  useEffect(() => {
    onStream.current = input.onStream;
  }, [input.onStream]);
  /** THE SPAN, FOR ONE DICTATION. Built at the press and dropped at the
   *  teardown: a writer kept between presses would hold offsets into a draft
   *  the person has since rewritten, and the next utterance would replace their
   *  words with its own. See `interim.ts`. */
  const writer = useRef<ReturnType<typeof createDictationWriter>>(null);
  /**
   * WHICH DICTATION THIS IS. Starting is asynchronous — a token round trip, a
   * permission prompt — and stopping is not, so a second press lands in the
   * middle of the first press's `await`. Without a fence, that `start` would
   * come back and install its socket and its recorder into a hook that has
   * already torn down, and the microphone would stay live under a button
   * saying idle. Every teardown moves this on; a `start` whose generation is
   * stale drops what it built instead of adopting it.
   */
  const generation = useRef(0);

  /**
   * EVERY PATH OUT COMES THROUGH HERE, including the ones that failed before
   * anything opened. Releasing the microphone is the step that must not be
   * conditional: a page holding a live track after the button says idle keeps
   * the browser's recording dot lit, and that is the kind of thing people
   * uninstall an app over.
   */
  /** The box this dictation is writing into, held for the length of it so the
   *  teardown can take its marks back off — the registry's "active composer"
   *  may well be a different one by then. */
  const marked = useRef<DictationBox>(null);

  const teardown = useCallback(() => {
    generation.current += 1;
    // THE MARKS COME OFF FIRST, and they come off on EVERY path out — a failed
    // start, a lost socket, an unmount. A box left with a tinted caret and a
    // greyed-out run after the microphone has closed is the app lying about
    // what it is doing.
    marked.current?.dictating?.({ listening: false });
    marked.current = null;
    setCaret(undefined);
    try {
      if (recorder.current?.state === "recording") recorder.current.stop();
    } catch {
      // A recorder in a state that cannot stop is already stopped.
    }
    recorder.current = null;
    const open = socket.current;
    socket.current = null;
    if (open) {
      try {
        // FLUSH BEFORE CLOSING. Deepgram holds the tail of an utterance until
        // it hears silence or this; closing the socket without it drops the
        // last few words, which is exactly the words somebody just said.
        if (open.readyState === WebSocket.OPEN) open.send(CLOSE_STREAM);
        open.close();
      } catch {
        // Already closing.
      }
    }
    // THE TAP IS TOLD BEFORE THE TRACKS STOP, so whatever is reading the stream
    // lets go of it while it is still a valid one — an analyser left connected
    // to a dead track is a bar frozen at the last thing it heard.
    if (stream.current) onStream.current?.(undefined);
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    // THE WORDS STAY IN THE BOX, the span does not. Whatever was written is the
    // person's draft now — including a guess Deepgram never got to settle,
    // which is the right call: they said it, and they can edit it.
    writer.current?.forget();
    writer.current = null;
    setPhase("idle");
  }, []);

  // ONE OWNER OF THE MICROPHONE PER MOUNT. Leaving the screen mid-dictation
  // releases it; without this a navigation would leave a socket streaming a
  // room to Deepgram with nothing on screen saying so.
  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    const mine = generation.current;
    const abandoned = (): boolean => generation.current !== mine;
    setError(undefined);
    setPhase("starting");
    // THE BOX FIRST, AND BEFORE THE TOKEN. Resolved once and held for this
    // whole dictation: the words have to keep going to the composer that was
    // on screen at the press, not to whichever one is focused eight frames
    // later. No box is a refusal rather than a silent no-op, and finding that
    // out costs nothing — a token spent and a microphone prompt raised for a
    // screen with no message box on it would both be for nothing.
    const speaking = box.current?.();
    if (!speaking) {
      refuse("No message box is on screen to dictate into.");
      setPhase("idle");
      return;
    }
    writer.current = createDictationWriter(speaking);
    try {
      // THE TOKEN FIRST, because it is the step that can fail for a reason the
      // person can fix — no key pasted, Deepgram refusing. Asking for the
      // microphone first would raise a permission prompt on a Mac that cannot
      // dictate at all, which is a prompt with nothing behind it.
      const minted = await createEngineApi().dictationToken();
      if (abandoned()) return;
      // WHICH SOCKET TO OPEN IS THE ANSWER'S TO SAY, not this file's to assume.
      // Everything below — the URL, the subprotocol, the container audio — is
      // Deepgram's shape; an OpenAI or on-device provider arrives with a
      // different one. Refusing by name is what keeps a future Mac from being
      // driven by an older browser tab that would send it the wrong bytes.
      if (minted.provider !== "deepgram") {
        throw new Error(`This browser does not know how to dictate with ${minted.provider}. Update Telar, or choose another provider in Settings → Dictation.`);
      }
      // WHICH MICROPHONE, READ AT THE PRESS (#643). A per-device choice kept in
      // this browser's own storage rather than on the engine — see `devices.ts`
      // for why a headset is not a fact about the Mac — so it is read here
      // rather than carried on the token, and it rides as `ideal`: an unplugged
      // headset degrades to the default instead of failing the press.
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(readMicrophone()) });
      // A PERMISSION PROMPT CAN OUTLAST THE PRESS. Granted after a stop, the
      // track is live and owned by nobody — so it is stopped here rather than
      // stored, which is the one case the teardown above cannot reach.
      if (abandoned()) {
        for (const track of microphone.getTracks()) track.stop();
        return;
      }
      stream.current = microphone;
      // THE TAP, ONCE THE STREAM IS OURS TO SPEAK FOR. Before the socket opens,
      // so the meter in the settings pane is already moving while the provider
      // is still connecting — which is exactly the interval where a person needs
      // to know whether the microphone or the provider is the problem.
      onStream.current?.(microphone);

      // THE TOKEN IS THE SECOND ARGUMENT, NOT A QUERY PARAMETER. Deepgram
      // refuses `?access_token=` on this endpoint (close 1002, "Expected 101
      // status code") and reads the credential out of the requested
      // subprotocols instead — see `listenProtocols` and the header of
      // `deepgram.ts`, where the three ways that were probed are written down.
      //
      // THE LANGUAGE COMES OFF THE TOKEN ANSWER (#560) rather than from a
      // second fetch or from `useDictationSettings`: this press already costs
      // one round trip, and the engine knows both answers at the moment it
      // mints. A settings hook here would also be a race — the button would
      // open a socket with whatever the hook had loaded by then.
      //
      // AND SO DOES THE GLOSSARY (#581). The keyterms are built from this Mac's
      // unsettled conversations, its projects and the terms somebody typed into
      // Settings — none of which this tab can see — so they arrive with the
      // credential rather than being worked out here.
      // `?? []` BECAUSE THE ENGINE ON THIS MAC MAY PREDATE THE FIELD: it
      // updates on its own schedule, and a mic button that stopped working
      // rather than dictating without a glossary would be a worse outcome than
      // the bug this closes.
      const live = new WebSocket(listenUrl(minted.language, minted.keyterms ?? []), listenProtocols(minted.token));
      socket.current = live;

      /** The pill, and the dim, re-read from the one place that knows. Called
       *  when the socket opens and after every frame that writes. */
      const redraw = (): void => {
        speaking.dictating?.({ listening: true, ...(writer.current?.span() ? { interim: writer.current.span() } : {}) });
        const rect = speaking.caretRect?.();
        setCaret(rect ? { rect, language: minted.language } : undefined);
      };

      live.onopen = () => {
        // THE RECORDER STARTS ONLY ONCE THE SOCKET IS OPEN. Chunks produced
        // before it are chunks with nowhere to go, and the first of them
        // carries the container header — losing that one makes everything
        // after it unreadable.
        const type = recordingType();
        const tape = new MediaRecorder(microphone, type ? { mimeType: type } : {});
        recorder.current = tape;
        tape.ondataavailable = (event) => {
          if (event.data.size > 0 && live.readyState === WebSocket.OPEN) live.send(event.data);
        };
        tape.start(CHUNK_MS);
        setPhase("listening");
        // THE PILL APPEARS WHEN THE MICROPHONE IS ACTUALLY OPEN, not at the
        // press: `starting` can end in a refused permission prompt, and an
        // indicator that said "listening" through that would be wrong for as
        // long as somebody took to read the dialog.
        marked.current = speaking;
        redraw();
      };

      live.onmessage = (event: MessageEvent) => {
        const frame = parseFrame(event.data);
        if (!frame) return;
        const words = readFrame(frame);
        // A FRAME THAT SAYS NOTHING ABOUT THE WORDS — metadata, an utterance
        // end, a keep-alive — must not touch the draft at all, which is why
        // the reducer answers `undefined` rather than a pair of empty strings.
        if (!words) return;
        const refusal = writer.current?.write(words);
        // A COMPOSER THAT TURNED THE WRITE AWAY ends the dictation rather than
        // dropping words silently: it has unmounted, or the conversation is not
        // ready, and every following frame would meet the same wall.
        if (refusal && !refusal.ok) {
          refuse(refusal.reason);
          teardown();
          return;
        }
        // AFTER THE WRITE, NOT BEFORE IT: the words that just landed are what
        // moved the caret, and the span the writer now holds is the run they
        // occupy. A frame that said nothing about the words returned above and
        // never reaches here, so the pill does not twitch on a keep-alive.
        redraw();
      };

      live.onerror = () => {
        // A WEBSOCKET ERROR EVENT CARRIES NOTHING. The browser deliberately
        // withholds the reason (it would be a cross-origin oracle), so the
        // sentence here is the honest one rather than an invented cause.
        //
        // DEEPGRAM DID SAY WHY, AND THIS TAB WILL NEVER SEE IT (#707). A
        // refused upgrade is an ordinary HTTP response — `400 Bad Request —
        // Keyterm limit exceeded` was this bug, and it took a raw TLS
        // handshake outside the browser to read it (`scripts/probe-deepgram-
        // listen.ts`).
        //
        // SO THE ENGINE IS ASKED, AND ITS ANSWER REPLACES THIS (#711). It
        // holds the key and can read that body; this sentence is what stands
        // until it answers, and what stands for good if it cannot.
        //
        // WHAT IS ADDED IS AN INSTRUCTION, NOT A CAUSE: pressing again is the
        // one move there is, and the notice that draws this goes away by
        // itself, so the sentence has to say what to do while it is up.
        refuse("The connection to the transcription service failed. Press the button to try again.");
        void diagnose(refusals.current);
        teardown();
      };

      // A CLOSE IS NOT AN ERROR BY ITSELF — the teardown above closes it on
      // purpose, and by then `socket.current` is no longer this socket. Only a
      // close nobody asked for gets a sentence.
      live.onclose = () => {
        if (socket.current !== live) return;
        refuse("The transcription service closed the connection. Press the button to try again.");
        // A CLOSE NOBODY ASKED FOR IS THE SAME KIND OF UNEXPLAINED FAILURE as
        // the error above, and Deepgram will say the same kind of thing about
        // it — a refused upgrade can surface either way depending on the
        // browser.
        void diagnose(refusals.current);
        teardown();
      };
    } catch (cause) {
      // A FAILURE NOBODY IS WAITING FOR IS NOT WORTH A SENTENCE: the person
      // pressed stop, and a toast about the start they cancelled would be the
      // app arguing with them.
      if (abandoned()) return;
      // WHOSE PROBLEM IT IS, SAID DIFFERENTLY — and said in ONE place (#643).
      // This used to tell a refused permission from everything else and pass
      // the rest of them through as `cause.message`, which meant "no
      // microphone connected" and "another app has it open" both arrived as
      // whatever the browser happened to call them. `microphoneRefusal` is the
      // whole table now, shared with the settings pane's own microphone test so
      // the two surfaces cannot drift: see `refusal.ts`.
      //
      // THROUGH `refuse` LIKE EVERY OTHER PATH (#707): the sentence is that
      // table's, and the only thing added here is which refusal it is.
      refuse(microphoneRefusal(cause));
      teardown();
    }
  }, [teardown, refuse, diagnose]);

  const toggle = useCallback(() => {
    // STOPPING IS SYNCHRONOUS AND STARTING IS NOT, so a second press during
    // `starting` still stops: it tears down whatever has been built so far and
    // the in-flight `start` finds its socket already disowned.
    if (phase === "idle") void start();
    else teardown();
  }, [phase, start, teardown]);

  return {
    phase,
    ...(error === undefined ? {} : { error }),
    toggle,
    supported,
    ...(caret === undefined ? {} : { caret }),
  };
}
