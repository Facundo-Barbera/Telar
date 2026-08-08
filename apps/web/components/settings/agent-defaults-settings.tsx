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

import type { ReactNode } from "react";
import type { RuntimeMode } from "@telar/core/runtime-mode";
import { BotIcon, CheckIcon, ShieldCheckIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { useUiPrefs, setUiPrefs } from "@/lib/ui-prefs";
import { modelsForProvider } from "@/lib/models";
import { RUNTIME_MODE_OPTIONS } from "@/lib/runtime-mode-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup, Row, Segmented } from "./settings-shell";

// The model seed stays Claude-only (Codex sessions pick their own model), but
// the MODE default is provider-neutral — the same runtime-mode vocabulary the
// composer itself speaks (issue #65 retired the old Claude-only one here).
const MODEL_OPTIONS = modelsForProvider("claude");

// The composer's own labels/descriptions, minus "full-access" — deliberately.
// A per-session escalation to full access is a choice made looking at that
// session; a standing default of it for EVERY new session is the one setting
// this page should not offer. The composer still offers it per session.
const MODE_OPTIONS = RUNTIME_MODE_OPTIONS.filter((o) => o.value !== "full-access");

const MODE_ICON: Partial<Record<RuntimeMode, ReactNode>> = {
  auto: <ZapIcon className="size-3.5" />,
  "auto-accept-edits": <CheckIcon className="size-3.5" />,
  "approval-required": <BotIcon className="size-3.5" />,
};

export function AgentDefaultsSettings() {
  const { defaultModel, defaultRuntimeMode } = useUiPrefs();
  const model = MODEL_OPTIONS.find((m) => m.id === defaultModel);
  const activeMode = MODE_OPTIONS.find((o) => o.value === defaultRuntimeMode);

  return (
    <SettingsGroup
      title="New-session defaults"
      description="The starting point for a new session in a project you haven't configured yet. A project's remembered config and any per-session change always win."
    >
      <Row
        label="Default runtime mode"
        hint={activeMode?.description ?? ""}
        icon={ShieldCheckIcon}
        control={
          <Segmented<RuntimeMode>
            value={defaultRuntimeMode}
            onChange={(v) => setUiPrefs({ defaultRuntimeMode: v })}
            options={MODE_OPTIONS.map((o) => ({
              value: o.value,
              label: (
                <>
                  {MODE_ICON[o.value]}
                  {o.label}
                </>
              ),
            }))}
          />
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
