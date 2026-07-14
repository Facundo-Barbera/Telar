"use client";

// Agent defaults — the INITIAL permission mode + model for a BRAND-NEW session in
// a project that has no remembered composer config. Per-project memory
// (telar:composer:<project>) and per-session choices always win over these; the
// composer reads them only as the seed for a never-configured project (see
// composer-settings.tsx). These are the same knobs the composer exposes.
//
// Loom Doctrine: a UI preference, never an engine flag. Nothing here writes
// telar.yaml / .telar or any engine env — it only changes what a new composer
// starts on. import type keeps models/permission-modes client-safe (data only).

import type { ReactNode } from "react";
import { BotIcon, CheckIcon, ShieldCheckIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { useUiPrefs, setUiPrefs } from "@/lib/ui-prefs";
import { modelsForProvider } from "@/lib/models";
import { type ClientPermissionMode } from "@/lib/permission-modes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup, Row, Segmented } from "./settings-shell";

// Claude-only: the composer's default seed is a Claude session; Codex sessions
// pick their own model + approval preset and ignore these.
const MODEL_OPTIONS = modelsForProvider("claude");

const PERM_LABEL: Record<ClientPermissionMode, ReactNode> = {
  auto: <><ZapIcon className="size-3.5" />Auto</>,
  acceptEdits: <><CheckIcon className="size-3.5" />Accept edits</>,
  default: <><BotIcon className="size-3.5" />Ask me</>,
};

const PERM_HINT: Record<ClientPermissionMode, string> = {
  auto: "A classifier approves routine tool calls automatically — the loom happy path.",
  acceptEdits: "File edits apply without asking; other actions still prompt.",
  default: "Every tool call asks first.",
};

export function AgentDefaultsSettings() {
  const { defaultModel, defaultPermissionMode } = useUiPrefs();
  const model = MODEL_OPTIONS.find((m) => m.id === defaultModel);

  return (
    <SettingsGroup
      title="New-session defaults"
      description="The starting point for a new session in a project you haven't configured yet. A project's remembered config and any per-session change always win."
    >
      <Row
        label="Default permission mode"
        hint={PERM_HINT[defaultPermissionMode]}
        icon={ShieldCheckIcon}
        control={
          <Segmented<ClientPermissionMode>
            value={defaultPermissionMode}
            onChange={(v) => setUiPrefs({ defaultPermissionMode: v })}
            options={[
              { value: "auto", label: PERM_LABEL.auto },
              { value: "acceptEdits", label: PERM_LABEL.acceptEdits },
              { value: "default", label: PERM_LABEL.default },
            ]}
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
