"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProviderInstance, ProviderProbe, ProviderUpdateRun } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { displayNameOf, sortInstances } from "../provider-instances";
import { announceProviderInstancesChanged } from "../provider-instance-cache";
import type { InstancePatch } from "../components/provider-instance-card";

const api = createEngineApi();

export type UpdateReport = { label: string; run?: ProviderUpdateRun; error?: string };

export const binaryKey = (instance: ProviderInstance): string => `${instance.driver} ${instance.binaryPath ?? ""}`;

const messageOf = (cause: unknown, fallback: string) => (cause instanceof EngineApiError ? cause.message : fallback);

export function useProviderInstances() {
  const [instances, setInstances] = useState<ProviderInstance[]>();
  const [probes, setProbes] = useState<ProviderProbe[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [rechecking, setRechecking] = useState(false);
  const [inheritance, setInheritance] = useState<Record<string, string[] | undefined>>({});
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateReport, setUpdateReport] = useState<UpdateReport | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      const answer = await api.providerInstances(refresh ? { refresh: true } : {});
      setInstances(sortInstances(answer.providerInstances));
      setProbes(answer.probes);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const setError = (id: string, error: string | null) => setErrors((current) => ({ ...current, [id]: error }));
  const setInherited = (id: string, names: string[] | undefined) => setInheritance((current) => ({ ...current, [id]: names }));

  const reload = async () => {
    await load();
    announceProviderInstancesChanged();
  };

  const patch = async (instance: ProviderInstance, next: InstancePatch) => {
    setError(instance.id, null);
    try {
      const answer = await api.saveProviderInstance({ id: instance.id, ...next });
      if (answer.stoppedInheriting?.length) setInherited(instance.id, answer.stoppedInheriting);
    } catch (cause) {
      setError(instance.id, messageOf(cause, "That change was not saved."));
    }
    await reload();
  };

  const carryOver = async (instance: ProviderInstance, names: readonly string[]) => {
    setError(instance.id, null);
    try {
      await api.saveProviderInstance({ id: instance.id, carryOverInherited: [...names] });
      setInherited(instance.id, undefined);
    } catch (cause) {
      setError(instance.id, messageOf(cause, "Those variables could not be carried over."));
    }
    await reload();
  };

  const remove = async (instance: ProviderInstance) => {
    if (!window.confirm(`Remove "${instance.displayName || instance.id}"? Its login on disk is left untouched, and sessions fall back to the built-in slot.`)) return;
    try {
      await api.removeProviderInstance(instance.id);
    } catch (cause) {
      setError(instance.id, messageOf(cause, "That login could not be removed."));
    }
    await reload();
  };

  const recheck = async () => {
    setRechecking(true);
    await load(true);
    setRechecking(false);
  };

  const runUpdate = async (instance: ProviderInstance) => {
    const label = displayNameOf(instance);
    setUpdating(binaryKey(instance));
    setUpdateReport(null);
    try {
      const answer = await api.updateProviderCli(instance.id);
      setInstances(sortInstances(answer.providerInstances));
      setProbes(answer.probes);
      setUpdateReport({ label, run: answer.result });
    } catch (cause) {
      setUpdateReport({ label, error: messageOf(cause, "That update could not be run.") });
    } finally {
      setUpdating(null);
    }
  };

  return {
    instances,
    probes,
    unreachable,
    errors,
    rechecking,
    inheritance,
    updating,
    updateReport,
    setInherited,
    load,
    patch,
    carryOver,
    remove,
    recheck,
    runUpdate,
  };
}
