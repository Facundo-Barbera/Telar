"use client";

// Agent defaults — the INITIAL runtime mode + model for a BRAND-NEW session in
// a project that has no remembered composer config. Per-project memory
// (telar:composer:<project>) and per-session choices always win over these; the
// composer reads them only as the seed for a never-configured project (see
// composer-settings.tsx). These are the same knobs the composer exposes.
//
// Loom Doctrine: a UI preference, never an engine flag. Nothing here writes
// telar.yaml / .telar or any engine env — it only changes what a new composer
// starts on.
//
// ONE LIST OF WORDS, ONE MAP OF GLYPHS. This pane used to speak the old
// Claude-only vocabulary ("Ask me / Accept edits / Auto", most-permissive
// first) while the composer showed "Supervised / Auto-accept edits / Auto",
// least-permissive first, with different icons — two names and two pictures for
// the same three rungs of one preference. Both now render
// SELECTABLE_RUNTIME_MODE_OPTIONS through ACCESS_GLYPH, so they are
// structurally unable to disagree.

import { useUiPrefs, setUiPrefs } from "@/lib/ui-prefs";
import { ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { modelsForProvider } from "@/lib/models";
import { SELECTABLE_RUNTIME_MODE_OPTIONS, type RuntimeMode } from "@/lib/permission-modes";
import { ACCESS_GLYPH } from "@/components/session/composer-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup, Row } from "./settings-shell";

// The MODEL row is Claude-only — a Codex session picks from its own catalog and
// this seed never reaches it. The access row above it is NOT: one runtime mode
// means the same thing on both harnesses, and the composer seeds both from it.
const MODEL_OPTIONS = modelsForProvider("claude");

export function AgentDefaultsSettings() {
  const { defaultModel, defaultRuntimeMode } = useUiPrefs();
  const model = MODEL_OPTIONS.find((m) => m.id === defaultModel);
  const mode = SELECTABLE_RUNTIME_MODE_OPTIONS.find((o) => o.value === defaultRuntimeMode);

  return (
    <SettingsGroup
      title="New-session defaults"
      description="The starting point for a new session in a project you haven't configured yet. A project's remembered config and any per-session change always win."
    >
      {/* A Select, not the Segmented strip the old three-value control used:
          these labels are the composer's own, and "Auto-accept edits" does not
          survive a third of a settings row any better than it survived a third
          of the popover. */}
      <Row
        label="Default access"
        hint={mode?.description ?? "How much a new session's agent may do on its own."}
        icon={ShieldCheckIcon}
        control={
          <Select
            value={defaultRuntimeMode}
            onValueChange={(v) => v && setUiPrefs({ defaultRuntimeMode: v as RuntimeMode })}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECTABLE_RUNTIME_MODE_OPTIONS.map((o) => {
                const { Icon, tone } = ACCESS_GLYPH[o.value];
                return (
                  <SelectItem key={o.value} value={o.value}>
                    <span className="flex items-center gap-1.5">
                      <Icon className={`size-3.5 ${tone}`} />
                      {o.label}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        }
      />
      <Row
        label="Default model"
        hint={model?.blurb ?? "Applied to new Claude sessions until the project remembers a choice."}
        icon={SparklesIcon}
        control={
          <Select
            value={defaultModel}
            onValueChange={(v) => v && setUiPrefs({ defaultModel: String(v) })}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroup>
  );
}
