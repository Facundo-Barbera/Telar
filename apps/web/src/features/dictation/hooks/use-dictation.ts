"use client";

/**
 * Toggle push-to-talk: mint a short-lived token, open the mic, stream 250 ms
 * chunks to Deepgram, and write words into the composer as they are heard
 * (`interim.ts` owns the span). Nothing is held between presses, and the mic is
 * released on every path out.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createEngineApi } from "@/lib/engine/client";
import { CHUNK_MS, listenProtocols, listenUrl, recordingType } from "../deepgram";
import { audioConstraints, readMicrophone } from "../devices";
import { createDictationWriter, type DictationBox } from "../interim";
import { microphoneRefusal, microphoneUnavailable } from "../refusal";
import { parseFrame, readFrame } from "../transcript";

export type DictationPhase =
  | "idle"
  | "starting"
  | "listening";

export type DictationState = {
  phase: DictationPhase;
  /** `seq` counts refusals, so the same sentence twice is two notices. */
  error?: { text: string; seq: number };
  /** Pressing while listening stops. */
  toggle: () => void;
  /** False without `MediaRecorder` or `getUserMedia` (e.g. an insecure origin). */
  supported: boolean;
  /**
   * Caret position in viewport coordinates while listening, else `undefined`.
   * Re-read after each frame that writes, since only those move the caret.
   */
  caret?: { rect: DOMRect; language: string };
};

/** Tells Deepgram to flush the tail of the utterance before the socket closes. */
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" });

/** Module-level so `useSyncExternalStore` doesn't resubscribe every render. */
const neverChanges = () => () => {};

const canRecord = (): boolean => typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

/**
 * Why this page can't record, or `undefined` (also the server answer, avoiding a
 * hydration mismatch). Dictation on localhost relies on W3C Secure Contexts
 * treating 127.0.0.0/8 and ::1 as trustworthy, a carve-out the spec marks at risk.
 */
export function useMicrophoneUnavailable(): string | undefined {
  return useSyncExternalStore(
    neverChanges,
    () => microphoneUnavailable({ secure: window.isSecureContext, canRecord: canRecord() }),
    () => undefined,
  );
}

