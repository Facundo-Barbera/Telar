import type { LoomGateResult } from "@telar/engine-client";
import { describeGate, gateTone, type GateTone } from "@/lib/loom-gate";

/**
 * THE ONLY PLACE A GATE BECOMES A COLOUR.
 *
 * One definition, imported by every surface, because "the gate renders the same
 * everywhere" is satisfied by there being ONE renderer and not by four surfaces
 * being careful. `components/loom/idiom.test.ts` fails if a second one appears.
 *
 * `unknown` IS NOT A SOFT PASS AND NOT A SOFT FAIL. It is `--color-warning` and
 * the words "could not verify", because exit 2 means the gate never ran — the
 * one case where a tick-or-cross UI silently invents an answer nothing gave it.
 * The colour and the words both differ from the other two states, so the
 * distinction survives colour-blindness and a greyscale screenshot.
 */
export function GateChip({ gate, className = "" }: { gate?: LoomGateResult | null; className?: string }) {
  const described = describeGate(gate);
  return (
    <span
      title={described.detail}
      data-gate={described.tone}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[11px] ${described.className} ${className}`}
    >
      {described.label}
    </span>
  );
}

/**
 * The same grammar with no result behind it — used by the Program tab's
 * exit-code table, where the tone names a MEANING rather than an outcome.
 */
export function GateToneChip({ tone, label }: { tone: GateTone; label?: string }) {
  const described = gateTone(tone);
  return (
    <span
      data-gate={tone}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-[11px] ${described.className}`}
    >
      {label ?? described.label}
    </span>
  );
}
