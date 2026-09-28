"use client";

import { useState } from "react";
import type { AutoCompact, ProviderInstance, ProviderInstanceEnvVar, ProviderProbe } from "@telar/engine-client";
import { cn } from "@/ui/utils";
import { Tabs } from "@/features/settings";
import { ProviderModelsTab } from "./provider-models-tab";
import { ProviderConfigurationTab } from "./provider-configuration-tab";
import { ProviderInstanceHeader } from "./provider-instance-header";
import { InheritanceNotice } from "./inheritance-notice";

type ProviderTab = "configuration" | "models";

export type InstancePatch = {
  displayName?: string | null;
  accentColor?: string | null;
  contextNoticePercent?: number | null;
  autoCompact?: AutoCompact | null;
  configDir?: string | null;
  binaryPath?: string | null;
  enabled?: boolean;
  env?: ProviderInstanceEnvVar[];
};

export function ProviderInstanceCard({
  instance,
  probe,
  signInCommand,
  onPatch,
  onRemove,
  onUpdateCli,
  updating,
  error,
  inheritance,
}: {
  instance: ProviderInstance;
  probe?: ProviderProbe;
  signInCommand: string;
  onPatch: (patch: InstancePatch) => void;
  onUpdateCli?: () => void;
  updating?: boolean;
  onRemove?: () => void;
  error?: string | null;
  inheritance?: InheritanceNotice;
}) {
  const [tab, setTab] = useState<ProviderTab>("configuration");

  return (
    <div className={cn("rounded-xl border border-border bg-card shadow-1", !instance.enabled && "opacity-80")}>
      <ProviderInstanceHeader instance={instance} probe={probe} onRemove={onRemove} />
      <div className="space-y-4 border-t border-border/60 px-3 pb-4 pt-3 sm:px-4">
        {inheritance && <InheritanceNotice driver={instance.driver} {...inheritance} />}
        <Tabs<ProviderTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "configuration", label: "Configuration" },
            { value: "models", label: "Models" },
          ]}
        />
        {tab === "models" && <ProviderModelsTab instance={instance} />}
        {tab === "configuration" && (
          <ProviderConfigurationTab
            instance={instance}
            probe={probe}
            signInCommand={signInCommand}
            onPatch={onPatch}
            onUpdateCli={onUpdateCli}
            updating={updating}
            error={error}
          />
        )}
      </div>
    </div>
  );
}
