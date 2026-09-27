"use client";

/**
 * WORKSPACE — where a new session's work lands, before anyone chooses.
 *
 * The composer has always asked this per conversation, and the answer has
 * always been the same one: a person who runs two agents at once wants a
 * worktree every time, and re-picking it on every new session is a tax on the
 * habit rather than a decision. This is the standing answer; the composer's
 * picker still overrides it for the one session in front of you.
 *
 * IT IS A REAL DEFAULT, NOT A PRE-TICKED BOX. The engine reads the same
 * document on the create path (`createSession`), so an API or MCP caller that
 * omits `envMode` builds what this row says too.
 *
 * SAVE-PER-INTERACTION, and the ENGINE'S ANSWER IS THE STATE — the two rules
 * every settings pane here follows.
 */

import { FolderGitIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { DEFAULT_DETACHED_RUNTIME_MODE, DEFAULT_SESSION_DEFAULTS, type EnvMode, type RuntimeMode } from "@telar/engine-client";
import { useSessionDefaults } from "@/lib/session-defaults";
import { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS, RUNTIME_MODES } from "@/lib/runtime-modes";
import { Dropdown, Row, SettingsGroup, ToggleRow, useRestoreDefaults } from "./settings-shell";

export function WorkspaceSection() {
  const { defaults, loading, save, error } = useSessionDefaults();
  useRestoreDefaults(() => save({ envMode: DEFAULT_SESSION_DEFAULTS.envMode, runtimeMode: null, resumeAfterRateLimit: true }));
  // Absent means the engine's own default for a new session, and Claude resuming.
  const access = defaults.runtimeMode ?? DEFAULT_DETACHED_RUNTIME_MODE;
  const resumes = defaults.resumeAfterRateLimit !== false;

  return (
    // NO CAPTION, BECAUSE THE ROW KEEPS ITS SENTENCE (#357). A group gets one or
    // the other, and "Workspace" is the jargon here — the caption restated the
    // group title while the row is where the two modes are actually explained.
    <SettingsGroup title="New sessions" scope="mac">
      <Row
        label="Workspace"
        icon={FolderGitIcon}
        hint={
          defaults.envMode === "worktree"
            ? "Each session gets its own checkout and branch, so two can edit the repo at once. A project without git falls back to the project checkout."
            : "Sessions share the project's checkout. Two at once will collide."
        }
        // UNDER the hint, not instead of it: the control still shows what the
        // engine has, so the sentence explaining it is still the true one.
        {...(error ? { error } : {})}
        // Only when it is NOT the default — the revert costs nothing when there
        // is nothing to undo, and saves a reader from remembering what "was".
        // Compared against the shared constant rather than a literal, so the
        // arrow and `Restore defaults` cannot disagree about what default means.
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
      {/* DEFAULTS, NOT LOCKS. Each conversation's composer starts from these and
          can still change its own. */}
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
