"use client";

/**
 * The microphone settings section: `useAudioInputs` is the picker, `useMicrophoneTest` the
 * diagnostic. The meter taps the demo's stream when one is live, so only one mic is ever open.
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
} from "../devices";
import { hostVisible, subscribeHostVisibility } from "@/lib/host-visibility";
import type { DictationBox } from "../interim";
import { createLevelMeter, type LevelMeter } from "../level";
import { microphoneRefusal } from "../refusal";
import { useDictation, type DictationState } from "./use-dictation";

export { useMicrophoneUnavailable } from "./use-dictation";

export type AudioInputsHandle = {
  /** Empty before the first grant. */
  inputs: AudioInput[];
  choice: MicrophoneChoice | undefined;
  /** `undefined` for the system default. Stored in this browser only. */
  choose: (choice: MicrophoneChoice | undefined) => void;
  /** Inputs exist but their names are withheld (the pre-grant state). */
  withheld: boolean;
};

/**
 * The choice is read synchronously via `useSyncExternalStore`, so it never flashes the default.
 * The list is re-enumerated on `devicechange`; enumerating raises no permission prompt.
 */
export function useAudioInputs(): AudioInputsHandle {
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [withheld, setWithheld] = useState(false);
  /** `undefined` on the server matches "nobody has chosen", so hydration agrees. */
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

  const choose = useCallback((next: MicrophoneChoice | undefined) => writeMicrophone(next), []);

  return { inputs, choice, choose, withheld };
}

export type MicrophoneTest = {
  /** 0..1 on the dB scale; see `level.ts`. */
  level: number;
  /** A mic opened for the meter alone is live; false while the demo holds the stream. */
  metering: boolean;
  /** No token, no socket, no spend. */
  startMeter: () => void;
  stopMeter: () => void;
  meterError?: string;
  /** `use-dictation.ts` driving a scratch box. */
  demo: DictationState;
  /** Discarded: nothing is sent or stored. */
  transcript: string;
  /** Closes the meter's own stream first, so only one mic is open. */
  toggleDemo: () => void;
};

export function useMicrophoneTest(): MicrophoneTest {
  const [level, setLevel] = useState(0);
  const [metering, setMetering] = useState(false);
  const [meterError, setMeterError] = useState<string>();
  const [transcript, setTranscript] = useState("");

  /** `undefined` while the meter reads the demo's stream. */
  const meter = useRef<LevelMeter>(null);
  const own = useRef<MediaStream>(null);
  /** Fences a permission grant that arrives after a stop. */
  const generation = useRef(0);
  /** A ref because the writer reads it back synchronously after every write. */
  const draft = useRef("");

  /** The one place a meter is built or released. */
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
    // A missing `mediaDevices` throws synchronously, so the whole call sits inside `try`.
    void (async () => {
      try {
        // Read the stored choice now so the meter tests the input the next press will use.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(readMicrophone()) });
        if (generation.current !== mine) {
          // Granted after a stop: release it here.
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
   * A `DictationBox` over a string. `insert` adds a space like a composer does, so `insertedSpan`
   * (see `interim.ts`) is exercised for real.
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
  /** Destructured so effect deps don't change with the fresh `demo` object every render. */
  const { phase: demoPhase, toggle: toggleDictation } = demo;

  const toggleDemo = useCallback(() => {
    if (demoPhase === "idle") {
      stopMeter();
      // A fresh paragraph per press; old span offsets would point into a discarded draft.
      draft.current = "";
      setTranscript("");
    }
    toggleDictation();
  }, [demoPhase, toggleDictation, stopMeter]);

  /** Unmount (also the pane closing) releases the meter's own mic. */
  useEffect(() => stopMeter, [stopMeter]);

  /** Stop, not pause, when the tab goes to the background. */
  useEffect(
    () =>
      subscribeHostVisibility(() => {
        if (hostVisible()) return;
        stopMeter();
        if (demoPhase !== "idle") toggleDictation();
      }),
    [demoPhase, toggleDictation, stopMeter],
  );

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
