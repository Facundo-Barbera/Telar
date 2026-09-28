"use client";

import { useState } from "react";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { announceProjectsChanged } from "../projects";
import { folderName, type Registered } from "../palette-model";

const api = createEngineApi();

export function useProjectAdding({
  onClose,
  onRegistered,
  setNotice,
}: {
  onClose: () => void;
  onRegistered: (registered: Registered) => void;
  setNotice: (notice: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);

  const settle = async (project: { id: string; name: string }) => {
    announceProjectsChanged();
    let ignored = true;
    try {
      await api.projectGitignore(project.id);
    } catch {
      ignored = false;
    }
    onClose();
    onRegistered({ projectId: project.id, name: project.name, ignored });
  };

  const register = async (send: () => Promise<{ project: { id: string; name: string } }>) => {
    setNotice(undefined);
    setBusy(true);
    try {
      await settle((await send()).project);
    } catch (cause) {
      setNotice(cause instanceof EngineApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const addLocalFolder = (root: string) => register(() => api.registerProject({ name: folderName(root), root }));
  const cloneInto = (url: string, parent: string) => register(() => api.cloneProject({ url, parent }));

  const pickWithSystem = (title: string, then: (path: string) => void) => {
    void chooseDirectory({ title }).then((chosen) => {
      if ("cancelled" in chosen) return;
      if ("unavailable" in chosen) {
        setNotice(chosen.unavailable);
        return;
      }
      then(chosen.path);
    });
  };

  return { busy, setBusy, addLocalFolder, cloneInto, pickWithSystem };
}
