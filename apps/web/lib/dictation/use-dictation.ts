"use client";

/**
 * PUSH-TO-TALK, FROM THE BUTTON'S SIDE (#544).
 *
 * ── THE WHOLE SHAPE IN ONE PARAGRAPH ────────────────────────────────────────
 * Press the button: ask this Mac's engine for a token that dies in five
 * minutes, ask the browser for the microphone, open a socket straight to
 * Deepgram with that token, and push 250 ms chunks of audio up it. Final
 * phrases come back and go into the composer through `window.telar.dictate` —
 * the same door the Quest cockpit uses (#548), so there is one insertion path
 * on this app and not two. Press it again and everything unwinds.
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
 * ── REFS, NOT STATE, FOR THE MACHINERY ──────────────────────────────────────
 * The socket, the recorder and the tracks are not rendered and must not
 * re-render anything when they change; what state carries is the three things
 * the button DRAWS — the phase, the words being heard, and the last refusal.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createEngineApi } from "@/lib/engine/client";
import { CHUNK_MS, listenProtocols, listenUrl, recordingType } from "./deepgram";
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
  /** Deepgram's current guess at the words still being spoken. SHOWN, never
   *  inserted — see `transcript.ts` for why. */
  heard: string;
  /** Why it stopped, or would not start. A sentence: the button's only move is
   *  to show it to a person. */
  error?: string;
  /** Toggle. Starting while listening stops, which is what pressing the one
   *  button twice has to mean. */
  toggle: () => void;
  /** Whether this browser can dictate at all — no `MediaRecorder`, no
   *  `getUserMedia` (an insecure origin, or a locked-down embed), no button. */
  supported: boolean;
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
 *  advertisement for something the reader cannot have. */
const canRecord = (): boolean => typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

export function useDictation(input: {
  /** Where a finalised phrase goes. The composer's own insertion in practice —
   *  injected so a test can watch what would have been typed without mounting
   *  one. */
  insert?: (text: string) => void;
}): DictationState {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string>();
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
  /** The insertion, held in a ref so `toggle` is stable across renders — the
   *  composer passes a fresh closure every time it re-renders, and a `toggle`
   *  that changed identity with it would re-arm every effect that holds one. */
  const insert = useRef(input.insert);
  // IN AN EFFECT, NOT IN THE BODY. Writing a ref during render is what this
  // app's lint forbids, and the rule is right here: the composer re-renders on
  // every keystroke, so this runs constantly, and the value is only ever read
  // from a socket callback — which is after the commit either way.
  useEffect(() => {
    insert.current = input.insert;
  }, [input.insert]);
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
  const teardown = useCallback(() => {
    generation.current += 1;
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
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    setHeard("");
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
    try {
      // THE TOKEN FIRST, because it is the step that can fail for a reason the
      // person can fix — no key pasted, Deepgram refusing. Asking for the
      // microphone first would raise a permission prompt on a Mac that cannot
      // dictate at all, which is a prompt with nothing behind it.
      const minted = await createEngineApi().dictationToken();
      if (abandoned()) return;
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      // A PERMISSION PROMPT CAN OUTLAST THE PRESS. Granted after a stop, the
      // track is live and owned by nobody — so it is stopped here rather than
      // stored, which is the one case the teardown above cannot reach.
      if (abandoned()) {
        for (const track of microphone.getTracks()) track.stop();
        return;
      }
      stream.current = microphone;

      // THE TOKEN IS THE SECOND ARGUMENT, NOT A QUERY PARAMETER. Deepgram
      // refuses `?access_token=` on this endpoint (close 1002, "Expected 101
      // status code") and reads the credential out of the requested
      // subprotocols instead — see `listenProtocols` and the header of
      // `deepgram.ts`, where the three ways that were probed are written down.
      const live = new WebSocket(listenUrl(), listenProtocols(minted.token));
      socket.current = live;

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
      };

      live.onmessage = (event: MessageEvent) => {
        const frame = parseFrame(event.data);
        if (!frame) return;
        const { commit, interim } = readFrame(frame);
        setHeard(interim);
        // ONE INSERTION PER FINAL, and the reducer hands back only what THIS
        // frame finalised — inserting everything said so far each time is how
        // a dictation says everything twice.
        if (commit) insert.current?.(commit);
      };

      live.onerror = () => {
        // A WEBSOCKET ERROR EVENT CARRIES NOTHING. The browser deliberately
        // withholds the reason (it would be a cross-origin oracle), so the
        // sentence here is the honest one rather than an invented cause.
        setError("The connection to the transcription service failed.");
        teardown();
      };

      // A CLOSE IS NOT AN ERROR BY ITSELF — the teardown above closes it on
      // purpose, and by then `socket.current` is no longer this socket. Only a
      // close nobody asked for gets a sentence.
      live.onclose = () => {
        if (socket.current !== live) return;
        setError("The transcription service closed the connection.");
        teardown();
      };
    } catch (cause) {
      // A FAILURE NOBODY IS WAITING FOR IS NOT WORTH A SENTENCE: the person
      // pressed stop, and a toast about the start they cancelled would be the
      // app arguing with them.
      if (abandoned()) return;
      // WHOSE PROBLEM IT IS, SAID DIFFERENTLY. A refused microphone is the
      // person's own browser asking them something; anything else is the
      // engine's or Deepgram's sentence, which is already written for them.
      const denied = cause instanceof Error && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      setError(
        denied
          ? "This browser did not allow the microphone. Allow it for this site and press the button again."
          : cause instanceof Error
            ? cause.message
            : "Dictation could not start.",
      );
      teardown();
    }
  }, [teardown]);

  const toggle = useCallback(() => {
    // STOPPING IS SYNCHRONOUS AND STARTING IS NOT, so a second press during
    // `starting` still stops: it tears down whatever has been built so far and
    // the in-flight `start` finds its socket already disowned.
    if (phase === "idle") void start();
    else teardown();
  }, [phase, start, teardown]);

  return {
    phase,
    heard,
    ...(error === undefined ? {} : { error }),
    toggle,
    supported,
  };
}
