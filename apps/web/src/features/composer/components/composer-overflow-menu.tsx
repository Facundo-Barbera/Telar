"use client";

import type { ReactNode } from "react";
import { CheckIcon, MoreHorizontalIcon } from "lucide-react";
import type { ProviderDriverKind, RuntimeMode } from "@telar/engine-client";
import { type ModelChoice, useModelCatalogue, ProviderIcon, PROVIDER_LABEL, RUNTIME_MODE_LABELS, RUNTIME_MODES } from "@/features/providers";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { modelOptionSections, PROVIDERS } from "../model-options";

type MenuChoice = { key: string; label: string; icon?: ReactNode; hint?: string; selected: boolean; disabled?: boolean; onClick: () => void };

// Base UI's GroupLabel throws without a Group above it, so every label sits in one.
function MenuChoices({ title, choices, first }: { title: string; choices: MenuChoice[]; first?: boolean }) {
  return (
    <>
      {!first && <DropdownMenuSeparator />}
      <DropdownMenuGroup>
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {choices.map((choice) => (
          <DropdownMenuItem key={choice.key} disabled={choice.disabled === true} onClick={choice.onClick}>
            {choice.icon}
            <span className="flex-1">{choice.label}</span>
            {choice.hint && <span className="shrink-0 text-3xs text-muted-foreground">{choice.hint}</span>}
            {choice.selected && <CheckIcon className="size-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </>
  );
}

/** Every control the pills offer, for a composer too narrow to show them; it swaps with the pills on container width. */
export function ComposerOverflowMenu({
  driver,
  choice,
  runtimeMode,
  fresh,
  envMode,
  onChange,
  onRuntimeMode,
  onDriverChange,
  onEnvMode,
  onResumeAfterRateLimit,
  resumeAfterRateLimit,
  instanceId,
  ultrathink,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  ultrathink?: { active: boolean; toggle: () => void };
  instanceId?: string;
  /** Absent means the driver's default, which is on for Claude. */
  resumeAfterRateLimit?: boolean;
  onResumeAfterRateLimit?: (next: boolean) => void;
  runtimeMode?: RuntimeMode;
  /** Before a session exists the provider and the workspace are still choices. */
  fresh?: boolean;
  envMode?: "local" | "worktree";
  onChange?: (next: ModelChoice) => void;
  onRuntimeMode?: (mode: RuntimeMode) => void;
  onDriverChange?: (driver: ProviderDriverKind) => void;
  onEnvMode?: (mode: "local" | "worktree") => void;
}) {
  const catalogue = useModelCatalogue(driver, instanceId);
  const sections = modelOptionSections(driver, catalogue?.models ?? [], choice, ultrathink ? { ultrathink: { active: ultrathink.active } } : {});
  const groups: { title: string; choices: MenuChoice[] }[] = [];

  if (onChange) {
    for (const section of sections) {
      groups.push({
        title: section.title,
        choices: section.rows.map((option) => ({
          key: option.key,
          label: option.label,
          ...(option.isDefault ? { hint: "Default" } : {}),
          selected: option.selected,
          disabled: option.disabled === true,
          onClick: () => (option.ultrathink ? ultrathink?.toggle() : option.apply && onChange(option.apply(choice))),
        })),
      });
    }
  }
  if (onResumeAfterRateLimit && driver === "claude") {
    const resumes = resumeAfterRateLimit ?? true;
    groups.push({
      title: "Usage limits",
      choices: [
        { key: "on", label: "Continue after a reset", selected: resumes, onClick: () => onResumeAfterRateLimit(true) },
        { key: "off", label: "Stay stopped", selected: !resumes, onClick: () => onResumeAfterRateLimit(false) },
      ],
    });
  }
  if (runtimeMode && onRuntimeMode) {
    groups.push({
      title: "Access",
      choices: RUNTIME_MODES.map((option) => ({ key: option, label: RUNTIME_MODE_LABELS[option], selected: option === runtimeMode, onClick: () => onRuntimeMode(option) })),
    });
  }
  if (fresh && onDriverChange) {
    groups.push({
      title: "Provider",
      choices: PROVIDERS.map((option) => ({
        key: option,
        label: PROVIDER_LABEL[option],
        icon: <ProviderIcon provider={option} size={14} />,
        selected: option === driver,
        onClick: () => onDriverChange(option),
      })),
    });
  }
  if (fresh && onEnvMode) {
    groups.push({
      title: "Workspace",
      choices: (["local", "worktree"] as const).map((option) => ({
        key: option,
        label: option === "worktree" ? "Own worktree" : "Project checkout",
        selected: option === (envMode ?? "local"),
        onClick: () => onEnvMode(option),
      })),
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More composer settings"
            title="More settings"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-[min(30rem,70vh)] w-60 overflow-y-auto">
        {groups.map((group, index) => (
          <MenuChoices key={group.title} title={group.title} choices={group.choices} first={index === 0} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
