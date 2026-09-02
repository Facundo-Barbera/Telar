"use client";

/**
 * TEXT GENERATION — who writes the words the human didn't.
 *
 * t3 code's "Text generation" settings idea on Telar's policy: a session's
 * title starts as the first message truncated and its branch as a slug of
 * that, and this pane decides whether a small model replaces both, through
 * which harness, and on which model.
 *
 * SAVE-PER-INTERACTION like the inbox pane, and the ENGINE'S ANSWER IS THE
 * STATE: `setTextGen` returns the whole policy, which matters here because a
 * driver change drops the model server-side — a client that kept its own copy
 * would go on showing `haiku` under Codex.
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TEXT_GEN_POLICY, type ProviderDriverKind, type ProviderModel, type TextGenPolicy } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { useModelCatalogueGeneration } from "@/lib/model-catalogue-cache";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";

const api = createEngineApi();

/** The Select's value for "no pinned model" — base-ui refuses `""`. */
const DRIVER_DEFAULT = "__driver-default";

export function TextGenSection() {
  const [policy, setPolicy] = useState<TextGenPolicy>(DEFAULT_TEXT_GEN_POLICY);
  const [loading, setLoading] = useState(true);
  // Stamped with the driver it answers for, so switching harnesses EMPTIES the
  // list by derivation rather than by a synchronous reset inside the effect —
  // the cascade the lint rule forbids.
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

  /**
   * The catalogue follows the DRIVER, not the mount: switching harnesses must
   * swap the model list under the select. Stale answers are dropped by driver
   * comparison rather than a token — the closure's driver IS the token.
   */
  const driver = policy.driver;
  /** Re-reads when the Models tab writes, so curating a login here and looking
   *  at this select in the same visit cannot disagree. */
  const epoch = useModelCatalogueGeneration();
  useEffect(() => {
    let live = true;
    void api
      .modelCatalogue(driver)
      .then(({ catalogue: answer }) => {
        // TWO DIFFERENT HIDES, and this list honours both. `hidden` is the
        // provider withdrawing a row; `hiddenByUser` is the reader curating it
        // away in the Models tab — and a model somebody hid from the picker has
        // no business turning up in the list that names the title-writer.
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

  // A pinned model the catalogue does not list (typed by hand, or the
  // catalogue fell back to the built-in short list) still needs a row, or the
  // select would silently display the wrong answer.
  const pinned = policy.model;
  const listed = pinned !== undefined && models.some((model) => model.id === pinned);

  return (
    <SettingsGroup
      title="Generated text"
      description="After your first message, a small model writes the session title and branch name."
    >
      <Row
        label="Written by"
        hint={error}
        control={
          <Segmented<ProviderDriverKind>
            value={policy.driver}
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
        control={
          <Select
            value={pinned ?? DRIVER_DEFAULT}
            onValueChange={(next) => {
              if (typeof next === "string") void save({ model: next === DRIVER_DEFAULT ? null : next });
            }}
            disabled={loading}
          >
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
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
        hint="Replaces the truncated first message. A title you set yourself is never touched."
        checked={policy.titles}
        onCheckedChange={(next) => void save({ titles: next })}
      />
      {policy.titles && (
        <ToggleRow
          label="Rename branches to match"
          hint="Only branches the engine cut. Yours keep their names."
          checked={policy.renameBranches}
          onCheckedChange={(next) => void save({ renameBranches: next })}
        />
      )}
    </SettingsGroup>
  );
}
