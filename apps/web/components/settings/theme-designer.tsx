"use client";

/**
 * THE DESIGNER — describe a look, wear it.
 *
 * One field and one button over the same round trip session titles use:
 * /api/textgen/complete hands a strict JSON schema to whichever harness the
 * Text generation setting names, and the answer is a whole theme — both
 * halves, a backdrop, an accent. lib/theme-designer.ts owns the schema, the
 * brief, and the validation; this file owns the waiting and the writing.
 *
 * IT REALLY TAKES UP TO A MINUTE. The engine spawns a CLI harness one-shot per
 * call, so a cold start plus a sixteen-token palette is 5-60 seconds — which
 * is why the button says "Designing…" rather than spinning silently, and why
 * BOTH controls disable: a second submission would spawn a second harness and
 * race the first into the library.
 *
 * APPLYING IS THREE STORES, in the order the reader perceives them: the theme
 * (saved and worn), the backdrop (only when the model drew one), the accent
 * (only when it named one of ours). None is conditional on the others — a
 * model that declines a backdrop still gets its theme worn.
 */

import { useState } from "react";
import { SparklesIcon } from "lucide-react";
import { applyDesign, buildDesignPrompt, DESIGN_SCHEMA } from "@/lib/theme-designer";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { composeGradient } from "@/lib/backdrop-presets";
import { useBackdrop } from "@/lib/backdrop";
import { useAppearance } from "@/lib/appearance";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

const PLACEHOLDER = "Describe a look — “warm autumn library”, “neon over deep navy”…";

const HINT = "The engine's model drafts both halves, and a matching backdrop and accent when they suit. This takes up to a minute.";

/**
 * The MESSAGE, not a flag — the three ways this fails are three different
 * things to do about it: fix the Text generation setting, start the engine, or
 * simply try describing the look again.
 */
function failureMessage(cause: unknown): string {
  if (cause instanceof EngineApiError) {
    if (cause.code === "textgen_failed") return "The engine's model didn't answer — check the Text generation setting.";
    if (cause.code === "engine_unavailable") return "The cockpit cannot reach its engine right now.";
    return cause.message;
  }
  return "That design could not be made.";
}

export function ThemeDesigner() {
  const { saveCustom, setActive } = useThemeLibrary();
  const { setBackdrop } = useBackdrop();
  const { setAppearance } = useAppearance();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const design = async () => {
    const brief = description.trim();
    if (brief.length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { result } = await api.complete({ prompt: buildDesignPrompt(brief), schema: DESIGN_SCHEMA });
      const outcome = applyDesign(result);
      if (outcome.error !== undefined) {
        setError(outcome.error);
        return;
      }
      const id = `custom-${Date.now().toString(36)}`;
      saveCustom({ id, ...outcome.definition });
      setActive(id);
      if (outcome.backdropSpec) {
        const light = composeGradient(outcome.backdropSpec.light);
        const dark = composeGradient(outcome.backdropSpec.dark);
        // The resolved layers ride along: gradient choices are stored WITH
        // their CSS so the pre-paint script never needs a compiler.
        setBackdrop({ kind: "custom-gradient", light, dark }, { light, dark });
      }
      if (outcome.accent) setAppearance({ accent: outcome.accent });
    } catch (cause: unknown) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Designer" description="A theme from a description — saved to the library and worn immediately.">
      <Row
        label="Design a theme"
        hint={error ?? HINT}
        control={
          <Button size="sm" variant="outline" disabled={busy || description.trim().length === 0} onClick={() => void design()}>
            <SparklesIcon /> {busy ? "Designing…" : "Design"}
          </Button>
        }
      >
        <Input
          className="mt-2 max-w-96"
          value={description}
          placeholder={PLACEHOLDER}
          aria-label="Describe a look"
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void design();
          }}
        />
      </Row>
    </SettingsGroup>
  );
}
