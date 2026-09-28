"use client";

import { AudioLinesIcon, MicIcon, TypeIcon } from "lucide-react";
import { hearing } from "../level";
import { microphoneOptions, microphoneStatus } from "../devices";
import { useAudioInputs, useMicrophoneTest, useMicrophoneUnavailable } from "../hooks/use-microphone";
import { Button } from "@/components/ui/button";
import { Dropdown, Row, SettingsGroup } from "@/components/settings/settings-shell";
import { cn } from "@/lib/utils";

export function DictationMicrophoneSection() {
  const unavailable = useMicrophoneUnavailable();
  const { inputs, choice, choose, withheld } = useAudioInputs();
  const { level, metering, startMeter, stopMeter, meterError, demo, transcript, toggleDemo } = useMicrophoneTest();

  if (unavailable) {
    return (
      <SettingsGroup title="Microphone" scope="browser">
        <Row icon={MicIcon} label="Not available here" hint={unavailable} />
      </SettingsGroup>
    );
  }

  const gone = microphoneStatus(choice, inputs);
  const listening = demo.phase !== "idle";
  const reading = metering || listening;

  return (
    <SettingsGroup title="Microphone" scope="browser">
      <Row
        label="Input"
        icon={MicIcon}
        {...(gone ? { status: <span className="text-2xs text-muted-foreground">Not connected</span> } : {})}
        {...(gone
          ? { hint: `${gone.label} is not connected; using the system default until it is.` }
          : withheld
            ? { hint: "Names appear once a microphone has been allowed." }
            : {})}
        info="Kept in this browser only. A paired phone or another Mac keeps its own."
        control={
          <Dropdown<string>
            value={choice?.deviceId ?? ""}
            onChange={(deviceId) => {
              const picked = inputs.find((input) => input.deviceId === deviceId);
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
            {demo.phase === "idle" && (
              <Button size="sm" variant={metering ? "outline" : "default"} onClick={metering ? stopMeter : startMeter}>
                {metering ? "Stop" : "Test"}
              </Button>
            )}
          </div>
        }
      />
      <Row
        label="Live transcript"
        icon={TypeIcon}
        {...(demo.error ? { error: demo.error.text } : {})}
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
