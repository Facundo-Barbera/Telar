"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { ProviderDriverKind, ProviderSkills, RuntimeMode } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { rankNotes, useProjectNotes } from "@/lib/project-notes";
import {
  availableCommands,
  buildPathIndex,
  ORCHESTRATE_SKILL,
  providerCommandCompletions,
  rankCommands,
  rankPaths,
  rankSkills,
  type Completion,
  type PathEntry,
} from "../completions";
import { detectComposerTrigger, type ComposerTrigger } from "../tokens";
import type { ComposerEditorHandle } from "../components/composer-editor";

const api = createEngineApi();

type CommandState = {
  busy: boolean;
  fresh: boolean;
  runtimeMode: RuntimeMode | undefined;
  envMode: "local" | "worktree" | undefined;
  compacting: boolean | undefined;
  canResume: boolean;
  choices: { models: { id: string; label: string }[]; efforts: string[] };
};

/** Read once on the first sigil, never on mount: listing is a git call, skills may spawn the harness. */
function useLazyRead<T>(wanted: boolean, checkout: string, read: (() => Promise<T>) | undefined, fallback: T) {
  // Keyed by checkout so one session's answer never serves another.
  const [cache, setCache] = useState<{ checkout: string; value: T }>();
  const [reading, setReading] = useState(false);
  const value = cache?.checkout === checkout ? cache.value : undefined;
  useEffect(() => {
    if (!wanted || value || reading || !read) return;
    const task = window.setTimeout(() => {
      setReading(true);
      void read()
        .then((answer) => setCache({ checkout, value: answer }))
        .catch(() => setCache({ checkout, value: fallback }))
        .finally(() => setReading(false));
    }, 0);
    return () => window.clearTimeout(task);
    // `read` and `fallback` are rebuilt every render; `checkout` names what they read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, value, reading, checkout]);
  return { value, reading };
}

/** `@` for notes and paths, `$` for skills, `/` for this box's commands then the provider's. */
export function useComposerCompletions({
  editor,
  sessionId,
  projectId,
  menuDriver,
  blocked,
  commands,
}: {
  editor: RefObject<ComposerEditorHandle | null>;
  sessionId: string | undefined;
  projectId: string | undefined;
  menuDriver: ProviderDriverKind | undefined;
  /** A question is open: the editor holds an answer, and `@` in it is punctuation. */
  blocked: boolean;
  commands: CommandState;
}) {
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [active, setActive] = useState(0);
  // Escape hides the list without clearing the trigger; the next edit re-arms it.
  const [dismissed, setDismissed] = useState(false);
  const checkout = sessionId ?? (projectId ? `project:${projectId}` : "none");
  const { notes } = useProjectNotes(projectId);

  const listPaths = sessionId || projectId
    ? async () => buildPathIndex((sessionId ? await api.sessionFiles(sessionId) : await api.projectFiles(projectId!)).listing.files)
    : async () => [] as PathEntry[];
  const paths = useLazyRead(trigger?.kind === "path", checkout, listPaths, [] as PathEntry[]);
  const listSkills = sessionId ? () => api.sessionSkills(sessionId) : projectId ? () => api.projectSkills(projectId, menuDriver) : undefined;
  const skills = useLazyRead<ProviderSkills>(trigger?.kind === "skill" || trigger?.kind === "command", checkout, listSkills, { skills: [], commands: [] });

  const { busy, fresh, runtimeMode, envMode, compacting, canResume, choices } = commands;
  const completions = useMemo<Completion[]>(() => {
    if (!trigger || dismissed) return [];
    if (trigger.kind === "skill") return rankSkills(skills.value?.skills ?? [], trigger.query);
    if (trigger.kind === "path") {
      // Notes take at most four rows so a short query cannot bury the checkout.
      const noteRows = rankNotes(notes, trigger.query);
      return [...noteRows, ...rankPaths(paths.value ?? [], trigger.query, Math.max(4, 12 - noteRows.length))];
    }
    // Two ranked lists, not one: a plugin command must not outscore `/stop`.
    const own = availableCommands({
      busy,
      fresh,
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(menuDriver ? { driver: menuDriver } : {}),
      ...(compacting ? { compacting } : {}),
      ...(envMode ? { envMode } : {}),
      models: choices.models,
      efforts: choices.efforts,
      canResume,
      orchestrate: Boolean(skills.value?.skills.some((skill) => skill.name === ORCHESTRATE_SKILL)),
    });
    return [...rankCommands(own, trigger.query), ...rankCommands(providerCommandCompletions(skills.value?.commands ?? []), trigger.query)];
  }, [trigger, dismissed, paths.value, notes, skills.value, busy, fresh, runtimeMode, menuDriver, compacting, envMode, choices, canResume]);

  // A list still fetching stays open and says so; `/` always has this box's own verbs to show.
  const loading = (trigger?.kind === "path" && paths.reading) || (trigger?.kind === "skill" && skills.reading);
  const open = !blocked && trigger !== null && !dismissed && (completions.length > 0 || loading);

  /** Recompute from the live caret after every edit and caret move; leaving a `@word` closes the list. */
  const retrigger = useCallback(
    (text: string) => setTrigger(detectComposerTrigger(text, editor.current?.caret() ?? text.length)),
    [editor],
  );

  const edited = (text: string) => {
    retrigger(text);
    setActive(0);
    setDismissed(false);
  };

  /** Takes the trigger out of the draft (or swaps in the inserted text) and returns the picked action. */
  const take = (completion: Completion): Completion["action"] | undefined => {
    // A disabled row is a label: the list stays open so its reason stays on screen.
    if (completion.disabled) return undefined;
    const range = trigger;
    setTrigger(null);
    setDismissed(false);
    setActive(0);
    const action = completion.action;
    if (range) editor.current?.replaceRange(range.rangeStart, range.rangeEnd, action.type === "insert" ? `${action.text} ` : "");
    return action;
  };

  const heading = () =>
    trigger?.kind === "skill" ? "Skills" : trigger?.kind === "command" ? "Commands" : notes.length > 0 ? "Notes, files and folders" : "Files and folders";

  return { trigger, completions, open, loading, active, setActive, setDismissed, retrigger, edited, take, heading };
}

export type ComposerCompletions = ReturnType<typeof useComposerCompletions>;
