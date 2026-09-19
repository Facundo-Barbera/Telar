"use client";

/**
 * THE MICROPHONE SECTION'S MACHINERY — PICK, TEST, WATCH (#643).
 *
 * Two hooks, because they are two independent questions and the pane asks both:
 * `useAudioInputs` is the picker, `useMicrophoneTest` is the diagnostic.
 *
 * ── THE TWO HALVES OF "DICTATION DOES NOT WORK" ─────────────────────────────
 * The microphone is dead, or the transcription is. The meter answers the first
 * with no token, no socket and no spend — so a muted input reads as dead on a Mac
 * with no key pasted and no network. The live transcript answers the second, and
 * costs a real provider request. Keeping them on separate presses is the whole
 * diagnostic value: one combined indicator cannot say which half is broken, and
 * which half is broken is why somebody opened this pane.
 *
 * ── ONE STREAM AT A TIME, ALWAYS ────────────────────────────────────────────
 * The meter never opens a microphone while the demo has one: it taps the demo's
 * stream through `useDictation`'s `onStream`, so the bar and the words are two
 * readings of the same audio. And starting the demo closes the meter's own stream
 * first. Two live tracks would be two recording lights for one press.
 *
 * ── THE DEMO DOES NOT FORK `use-dictation.ts` ───────────────────────────────
 * It is the same hook the composer's mic button drives, handed a SCRATCH box
 * instead of a composer. That box is a string in a ref: the interim rewriting,
 * the span arithmetic, the "somebody else typed" guard and the failure sentences
 * are all the one implementation, which is the point — two copies of
 * interim-rewriting would drift, and the composer's is the one that matters.
 *
 * ── AND IT STOPS ON ITS OWN, THREE WAYS ─────────────────────────────────────
 * Unmount (which is also the pane closing — settings panes render conditionally,
 * so switching away unmounts this), the tab going to the background, and the
 * explicit stop. A settings tab left open in another window holding a recording
 * light and a provider socket is the failure this section most has to not be.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  audioConstraints,
  audioInputs,
  labelsWithheld,
  microphoneSnapshot,
  readMicrophone,
  subscribeMicrophone,
  writeMicrophone,
  type AudioInput,
  type MicrophoneChoice,
} from "./devices";
import type { DictationBox } from "./interim";
import { createLevelMeter, type LevelMeter } from "./level";
import { microphoneRefusal, microphoneUnavailable } from "./refusal";
import { canRecord, useDictation, type DictationState } from "./use-dictation";

/** Module-level so `useSyncExternalStore` does not resubscribe every render —
 *  the same reason `use-dictation.ts` keeps one. */
const neverChanges = () => () => {};

/**
 * WHY THIS PAGE CANNOT RECORD AT ALL, as a sentence, or nothing.
 *
 * `useSyncExternalStore` RATHER THAN A READ DURING RENDER: this is a question
 * about `window`, and settings is server-rendered first. Reading it inline would
 * answer one thing on the server and another in the browser — a hydration
 * mismatch on a pane that is otherwise entirely static. `undefined` is the server
 * answer, which is also the optimistic one: the pane draws its controls and then
 * replaces them with the reason on the first client render, rather than flashing
 * a refusal at somebody whose browser is fine.
 */
export function useMicrophoneUnavailable(): string | undefined {
  return useSyncExternalStore(
    neverChanges,
    () => microphoneUnavailable({ secure: window.isSecureContext, canRecord: canRecord() }),
    () => undefined,
  );
}

export type AudioInputsHandle = {
  /** The inputs the browser is willing to name. Empty before the first grant. */
  inputs: AudioInput[];
  /** What is stored for this browser, or nothing for the system default. */
  choice: MicrophoneChoice | undefined;
  /** Choose one, or `undefined` for the system default. Written to this
   *  browser's storage; nothing is sent to the engine. */
  choose: (choice: MicrophoneChoice | undefined) => void;
  /** There are inputs and the browser is withholding their names — the pre-grant
   *  state, which the pane says in words rather than rendering as blanks. */
  withheld: boolean;
};

