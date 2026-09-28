"use client";

import { useEffect, useState } from "react";
import { createEngineApi } from "@/platform/engine";
import { rememberedProjectName, writeFrontDoorNote } from "@/features/composer";
import { projectDraftModel } from "@/features/providers";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { cockpitPlugins } from "../model";

/** A project's own answers for a new conversation, keyed by the project they came from. */
export type ProjectDefaults = { projectId: string; envMode?: "local" | "worktree"; model: ReturnType<typeof projectDraftModel> };

/** The project's name, enabled plugins and new-conversation defaults, read once the transcript has landed. */
export function useCockpitProject({ hostId, projectId, serverProjectName, transcriptLanded }: {
  hostId: string;
  projectId: string | undefined;
  serverProjectName: string | undefined;
  transcriptLanded: boolean;
}) {
  const [projectName, setProjectName] = useState<string | undefined>(serverProjectName);
  const [projectResolved, setProjectResolved] = useState(false);
  const nameKey = JSON.stringify([hostId, projectId]);
  const [nameSubject, setNameSubject] = useState(nameKey);
  if (nameSubject !== nameKey) {
    setNameSubject(nameKey);
    setProjectName(undefined);
    setProjectResolved(false);
  }
  const [defaults, setDefaults] = useState<ProjectDefaults>();
  const [enabledPlugins, setEnabledPlugins] = useState<readonly string[]>([]);

  // A failed read leaves the breadcrumb on the id, which is worse to read but never wrong.
  useEffect(() => {
    if (!transcriptLanded) return;
    let cancelled = false;
    const local = hostId === LOCAL_HOST_ID;
    let answered = false;
    const task = window.setTimeout(() => {
      if (cancelled || answered || !local) return;
      const remembered = projectId === undefined ? undefined : rememberedProjectName(projectId);
      if (remembered) setProjectName(remembered);
    }, 0);
    void createEngineApi(hostFetcher(hostId)).projects().then(
      (result) => {
        if (cancelled) return;
        answered = true;
        const found = result.projects.find((project) => project.id === projectId);
        setProjectName(found?.name);
        // Resolved even when absent: that is what tells "not arrived yet" from "not on this Mac".
        setProjectResolved(true);
        if (projectId !== undefined) {
          setDefaults({ projectId, model: projectDraftModel(found?.defaultModel), ...(found?.envMode ? { envMode: found.envMode } : {}) });
        }
        // Replaced only when the set changed, so everything keyed on it keeps its identity.
        const plugins = cockpitPlugins(found);
        setEnabledPlugins((current) => (current.join(",") === plugins.join(",") ? current : plugins));
        if (local) writeFrontDoorNote(result.projects, projectId);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [projectId, hostId, transcriptLanded]);

  return { projectName, projectResolved, defaults, enabledPlugins };
}
