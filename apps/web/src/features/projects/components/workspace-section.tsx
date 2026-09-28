"use client";

import { FolderGitIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { DEFAULT_DETACHED_RUNTIME_MODE, DEFAULT_SESSION_DEFAULTS, type EnvMode, type RuntimeMode } from "@telar/engine-client";
import { useSessionDefaults } from "@/features/sessions";
import { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS, RUNTIME_MODES } from "@/lib/runtime-modes";
import { Dropdown, Row, SettingsGroup, ToggleRow, useRestoreDefaults } from "@/components/settings/settings-shell";

export function WorkspaceSection() {
  const { defaults, loading, save, error } = useSessionDefaults();
  useRestoreDefaults(() => save({ envMode: DEFAULT_SESSION_DEFAULTS.envMode, runtimeMode: null, resumeAfterRateLimit: true }));
  const access = defaults.runtimeMode ?? DEFAULT_DETACHED_RUNTIME_MODE;
  const resumes = defaults.resumeAfterRateLimit !== false;

  return (
    <SettingsGroup title="New sessions" scope="mac">
      <Row
        label="Workspace"
        icon={FolderGitIcon}
        hint={
          defaults.envMode === "worktree"
            ? "Each session gets its own checkout and branch, so two can edit the repo at once. A project without git falls back to the project checkout."
            : "Sessions share the project's checkout. Two at once will collide."
        }
        {...(error ? { error } : {})}
        {...(defaults.envMode === DEFAULT_SESSION_DEFAULTS.envMode
          ? {}
          : { onRevert: () => void save({ envMode: DEFAULT_SESSION_DEFAULTS.envMode }) })}
        control={
          loading ? null : (
            <Dropdown<EnvMode>
              value={defaults.envMode}
              label="Workspace"
              onChange={(next) => void save({ envMode: next })}
              options={[
                { value: "local", label: "Project checkout" },
                { value: "worktree", label: "Own worktree" },
              ]}
            />
          )
        }
      />
      <Row
        label="Access"
        icon={ShieldCheckIcon}
        hint={`${RUNTIME_MODE_HELP[access]}. A conversation can still change its own.`}
        {...(defaults.runtimeMode === undefined ? {} : { onRevert: () => void save({ runtimeMode: null }) })}
        control={
          loading ? null : (
            <Dropdown<RuntimeMode>
              value={access}
              label="Default access"
              onChange={(next) => void save({ runtimeMode: next })}
              options={RUNTIME_MODES.map((mode) => ({ value: mode, label: RUNTIME_MODE_LABELS[mode] }))}
            />
          )
        }
      />
      <ToggleRow
        label="Continue after a reset"
        icon={RefreshCwIcon}
        hint="A Claude turn stopped by a usage limit runs again once the limit lifts. A conversation can still change its own."
        checked={resumes}
        onCheckedChange={(next) => void save({ resumeAfterRateLimit: next })}
        {...(resumes ? {} : { onRevert: () => void save({ resumeAfterRateLimit: true }) })}
      />
    </SettingsGroup>
  );
}