export function useDictation(input: {
  /** The box to write into, resolved at the press; `undefined` is a refusal. */
  box?: () => DictationBox | undefined;
  /**
   * Called with the live stream when open and `undefined` on every path out, so
   * the settings meter reads the same audio. The callee must not stop the tracks.
   */
  onStream?: (stream: MediaStream | undefined) => void;
}): DictationState {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [error, setError] = useState<{ text: string; seq: number }>();
  const refusals = useRef(0);
  const refuse = useCallback((text: string) => {
    refusals.current += 1;
    setError({ text, seq: refusals.current });
  }, []);
  /**
   * A WebSocket error carries no reason, so ask the engine (which holds the key)
   * why Deepgram refused, and replace the sentence if no newer refusal happened
   * since `after`. Failures here are silent.
   */
  const diagnose = useCallback(
    async (after: number) => {
      try {
        const said = await createEngineApi().dictationDiagnosis();
        if (refusals.current !== after || !said.reason) return;
        refuse(said.reason);
      } catch {
        // Engine too old, Mac off, or fetch failed: the first sentence stays.
      }
    },
    [refuse],
  );
  const [caret, setCaret] = useState<{ rect: DOMRect; language: string }>();
  // `getServerSnapshot` avoids a hydration mismatch; a browser never grows a `MediaRecorder` mid-session.
  const supported = useSyncExternalStore(neverChanges, canRecord, () => false);

  const socket = useRef<WebSocket>(null);
  const recorder = useRef<MediaRecorder>(null);
  const stream = useRef<MediaStream>(null);
  /** A ref so `toggle` stays stable while the caller passes fresh closures. */
  const box = useRef(input.box);
  useEffect(() => {
    box.current = input.box;
  }, [input.box]);
  const onStream = useRef(input.onStream);
  useEffect(() => {
    onStream.current = input.onStream;
  }, [input.onStream]);
  /** Per dictation: a writer kept between presses would hold stale offsets into the draft. */
  const writer = useRef<ReturnType<typeof createDictationWriter>>(null);
  /** Fences an async `start` that returns after a teardown so it drops what it built. */
  const generation = useRef(0);

  /** Held so teardown can unmark the box even if another composer is now active. */
  const marked = useRef<DictationBox>(null);

  const teardown = useCallback(() => {
    generation.current += 1;
    // Marks come off on every path out.
    marked.current?.dictating?.({ listening: false });
    marked.current = null;
    setCaret(undefined);
    try {
      if (recorder.current?.state === "recording") recorder.current.stop();
    } catch {
      // A recorder that cannot stop is already stopped.
    }
    recorder.current = null;
    const open = socket.current;
    socket.current = null;
    if (open) {
      try {
        // Without CloseStream, Deepgram drops the last few words.
        if (open.readyState === WebSocket.OPEN) open.send(CLOSE_STREAM);
        open.close();
      } catch {
        // Already closing.
      }
    }
    // Release the tap before stopping the tracks, or the meter freezes on a dead track.
    if (stream.current) onStream.current?.(undefined);
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    // The words stay in the draft; only the span is forgotten.
    writer.current?.forget();
    writer.current = null;
    setPhase("idle");
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    const mine = generation.current;
    const abandoned = (): boolean => generation.current !== mine;
    setError(undefined);
    setPhase("starting");
    // Resolve the box once, before spending a token: words go to the composer on screen at the press.
    const speaking = box.current?.();
    if (!speaking) {
      refuse("No message box is on screen to dictate into.");
      setPhase("idle");
      return;
    }
    writer.current = createDictationWriter(speaking);
    try {
      // Token before mic, so a Mac that can't dictate never raises a permission prompt.
      const minted = await createEngineApi().dictationToken();
      if (abandoned()) return;
      // Everything below is Deepgram's shape; refuse other providers by name.
      if (minted.provider !== "deepgram") {
        throw new Error(`This browser does not know how to dictate with ${minted.provider}. Update Telar, or choose another provider in Settings → Dictation.`);
      }
      // A per-browser device choice (`devices.ts`); `ideal` so an unplugged headset falls back to the default.
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(readMicrophone()) });
      // Permission granted after a stop: the teardown can't reach this track.
      if (abandoned()) {
        for (const track of microphone.getTracks()) track.stop();
        return;
      }
      stream.current = microphone;
      // Before the socket opens, so the settings meter moves while the provider connects.
      onStream.current?.(microphone);

      // Deepgram refuses `?access_token=` here (close 1002) and reads the token from
      // the subprotocols; see `deepgram.ts`. Language and keyterms come on the token
      // answer; `?? []` for engines that predate keyterms.
      const live = new WebSocket(listenUrl(minted.language, minted.keyterms ?? []), listenProtocols(minted.token));
      socket.current = live;

      const redraw = (): void => {
        speaking.dictating?.({ listening: true, ...(writer.current?.span() ? { interim: writer.current.span() } : {}) });
        const rect = speaking.caretRect?.();
        setCaret(rect ? { rect, language: minted.language } : undefined);
      };

      live.onopen = () => {
        // Start recording only once open: the first chunk carries the container header.
        const type = recordingType();
        const tape = new MediaRecorder(microphone, type ? { mimeType: type } : {});
        recorder.current = tape;
        tape.ondataavailable = (event) => {
          if (event.data.size > 0 && live.readyState === WebSocket.OPEN) live.send(event.data);
        };
        tape.start(CHUNK_MS);
        setPhase("listening");
        // Mark the box only once the mic is actually open.
        marked.current = speaking;
        redraw();
      };

      live.onmessage = (event: MessageEvent) => {
        const frame = parseFrame(event.data);
        if (!frame) return;
        const words = readFrame(frame);
        if (!words) return;
        const refusal = writer.current?.write(words);
        // The composer refused the write (unmounted or not ready): end the dictation.
        if (refusal && !refusal.ok) {
          refuse(refusal.reason);
          teardown();
          return;
        }
        redraw();
      };

      live.onerror = () => {
        // Browsers withhold the reason for a WebSocket error; `diagnose` asks the engine.
        refuse("The connection to the transcription service failed. Press the button to try again.");
        void diagnose(refusals.current);
        teardown();
      };

      // Only a close nobody asked for is a failure; teardown closes on purpose.
      live.onclose = () => {
        if (socket.current !== live) return;
        refuse("The transcription service closed the connection. Press the button to try again.");
        void diagnose(refusals.current);
        teardown();
      };
    } catch (cause) {
      // The person already pressed stop.
      if (abandoned()) return;
      refuse(microphoneRefusal(cause));
      teardown();
    }
  }, [teardown, refuse, diagnose]);

  const toggle = useCallback(() => {
    // Stopping is synchronous, so a press during `starting` still stops.
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
