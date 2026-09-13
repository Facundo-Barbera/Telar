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

import { FolderGitIcon } from "lucide-react";
import { DEFAULT_SESSION_DEFAULTS, type EnvMode } from "@telar/engine-client";
import { useSessionDefaults } from "@/lib/session-defaults";
import { Row, Segmented, SettingsGroup, useRestoreDefaults } from "./settings-shell";

export function WorkspaceSection() {
  const { defaults, loading, save, error } = useSessionDefaults();
  useRestoreDefaults(() => save({ envMode: DEFAULT_SESSION_DEFAULTS.envMode }));

  return (
    <SettingsGroup title="New sessions" description="What a conversation is built with before you change it.">
      <Row
        label="Workspace"
        icon={FolderGitIcon}
        hint={
          error ??
          (defaults.envMode === "worktree"
            ? "Each session gets its own checkout and branch, so two can edit the repo at once. A project without git falls back to the project checkout."
            : "Sessions share the project's checkout. Two at once will collide.")
        }
        // Only when it is NOT the default — the revert costs nothing when there
        // is nothing to undo, and saves a reader from remembering what "was".
        // Compared against the shared constant rather than a literal, so the
        // arrow and `Restore defaults` cannot disagree about what default means.
        {...(defaults.envMode === DEFAULT_SESSION_DEFAULTS.envMode
          ? {}
          : { onRevert: () => void save({ envMode: DEFAULT_SESSION_DEFAULTS.envMode }) })}
        control={
          loading ? null : (
            <Segmented<EnvMode>
              value={defaults.envMode}
              onChange={(next) => void save({ envMode: next })}
              options={[
                { value: "local", label: "Project checkout" },
                { value: "worktree", label: "Own worktree" },
              ]}
            />
          )
        }
      />
    </SettingsGroup>
  );
}
