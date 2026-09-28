"use client";

import { useState } from "react";
import type { AutoCompact, ProviderInstance, ProviderInstanceEnvVar, ProviderProbe } from "@telar/engine-client";
import { cn } from "@/ui/utils";
import { Collapsible, CollapsibleContent } from "@/ui/collapsible";
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
  expanded,
  onExpandedChange,
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
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  onPatch: (patch: InstancePatch) => void;
  onUpdateCli?: () => void;
  updating?: boolean;
  onRemove?: () => void;
  error?: string | null;
  inheritance?: InheritanceNotice;
}) {
  const [tab, setTab] = useState<ProviderTab>("configuration");

  return (
    <div className={cn("rounded-xl transition-colors hover:bg-muted/20", !instance.enabled && "opacity-60")}>
      <ProviderInstanceHeader instance={instance} probe={probe} expanded={expanded} onExpandedChange={onExpandedChange} onPatch={onPatch} onRemove={onRemove} />

      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <CollapsibleContent>
          <div className="space-y-4 px-3 pb-4 pt-1 sm:px-4">
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
