"use client";

/**
 * PICK A MICROPHONE, TEST IT, WATCH THE WORDS ARRIVE (#643).
 *
 * ── THREE ROWS, AND THE MIDDLE ONE IS THE POINT ─────────────────────────────
 * "Dictation does not work" is two faults sharing a sentence: the microphone is
 * not being heard, or the transcription is not coming back. The LEVEL row answers
 * the first with no token, no socket and no spend — a muted input is visibly dead
 * on a Mac with no key pasted and no network. The LIVE TRANSCRIPT row answers the
 * second, and costs a real provider request. A single combined indicator could
 * not tell a person which half is broken, and that is the only question this
 * section exists to answer.
 *
 * ── AND IT IS WHAT PAID FOR DELETING "HOW IT WORKS" ─────────────────────────
 * The pane used to carry a ~300-character row explaining in prose that words
 * appear as they are heard and are rewritten in place until they settle. This
 * SHOWS that. The paragraph went with the same commit, which is the argument for
 * building the two together: the demo is what earns the deletion.
 *
 * ── NO CAPTION ON THE GROUP ─────────────────────────────────────────────────
 * Every row here carries a live sentence — which input is chosen and whether it
 * is connected, whether the meter is hearing anything, whether the demo is
 * running and spending — and a standing caption over three of those is the
 * doubling #357 is about. Same rule `updates-section.tsx` states.
 *
 * ── STARTING IS ALWAYS A PRESS ──────────────────────────────────────────────
 * Neither the meter nor the demo starts on open. The meter would raise a
 * permission prompt at somebody who came to read a setting; the demo would spend
 * provider credit and hold a microphone for as long as a tab stayed open. Both
 * stop on unmount, on the pane closing and on the tab going to the background —
 * see `use-microphone.ts`.
 */

import { AudioLinesIcon, MicIcon, TypeIcon } from "lucide-react";
import { microphoneOptions, microphoneStatus } from "@/lib/dictation/devices";
import { hearing } from "@/lib/dictation/level";
import { useAudioInputs, useMicrophoneTest, useMicrophoneUnavailable } from "@/lib/dictation/use-microphone";
import { Button } from "@/components/ui/button";
import { Dropdown, Row, SettingsGroup } from "./settings-shell";
import { cn } from "@/lib/utils";