/**
 * The picker's list and the stored choice.
 *
 * THE CHOICE IS READ SYNCHRONOUSLY, ON THE FIRST RENDER — `useSyncExternalStore`
 * over this browser's own storage, not an effect that loads it a tick later. The
 * tick was a bug rather than a slower path: this section mounts only once the
 * engine has answered with a provider, so a deferred read lands two renders after
 * the pane's, and until it does the row says "System default" over a choice
 * somebody made. See `microphoneSnapshot` in `devices.ts`, which is where the
 * cache that makes this safe lives.
 *
 * THE LIST CANNOT BE — `enumerateDevices` is a promise — so it is an effect, and
 * RE-ENUMERATED ON `devicechange`, which is the event a headset being plugged in
 * fires. Without that the list is whatever was true when the pane opened, and the
 * commonest moment to open this pane is right after plugging something in.
 *
 * THE LIST IS NOT A PERMISSION PROMPT. `enumerateDevices` does not ask for
 * anything — it answers with empty labels until a grant exists — so building it
 * on mount raises no dialog on a pane somebody is only reading.
 */
export function useAudioInputs(): AudioInputsHandle {
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [withheld, setWithheld] = useState(false);
  /** `undefined` on the server, which is also what "nobody has chosen" is — so
   *  the first paint is the system default either way and hydration matches. */
  const choice = useSyncExternalStore(subscribeMicrophone, microphoneSnapshot, () => undefined);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;

    let live = true;
    const look = (): void => {
      void media
        .enumerateDevices()
        .then((devices) => {
          if (!live) return;
          setInputs(audioInputs(devices));
          setWithheld(labelsWithheld(devices));
        })
        .catch(() => undefined);
    };
    look();
    media.addEventListener?.("devicechange", look);
    return () => {
      live = false;
      media.removeEventListener?.("devicechange", look);
    };
  }, []);

  // THE STORE IS THE TRUTH AND THE ROW IS ITS READER: the write notifies, the
  // snapshot re-reads, and a write that did not land (a full or blocked store)
  // leaves the control showing what is actually stored. No mirrored copy to keep
  // in step — the same rule every row on this pane follows with the engine.
  const choose = useCallback((next: MicrophoneChoice | undefined) => writeMicrophone(next), []);

  return { inputs, choice, choose, withheld };
}

export type MicrophoneTest = {
  /** 0..1, on the dB scale a bar is drawn from — see `level.ts`. */
  level: number;
  /** A microphone this hook opened for the meter alone is live. False while the
   *  demo is the one holding the stream, which the demo's own phase says. */
  metering: boolean;
  /** Open a microphone and read its level. No token, no socket, no spend. */
  startMeter: () => void;
  stopMeter: () => void;
  /** Why the meter could not open one — one sentence per path, from
   *  `refusal.ts`. */
  meterError?: string;
  /** The live demo, which is `use-dictation.ts` driving a scratch box. Its
   *  `error` is the provider's and the engine's own sentences. */
  demo: DictationState;
  /** What the demo has heard so far, rewritten in place exactly as it would be
   *  in a composer. Discarded — nothing is sent, nothing is stored, no composer
   *  is touched. */
  transcript: string;
  /** Start the demo, or stop it. Closes the meter's own stream first, so there
   *  is never more than one microphone open. */
  toggleDemo: () => void;
};

