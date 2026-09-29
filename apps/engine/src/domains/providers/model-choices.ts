import {
  defaultInstanceIdForDriver,
  type AgentModelChoice,
  type CapabilityModel,
  type ModelSelection,
  type Project,
  type ProviderDriverKind,
  type ProviderInstance,
  type ProviderModel,
  type Session,
  type SessionCapabilities,
  type SessionDefaults,
  type TurnModelSelection,
} from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";
import { claudeSlugOf, claudeTierOf, claudeWindowTokensOf } from "./manifest";

const tierOf = (driver: ProviderDriverKind, id: string): number | undefined => (driver === "claude" ? claudeTierOf(id) : undefined);

/** Current rows, plus a legacy row cheaper than every current one, so the cheapest tier stays on offer. */
export function offeredRows(driver: ProviderDriverKind, rows: readonly ProviderModel[]): ProviderModel[] {
  const shown = rows.filter((row) => !row.hidden);
  const current = shown.filter((row) => !row.legacy);
  const cheapest = Math.min(...current.map((row) => tierOf(driver, row.id) ?? Infinity));
  return shown.filter((row) => !row.legacy || (tierOf(driver, row.id) ?? Infinity) < cheapest);
}

function rowNamed(driver: ProviderDriverKind, rows: readonly ProviderModel[], model: string): ProviderModel | undefined {
  const exact = rows.find((row) => row.id === model || row.resolves === model);
  if (exact || driver !== "claude") return exact;
  const slug = claudeSlugOf(model);
  const same = slug ? rows.filter((row) => claudeSlugOf(row.id) === slug) : [];
  return same.find((row) => row.defaultWindow) ?? same[0];
}

export function chosenModel(
  driver: ProviderDriverKind,
  instanceId: string,
  choice: AgentModelChoice,
  rows: readonly ProviderModel[] | undefined,
): ModelSelection | undefined {
  if (!choice.model && !choice.effort) return undefined;
  if (!rows) return { instanceId, ...choice };
  const offered = rows.filter((row) => !row.hidden);
  const row = choice.model ? rowNamed(driver, offered, choice.model) : offered.find((candidate) => candidate.isDefault);
  if (choice.model && !row) {
    const names = offeredRows(driver, rows).map((candidate) => candidate.id).join(", ");
    throw new EngineStateError("invalid_request", `"${choice.model}" is not a model ${instanceId} offers. Offered: ${names}. sessions_capabilities lists each with its efforts.`);
  }
  if (choice.effort && row && !row.efforts.includes(choice.effort)) {
    throw new EngineStateError(
      "invalid_request",
      row.efforts.length === 0 ? `${row.id} takes no effort; omit it.` : `${row.id} takes effort ${row.efforts.join(", ")}, not "${choice.effort}".`,
    );
  }
  return { instanceId, ...(choice.model ? { model: row?.id ?? choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) };
}

export function turnModelChoice(session: Session, choice: AgentModelChoice, rows: readonly ProviderModel[] | undefined): TurnModelSelection | undefined {
  const base = session.model;
  const instanceId = session.providerInstanceId ?? defaultInstanceIdForDriver(session.driver);
  if (!choice.model && !choice.effort) return undefined;
  const model = choice.model ?? base?.model;
  const picked = chosenModel(session.driver, instanceId, { ...(model ? { model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) }, rows);
  if (!picked) return undefined;
  const { instanceId: _instance, ...selection } = base && picked.model === base.model ? { ...base, ...picked } : picked;
  return selection;
}

export type CapabilitiesDeps = {
  instances(): ProviderInstance[];
  rows(driver: ProviderDriverKind): readonly ProviderModel[] | undefined;
  defaultModel(instanceId: string, driver: ProviderDriverKind): string | undefined;
  sessionDefaults(): SessionDefaults;
  session(sessionId: string): Session;
  project(projectId: string): Project | undefined;
};

export function sessionCapabilities(deps: CapabilitiesDeps, caller?: string): SessionCapabilities {
  const self = caller === undefined ? undefined : deps.session(caller);
  const standing = deps.sessionDefaults();
  const projectModel = self?.projectId ? deps.project(self.projectId)?.defaultModel : undefined;
  const providers = deps.instances().filter((instance) => instance.enabled).map((instance) => {
    const fallback = deps.defaultModel(instance.id, instance.driver);
    const models = offeredRows(instance.driver, deps.rows(instance.driver) ?? []).map((row): CapabilityModel => {
      const tier = tierOf(instance.driver, row.id);
      const window = row.contextWindow ?? (instance.driver === "claude" ? claudeWindowTokensOf(row.id) : undefined);
      return {
        id: row.id,
        label: row.label,
        ...(tier ? { tier } : {}),
        efforts: row.efforts,
        ...(row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
        ...(window ? { window } : {}),
        ...(row.id === fallback ? { default: true as const } : {}),
      };
    });
    return { instanceId: instance.id, driver: instance.driver, ...(instance.displayName ? { name: instance.displayName } : {}), models };
  });
  const you = self && (() => {
    const instanceId = self.providerInstanceId ?? defaultInstanceIdForDriver(self.driver);
    const model = self.model?.model ?? deps.defaultModel(instanceId, self.driver);
    const tier = model ? tierOf(self.driver, model) : undefined;
    return {
      sessionId: self.id,
      driver: self.driver,
      instanceId,
      ...(model ? { model } : {}),
      ...(self.model?.effort ? { effort: self.model.effort } : {}),
      ...(tier ? { tier } : {}),
      access: self.runtimeMode,
    };
  })();
  return {
    ...(you ? { you } : {}),
    defaults: {
      envMode: standing.envMode,
      ...(standing.runtimeMode ? { access: standing.runtimeMode } : {}),
      ...(projectModel && (projectModel.model || projectModel.effort)
        ? { project: { ...(projectModel.model ? { model: projectModel.model } : {}), ...(projectModel.effort ? { effort: projectModel.effort } : {}) } }
        : {}),
    },
    providers,
  };
}
