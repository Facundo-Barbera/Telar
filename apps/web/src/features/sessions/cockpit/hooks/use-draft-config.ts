"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ProviderDriverKind, RuntimeMode } from "@telar/engine-client";
import type { ModelChoice } from "@/features/providers";
import { useSessionDefaults } from "../../session-defaults";
import type { ProjectDefaults } from "./use-cockpit-project";
import type { DraftChoices } from "./use-session-browser";

type EnvMode = "local" | "worktree";
type Base = { baseRef?: string; branchName?: string };

/**
 * A fresh canvas's picks for the session it will create. Seeds (the Mac's defaults, the project's, `?base`)
 * are render-phase adjustments and never overwrite a pick: every human choice goes through a `choose*`.
 */
export function useDraftConfig({ projectId, fresh, projectDefaults }: {
  projectId: string | undefined;
  fresh: boolean;
  projectDefaults: ProjectDefaults | undefined;
}) {
  const [driver, setDriver] = useState<ProviderDriverKind>("claude");
  const [envMode, setEnvMode] = useState<EnvMode>("local");
  const [envModeTouched, setEnvModeTouched] = useState(false);
  const { defaults: sessionDefaults, loading: sessionDefaultsLoading } = useSessionDefaults();
  const [seededEnvMode, setSeededEnvMode] = useState<EnvMode>();
  const projectAnswered = projectId === undefined || projectDefaults?.projectId === projectId;
  const envModeSeed = (projectId !== undefined ? projectDefaults?.envMode : undefined) ?? sessionDefaults.envMode;
  if (!sessionDefaultsLoading && projectAnswered && !envModeTouched && seededEnvMode !== envModeSeed) {
    setSeededEnvMode(envModeSeed);
    setEnvMode(envModeSeed);
  }
  const chooseEnvMode = useCallback((next: EnvMode) => {
    setEnvModeTouched(true);
    setEnvMode(next);
  }, []);
  const [base, setBase] = useState<Base>({});
  const searchParams = useSearchParams();
  const requestedBase = fresh ? (searchParams.get("base") ?? undefined) : undefined;
  const [seededBase, setSeededBase] = useState<string>();
  if (requestedBase !== undefined && seededBase !== requestedBase) {
    setSeededBase(requestedBase);
    setBase({ baseRef: requestedBase });
    chooseEnvMode("worktree");
  }
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("auto");
  const [runtimeModeTouched, setRuntimeModeTouched] = useState(false);
  const runtimeModeSeed = sessionDefaults.runtimeMode ?? "auto";
  if (!sessionDefaultsLoading && !runtimeModeTouched && runtimeMode !== runtimeModeSeed) setRuntimeMode(runtimeModeSeed);
  const [model, setModel] = useState<ModelChoice>({});
  const [modelTouched, setModelTouched] = useState(false);
  const [seededModelFor, setSeededModelFor] = useState<string>();
  // Keyed by project, so a canvas that moves to another project starts from that project's default.
  if (fresh && !modelTouched && projectDefaults && projectDefaults.projectId === projectId && seededModelFor !== projectId) {
    setSeededModelFor(projectId);
    if (projectDefaults.model) {
      setDriver(projectDefaults.model.driver);
      setModel(projectDefaults.model.choice);
    }
  }
  // Each control sends the whole choice, so changing one knob keeps the rest of the project's default.
  const chooseModel = useCallback((next: ModelChoice) => {
    setModelTouched(true);
    setModel(next);
  }, []);
  const chooseDriver = useCallback((next: ProviderDriverKind) => {
    setModelTouched(true);
    setDriver(next);
    setModel({});
  }, []);
  // Picking a base is choosing a worktree: the shared checkout's branch is not ours to switch.
  const chooseBase = (next: Base) => {
    setBase(next);
    if (next.baseRef || next.branchName) chooseEnvMode("worktree");
  };
  const chooseRuntimeMode = (mode: RuntimeMode) => {
    setRuntimeModeTouched(true);
    setRuntimeMode(mode);
  };
  const choices: DraftChoices = { driver, envMode, base, pick: modelTouched ? model : {}, runtimeMode };
  return { ...choices, model, runtimeModeTouched, sessionDefaults, chooseEnvMode, chooseBase, chooseRuntimeMode, chooseModel, chooseDriver, choices };
}
