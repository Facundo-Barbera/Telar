"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TEXT_GEN_POLICY, type ProviderDriverKind, type ProviderModel, type TextGenPolicy } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { useModelCatalogueGeneration } from "../model-catalogue-cache";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Dropdown, Row, SettingsGroup, ToggleRow, useRestoreDefaults } from "@/features/settings";

const api = createEngineApi();

const DRIVER_DEFAULT = "__driver-default";

export function TextGenSection() {
  const [policy, setPolicy] = useState<TextGenPolicy>(DEFAULT_TEXT_GEN_POLICY);
  const [loading, setLoading] = useState(true);
  const [catalogue, setCatalogue] = useState<{ driver: ProviderDriverKind; models: ProviderModel[] }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const task = window.setTimeout(() => {
      void api
        .textGen()
        .then(({ textGen }) => setPolicy(textGen))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The engine did not answer."))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const driver = policy.driver;
  const epoch = useModelCatalogueGeneration();
  useEffect(() => {
    let live = true;
    void api
      .modelCatalogue(driver)
      .then(({ catalogue: answer }) => {
        if (live) {
          setCatalogue({
            driver: answer.driver,
            models: answer.models.filter((model) => !model.hidden && !model.hiddenByUser),
          });
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [driver, epoch]);
  const models = catalogue?.driver === driver ? catalogue.models : [];

  const save = useCallback(async (patch: Parameters<typeof api.setTextGen>[0]) => {
    setError(undefined);
    try {
      const { textGen } = await api.setTextGen(patch);
      setPolicy(textGen);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused the change.");
    }
  }, []);

  useRestoreDefaults(async () => {
    await save({
      driver: DEFAULT_TEXT_GEN_POLICY.driver,
      titles: DEFAULT_TEXT_GEN_POLICY.titles,
      renameBranches: DEFAULT_TEXT_GEN_POLICY.renameBranches,
    });
    await save({ model: DEFAULT_TEXT_GEN_POLICY.model ?? null });
  });

  const pinned = policy.model;
  const listed = pinned !== undefined && models.some((model) => model.id === pinned);
  const pinnedLabel = pinned === undefined ? "Provider default" : (models.find((model) => model.id === pinned)?.label ?? pinned);

  return (
    <SettingsGroup title="Generated text" scope="mac">
      <Row
        label="Written by"
        {...(error ? { error } : {})}
        {...(policy.driver === DEFAULT_TEXT_GEN_POLICY.driver
          ? {}
          : { onRevert: () => void save({ driver: DEFAULT_TEXT_GEN_POLICY.driver }) })}
        control={
          <Dropdown<ProviderDriverKind>
            value={policy.driver}
            label="Written by"
            onChange={(next) => void save({ driver: next })}
            options={[
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
            ]}
          />
        }
      />
      <Row
        label="Model"
        hint="Changing the provider above clears a pinned model."
        {...(pinned === DEFAULT_TEXT_GEN_POLICY.model
          ? {}
          : { onRevert: () => void save({ model: DEFAULT_TEXT_GEN_POLICY.model ?? null }) })}
        control={
          <Select
            value={pinned ?? DRIVER_DEFAULT}
            onValueChange={(next) => {
              if (typeof next === "string") void save({ model: next === DRIVER_DEFAULT ? null : next });
            }}
            disabled={loading}
          >
            <SelectTrigger size="sm" className="w-44">
              <SelectValue>{pinnedLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DRIVER_DEFAULT}>Provider default</SelectItem>
              {pinned !== undefined && !listed && <SelectItem value={pinned}>{pinned}</SelectItem>}
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <ToggleRow
        label="Name sessions"
        checked={policy.titles}
        onCheckedChange={(next) => void save({ titles: next })}
        {...(policy.titles === DEFAULT_TEXT_GEN_POLICY.titles
          ? {}
          : { onRevert: () => void save({ titles: DEFAULT_TEXT_GEN_POLICY.titles }) })}
      />
      {policy.titles && (
        <ToggleRow
          label="Rename branches to match"
          hint="Only branches the engine cut. Yours keep their names."
          checked={policy.renameBranches}
          onCheckedChange={(next) => void save({ renameBranches: next })}
          {...(policy.renameBranches === DEFAULT_TEXT_GEN_POLICY.renameBranches
            ? {}
            : { onRevert: () => void save({ renameBranches: DEFAULT_TEXT_GEN_POLICY.renameBranches }) })}
        />
      )}
    </SettingsGroup>
  );
}