export function DictationMicrophoneSection() {
  const unavailable = useMicrophoneUnavailable();
  const { inputs, choice, choose, withheld } = useAudioInputs();
  const { level, metering, startMeter, stopMeter, meterError, demo, transcript, toggleDemo } = useMicrophoneTest();

  /**
   * NO CONTROLS AT ALL WHERE THE BROWSER WILL NOT GRANT A MICROPHONE (#639).
   *
   * A picker over inputs that can never be opened, above a meter that can never
   * move, is a pane telling somebody their hardware is broken. The reason is one
   * sentence and it is the whole section — `microphoneUnavailable` says which of
   * the two cases it is and what the way out is.
   */
  if (unavailable) {
    return (
      <SettingsGroup title="Microphone">
        <Row icon={MicIcon} label="Not available here" hint={unavailable} />
      </SettingsGroup>
    );
  }

  const gone = microphoneStatus(choice, inputs);
  const listening = demo.phase !== "idle";
  /** The bar is live whenever something is feeding it — the meter's own stream,
   *  or the demo's, which it taps rather than duplicating.
   *
   *  `!== "idle"` AND NOT `=== "listening"`: the demo hands its stream over the
   *  moment the microphone opens, which is BEFORE the socket does, so the bar is
   *  already moving while the phase still says `starting`. Drawn grey through
   *  that window it would look broken in exactly the seconds somebody is watching
   *  it hardest. */
  const reading = metering || listening;

  return (
    <SettingsGroup title="Microphone">
      <Row
        label="Input"
        icon={MicIcon}
        {...(gone ? { status: <span className="text-2xs text-muted-foreground">Not connected</span> } : {})}
        {...(gone
          ? { hint: `${gone.label} is not connected; using the system default until it is.` }
          : withheld
            ? { hint: "Names appear once a microphone has been allowed." }
            : {})}
        // WHAT THE CONTROL CANNOT SAY: where the answer lives. Every other row
        // on this pane is a fact about the Mac, read by the phone as well;
        // this one is per browser.
        info="Kept in this browser only. A paired phone or another Mac keeps its own."
        control={
          <Dropdown<string>
            value={choice?.deviceId ?? ""}
            onChange={(deviceId) => {
              const picked = inputs.find((input) => input.deviceId === deviceId);
              // THE LABEL IS STORED WITH THE ID, which is what lets the row name
              // the device when it is gone rather than drawing a hash — see
              // `devices.ts`. Re-choosing an absent device keeps the label it
              // already had.
              choose(deviceId === "" ? undefined : { deviceId, label: picked?.label ?? choice?.label ?? "" });
            }}
            options={microphoneOptions(choice, inputs)}
            className="w-64"
            label="Dictation microphone"
          />
        }
      />
      <Row
        label="Level"
        icon={AudioLinesIcon}
        {...(reading && !hearing(level) ? { hint: "Hearing nothing. Pick another input." } : {})}
        info="Reads the input directly; nothing is sent anywhere."
        {...(meterError ? { error: meterError } : {})}
        control={
          <div className="flex items-center gap-3">
            <Meter level={level} live={reading} />
            {/* THE BUTTON IS ABSENT WHILE THE DEMO HOLDS THE STREAM: the bar is
                already live off the demo's own audio, and a "Test" beside a
                moving bar would be a control with nothing to do. */}
            {demo.phase === "idle" && (
              <Button size="sm" variant={metering ? "outline" : "default"} onClick={metering ? stopMeter : startMeter}>
                {metering ? "Stop" : "Test"}
              </Button>
            )}
          </div>
        }
      />
      {/* THE SENTENCE, NOT THE WHOLE REFUSAL (#707). `error` carries which
          refusal it is as well as what it says, because the composer's toolbar
          draws a caption that dismisses itself and has to tell two identical
          failures apart. This row is a settings pane: the refusal sits under
          the control until it is fixed, so it only wants the words. */}
      <Row
        label="Live transcript"
        icon={TypeIcon}
        {...(demo.error ? { error: demo.error.text } : {})}
        // Only what cannot be seen: the rewriting is on screen, the cost and
        // the discarding are not.
        info="A real, paid transcription. The words are discarded and touch no message box."
        control={
          <Button
            size="sm"
            variant={listening ? "destructive" : "default"}
            disabled={demo.phase === "starting" || !demo.supported}
            onClick={toggleDemo}
          >
            {demo.phase === "starting" ? "Starting…" : listening ? "Stop" : "Start"}
          </Button>
        }
      >
        {/* THE SCRATCH PARAGRAPH, and only once there is something to show or
            something is running — an empty box on an idle pane is furniture.
            NOT an `aria-live` region: interim results rewrite themselves several
            times a second, and a screen reader reading each revision aloud would
            be unusable. The words are here to be watched. */}
        {(listening || transcript) && (
          <p
            aria-label="Dictation demo transcript"
            className="mt-2 min-h-16 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm leading-snug text-foreground"
          >
            {transcript || <span className="text-muted-foreground">Say something…</span>}
          </p>
        )}
      </Row>
    </SettingsGroup>
  );
}

/**
 * THE BAR.
 *
 * `role="meter"` because that is what this is — a current value inside a known
 * range, not a task's progress. Screen readers announce it when it is reached
 * rather than on every change, which is the behaviour a 24-step bar needs.
 *
 * NO TRANSITION ON THE WIDTH. The level is already quantised and reported at
 * frame rate (`level.ts`); a CSS transition on top of that lags behind the voice
 * it is drawing, and a meter that trails what you hear reads as a broken one.
 */
function Meter({ level, live }: { level: number; live: boolean }) {
  return (
    <div
      role="meter"
      aria-label="Input level"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={level}
      className="h-2 w-32 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn("h-full rounded-full", live ? "bg-primary" : "bg-muted-foreground/30")}
        style={{ width: `${Math.round(level * 100)}%` }}
      />
    </div>
  );
}