export function useMicrophoneTest(): MicrophoneTest {
  const [level, setLevel] = useState(0);
  const [metering, setMetering] = useState(false);
  const [meterError, setMeterError] = useState<string>();
  const [transcript, setTranscript] = useState("");

  /** The analyser, and the microphone this hook opened for it — `undefined` when
   *  the meter is reading the demo's stream instead. */
  const meter = useRef<LevelMeter>(null);
  const own = useRef<MediaStream>(null);
  /** Which meter start this is. A permission prompt can outlast the press, the
   *  same fence `use-dictation.ts` keeps and for the same reason: a grant that
   *  arrives after a stop must not install a live track into a hook that has
   *  already let go. */
  const generation = useRef(0);
  /** The scratch draft. A ref because the writer reads it back synchronously
   *  after every write — that read is the whole of its "did somebody else type?"
   *  guard — and state alone would hand it the previous render's string. */
  const draft = useRef("");

  /** Point the analyser at a stream, or at nothing. The one place a meter is
   *  built or released, so the two callers cannot leave one running. */
  const attach = useCallback((stream: MediaStream | undefined) => {
    meter.current?.stop();
    meter.current = null;
    if (stream) meter.current = createLevelMeter(stream, setLevel);
    else setLevel(0);
  }, []);

  const stopMeter = useCallback(() => {
    generation.current += 1;
    attach(undefined);
    for (const track of own.current?.getTracks() ?? []) track.stop();
    own.current = null;
    setMetering(false);
  }, [attach]);

  const startMeter = useCallback(() => {
    const mine = generation.current + 1;
    generation.current = mine;
    setMeterError(undefined);
    // `try` AROUND THE CALL ITSELF, not only around the await: `mediaDevices`
    // being absent THROWS rather than rejecting, and a synchronous throw would
    // walk straight past a `.catch` and out of an event handler — a Test button
    // that logs to the console and says nothing on the row.
    void (async () => {
      try {
        // THE CHOSEN DEVICE, READ HERE RATHER THAN HELD. `devices.ts`'s store is
        // the one answer — the picker writes it and the composer's dictation
        // reads it the same way — so the meter cannot be testing an input the
        // next press will not use.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(readMicrophone()) });
        if (generation.current !== mine) {
          // Granted after a stop: live, owned by nobody, and stopped here — the
          // one case `stopMeter` above cannot reach.
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        own.current = stream;
        attach(stream);
        setMetering(true);
      } catch (cause) {
        if (generation.current !== mine) return;
        setMeterError(microphoneRefusal(cause));
        setMetering(false);
      }
    })();
  }, [attach]);

  /**
   * THE SCRATCH TARGET — a `DictationBox` whose draft is a string.
   *
   * `insert` ADDS THE SPACE A COMPOSER WOULD, which is deliberate rather than
   * incidental: the composer's insertion is wider than the text handed over, and
   * `insertedSpan` exists to find the words inside it (see `interim.ts`). A fake
   * that spliced exactly would be a box that never exercises the arithmetic this
   * demo is meant to show working.
   *
   * NO `dictating` AND NO `caretRect`: both are optional, and there is no caret
   * pill to draw over a read-only paragraph in a settings pane.
   */
  const box = useCallback((): DictationBox => {
    const commit = (next: string) => {
      draft.current = next;
      setTranscript(next);
      return { ok: true as const, draft: next };
    };
    return {
      draft: () => draft.current,
      insert: (text) => commit(draft.current === "" ? text : `${draft.current} ${text}`),
      replace: (start, end, text) => commit(draft.current.slice(0, start) + text + draft.current.slice(end)),
    };
  }, []);

  const demo = useDictation({ box, onStream: attach });
  /** The two fields the callbacks below close over, pulled out so their
   *  dependency lists name the values rather than the object — `demo` is a fresh
   *  object every render, and depending on it would re-arm the visibility
   *  listener on every frame the transcript grows. */
  const { phase: demoPhase, toggle: toggleDictation } = demo;

  const toggleDemo = useCallback(() => {
    if (demoPhase === "idle") {
      // ONE STREAM. The demo is about to open its own, and the meter will tap
      // that one through `onStream`.
      stopMeter();
      // A FRESH PARAGRAPH PER PRESS. Keeping the last one would have the next
      // utterance append to words from a run somebody has stopped reading, and
      // the writer's span offsets are into a draft it no longer holds either.
      draft.current = "";
      setTranscript("");
    }
    toggleDictation();
  }, [demoPhase, toggleDictation, stopMeter]);

  /** UNMOUNT RELEASES THE METER'S OWN MICROPHONE — which is also the pane
   *  closing, since settings panes render conditionally. `useDictation` already
   *  does this for the demo's. */
  useEffect(() => stopMeter, [stopMeter]);

  /**
   * AND SO DOES THE TAB GOING TO THE BACKGROUND. A settings tab in another window
   * holding a live track and a provider socket is spend nobody authorised and a
   * recording light nobody asked for. Stopping rather than pausing, because a
   * dictation resumed from the middle of a sentence is words out of order.
   */
  useEffect(() => {
    const onHidden = (): void => {
      if (document.visibilityState !== "hidden") return;
      stopMeter();
      if (demoPhase !== "idle") toggleDictation();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [demoPhase, toggleDictation, stopMeter]);

  return {
    level,
    metering,
    startMeter,
    stopMeter,
    ...(meterError === undefined ? {} : { meterError }),
    demo,
    transcript,
    toggleDemo,
  };
}
